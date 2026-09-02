'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import IconButton from '@mui/material/IconButton';
import LinearProgress from '@mui/material/LinearProgress';
import Typography from '@mui/material/Typography';
import CloseIcon from '@mui/icons-material/Close';
import FiberManualRecordIcon from '@mui/icons-material/FiberManualRecord';
import StopIcon from '@mui/icons-material/Stop';
import { formatStopwatch } from '@/lib/duration';
import {
  AUDIO_BITS_PER_SECOND,
  MAX_RECORDING_MS,
  MAX_RECORDING_MS as CAP_MS,
  RECORDER_CONSTRAINTS,
  VIDEO_BITS_PER_SECOND,
  extensionForMimeType,
  pickRecorderMimeType,
  posterFromVideo,
} from '@/lib/videoCapture';
import type { CapturedVideo } from '@/lib/videoCapture';

type Phase = 'requesting' | 'ready' | 'recording' | 'error';

/** How long after the first frame the poster is grabbed. */
const POSTER_DELAY_MS = 500;
/** Countdown repaint interval. Fast enough to read as running, slow enough to cost nothing. */
const TICK_MS = 200;

/**
 * One `dataavailable` per second, which is what makes the byte budget below possible
 * — without a timeslice the recorder hands everything over in a single blob at stop,
 * far too late to act on.
 */
const CHUNK_MS = 1000;

/**
 * Stop early rather than upload something the bucket will refuse.
 *
 * The bitrate settings put two minutes at roughly 23 MB, so this is headroom against a
 * handset that treats them as a suggestion — not a routine limit. It matters because
 * the `attachments` bucket inherits the project-wide ceiling, so an oversized clip
 * fails at the END of a multi-minute cellular upload, which is the worst moment
 * available.
 */
const MAX_CLIP_BYTES = 45 * 1024 * 1024;

/**
 * Why a camera error says what it says. `getUserMedia` rejections are the one place
 * an operator can actually fix the problem themselves, so each name gets its own
 * sentence rather than a shared "couldn't start the camera".
 */
function messageForCameraError(err: unknown): string {
  const name = err instanceof Error ? err.name : '';
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      // Same sentence shape as LocationScanner's, which is already shipped on this
      // surface — one condition should not have two phrasings in one app. Widened to
      // name the microphone, because getUserMedia is all-or-nothing: refusing either
      // device produces this one rejection, and an operator told only about the camera
      // would go and find it already allowed.
      return 'Camera and microphone access was blocked. Allow them for this site in your browser settings, then try again.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'No camera was found on this device.';
    case 'NotReadableError':
    case 'AbortError':
      return 'The camera is in use by another app. Close it and try again.';
    default:
      return 'The camera could not be started. Try again.';
  }
}

/**
 * Record a short clip inside Jigged, capped at two minutes.
 *
 * WHY THIS EXISTS RATHER THAN A `capture` FILE INPUT. Handing the recording to the
 * phone's camera app costs both halves of the requirement: HTML Media Capture takes
 * no duration argument (iOS runs to its own 10-minute default) and no bitrate
 * argument, so two minutes of 1080p arrives as 100-400 MB — over the bucket ceiling
 * and hopeless on shop cellular. `MediaRecorder` stops itself at 2:00 and encodes at
 * a size that uploads.
 *
 * NO REVIEW STEP, deliberately. Stopping closes the dialog and appends the clip to
 * the composer's pending strip, exactly as a photo does, and the strip's remove-X is
 * the undo. A staged clip has not been uploaded yet, so discarding it is free — a
 * confirm screen would buy nothing and cost a tap on a surface where taps are
 * expensive.
 *
 * THE COUNTDOWN IS ABOUT THE RECORDING, NOT THE PERSON. It describes the clip in
 * front of the operator and resets every time; nothing here accumulates across jobs.
 * See the surveillance guardrail in docs/modules/operator-view.md before adding any
 * number to this screen.
 */
