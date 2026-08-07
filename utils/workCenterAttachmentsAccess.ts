import { getSupabase } from '@/lib/supabase';
import { toFriendlyError } from '@/lib/supabaseErrors';
import {
  generateStoragePath,
  uploadFileToStorage,
  deleteFileFromStorage,
  getSignedUrl,
} from '@/utils/storageHelpers';
import { getCurrentMember } from '@/utils/operatorAccess';
import type { WorkCenterAttachment } from '@/types/machineMaintenance';

/**
 * Machine manuals and reference images.
 *
 * Mirrors partAttachmentsAccess.ts, including the two ordering rules it learned
 * the hard way: upload-then-insert with a storage rollback on a failed insert
 * (so a failed attach never leaks a file), and row-first-then-file on delete (so
 * a failure leaks an INVISIBLE orphan rather than leaving a visible row that
 * 404s when someone taps it on the floor).
 *
 * Narrower allowlist than part attachments: a machine manual is a PDF, and the
 * other thing worth keeping is a photo of a nameplate or a lube chart. STEP and
 * DWG belong to a part, not to a machine.
 */

const PDF_MAX_BYTES = 50 * 1024 * 1024;
const IMAGE_MAX_BYTES = 15 * 1024 * 1024;
const ATTACHMENT_URL_EXPIRY_SECONDS = 4 * 60 * 60;

const PDF_EXTENSIONS = ['pdf'];
const IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'heic', 'webp'];

function fileExtension(name: string): string {
  const i = name.lastIndexOf('.');
  return i === -1 ? '' : name.slice(i + 1).toLowerCase();
}

export function detectManualKind(fileName: string): WorkCenterAttachment['kind'] {
  const ext = fileExtension(fileName);
  if (PDF_EXTENSIONS.includes(ext)) return 'pdf';
  if (IMAGE_EXTENSIONS.includes(ext)) return 'image';
  return 'other';
}

/** An error string if this file is not an acceptable manual, or null if it is. */
export function validateManualFile(file: File): string | null {
  const kind = detectManualKind(file.name);
  if (kind === 'other') {
    return 'Only PDFs and images can be attached to a machine.';
  }
  const max = kind === 'pdf' ? PDF_MAX_BYTES : IMAGE_MAX_BYTES;
  if (file.size > max) {
    return `That file is larger than ${Math.round(max / (1024 * 1024))} MB — attach a smaller one.`;
  }
  return null;
}

const ATTACHMENT_SELECT = '*, uploader:user_company_access(name)';

type AttachmentRow = Omit<WorkCenterAttachment, 'uploaded_by_name'> & {
  uploader: { name: string | null } | { name: string | null }[] | null;
};

function rowToAttachment(row: AttachmentRow): WorkCenterAttachment {
  const uploader = Array.isArray(row.uploader) ? row.uploader[0] : row.uploader;
  const { uploader: _uploader, ...rest } = row;
  return { ...rest, uploaded_by_name: uploader?.name ?? null };
}

/**
 * Upload a manual and file it against a machine. `uploaded_by` is the acting
 * member's user_company_access id; the INSERT policy requires it to match the
 * caller, so there is no path to attribute an upload to anyone else.
 */
export async function uploadWorkCenterAttachment(
  companyId: string,
  workCenterId: string,
  file: File,
): Promise<WorkCenterAttachment> {
  const validationError = validateManualFile(file);
  if (validationError) throw new Error(validationError);

  const member = await getCurrentMember(companyId);
  if (!member) {
    throw new Error('Could not identify your account — reload the page and try again.');
  }

  const supabase = getSupabase();
  const storagePath = generateStoragePath(companyId, 'work-centers', workCenterId, file.name);
  await uploadFileToStorage(storagePath, file);

  const { data, error } = await supabase
    .from('work_center_attachments')
    .insert({
      company_id: companyId,
      work_center_id: workCenterId,
      storage_path: storagePath,
      file_name: file.name,
      kind: detectManualKind(file.name),
      mime_type: file.type || null,
      size_bytes: file.size,
      uploaded_by: member.id,
    })
    .select(ATTACHMENT_SELECT)
    .single();

  if (error) {
    // Roll back the orphaned upload so a failed insert doesn't leak a file.
    await deleteFileFromStorage(storagePath).catch(() => {});
    console.error('Error inserting work center attachment:', error);
    throw new Error('Failed to attach the file. Please try again.');
  }

  return rowToAttachment(data as unknown as AttachmentRow);
}

/**
 * A machine's manuals, newest first.
 *
 * `companyId` is required, and RLS is not a substitute for it: the policy admits
 * every company the caller belongs to, so filtering on `work_center_id` alone
 * lists another company's manuals — with signed URLs that open — whenever a
 * foreign machine id reaches this call. A manual carries part numbers, tooling
 * and process notes, so that is a real disclosure and not a cosmetic one.
 */
export async function listWorkCenterAttachments(
  workCenterId: string,
  companyId: string,
): Promise<WorkCenterAttachment[]> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('work_center_attachments')
    .select(ATTACHMENT_SELECT)
    .eq('work_center_id', workCenterId)
    .eq('company_id', companyId)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('Error listing work center attachments:', error);
    throw error;
  }
  return ((data ?? []) as unknown as AttachmentRow[]).map(rowToAttachment);
}

/**
 * How many manuals a machine has. Returns 0 on error rather than throwing: the
 * count only decides whether an affordance renders, and a machine with no
 * manuals shows nothing — so a failure degrades to the same thing as an empty
 * machine rather than to a broken screen.
 *
 * Company-scoped for the same reason as `listWorkCenterAttachments` — this count
 * is what renders the "Manuals · N" button that opens that list, so an unscoped
 * count advertises another company's documents before anyone taps.
 */
export async function countWorkCenterAttachments(
  workCenterId: string,
  companyId: string,
): Promise<number> {
  const supabase = getSupabase();
  const { count, error } = await supabase
    .from('work_center_attachments')
    .select('id', { count: 'exact', head: true })
    .eq('work_center_id', workCenterId)
    .eq('company_id', companyId);
  if (error) {
    console.error('Error counting work center attachments:', error);
    return 0;
  }
  return count ?? 0;
}

/** A fresh, time-limited URL for opening a manual. */
export function getWorkCenterAttachmentUrl(storagePath: string): Promise<string> {
  return getSignedUrl(storagePath, ATTACHMENT_URL_EXPIRY_SECONDS);
}

/**
 * Delete a manual: the row first, then the file. RLS restricts the row delete to
 * the uploader or a company admin.
 */
export async function deleteWorkCenterAttachment(att: {
  id: string;
  storage_path: string;
}): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase.from('work_center_attachments').delete().eq('id', att.id);
  if (error) {
    console.error('Error deleting work center attachment row:', error);
    throw toFriendlyError(error, { entity: 'attachment' });
  }
  await deleteFileFromStorage(att.storage_path).catch((err) =>
    console.warn('Failed to delete manual file after row delete:', err),
  );
}
