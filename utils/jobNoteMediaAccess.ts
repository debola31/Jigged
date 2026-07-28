import { getTypedSupabase as getSupabase } from '@/lib/supabase';
import {
  generateStoragePath,
  uploadFileToStorage,
  deleteFileFromStorage,
  getSignedUrl,
} from '@/utils/storageHelpers';
import type { JobNoteMedia } from '@/types/operator';

/**
 * Access layer for note media — photos (and, later, short videos) attached to a
 * `notes` entry. File bytes live in the private `attachments` storage bucket
 * under {companyId}/jobs/{jobId}/... (see utils/storageHelpers.ts, whose bucket
 * RLS already gates by the company folder); this module manages the `note_media`
 * metadata rows and ties the two together.
 *
 * The storage path still keys on the capturing job even for durable
 * part-subject notes: it is only a folder layout, and the company segment (which
 * is what the bucket RLS gates on) is unchanged. Repathing existing objects would
 * be a data migration with no functional benefit.
 *
 * Mirrors partAttachmentsAccess.ts. Heavy media work (compression, EXIF fix,
 * dimension reading) happens in the browser BEFORE these calls — they only see
 * an already-compressed File and upload it (Supabase-first, no FastAPI/ffmpeg).
 */

/** Signed-URL lifetime for feed thumbnails; long enough that an open feed won't 403. */
const MEDIA_URL_EXPIRY_SECONDS = 4 * 60 * 60;

const MEDIA_SELECT =
  'id, note_id, storage_path, thumbnail_path, kind, mime_type, width, height';

type MediaRow = {
  id: string;
  note_id: string;
  storage_path: string;
  thumbnail_path: string | null;
  kind: string;
  mime_type: string | null;
  width: number | null;
  height: number | null;
};

function rowToMedia(row: MediaRow): JobNoteMedia {
  return {
    id: row.id,
    note_id: row.note_id,
    storage_path: row.storage_path,
    thumbnail_path: row.thumbnail_path,
    kind: row.kind === 'video' ? 'video' : 'photo',
    mime_type: row.mime_type,
    width: row.width,
    height: row.height,
  };
}

/**
 * Attach one (already-compressed) photo to a job note. Uploads to
 * {companyId}/jobs/{jobId}/... then records the metadata row. Rolls back the
 * storage object if the row insert fails so a failed attach never leaks an
 * orphaned file. `dims` (the compressed image's pixel size) is optional.
 */
export async function addJobNoteMedia(
  companyId: string,
  jobId: string,
  noteId: string,
  file: File,
  opts?: { dims?: { width: number; height: number }; thumbnail?: File },
): Promise<JobNoteMedia> {
  const supabase = getSupabase();
  const storagePath = generateStoragePath(companyId, 'jobs', jobId, file.name);
  await uploadFileToStorage(storagePath, file);

  // The thumbnail is an optimisation, so a failure here must not cost the photo.
  // Upload it best-effort and fall back to a null thumbnail_path — the renderers
  // already fall back to storage_path, which is today's behaviour for every row.
  let thumbnailPath: string | null = null;
  if (opts?.thumbnail) {
    const candidate = generateStoragePath(companyId, 'jobs', jobId, opts.thumbnail.name);
    try {
      await uploadFileToStorage(candidate, opts.thumbnail);
      thumbnailPath = candidate;
    } catch {
      thumbnailPath = null;
    }
  }

  const { data, error } = await supabase
    .from('note_media')
    .insert({
      company_id: companyId,
      note_id: noteId,
      storage_path: storagePath,
      thumbnail_path: thumbnailPath,
      kind: 'photo',
      mime_type: file.type || null,
      size_bytes: file.size,
      width: opts?.dims?.width ?? null,
      height: opts?.dims?.height ?? null,
    })
    .select(MEDIA_SELECT)
    .single();

  if (error) {
    // Roll back BOTH orphaned uploads so a failed insert doesn't leak files.
    await deleteFileFromStorage(storagePath).catch(() => {});
    if (thumbnailPath) await deleteFileFromStorage(thumbnailPath).catch(() => {});
    console.error('Error inserting job note media:', error);
    throw new Error('Failed to attach the photo. Please try again.');
  }

  return rowToMedia(data as unknown as MediaRow);
}

/** A fresh, time-limited URL for rendering a photo/thumbnail in the feed. */
export function getJobNoteMediaUrl(storagePath: string): Promise<string> {
  return getSignedUrl(storagePath, MEDIA_URL_EXPIRY_SECONDS);
}

/**
 * Delete one media item: remove the metadata row first, then the stored file.
 * Row-first (matches partAttachments): a failed file delete after the row is
 * gone leaks an *invisible* orphan (cleanable later) rather than a *visible* row
 * that 404s. RLS restricts the row delete to the parent note's author or an admin.
 */
export async function deleteJobNoteMedia(media: {
  id: string;
  storage_path: string;
  thumbnail_path?: string | null;
}): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase.from('note_media').delete().eq('id', media.id);
  if (error) {
    console.error('Error deleting job note media row:', error);
    throw error;
  }
  // Both objects, or the thumbnail outlives the row it belonged to.
  for (const path of [media.storage_path, media.thumbnail_path]) {
    if (!path) continue;
    await deleteFileFromStorage(path).catch((err) =>
      console.warn('Failed to delete media file after row delete:', err),
    );
  }
}

/**
 * Delete a whole note and clean up its media files. The job_note_media rows
 * cascade away with the note, so read the storage paths FIRST (while the rows
 * still exist), delete the note, then best-effort remove the orphaned files.
 * RLS restricts the note delete to its author or a company admin.
 */
export async function deleteJobNote(noteId: string): Promise<void> {
  const supabase = getSupabase();

  // Read media storage paths before the cascade removes the rows.
  let paths: string[] = [];
  const { data: mediaRows, error: listError } = await supabase
    .from('note_media')
    .select('storage_path, thumbnail_path')
    .eq('note_id', noteId);
  if (listError) {
    console.warn('Could not list note media for cleanup:', listError);
  } else {
    paths = ((mediaRows ?? []) as Array<{ storage_path: string; thumbnail_path: string | null }>)
      .flatMap((r) => [r.storage_path, r.thumbnail_path])
      .filter((p): p is string => Boolean(p));
  }

  const { error } = await supabase.from('notes').delete().eq('id', noteId);
  if (error) {
    console.error('Error deleting job note:', error);
    throw error;
  }

  for (const path of paths) {
    await deleteFileFromStorage(path).catch((err) =>
      console.warn('Failed to delete media file after note delete:', err),
    );
  }
}
