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
 * The folder an upload is filed under. Only the FIRST segment of the path is
 * load-bearing: the bucket's RLS gates on `foldername[1] = companyId`, so adding
 * an entity type here needs no new storage policy.
 */
export type StorageEntityType =
  | 'quotes'
  | 'jobs'
  | 'parts'
  | 'work-centers'
  | 'locations'
  /**
   * Evidence photographed when stock moves. Filed under the LOCATION id, not the transaction's —
   * the row does not exist yet when the file is uploaded, because `photo_path` is written at INSERT
   * and is immutable afterwards. Grouping by place is the useful fallback anyway when someone has
   * to go looking in the bucket.
   */
  | 'inventory-transactions';

/**
 * Generate storage path with UUID prefix and sanitized filename
 */
export function generateStoragePath(
  companyId: string,
  entityType: StorageEntityType,
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

/** A storage request that ran past its deadline. Distinct so callers can word it as a network
 *  condition rather than as a rejection by the server. */
export class UploadTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UploadTimeoutError';
  }
}

/**
 * Deadlines for storage requests, because a stalled one otherwise hangs forever.
 *
 * Supabase's `.upload()` accepts no AbortSignal (still true in storage-js 2.112) and there is no
 * progress event to hang a stall detector off, so this RACES rather than CANCELS: the request is
 * abandoned, not stopped. The cost is that a stalled upload whose bytes later land leaves an
 * orphaned object with no row — invisible, and a category this module already tolerates by design
 * (see deleteJobNoteMedia). It can never block a retry, because generateStoragePath mints a fresh
 * uuid per call. If uploads on shop wifi turn out to fail often enough to care, the escalation is
 * TUS resumable uploads (which Supabase recommends above 6 MB), not a bigger timeout.
 */
const UPLOAD_TIMEOUT_BASE_MS = 20_000;
/**
 * ≈480 kbit/s sustained — deliberately BELOW any link a phone can meaningfully use, so failing this
 * budget means the transfer stalled rather than that it was slow. A marginal LTE signal inside a
 * steel building still sustains around 1 Mbit/s up when it is working at all.
 */
const UPLOAD_MIN_BYTES_PER_MS = 60;
/** Only binds above ~51 MB. No single request should be able to pin a tab for half an hour. */
const UPLOAD_TIMEOUT_MAX_MS = 15 * 60_000;
/** A delete carries no payload, so it needs no size term. */
const DELETE_TIMEOUT_MS = 20_000;

/**
 * How long an upload of `bytes` may take before it counts as stalled.
 *
 * ONE FORMULA CANNOT SERVE BOTH ENDS OF THIS WELL, and the linear term is the compromise: the same
 * choke point carries 1.5 MB operator photos taken on a phone (~46 s) and 100 MB part model files
 * uploaded from an office desk (capped at 15 min). If the phone number proves wrong in the pilot,
 * add a per-call override rather than changing the shared rate.
 */
export function uploadTimeoutMs(bytes: number): number {
  return Math.min(
    UPLOAD_TIMEOUT_BASE_MS + Math.ceil(bytes / UPLOAD_MIN_BYTES_PER_MS),
    UPLOAD_TIMEOUT_MAX_MS,
  );
}

/** Reject after `ms` if `work` has not settled. Clears its timer either way. */
async function withDeadline<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new UploadTimeoutError(message)), ms);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
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

  const { error } = await withDeadline(
    supabase.storage
      .from(bucket)
      .upload(path, file, {
        cacheControl: '3600',
        upsert: false
      }),
    uploadTimeoutMs(file.size),
    'The upload timed out — check your connection and try again.',
  );

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

  // Bounded for the same reason as the upload, and it is not hypothetical: the media rollback path
  // awaits this after a failed insert, so a hung remove would hang the composer one branch below
  // the failure it is cleaning up after.
  const { error } = await withDeadline(
    supabase.storage.from(bucket).remove([path]),
    DELETE_TIMEOUT_MS,
    'Removing the file timed out — check your connection and try again.',
  );

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
 * Signed URLs for MANY paths in ONE request.
 *
 * The batched sibling of `getSignedUrl`. Without it, anything rendering a grid of private images
 * pays a round trip per tile: `NoteMediaGallery` works around the gap with `Promise.all` over
 * singles, and the storage board would have done the same once every location could carry a photo.
 *
 * Returns a `path → url` map rather than an array, so a caller can look up by the value it already
 * holds. **Paths that fail are simply absent** rather than throwing: one unreadable photo must not
 * blank an entire board, and the callers all render a placeholder when a path has no URL.
 */
export async function getSignedUrls(
  paths: string[],
  expiresIn: number = 3600,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (paths.length === 0) return out;

  const supabase = getSupabase();
  const bucket = getStorageBucket();

  const { data, error } = await supabase.storage
    .from(bucket)
    .createSignedUrls(paths, expiresIn);

  if (error || !data) {
    console.error('Failed to create signed URLs:', error);
    return out;
  }

  for (const row of data) {
    if (row.path && row.signedUrl && !row.error) out.set(row.path, row.signedUrl);
  }
  return out;
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
