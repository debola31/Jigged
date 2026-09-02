import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  RECORDER_CONSTRAINTS,
  MAX_RECORDING_MS,
  canRecordVideo,
  extensionForMimeType,
  pickRecorderMimeType,
  posterFromVideo,
} from '@/lib/videoCapture';

/**
 * The recorder's decisions, tested where they can be tested.
 *
 * jsdom has no MediaRecorder and no getUserMedia, so a component test can only ever
 * assert that the dialog ASKED for a camera. Everything that decides what gets
 * written — which container, whether to offer the control at all — lives in this
 * module for exactly that reason, and this is where those choices are pinned.
 */

type MimeProbe = (type: string) => boolean;

/** Install a fake MediaRecorder whose `isTypeSupported` answers however a test wants. */
function stubMediaRecorder(isTypeSupported: MimeProbe): void {
  (globalThis as unknown as { MediaRecorder: unknown }).MediaRecorder = { isTypeSupported };
}

function removeMediaRecorder(): void {
  delete (globalThis as unknown as { MediaRecorder?: unknown }).MediaRecorder;
}

afterEach(() => {
  removeMediaRecorder();
  vi.unstubAllGlobals();
});

describe('pickRecorderMimeType', () => {
  it('prefers MP4 over WebM when the browser will write both', () => {
    stubMediaRecorder(() => true);
    // THE ORDERING IS THE POINT, and it is the property most likely to regress: the
    // candidate list is trivially reorderable and nothing else would notice.
    // Safari cannot play VP8 WebM at all, and these clips are read back by office
    // staff on a Mac — so a WebM recorded on an Android phone would be a permanently
    // unplayable file for the person it was recorded FOR.
    expect(pickRecorderMimeType()).toBe('video/mp4;codecs=avc1.42E01E,mp4a.40.2');
  });

  it('falls back to WebM rather than refusing when MP4 is unavailable', () => {
    stubMediaRecorder((type) => type.startsWith('video/webm'));
    expect(pickRecorderMimeType()).toBe('video/webm;codecs=vp8,opus');
  });

  it('takes plain video/mp4 when the explicit codec string is rejected', () => {
    stubMediaRecorder((type) => type === 'video/mp4');
    expect(pickRecorderMimeType()).toBe('video/mp4');
  });

  it('is null when nothing is supported', () => {
    stubMediaRecorder(() => false);
    expect(pickRecorderMimeType()).toBeNull();
  });

  it('is null rather than throwing when MediaRecorder does not exist', () => {
    removeMediaRecorder();
    expect(pickRecorderMimeType()).toBeNull();
  });

  it('treats a probe that throws as a no', () => {
    stubMediaRecorder(() => {
      throw new Error('nope');
    });
    expect(pickRecorderMimeType()).toBeNull();
  });
});

describe('canRecordVideo', () => {
  it('is false when the browser has no MediaRecorder, so the button never renders', () => {
    // The whole point of deciding this BEFORE render: a control that can only fail is
    // worse than no control, and photos still work on such a device. It is also what
    // keeps every other test suite green — under bare jsdom this is false.
    removeMediaRecorder();
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: () => Promise.resolve() } });
    expect(canRecordVideo()).toBe(false);
  });

  it('is false when mediaDevices is missing, which is what an insecure context looks like', () => {
    stubMediaRecorder(() => true);
    vi.stubGlobal('navigator', {});
    expect(canRecordVideo()).toBe(false);
  });

  it('is true when both the recorder and a supported container are present', () => {
    stubMediaRecorder(() => true);
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: () => Promise.resolve() } });
    expect(canRecordVideo()).toBe(true);
  });
});

describe('extensionForMimeType', () => {
  it('names the file after what is actually inside it', () => {
    expect(extensionForMimeType('video/mp4;codecs=avc1.42E01E,mp4a.40.2')).toBe('mp4');
    expect(extensionForMimeType('video/mp4')).toBe('mp4');
    expect(extensionForMimeType('video/webm;codecs=vp8,opus')).toBe('webm');
  });
});

describe('the recording constraints', () => {
  it('asks for the rear camera and for audio', () => {
    const video = RECORDER_CONSTRAINTS.video as MediaTrackConstraints;
    expect(video.facingMode).toEqual({ ideal: 'environment' });
    // Audio is a product decision, not an accident: a chattering tool is diagnosed
    // by sound, and an operator narrating is much of a clip's value.
    expect(RECORDER_CONSTRAINTS.audio).toBeTruthy();
  });

  it('leaves machine noise alone', () => {
    const audio = RECORDER_CONSTRAINTS.audio as MediaTrackConstraints;
    // Noise suppression is tuned to remove steady machine noise, which on this
    // surface IS the content. Turning it on would erase the reason for the clip.
    expect(audio.noiseSuppression).toBe(false);
  });

  it('caps recording at two minutes', () => {
    expect(MAX_RECORDING_MS).toBe(120_000);
  });
});

describe('posterFromVideo', () => {
  it('is null when the video has no frame yet, rather than a blank poster', () => {
    const video = { videoWidth: 0, videoHeight: 0 } as HTMLVideoElement;
    return expect(posterFromVideo(video)).resolves.toBeNull();
  });

  it('is null when a 2D context cannot be had, so a missing poster is never fatal', async () => {
    const video = { videoWidth: 1280, videoHeight: 720 } as HTMLVideoElement;
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    await expect(posterFromVideo(video)).resolves.toBeNull();
  });

  it('draws the frame scaled down and hands back a JPEG', async () => {
    const video = { videoWidth: 1280, videoHeight: 720 } as HTMLVideoElement;
    const drawImage = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawImage,
    } as unknown as CanvasRenderingContext2D);
    const blob = new Blob(['x'], { type: 'image/jpeg' });
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((cb) => cb(blob));

    await expect(posterFromVideo(video, 640)).resolves.toBe(blob);
    // Scaled to the 640px budget — the poster exists so a feed never fetches the
    // whole clip to paint a thumbnail, so its size is the whole point.
    const canvas = drawImage.mock.calls[0][0] === video ? drawImage.mock.calls[0] : null;
    expect(canvas).not.toBeNull();
    expect(drawImage).toHaveBeenCalledWith(video, 0, 0, 640, 360);
  });
});
