import { getSupabase } from '@/lib/supabase';
import { assertDeleted, toFriendlyError } from '@/lib/supabaseErrors';
import {
  generateStoragePath,
  uploadFileToStorage,
  deleteFileFromStorage,
  getSignedUrl,
} from '@/utils/storageHelpers';
import type { StorageEntityType } from '@/utils/storageHelpers';
import type { JobNoteMedia } from '@/types/operator';

/**
 * Access layer for note media — photos and short videos attached to a `notes`
 * entry. File bytes live in the private `attachments` storage bucket
 * under {companyId}/{entityType}/{entityId}/... (see utils/storageHelpers.ts,
 * whose bucket RLS already gates by the company folder); this module manages the
 * `note_media` metadata rows and ties the two together.
 *
 * The storage path still keys on the capturing job even for durable
 * part-subject notes: it is only a folder layout, and the company segment (which
 * is what the bucket RLS gates on) is unchanged. Repathing existing objects would
 * be a data migration with no functional benefit. A machine-subject note has no
 * job at all, so it files under work-centers instead — the same reasoning, not an
 * exception to it.
 *
 * Mirrors partAttachmentsAccess.ts. Heavy media work (compression, EXIF fix,
 * dimension reading, and for a clip the encode itself and its poster frame)
 * happens in the browser BEFORE these calls — they only see a File that is already
 * the size it will be stored at, and upload it (Supabase-first, no FastAPI/ffmpeg).
 * A video is never re-encoded here: the recorder's bitrate IS the compression pass.
 */

/** Signed-URL lifetime for feed thumbnails; long enough that an open feed won't 403. */
const MEDIA_URL_EXPIRY_SECONDS = 4 * 60 * 60;

const MEDIA_SELECT =
  'id, note_id, storage_path, thumbnail_path, kind, mime_type, width, height, duration_seconds';

type MediaRow = {
  id: string;
  note_id: string;
  storage_path: string;
  thumbnail_path: string | null;
  kind: string;
  mime_type: string | null;
  width: number | null;
  height: number | null;
  duration_seconds: number | null;
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
    duration_seconds: row.duration_seconds,
  };
}

/**
 * One file already in the bucket, waiting for a note to belong to.
 *
 * AN OBJECT RATHER THAN POSITIONAL ARGUMENTS because video needs three more facts
 * than a photo does, and threading `(…, dims, kind, durationSeconds, thumbnailPath)`
 * through three call sites is how a caller ends up passing a duration as a width.
 * The union keeps the video-only fields off the photo shape entirely.
 */
export type UploadedMedia =
  | {
      kind: 'photo';
      storagePath: string;
      file: File;
      dims?: { width: number; height: number };
    }
  | {
      kind: 'video';
      storagePath: string;
      file: File;
      dims?: { width: number; height: number };
      /** Poster key. Null when the frame could not be grabbed — the gallery copes. */
      thumbnailPath: string | null;
      durationSeconds: number;
    };

/**
 * Put one already-sized file — a compressed photo, a recorded clip, or a clip's poster — in the
 * bucket and return where it landed.
 *
 * SPLIT FROM THE ROW INSERT ON PURPOSE, and the split is the whole point of #624. The bytes are
 * the slow, failure-prone half; the row is a fast local write. Keeping them in one function forced
 * every caller to have a note row already, so a stalled upload on shop wifi left a note claiming
 * to be saved with the photo it was taken for missing. Callers now upload first and commit second.
 *
 * NOTE THAT THE PATH NEVER CONTAINED THE NOTE ID — it keys on the job or the work center — so this
 * needs nothing that does not exist before the note does. That is what made the reorder possible.
 *
 * The folder is a caller decision because a machine-subject note has no job to file under; its
 * photos live beside the machine. The company segment, which is the only one the bucket RLS reads,
 * is unchanged either way.
 */
export async function uploadNoteMediaFile(
  companyId: string,
  file: File,
  folder: { entityType: StorageEntityType; entityId: string },
): Promise<string> {
  const storagePath = generateStoragePath(
    companyId,
    folder.entityType,
    folder.entityId,
    file.name,
  );
  await uploadFileToStorage(storagePath, file);
  return storagePath;
}

/**
 * Drop photos that reached the bucket before a later step of the same save failed.
 *
 * The counterpart to uploading before committing: if the note write or a row insert fails, the
 * bytes already up would otherwise be orphans. Best-effort and NEVER THROWS — the caller is already
 * on its way to reporting a real failure, and replacing that message with "cleanup failed" would
 * tell the operator about our problem instead of theirs. A missed sweep leaves an unreferenced
 * object, which is invisible and cheap — the same trade `deleteJobNoteMedia` already makes.
 */
export async function discardNoteMediaUploads(storagePaths: string[]): Promise<void> {
  await Promise.all(
    storagePaths.map((path) =>
      deleteFileFromStorage(path).catch((err) =>
        console.warn('Failed to discard an uploaded photo after a failed save:', err),
      ),
    ),
  );
}

