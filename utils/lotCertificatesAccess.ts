import { getSupabase } from '@/lib/supabase';
import { toFriendlyError } from '@/lib/supabaseErrors';
import {
  generateStoragePath,
  uploadFileToStorage,
  deleteFileFromStorage,
  getSignedUrl,
} from '@/utils/storageHelpers';
import { getCurrentMember } from '@/utils/operatorAccess';
import type { LotCertificate, LotCertificatePreview } from '@/types/inventoryLocations';

/**
 * Access layer for mill certificates (MTRs) held against a lot — the document that says what the
 * steel actually is. Bytes live in the private `attachments` bucket under `{companyId}/lots/{lotId}/`;
 * this module owns the `lot_certificates` rows and ties the two together.
 *
 * Mirrors `partAttachmentsAccess.ts`, which is the house shape for upload-plus-metadata-row. Four
 * places it deliberately diverges are commented where they occur: no compression, the throw/quiet
 * split between the single and batch reads, the friendly-error on insert, and extension-only
 * validation widened to photographs.
 *
 * **A cert attaches to the LOT, never to a movement.** A lot is received twice under one heat and
 * consumed over months; the document outlives every individual movement of it.
 */

/**
 * One cap, not a per-kind table: there is one kind of thing here. Matches `part_attachments`' PDF
 * cap so a shop learns one number.
 *
 * Advisory only — the `attachments` bucket sets no `file_size_limit` (20260728212230), so unlike
 * the `logos` bucket nothing server-side enforces this. A client-side check is the whole of it.
 */
export const CERT_MAX_BYTES = 25 * 1024 * 1024;

/** Long enough that a 40-page MTR scanned at 300 dpi doesn't 403 halfway through being read. */
const CERT_URL_EXPIRY_SECONDS = 4 * 60 * 60;

/**
 * Allowlisted by EXTENSION, not MIME. Desk scanners routinely emit `application/octet-stream` for a
 * PDF and iOS is inconsistent about HEIC, so the MIME type is recorded but never trusted.
 *
 * Photographs are in because the dock case is a paper cert stapled to the bundle and the phone in
 * someone's hand is the scanner — the same gesture `MovementPhotoField` already proves people make.
 */
export const CERT_ALLOWED_EXTENSIONS = [
  'pdf',
  'jpg',
  'jpeg',
  'png',
  'heic',
  'heif',
  'tif',
  'tiff',
] as const;

/** The `accept` attribute, built from the allowlist so the picker and the check cannot drift. */
export const CERT_ACCEPT_ATTR = CERT_ALLOWED_EXTENSIONS.map((e) => `.${e}`).join(',');

const IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'tif', 'tiff'];

/** Lowercased extension after the last dot, or '' if the name has none. */
function fileExtension(name: string): string {
  const i = name.lastIndexOf('.');
  return i === -1 ? '' : name.slice(i + 1).toLowerCase();
}

/**
 * An error string if this file is not an acceptable certificate, else null. Exported so the UI can
 * refuse before anything leaves the browser.
 */
export function validateLotCertificateFile(file: File): string | null {
  const ext = fileExtension(file.name);
  if (!(CERT_ALLOWED_EXTENSIONS as readonly string[]).includes(ext)) {
    return 'A certificate has to be a PDF or a photo (JPG, PNG, HEIC or TIFF).';
  }
  // A zero-byte "scan" renders as a blank cert, which is worse than a refusal: the lot then looks
  // documented and is not. `part_attachments` does not check this; a compliance artefact should.
  if (file.size === 0) {
    return 'That file is empty — check the scan came out, then try again.';
  }
  if (file.size > CERT_MAX_BYTES) {
    const mb = Math.round(CERT_MAX_BYTES / (1024 * 1024));
    return `That file is larger than ${mb} MB — attach a smaller scan.`;
  }
  return null;
}

/**
 * How to paint this cert.
 *
 * HEIC/HEIF are `download`, not `image`: no browser renders them in an `<img>`, so treating them as
 * images shows a broken tile. iPhones produce them by default, so this is the ordinary case, not an
 * edge one.
 */
export function certificatePreviewKind(
  cert: Pick<LotCertificate, 'file_name' | 'mime_type'>,
): LotCertificatePreview {
  const ext = fileExtension(cert.file_name);
  if (ext === 'pdf') return 'pdf';
  if (IMAGE_EXTENSIONS.includes(ext)) return 'image';
  return 'download';
}

const CERT_SELECT = '*, uploader:user_company_access(name)';

type CertRow = Omit<LotCertificate, 'uploaded_by_name'> & {
  uploader: { name: string | null } | { name: string | null }[] | null;
};

/** Flatten the joined uploader name onto a flat LotCertificate. */
function rowToCertificate(row: CertRow): LotCertificate {
  const uploader = Array.isArray(row.uploader) ? row.uploader[0] : row.uploader;
  const { uploader: _uploader, ...rest } = row;
  return { ...rest, uploaded_by_name: uploader?.name ?? null };
}

