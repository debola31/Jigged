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
 * Compression is the OTHER way the composer can hang: it precedes every upload, and a worker that
 * never reports back leaves the same endless "Saving…" as a stalled request. Unlike the upload,
 * this one cancels for real — browser-image-compression takes an AbortSignal.
 *
 * Generous, because the budget is CPU rather than network: a 12 MP photo on an old phone is a few
 * seconds, so 30 s only fires when something is genuinely wrong.
 */
const COMPRESSION_TIMEOUT_MS = 30_000;

/**
 * Fresh per call — a module-level signal would start its clock at import and be shared by every
 * photo. Guarded because `AbortSignal.timeout` needs Safari 16+, and operators are on their own
 * phones of unknown vintage: on an older one we lose the deadline, which is where we already are,
 * rather than losing the ability to attach a photo at all.
 */
function compressionSignal(): AbortSignal | undefined {
  return typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(COMPRESSION_TIMEOUT_MS)
    : undefined;
}

export interface PreparedPhoto {
  file: File;
  dims?: { width: number; height: number };
}

function renameToJpg(name: string): string {
  const dot = name.lastIndexOf('.');
  const base = (dot === -1 ? name : name.slice(0, dot)).trim();
  return `${base || 'photo'}.jpg`;
}

/** Compress + downscale a captured image and read its final pixel dimensions. */
export async function compressPhoto(input: File): Promise<PreparedPhoto> {
  const compressed = await imageCompression(input, {
    ...PHOTO_COMPRESSION_OPTIONS,
    signal: compressionSignal(),
  });

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

  return { file, dims };
}
