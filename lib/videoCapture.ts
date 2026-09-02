/**
 * Everything about recording a short clip that is not React.
 *
 * Split out from `VideoRecorderDialog` because all of it is decidable without a
 * camera: which container the browser can actually write, whether the surface is
 * offerable at all, and how a poster frame is made. jsdom has neither
 * `MediaRecorder` nor `getUserMedia`, so a component test can only assert that
 * the dialog asked — these functions are where the answers are tested.
 */

/**
 * What one finished recording hands back to the composer.
 *
 * Declared here rather than beside the dialog so the capture hook can name it
 * without importing a component — the hook is the consumer, and a hook reaching
 * into a component for a type is the wrong direction.
 */
export interface CapturedVideo {
  file: File;
  /** JPEG still for `note_media.thumbnail_path`. Null when the frame could not be read. */
  poster: Blob | null;
  /** OUR measurement — see `posterFromVideo` and the recorder's `onstop`. */
  durationSeconds: number;
  width: number;
  height: number;
  mimeType: string;
}

/**
 * The hard ceiling, and the reason this surface exists rather than a `capture`
 * file input. HTML Media Capture hands the phone's own camera app the recording
 * and takes no duration argument — iOS stops at its own 10-minute default — so a
 * two-minute rule can only be enforced by rejecting a clip after it was shot.
 * `MediaRecorder` can simply stop.
 */
export const MAX_RECORDING_MS = 120_000;

/**
 * 720p at 1.5 Mbit/s, which puts a full-length clip at roughly 23 MB.
 *
 * The number is chosen against the UPLOAD, not against what the phone can encode.
 * Operators are on personal phones on cellular inside a steel building, and the
 * `attachments` bucket inherits the project-wide 50 MB ceiling — a raw 1080p
 * capture of the same two minutes is 100–400 MB and clears neither bar. Tune here
 * if pilot footage reads too soft; nothing else depends on the value.
 */
export const VIDEO_BITS_PER_SECOND = 1_500_000;
export const AUDIO_BITS_PER_SECOND = 64_000;

/**
 * Containers we will write, best first.
 *
 * MP4 IS NOT A PREFERENCE, IT IS A COMPATIBILITY REQUIREMENT. These clips are read
 * back by office staff on a desktop, and Safari cannot play VP8/VP9 WebM at all —
 * an Android-recorded WebM would be a permanently unplayable file for a shop owner
 * on a Mac. iOS Safari has written H.264/AAC MP4 since 14.5, and Chrome writes it
 * on current versions, so the first entry is the common case on both phones.
 * WebM stays as the fallback because a playable-on-most is better than a refusal.
 */
export const RECORDER_MIME_CANDIDATES = [
  'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
  'video/mp4',
  'video/webm;codecs=vp8,opus',
  'video/webm',
] as const;

/** The constraints the camera is opened with. */
export const RECORDER_CONSTRAINTS: MediaStreamConstraints = {
  video: {
    facingMode: { ideal: 'environment' },
    width: { ideal: 1280 },
    height: { ideal: 720 },
    frameRate: { ideal: 30, max: 30 },
  },
  /**
   * NOISE SUPPRESSION IS OFF ON PURPOSE. It is tuned to treat steady machine noise
   * as the thing to remove, and on this surface that noise is the content — a
   * chattering tool or a bearing starting to go is exactly what the clip is being
   * taken to show. Echo cancellation stays on; it only affects a narrating voice.
   */
  audio: { echoCancellation: true, noiseSuppression: false },
};

/**
 * The first container this browser will actually write, or null if none.
 *
 * `isTypeSupported` is the only honest probe: support varies by OS version within
 * one browser name, so a UA test would be wrong on a phone we have never seen.
 */
export function pickRecorderMimeType(): string | null {
  if (typeof MediaRecorder === 'undefined') return null;
  for (const candidate of RECORDER_MIME_CANDIDATES) {
    try {
      if (MediaRecorder.isTypeSupported(candidate)) return candidate;
    } catch {
      /* A throwing probe is a no. */
    }
  }
  return null;
}

/**
 * Whether to offer video capture at all.
 *
 * Called before the control is rendered, not when it is tapped: a button that
 * always fails is worse than no button, and photos still work on a device that
 * cannot record. `getUserMedia` additionally needs a secure context, which is why
 * `mediaDevices` itself can be undefined rather than merely unhelpful.
 */
export function canRecordVideo(): boolean {
  if (typeof navigator === 'undefined') return false;
  if (typeof navigator.mediaDevices?.getUserMedia !== 'function') return false;
  return pickRecorderMimeType() !== null;
}

/** `.mp4` / `.webm`, so the stored object is named like what it contains. */
export function extensionForMimeType(mimeType: string): string {
  return mimeType.includes('mp4') ? 'mp4' : 'webm';
}

/**
 * A JPEG still of whatever the live preview is showing.
 *
 * THE FEED NEEDS THIS, and it is why `note_media.thumbnail_path` exists but has
 * never been written. Without a poster the gallery falls back to `storage_path`,
 * so painting a 72px thumbnail would pull the whole clip down a cellular link.
 * ~640px wide at q0.7 lands around 40 KB.
 *
 * Taken from the LIVE element rather than by decoding the recorded blob: seeking a
 * fresh MediaRecorder file is exactly where the broken-duration metadata bites,
 * and the frame is already on screen.
 */
export function posterFromVideo(
  video: HTMLVideoElement,
  maxWidth = 640,
): Promise<Blob | null> {
  const sourceWidth = video.videoWidth;
  const sourceHeight = video.videoHeight;
  if (!sourceWidth || !sourceHeight) return Promise.resolve(null);

  const scale = Math.min(1, maxWidth / sourceWidth);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(sourceWidth * scale);
  canvas.height = Math.round(sourceHeight * scale);

  const ctx = canvas.getContext('2d');
  if (!ctx) return Promise.resolve(null);

  try {
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  } catch {
    // A tainted or not-yet-painted frame is a missing poster, not a failed capture.
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    if (typeof canvas.toBlob !== 'function') {
      resolve(null);
      return;
    }
    canvas.toBlob((blob) => resolve(blob), 'image/jpeg', 0.7);
  });
}
