import { getTypedSupabase as getSupabase } from '@/lib/supabase';
import {
  generateStoragePath,
  uploadFileToStorage,
  deleteFileFromStorage,
  getSignedUrl,
} from '@/utils/storageHelpers';
import { getCurrentOperator } from '@/utils/operatorAccess';
import type { PartAttachment, PartAttachmentKind } from '@/types/part';

/**
 * Access layer for part attachments — engineering files (PDF drawings, STEP
 * models, DWG drawings) referenced on a part. File bytes live in the private
 * `attachments` storage bucket (see utils/storageHelpers.ts); this module
 * manages the part_attachments metadata rows and ties the two together.
 *
 * Mirrors jobAttachmentsAccess.ts, widened to multiple file kinds with per-kind
 * validation, an extension-derived `kind`, and the uploader-name join.
 */

/** PDFs are the common case and stay small; CAD models (STEP/DWG) run large. */
const PDF_MAX_BYTES = 25 * 1024 * 1024;
const MODEL_MAX_BYTES = 100 * 1024 * 1024;

/** Viewer/download links live a little longer so a large file doesn't 403 mid-view. */
const ATTACHMENT_URL_EXPIRY_SECONDS = 4 * 60 * 60;

interface KindRule {
  extensions: string[];
  maxBytes: number;
  label: string;
}

/**
 * Per-kind upload rules, keyed by stored kind. Detection and the allowlist key
 * off the file **extension**, not the MIME type: STEP/DWG files frequently report
 * `application/octet-stream` or an empty type, so MIME is recorded but advisory.
 */
const KIND_RULES: Record<Exclude<PartAttachmentKind, 'other'>, KindRule> = {
  pdf: { extensions: ['pdf'], maxBytes: PDF_MAX_BYTES, label: 'PDF' },
  step: { extensions: ['step', 'stp'], maxBytes: MODEL_MAX_BYTES, label: 'STEP' },
  dwg: { extensions: ['dwg'], maxBytes: MODEL_MAX_BYTES, label: 'DWG' },
};

const ALLOWED_EXTENSIONS = Object.values(KIND_RULES).flatMap((r) => r.extensions);

/** Lowercased extension after the last dot, or '' if the name has none. */
function fileExtension(name: string): string {
  const i = name.lastIndexOf('.');
  return i === -1 ? '' : name.slice(i + 1).toLowerCase();
}

/**
 * Map a filename to its stored kind. `.step`/`.stp` → step, `.dwg` → dwg,
 * `.pdf` → pdf, everything else → other. `other` is never produced on the happy
 * path (validatePartAttachmentFile rejects non-allowlisted extensions first); it
 * exists as a defensive default and to keep the type open.
 */
export function detectAttachmentKind(fileName: string): PartAttachmentKind {
  const ext = fileExtension(fileName);
  for (const [kind, rule] of Object.entries(KIND_RULES) as [
    Exclude<PartAttachmentKind, 'other'>,
    KindRule,
  ][]) {
    if (rule.extensions.includes(ext)) return kind;
  }
  return 'other';
}

/**
 * Returns an error string if the file is not an acceptable part attachment, or
 * null if it's fine. Allowlists by extension and enforces the per-kind size cap.
 */
export function validatePartAttachmentFile(file: File): string | null {
  const ext = fileExtension(file.name);
  if (!ALLOWED_EXTENSIONS.includes(ext)) {
    return 'Only PDF, STEP (.step/.stp), and DWG files can be attached.';
  }
  const kind = detectAttachmentKind(file.name) as Exclude<PartAttachmentKind, 'other'>;
  const rule = KIND_RULES[kind];
  if (file.size > rule.maxBytes) {
    const mb = Math.round(rule.maxBytes / (1024 * 1024));
    return `That ${rule.label} is larger than ${mb} MB — attach a smaller file.`;
  }
  return null;
}

const ATTACHMENT_SELECT = '*, uploader:user_company_access(name)';

type AttachmentRow = Omit<PartAttachment, 'uploaded_by_name'> & {
  uploader: { name: string | null } | { name: string | null }[] | null;
};

/** Flatten the joined uploader name onto a flat PartAttachment. */
function rowToAttachment(row: AttachmentRow): PartAttachment {
  const uploader = Array.isArray(row.uploader) ? row.uploader[0] : row.uploader;
  const { uploader: _uploader, ...rest } = row;
  return { ...rest, uploaded_by_name: uploader?.name ?? null };
}

/**
 * Upload a file and attach it to a part. Uploads to {companyId}/parts/{partId}/...
 * then records the metadata row. `uploaded_by` is the uploader's
 * user_company_access id (the INSERT RLS policy requires it to match the caller).
 * Rolls back the storage object if the row insert fails so a failed attach never
 * leaks an orphaned file.
 */
