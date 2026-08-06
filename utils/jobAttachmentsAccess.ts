import { getSupabase } from '@/lib/supabase';
import {
  generateStoragePath,
  uploadFileToStorage,
  deleteFileFromStorage,
  getSignedUrl,
} from '@/utils/storageHelpers';
import type { JobAttachment } from '@/types/job';

/**
 * Access layer for job attachments — customer-supplied PDFs (typically the PO
 * document) referenced on a job. File bytes live in the private storage bucket
 * (see utils/storageHelpers.ts); this module manages the job_attachments
 * metadata rows and ties the two together.
 */

/** v1 accepts PDFs only, capped at 25 MB — the customer PO is the driving case. */
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export function validateAttachmentFile(file: File): string | null {
  if (file.type !== 'application/pdf') return 'Only PDF files can be attached.';
  if (file.size > MAX_ATTACHMENT_BYTES) return 'That PDF is larger than 25 MB — attach a smaller file.';
  return null;
}

/**
 * Upload a PDF and attach it to a job. Uploads to {companyId}/jobs/{jobId}/...
 * then records the metadata row. Rolls back the upload if the row insert fails
 * so a failed attach never leaks an orphaned file.
 */
export async function uploadJobAttachment(
  companyId: string,
  jobId: string,
  file: File,
): Promise<JobAttachment> {
  const validationError = validateAttachmentFile(file);
  if (validationError) throw new Error(validationError);

  const supabase = getSupabase();
  const { data: { user } } = await supabase.auth.getUser();

  const storagePath = generateStoragePath(companyId, 'jobs', jobId, file.name);
  await uploadFileToStorage(storagePath, file);

  const { data, error } = await supabase
    .from('job_attachments')
    .insert({
      company_id: companyId,
      job_id: jobId,
      storage_path: storagePath,
      file_name: file.name,
      mime_type: file.type,
      size_bytes: file.size,
      uploaded_by: user?.id ?? null,
    })
    .select('*')
    .single();

  if (error) {
    // Roll back the orphaned upload so a failed insert doesn't leak a file.
    await deleteFileFromStorage(storagePath).catch(() => {});
    console.error('Error inserting job attachment:', error);
    throw new Error('Failed to attach the PDF. Please try again.');
  }

  return data as JobAttachment;
}

/** List a job's attachments, newest first. */
export async function listJobAttachments(jobId: string): Promise<JobAttachment[]> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('job_attachments')
    .select('*')
    .eq('job_id', jobId)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('Error listing job attachments:', error);
    throw error;
  }
  return (data ?? []) as JobAttachment[];
}

/** A fresh, time-limited download/preview URL for an attachment. */
export function getJobAttachmentUrl(storagePath: string): Promise<string> {
  return getSignedUrl(storagePath);
}

/**
 * Delete an attachment: remove the stored file first, then the metadata row,
 * so we never leave a row pointing at a missing file.
 */
export async function deleteJobAttachment(att: {
  id: string;
  storage_path: string;
}): Promise<void> {
  await deleteFileFromStorage(att.storage_path);

  const supabase = getSupabase();
  const { error } = await supabase.from('job_attachments').delete().eq('id', att.id);
  if (error) {
    console.error('Error deleting job attachment row:', error);
    throw error;
  }
}

/**
 * Best-effort removal of all stored files for the given jobs, used before the
 * jobs are deleted. The job_attachments rows cascade with the job, but the
 * storage objects don't — so clean them here. Failures are logged, not thrown:
 * a missing/locked file must not block a job delete.
 */
export async function deleteStoredFilesForJobs(jobIds: string[]): Promise<void> {
  if (jobIds.length === 0) return;
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('job_attachments')
    .select('storage_path')
    .in('job_id', jobIds);
  if (error) {
    console.warn('Could not list attachments for storage cleanup:', error);
    return;
  }
  for (const row of (data ?? []) as Array<{ storage_path: string }>) {
    await deleteFileFromStorage(row.storage_path).catch((err) =>
      console.warn('Failed to delete attachment file during job delete:', err),
    );
  }
}