export default function VideoRecorderDialog({
  open,
  onClose,
  onCaptured,
}: {
  open: boolean;
  onClose: () => void;
  onCaptured: (video: CapturedVideo) => void;
}) {
  const [phase, setPhase] = useState<Phase>('requesting');
  const [error, setError] = useState<string | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const posterRef = useRef<Blob | null>(null);
  /**
   * When `onstart` fired, or null before it has. NULL RATHER THAN 0 as the "not
   * started" sentinel: `performance.now()` can legitimately return 0, and a zero
   * treated as "not started yet" silently stops the countdown from ever running.
   */
  const startedAtRef = useRef<number | null>(null);
  const bytesRef = useRef(0);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const posterTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * Set the moment a stop is requested for any reason. `onstop` is asynchronous and
   * the auto-stop, the STOP button and a backgrounded tab can all reach it — this is
   * what stops a second stop from firing `onCaptured` twice.
   */
  const finishedRef = useRef(false);

  const clearTimers = useCallback(() => {
    if (tickRef.current) clearInterval(tickRef.current);
    if (posterTimerRef.current) clearTimeout(posterTimerRef.current);
    tickRef.current = null;
    posterTimerRef.current = null;
  }, []);

  /**
   * Release the camera. Called from every exit path there is — stop, cancel, close,
   * unmount, and the tab going to the background. A held camera on a phone is a
   * visible, battery-burning bug, and on iOS a stream that outlives its page is how
   * the NEXT recording fails with NotReadableError.
   */
  const teardown = useCallback(() => {
    clearTimers();
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== 'inactive') {
      try {
        recorder.stop();
      } catch {
        /* Already stopping. */
      }
    }
    recorderRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, [clearTimers]);

  // Acquire the camera when the dialog opens, and hand it back when it closes.
  useEffect(() => {
    if (!open) return;

    let cancelled = false;
    finishedRef.current = false;
    chunksRef.current = [];
    posterRef.current = null;
    setElapsedMs(0);
    setError(null);
    setPhase('requesting');

    navigator.mediaDevices
      .getUserMedia(RECORDER_CONSTRAINTS)
      .then((stream) => {
        // The dialog closed while the permission sheet was up: hand the camera
        // straight back rather than leaking a live stream nothing will render.
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          // Autoplay of a muted inline stream is allowed; a rejection here is not
          // actionable and must not replace the preview with an error.
          void videoRef.current.play().catch(() => {});
        }
        setPhase('ready');
      })
      .catch((err) => {
        if (cancelled) return;
        setError(messageForCameraError(err));
        setPhase('error');
      });

    return () => {
      cancelled = true;
      teardown();
    };
  }, [open, teardown]);

  const stop = useCallback(() => {
    if (finishedRef.current) return;
    finishedRef.current = true;
    clearTimers();

    const recorder = recorderRef.current;
    if (!recorder || recorder.state === 'inactive') {
      teardown();
      onClose();
      return;
    }
    // `onstop` does the handing-back; this only asks for it.
    try {
      recorder.stop();
    } catch {
      teardown();
      onClose();
    }
  }, [clearTimers, onClose, teardown]);

  const start = useCallback(() => {
    const stream = streamRef.current;
    const mimeType = pickRecorderMimeType();
    if (!stream || !mimeType) {
      setError('This device cannot record video in a format Jigged can store.');
      setPhase('error');
      return;
    }

    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream, {
        mimeType,
        videoBitsPerSecond: VIDEO_BITS_PER_SECOND,
        audioBitsPerSecond: AUDIO_BITS_PER_SECOND,
      });
    } catch {
      setError('This device cannot record video in a format Jigged can store.');
      setPhase('error');
      return;
    }

    recorderRef.current = recorder;
    chunksRef.current = [];
    bytesRef.current = 0;

    recorder.ondataavailable = (event) => {
      if (!event.data || event.data.size === 0) return;
      chunksRef.current.push(event.data);
      bytesRef.current += event.data.size;
      if (bytesRef.current >= MAX_CLIP_BYTES) stop();
    };

    /**
     * A recorder that dies mid-clip is usually the phone running out of storage. Keep
     * what was captured if there is anything — `stop()` runs the same `onstop` path —
     * and only report a failure when there is genuinely nothing to keep.
     */
    recorder.onerror = () => {
      if (chunksRef.current.length > 0) {
        stop();
        return;
      }
      finishedRef.current = true;
      teardown();
      setError('Recording stopped — your phone may be low on storage.');
      setPhase('error');
    };

    recorder.onstop = () => {
      /**
       * DURATION IS OUR NUMBER, NOT THE FILE'S. A blob straight out of MediaRecorder
       * routinely reports `duration` as Infinity or 0 — the container is written
       * without a duration box because the recorder never knew the length in advance.
       * That is precisely why `note_media.duration_seconds` is a column: we timed it.
       */
      const startedAt = startedAtRef.current;
      const recordedMs = startedAt === null ? 0 : Math.min(performance.now() - startedAt, CAP_MS);
      /**
       * THE BLOB AND THE FILE CARRY THE BASE TYPE, not the full codecs string.
       * `supabase.storage.upload()` derives Content-Type from `file.type`, and a
       * stored object served as anything Safari does not recognise simply will not
       * play from a signed URL. The codecs string is still worth keeping — it says
       * which handset produced what — so it goes to `note_media.mime_type` instead.
       */
      const baseType = mimeType.split(';')[0];
      const blob = new Blob(chunksRef.current, { type: baseType });
      chunksRef.current = [];

      const width = videoRef.current?.videoWidth ?? 0;
      const height = videoRef.current?.videoHeight ?? 0;

      teardown();

      // A zero-byte result is a failed recording, not an empty one — never post it.
      if (blob.size === 0) {
        setError('That recording came back empty. Try again.');
        setPhase('error');
        finishedRef.current = false;
        return;
      }

      onCaptured({
        file: new File([blob], `clip.${extensionForMimeType(mimeType)}`, { type: baseType }),
        poster: posterRef.current,
        durationSeconds: Math.max(1, Math.round(recordedMs / 1000)),
        width,
        height,
        mimeType,
      });
      onClose();
    };

    /**
     * The clock starts in `onstart`, NOT here. Permission plumbing, pipeline warm-up
     * and the first keyframe all sit between this call and the first recorded frame,
     * and they are real milliseconds — charging them to the clip makes every stored
     * duration read slightly long. Zero until then, and the tick below ignores zero.
     */
    startedAtRef.current = null;
    recorder.onstart = () => {
      startedAtRef.current = performance.now();
    };

    setElapsedMs(0);
    setPhase('recording');
    recorder.start(CHUNK_MS);

    // The poster is grabbed just after the first frames rather than at stop: by the
    // time an operator taps STOP the phone is usually already coming down, and a
    // thumbnail of the floor names nothing in the feed.
    posterTimerRef.current = setTimeout(() => {
      if (!videoRef.current) return;
      void posterFromVideo(videoRef.current).then((blob) => {
        posterRef.current = blob;
      });
    }, POSTER_DELAY_MS);

    tickRef.current = setInterval(() => {
      const startedAt = startedAtRef.current;
      if (startedAt === null) return;
      const ms = performance.now() - startedAt;
      setElapsedMs(ms);
      if (ms >= CAP_MS) stop();
    }, TICK_MS);
  }, [onCaptured, onClose, stop, teardown]);

  /**
   * iOS suspends a backgrounded page's media stream, which turns a still-running
   * recording into a truncated or empty file. Stopping on hide keeps whatever was
   * recorded up to that point instead — a short clip beats a corrupt one.
   */
  useEffect(() => {
    if (phase !== 'recording') return;
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') stop();
    };
    // `pagehide` as well as `visibilitychange`: iOS does not fire `beforeunload`
    // dependably, and `pagehide` is the one that arrives on a Safari tab switch and
    // on app suspension. Both funnel into the same idempotent stop.
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', stop);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', stop);
    };
  }, [phase, stop]);

  const cancel = useCallback(() => {
    finishedRef.current = true;
    teardown();
    onClose();
  }, [onClose, teardown]);

  const remainingMs = Math.max(0, MAX_RECORDING_MS - elapsedMs);
  const recording = phase === 'recording';

  return (
    <Dialog
      open={open}
      // Never dismissable by backdrop while the camera is live: a stray tap must not
      // throw away a recording in progress.
      onClose={recording ? undefined : cancel}
      fullScreen
    >
      <Box
        sx={{
          position: 'relative',
          height: '100%',
          bgcolor: 'common.black',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <IconButton
          aria-label="Close"
          onClick={cancel}
          disabled={recording}
          sx={{
            position: 'absolute',
            top: 12,
            right: 12,
            zIndex: 2,
            width: 48,
            height: 48,
            color: 'common.white',
            bgcolor: 'rgba(0,0,0,0.45)',
            '&:hover': { bgcolor: 'rgba(0,0,0,0.45)' },
          }}
        >
          <CloseIcon />
        </IconButton>

        {recording && (
          <Box
            sx={{
              position: 'absolute',
              top: 20,
              left: 16,
              zIndex: 2,
              display: 'flex',
              alignItems: 'center',
              gap: 1,
              px: 1.5,
              py: 0.5,
              borderRadius: 2,
              bgcolor: 'rgba(0,0,0,0.55)',
            }}
          >
            <FiberManualRecordIcon sx={{ fontSize: 14, color: 'error.main' }} />
            <Typography
              variant="h6"
              sx={{ fontVariantNumeric: 'tabular-nums', color: 'common.white' }}
            >
              {formatStopwatch(remainingMs)}
            </Typography>
            <Typography variant="caption" sx={{ color: 'grey.400' }}>
              left
            </Typography>
          </Box>
        )}

        <Box
          component="video"
          ref={videoRef}
          muted
          playsInline
          autoPlay
          sx={{ flex: 1, width: '100%', minHeight: 0, objectFit: 'contain', bgcolor: 'common.black' }}
        />

        {recording && (
          <LinearProgress
            variant="determinate"
            value={Math.min(100, (elapsedMs / MAX_RECORDING_MS) * 100)}
            sx={{ height: 4 }}
          />
        )}

        <Box sx={{ p: 3, pb: 4, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
          {phase === 'requesting' && (
            <>
              <CircularProgress size={28} />
              <Typography variant="body2" sx={{ color: 'grey.400' }}>
                Starting the camera…
              </Typography>
            </>
          )}

          {phase === 'error' && (
            <>
              <Alert severity="error" sx={{ width: '100%' }}>
                {error}
              </Alert>
              <Button onClick={cancel} variant="outlined" sx={{ minHeight: 48 }}>
                Close
              </Button>
            </>
          )}

          {phase === 'ready' && (
            <>
              <IconButton
                aria-label="Start recording"
                onClick={start}
                sx={{
                  width: 76,
                  height: 76,
                  bgcolor: 'error.main',
                  color: 'common.white',
                  '&:hover': { bgcolor: 'error.dark' },
                }}
              >
                <FiberManualRecordIcon sx={{ fontSize: 40 }} />
              </IconButton>
              <Typography variant="caption" sx={{ color: 'grey.400' }}>
                Up to {formatStopwatch(MAX_RECORDING_MS)} · stops on its own
              </Typography>
            </>
          )}

          {recording && (
            <IconButton
              aria-label="Stop recording"
              onClick={stop}
              sx={{
                width: 76,
                height: 76,
                bgcolor: 'common.white',
                color: 'error.main',
                '&:hover': { bgcolor: 'common.white' },
              }}
            >
              <StopIcon sx={{ fontSize: 40 }} />
            </IconButton>
          )}
        </Box>
      </Box>
    </Dialog>
  );
}
