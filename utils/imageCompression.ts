import imageCompression from 'browser-image-compression';

/**
 * Client-only photo preparation for the operator job feed.
 *
 * Shop-floor tablets/phones produce 4–12 MB photos; raw uploads crush floor
 * wifi. We downscale to ~2048px on the long edge and re-encode to JPEG before
 * upload (typically 5–10× smaller). Re-encoding through the library's canvas
 * pipeline also bakes EXIF orientation into the pixels, so iPhone photos don't
 * render sideways, and normalizes HEIC to JPEG. Compression runs in a Web Worker
 * (useWebWorker) so the UI doesn't jank.
 *
 * Import only from client components — browser-image-compression uses canvas /
 * Web Workers and has no Node fallback.
 */
const PHOTO_COMPRESSION_OPTIONS = {
  maxWidthOrHeight: 2048,
  maxSizeMB: 1.5,
  initialQuality: 0.8,
  useWebWorker: true,
  fileType: 'image/jpeg' as const,
};

/**
 * Thumbnail variant. Feed tiles render at 76px, so 320px covers a 3–4× DPR
 * screen with room to spare.
 *
 * This exists because `job_note_media.thumbnail_path` was never populated, so
 * every renderer fell back to `storage_path` — pulling a full 2048px JPEG for a
 * 76px tile. On shop wifi those tiles resolve slowly or not at all, and a tile
 * that never resolves is indistinguishable from a photo that failed to upload.
 * That is the "my photos didn't upload" report, from the read side.
 */
const THUMBNAIL_COMPRESSION_OPTIONS = {
  maxWidthOrHeight: 320,
  maxSizeMB: 0.06,
  initialQuality: 0.7,
  useWebWorker: true,
  fileType: 'image/jpeg' as const,
};

export interface PreparedPhoto {
  file: File;
  /** Small variant for feed tiles. Undefined if generation failed — see below. */
  thumbnail?: File;
  dims?: { width: number; height: number };
}

function renameToJpg(name: string): string {
  const dot = name.lastIndexOf('.');
  const base = (dot === -1 ? name : name.slice(0, dot)).trim();
  return `${base || 'photo'}.jpg`;
}

/** Compress + downscale a captured image and read its final pixel dimensions. */
export async function compressPhoto(input: File): Promise<PreparedPhoto> {
  const compressed = await imageCompression(input, PHOTO_COMPRESSION_OPTIONS);

  // Normalize to a File with a .jpg name and image/jpeg type regardless of what
  // the library returns (File or Blob, original extension).
  const lower = compressed.name?.toLowerCase() ?? '';
  const file =
    compressed instanceof File && (lower.endsWith('.jpg') || lower.endsWith('.jpeg'))
      ? compressed
      : new File([compressed], renameToJpg(input.name), { type: 'image/jpeg' });

  let dims: { width: number; height: number } | undefined;
  try {
    const bmp = await createImageBitmap(file);
    dims = { width: bmp.width, height: bmp.height };
    bmp.close();
  } catch {
    dims = undefined;
  }

  // Derived from the already-downscaled file rather than the original: cheaper,
  // and it inherits the EXIF-orientation bake-in from the first pass.
  //
  // Best-effort by design. A thumbnail is an optimisation, and failing to make
  // one must never cost the operator the actual photo — the caller falls back to
  // the full image, which is exactly today's behaviour.
  let thumbnail: File | undefined;
  try {
    const small = await imageCompression(file, THUMBNAIL_COMPRESSION_OPTIONS);
    thumbnail = new File([small], renameToJpg(`thumb-${input.name}`), {
      type: 'image/jpeg',
    });
  } catch {
    thumbnail = undefined;
  }

  return { file, thumbnail, dims };
}