/**
 * Upload a certificate and record it against a lot.
 *
 * **Deliberately does not compress.** `MovementPhotoField` re-encodes to 2048px / 1.5 MB JPEG,
 * which is right for evidence that a pile was moved and wrong here: the small print on a mill cert
 * — the heat, the chemistry, the tensile numbers — is the entire content, and it is the first thing
 * a re-encode destroys.
 *
 * Rolls the storage object back if the row insert fails, so a failure never leaks an orphan.
 */
export async function uploadLotCertificate(
  companyId: string,
  lotId: string,
  file: File,
): Promise<LotCertificate> {
  const validationError = validateLotCertificateFile(file);
  if (validationError) throw new Error(validationError);

  const member = await getCurrentMember(companyId);
  if (!member) {
    throw new Error('Could not identify your account — reload the page and try again.');
  }

  const supabase = getSupabase();
  const filePath = generateStoragePath(companyId, 'lots', lotId, file.name);
  await uploadFileToStorage(filePath, file);

  const { data, error } = await supabase
    .from('lot_certificates')
    .insert({
      company_id: companyId,
      lot_id: lotId,
      file_path: filePath,
      file_name: file.name,
      mime_type: file.type || null,
      size_bytes: file.size,
      uploaded_by: member.id,
    })
    .select(CERT_SELECT)
    .single();

  if (error) {
    // Roll back the orphaned upload so a failed insert doesn't leak a file.
    await deleteFileFromStorage(filePath).catch(() => {});
    console.error('Error inserting lot certificate:', error);
    // `toFriendlyError`, not a bare Error: `apply_billing_write_gate` is on this table, so a lapsed
    // shop's refusal has to reach ErrorAlert as a billing block rather than as "please try again".
    throw toFriendlyError(error, { entity: 'certificate' });
  }

  return rowToCertificate(data as unknown as CertRow);
}

/**
 * One lot's certificates, newest first.
 *
 * THROWS on failure, unlike its batch sibling below. This backs a surface whose entire content is
 * the cert list, so an empty list caused by an error would read as "this lot has no cert" — the one
 * wrong answer.
 */
export async function listLotCertificates(lotId: string): Promise<LotCertificate[]> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('lot_certificates')
    .select(CERT_SELECT)
    .eq('lot_id', lotId)
    .order('uploaded_at', { ascending: false });

  if (error) {
    console.error('Error listing lot certificates:', error);
    throw error;
  }
  return ((data ?? []) as unknown as CertRow[]).map(rowToCertificate);
}

/**
 * Certificates for many lots in ONE request, keyed by lot id.
 *
 * **A lot absent from the map has no certificates** — never read absence as "not asked about".
 *
 * BEST-EFFORT: returns an empty map rather than throwing. This decorates a balances view whose job
 * is stock, and a cert badge that fails must not blank the part page. That asymmetry with
 * `listLotCertificates` is the point, not an oversight.
 *
 * Not chunked, matching `getLotsForTrackedParts`: every caller is page-scoped (the lots on one
 * part, or one page of balances). Do not hand it thousands of ids.
 */
export async function listLotCertificatesForLots(
  lotIds: string[],
): Promise<Map<string, LotCertificate[]>> {
  const byLot = new Map<string, LotCertificate[]>();
  const unique = [...new Set(lotIds)];
  if (unique.length === 0) return byLot;

  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('lot_certificates')
    .select(CERT_SELECT)
    .in('lot_id', unique)
    .order('uploaded_at', { ascending: false });

  if (error) {
    console.warn('Could not load lot certificates:', error);
    return byLot;
  }

  for (const row of (data ?? []) as unknown as CertRow[]) {
    const cert = rowToCertificate(row);
    const existing = byLot.get(cert.lot_id);
    if (existing) existing.push(cert);
    else byLot.set(cert.lot_id, [cert]);
  }
  return byLot;
}

/** A fresh, time-limited URL for inline preview / download. Never cache one across opens. */
export function getLotCertificateUrl(filePath: string): Promise<string> {
  return getSignedUrl(filePath, CERT_URL_EXPIRY_SECONDS);
}

/**
 * Delete a certificate: row first, then the file.
 *
 * Hard delete — `lot_certificates` has no `deleted_at`, matching every other upload table. Row-first
 * for the `part_attachments` reason: a failure after the row is gone leaks an *invisible* orphan,
 * where the other order leaves a *visible* row that 404s when opened.
 *
 * **Replacing a cert is not an operation here.** Upload the new one, then delete the old — in that
 * order, so a failed upload never leaves the lot with nothing.
 */
export async function deleteLotCertificate(cert: {
  id: string;
  file_path: string;
}): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase.from('lot_certificates').delete().eq('id', cert.id);
  if (error) {
    console.error('Error deleting lot certificate row:', error);
    throw toFriendlyError(error, { entity: 'certificate' });
  }
  await deleteFileFromStorage(cert.file_path).catch((err) =>
    console.warn('Failed to delete certificate file after row delete:', err),
  );
}