/**
 * Record the metadata row for a file already in the bucket. Rolls the object back if the insert
 * fails, so a failed attach never leaks an orphan.
 */
export async function insertNoteMedia(
  companyId: string,
  noteId: string,
  upload: UploadedMedia,
): Promise<JobNoteMedia> {
  const supabase = getSupabase();
  const isVideo = upload.kind === 'video';
  const thumbnailPath = isVideo ? upload.thumbnailPath : null;

  const { data, error } = await supabase
    .from('note_media')
    .insert({
      company_id: companyId,
      note_id: noteId,
      storage_path: upload.storagePath,
      thumbnail_path: thumbnailPath,
      kind: upload.kind,
      mime_type: upload.file.type || null,
      size_bytes: upload.file.size,
      width: upload.dims?.width ?? null,
      height: upload.dims?.height ?? null,
      duration_seconds: isVideo ? upload.durationSeconds : null,
    })
    .select(MEDIA_SELECT)
    .single();

  if (error) {
    // Roll back the orphaned upload so a failed insert doesn't leak a file. The
    // poster goes with it — it exists only to stand for this row.
    await deleteFileFromStorage(upload.storagePath).catch(() => {});
    if (thumbnailPath) await deleteFileFromStorage(thumbnailPath).catch(() => {});
    console.error('Error inserting note media:', error);
    throw new Error(
      isVideo
        ? 'Failed to attach the video. Please try again.'
        : 'Failed to attach the photo. Please try again.',
    );
  }

  return rowToMedia(data as unknown as MediaRow);
}

/**
 * Upload and record in one step, for callers that already hold a note row and are not carrying the
 * two halves themselves. The composer deliberately does NOT use this — see `uploadNoteMediaFile`.
 */
export async function addNoteMedia(
  companyId: string,
  noteId: string,
  file: File,
  opts: {
    folder: { entityType: StorageEntityType; entityId: string };
    dims?: { width: number; height: number };
  },
): Promise<JobNoteMedia> {
  const storagePath = await uploadNoteMediaFile(companyId, file, opts.folder);
  // Photo-only by design: this one-step helper is for callers that already hold a
  // note, and video never arrives that way — the composer stages a clip and its
  // poster together, which is exactly the two-half path below.
  return insertNoteMedia(companyId, noteId, { kind: 'photo', storagePath, file, dims: opts.dims });
}

/**
 * Upload half of `addJobNoteMedia`, for the composer's upload-then-commit order. Only the folder
 * choice differs between a job photo and a machine photo, so that is all the two halves split on —
 * `insertNoteMedia` is shared.
 */
export function uploadJobNoteMediaFile(
  companyId: string,
  jobId: string,
  file: File,
): Promise<string> {
  return uploadNoteMediaFile(companyId, file, { entityType: 'jobs', entityId: jobId });
}

/**
 * Attach a photo to a note captured on a job. Files under the capturing job even
 * when the note's SUBJECT is a part — see the header: the folder is layout, not
 * meaning, and repathing existing objects would be a data migration that bought
 * nothing.
 */
export function addJobNoteMedia(
  companyId: string,
  jobId: string,
  noteId: string,
  file: File,
  opts?: { dims?: { width: number; height: number } },
): Promise<JobNoteMedia> {
  return addNoteMedia(companyId, noteId, file, {
    folder: { entityType: 'jobs', entityId: jobId },
    dims: opts?.dims,
  });
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
  /** Optional so existing photo call sites need no change; a video always has one. */
  thumbnail_path?: string | null;
}): Promise<void> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('note_media')
    .delete()
    .eq('id', media.id)
    .select('id');
  if (error) {
    console.error('Error deleting job note media row:', error);
    throw toFriendlyError(error, { entity: 'photo' });
  }
  assertDeleted(data, 'photo');
  // Both objects, not just the clip: a poster whose row is gone is an orphan
  // nothing will ever name again.
  for (const path of [media.storage_path, media.thumbnail_path ?? null]) {
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
    // Posters included — the cascade takes the rows, so this is the last moment
    // anything knows a video's thumbnail existed.
    paths = ((mediaRows ?? []) as Array<{ storage_path: string; thumbnail_path: string | null }>)
      .flatMap((r) => [r.storage_path, r.thumbnail_path])
      .filter((p): p is string => !!p);
  }

  const { data, error } = await supabase
    .from('notes')
    .delete()
    .eq('id', noteId)
    .select('id');
  if (error) {
    console.error('Error deleting job note:', error);
    throw toFriendlyError(error, { entity: 'note' });
  }
  assertDeleted(data, 'note');

  for (const path of paths) {
    await deleteFileFromStorage(path).catch((err) =>
      console.warn('Failed to delete media file after note delete:', err),
    );
  }
}