export async function uploadPartAttachment(
  companyId: string,
  partId: string,
  file: File,
): Promise<PartAttachment> {
  const validationError = validatePartAttachmentFile(file);
  if (validationError) throw new Error(validationError);

  const operator = await getCurrentOperator(companyId);
  if (!operator) {
    throw new Error('Could not identify your account — reload the page and try again.');
  }

  const supabase = getSupabase();
  const kind = detectAttachmentKind(file.name);
  const storagePath = generateStoragePath(companyId, 'parts', partId, file.name);
  await uploadFileToStorage(storagePath, file);

  const { data, error } = await supabase
    .from('part_attachments')
    .insert({
      company_id: companyId,
      part_id: partId,
      storage_path: storagePath,
      file_name: file.name,
      kind,
      mime_type: file.type || null,
      size_bytes: file.size,
      uploaded_by: operator.id,
    })
    .select(ATTACHMENT_SELECT)
    .single();

  if (error) {
    // Roll back the orphaned upload so a failed insert doesn't leak a file.
    await deleteFileFromStorage(storagePath).catch(() => {});
    console.error('Error inserting part attachment:', error);
    throw new Error('Failed to attach the file. Please try again.');
  }

  return rowToAttachment(data as unknown as AttachmentRow);
}

/** List a part's attachments, newest first, with the uploader's display name. */
export async function listPartAttachments(partId: string): Promise<PartAttachment[]> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('part_attachments')
    .select(ATTACHMENT_SELECT)
    .eq('part_id', partId)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('Error listing part attachments:', error);
    throw error;
  }
  return ((data ?? []) as unknown as AttachmentRow[]).map(rowToAttachment);
}

/**
 * Count a part's attachments (head-only, no rows) — powers the operator's Files
 * affordance count so a drawing/CAD that's needed to do the job can't be missed.
 * Returns 0 on error rather than throwing (the count is a hint, not load-bearing).
 */
export async function countPartAttachments(partId: string): Promise<number> {
  const supabase = getSupabase();
  const { count, error } = await supabase
    .from('part_attachments')
    .select('id', { count: 'exact', head: true })
    .eq('part_id', partId);
  if (error) {
    console.error('Error counting part attachments:', error);
    return 0;
  }
  return count ?? 0;
}

/** A fresh, time-limited URL for inline preview / download. */
export function getPartAttachmentUrl(storagePath: string): Promise<string> {
  return getSignedUrl(storagePath, ATTACHMENT_URL_EXPIRY_SECONDS);
}

/**
 * Delete an attachment: remove the metadata row first, then the stored file.
 *
 * Row-first (the reverse of jobAttachments): if the file delete fails after the
 * row is gone, we leak an *invisible* orphan file (cleanable later) rather than
 * leaving a *visible* row that 404s when opened. RLS restricts the row delete to
 * the uploader or a company admin.
 */
export async function deletePartAttachment(att: {
  id: string;
  storage_path: string;
}): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase.from('part_attachments').delete().eq('id', att.id);
  if (error) {
    console.error('Error deleting part attachment row:', error);
    throw error;
  }
  // Row is gone; best-effort remove the file. A failure here is a recoverable
  // orphan, not a user-visible problem, so don't surface it.
  await deleteFileFromStorage(att.storage_path).catch((err) =>
    console.warn('Failed to delete attachment file after row delete:', err),
  );
}

/**
 * Capture the storage paths of all attachments for the given parts. Best-effort:
 * returns [] on any error so it can never block a part delete. Call this BEFORE
 * deleting the parts — the part_attachments rows cascade away with the part, so
 * the paths must be read while the rows still exist.
 */
export async function getStoredPartAttachmentPaths(partIds: string[]): Promise<string[]> {
  if (partIds.length === 0) return [];
  try {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('part_attachments')
      .select('storage_path')
      .in('part_id', partIds);
    if (error) {
      console.warn('Could not list part attachments for storage cleanup:', error);
      return [];
    }
    const rows = Array.isArray(data) ? (data as Array<{ storage_path: string }>) : [];
    return rows.map((r) => r.storage_path).filter(Boolean);
  } catch (err) {
    console.warn('Could not list part attachments for storage cleanup:', err);
    return [];
  }
}

/**
 * Best-effort removal of storage objects by path, used after the owning parts
 * have been deleted. Failures are logged, not thrown — a missing/locked file
 * must not turn a successful part delete into an error.
 */
export async function deleteStoredFilesByPaths(paths: string[]): Promise<void> {
  for (const path of paths) {
    await deleteFileFromStorage(path).catch((err) =>
      console.warn('Failed to delete attachment file during part delete:', err),
    );
  }
}
