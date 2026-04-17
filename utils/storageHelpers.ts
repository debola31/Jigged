import { getSupabase } from '@/lib/supabase';

/**
 * Get the storage bucket name from environment variable
 */
function getStorageBucket(): string {
  const bucket = process.env.NEXT_PUBLIC_SUPABASE_S3_BUCKET || process.env.SUPABASE_S3_BUCKET;
  if (!bucket) {
    throw new Error('SUPABASE_S3_BUCKET environment variable is not set');
  }
  return bucket;
}

/**
 * Sanitize filename for storage
 */
export function sanitizeFilename(filename: string): string {
  return filename
    .replace(/[^a-zA-Z0-9._-]/g, '_')  // Replace special chars
    .replace(/_{2,}/g, '_')             // Collapse multiple underscores
    .substring(0, 100);                 // Limit length
}

/**
 * Generate storage path with UUID prefix and sanitized filename
 */
export function generateStoragePath(
  companyId: string,
  entityType: 'quotes' | 'jobs',
  entityId: string,
  filename: string
): string {
  const uuid = crypto.randomUUID().substring(0, 8);
  const sanitized = sanitizeFilename(filename);
  return `${companyId}/${entityType}/${entityId}/${uuid}_${sanitized}`;
}

/**
 * Generate storage path for a company logo.
 * A fresh uuid each upload gives automatic cache-busting.
 */
export function generateCompanyLogoPath(
  companyId: string,
  filename: string
): string {
  const uuid = crypto.randomUUID().substring(0, 8);
  const sanitized = sanitizeFilename(filename);
  return `${companyId}/company/logo_${uuid}_${sanitized}`;
}

/**
 * Upload file to Supabase Storage
 */
export async function uploadFileToStorage(
  path: string,
  file: File | Blob
): Promise<void> {
  const supabase = getSupabase();
  const bucket = getStorageBucket();

  const { error } = await supabase.storage
    .from(bucket)
    .upload(path, file, {
      cacheControl: '3600',
      upsert: false
    });

  if (error) {
    console.error('Storage upload error:', error);
    throw new Error(`Failed to upload file: ${error.message}`);
  }
}

/**
 * Delete file from Supabase Storage
 */
export async function deleteFileFromStorage(
  path: string
): Promise<void> {
  const supabase = getSupabase();
  const bucket = getStorageBucket();

  const { error } = await supabase.storage
    .from(bucket)
    .remove([path]);

  if (error) {
    console.error('Storage delete error:', error);
    throw new Error(`Failed to delete file: ${error.message}`);
  }
}

/**
 * Get signed URL for private file (fetch fresh on each download)
 */
export async function getSignedUrl(
  path: string,
  expiresIn: number = 3600
): Promise<string> {
  const supabase = getSupabase();
  const bucket = getStorageBucket();

  const { data, error } = await supabase.storage
    .from(bucket)
    .createSignedUrl(path, expiresIn);

  if (error || !data) {
    console.error('Failed to create signed URL:', error);
    throw new Error('Failed to generate download link');
  }

  return data.signedUrl;
}

/**
 * Download file from storage (returns Blob for copying)
 */
export async function downloadFileFromStorage(
  path: string
): Promise<Blob> {
  const supabase = getSupabase();
  const bucket = getStorageBucket();

  const { data, error } = await supabase.storage
    .from(bucket)
    .download(path);

  if (error || !data) {
    console.error('Storage download error:', error);
    throw new Error(`Failed to download file: ${error?.message || 'Unknown error'}`);
  }

  return data;
}

/**
 * Move file from one location to another in storage
 */
export async function moveFileInStorage(
  fromPath: string,
  toPath: string
): Promise<void> {
  // 1. Download the file
  const fileData = await downloadFileFromStorage(fromPath);

  // 2. Upload to new location
  await uploadFileToStorage(toPath, fileData);

  // 3. Delete from old location (best effort)
  await deleteFileFromStorage(fromPath).catch((err) =>
    console.warn('Failed to delete old file during move:', err)
  );
}

/**
 * Generate temp storage path for files uploaded before quote creation
 */
export function generateTempStoragePath(
  companyId: string,
  sessionId: string,
  filename: string
): string {
  const uuid = crypto.randomUUID().substring(0, 8);
  const sanitized = sanitizeFilename(filename);
  return `${companyId}/temp/${sessionId}/${uuid}_${sanitized}`;
}
