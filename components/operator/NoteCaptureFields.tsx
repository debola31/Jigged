'use client';

import { useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import CloseIcon from '@mui/icons-material/Close';
import PhotoCameraIcon from '@mui/icons-material/PhotoCamera';
import PlayCircleOutlineIcon from '@mui/icons-material/PlayCircleOutline';
import VideocamIcon from '@mui/icons-material/Videocam';
import VideocamOffOutlinedIcon from '@mui/icons-material/VideocamOffOutlined';
import VideoRecorderDialog from '@/components/operator/VideoRecorderDialog';
import { canRecordVideo } from '@/lib/videoCapture';
import { formatStopwatch } from '@/lib/duration';
import type { NoteCaptureFieldsState } from '@/hooks/useNoteCapture';

const THUMB = 76;

/** Shared by both layouts. */
function PendingThumbs({ capture }: { capture: NoteCaptureFieldsState }) {
  return (
    <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
      {capture.pending.map((p) => {
        const isVideo = p.kind === 'video';
        // A clip paints from its POSTER, never from itself. An <img> cannot decode
        // an mp4, and pointing one at the clip would also mean holding the whole
        // thing in the layout to draw 76 pixels.
        const thumbSrc = isVideo ? p.posterUrl : p.previewUrl;
        return (
        <Box key={p.id} sx={{ position: 'relative' }}>
          {thumbSrc ? (
            <Box
              component="img"
              src={thumbSrc}
              alt={isVideo ? 'Pending video' : 'Pending photo'}
              sx={{
                width: THUMB,
                height: THUMB,
                objectFit: 'cover',
                borderRadius: 1,
                display: 'block',
              }}
            />
          ) : (
            // The poster grab failed. Say "there is a clip here" rather than
            // rendering a broken image or, worse, falling back to the clip itself.
            <Box
              sx={{
                width: THUMB,
                height: THUMB,
                borderRadius: 1,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                bgcolor: 'rgba(255,255,255,0.06)',
              }}
            >
              <VideocamOffOutlinedIcon fontSize="small" sx={{ color: 'text.disabled' }} />
            </Box>
          )}
          {isVideo && (
            <>
              {thumbSrc && (
                <PlayCircleOutlineIcon
                  sx={{
                    position: 'absolute',
                    top: '50%',
                    left: '50%',
                    transform: 'translate(-50%, -50%)',
                    color: 'common.white',
                    pointerEvents: 'none',
                  }}
                />
              )}
              <Typography
                variant="caption"
                sx={{
                  position: 'absolute',
                  bottom: 4,
                  right: 4,
                  px: 0.5,
                  borderRadius: 0.5,
                  bgcolor: 'rgba(0,0,0,0.6)',
                  color: 'common.white',
                  fontVariantNumeric: 'tabular-nums',
                  pointerEvents: 'none',
                }}
              >
                {formatStopwatch(p.durationSeconds * 1000)}
              </Typography>
            </>
          )}
          <IconButton
            size="small"
            aria-label={isVideo ? 'Remove video' : 'Remove photo'}
            onClick={() => capture.removePending(p.id)}
            sx={{
              position: 'absolute',
              top: -8,
              right: -8,
              bgcolor: 'background.paper',
              '&:hover': { bgcolor: 'background.paper' },
            }}
          >
            <CloseIcon fontSize="small" />
          </IconButton>
        </Box>
        );
      })}
    </Box>
  );
}

/** The dictation tip. Capped and dismissible — see MIC_HINT_MAX_SHOWS. */
function MicHint({ onDismiss }: { onDismiss: () => void }) {
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
      <Typography variant="caption" color="text.secondary" sx={{ flex: 1 }}>
        ※ Tip: tap the{' '}
        {/* The iOS keyboard's dictation glyph (outlined mic + cradle + stem + base
            bar), so it reads as the exact key operators tap — not a generic
            emoji, and not something that looks tappable HERE. */}
        <Box
          component="svg"
          viewBox="0 0 24 24"
          aria-hidden="true"
          sx={{
            width: '1.05em',
            height: '1.05em',
            verticalAlign: '-0.2em',
            mx: '1px',
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: 1.6,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
          }}
        >
          <rect x="9.5" y="3" width="5" height="10" rx="2.5" />
          <path d="M6.5 11a5.5 5.5 0 0 0 11 0" />
          <path d="M12 16.5V19" />
          <path d="M8.5 19h7" />
        </Box>{' '}
        on your keyboard to talk instead of type.
      </Typography>
      <IconButton size="small" aria-label="Dismiss tip" onClick={onDismiss} sx={{ p: 0.25 }}>
        <CloseIcon sx={{ fontSize: 14 }} />
      </IconButton>
    </Box>
  );
}

/**
 * The capture fields: text, camera, video recorder, pending thumbnails, dictation hint.
 *
 * CAPTURE-ONLY. Both controls go to a live camera — the photo input carries
 * `capture="environment"` and the video button opens Jigged's own recorder. Neither
 * offers the camera roll or a file picker any more. See the picker's comment for the
 * decision this reverses and what to watch.
 *
 * Rendered from one implementation by the job composer and the machine log. It
 * deliberately owns NO submit button: the surface it sits in decides what "save"
 * means.
 *
 * TWO LAYOUTS. `compact` is one row — single-line field that grows as it fills,
 * camera as an adjacent icon, the dictation tip as an icon rather than a
 * sentence. It exists because a four-row composer above a screen's primary action
 * pushes that action off the bottom of a 6.9" phone, which is the one thing that
 * must never happen; the machine log still needs it for that reason.
 * The JOB composer went back to the full layout when it moved out of the
 * completion block and BELOW the action buttons — nothing it does can push them
 * anywhere now, and capture is the only thing in its card, so it has the room to
 * invite.
 */
export default function NoteCaptureFields({
  capture,
  placeholder,
  disabled = false,
  compact = false,
}: {
  capture: NoteCaptureFieldsState;
  placeholder: string;
  disabled?: boolean;
  compact?: boolean;
}) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [recorderOpen, setRecorderOpen] = useState(false);
  /**
   * Decided once per mount, before the control is rendered rather than when it is
   * tapped. A device with no MediaRecorder (an old iOS, or an insecure context) gets
   * no video button at all — a button that can only ever fail is worse than its
   * absence, and photos still work.
   */
  const [videoOffered] = useState(canRecordVideo);
  const captureDisabled = disabled || capture.saving;

  const field = (
    <TextField
      multiline
      minRows={compact ? 1 : 2}
      maxRows={compact ? 4 : undefined}
      placeholder={placeholder}
      value={capture.draft}
      onChange={(e) => capture.setDraft(e.target.value)}
      onFocus={(e) => {
        capture.noteFocused();
        // A compact composer is the one that sits directly above a screen's
        // action controls, so the on-screen keyboard is most likely to cover the
        // very field being typed into. Centring on focus keeps it clear of both
        // the keyboard and whatever sits below it.
        // Optional-call: jsdom does not implement scrollIntoView, and this is a
        // progressive nicety rather than behaviour worth throwing over. The same
        // `?.()` guard is used elsewhere in the operator components for exactly
        // this reason.
        if (compact) {
          e.currentTarget.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
        }
      }}
      disabled={disabled || capture.saving}
      fullWidth
      size="small"
    />
  );

  {
    /* `capture="environment"` sends the tap STRAIGHT to the rear camera, replacing
       the OS sheet (Photo Library / Take Photo / Choose File) that used to appear
       here.

       THIS REVERSES A DOCUMENTED DECISION, and the reason it was made is still
       true: the sheet was deliberately left open because the observed failure mode
       was setup photos stuck in the camera roll, and the audit that followed found
       the phone-camera-then-attach flow was how photos actually arrived. What
       changed is the requirement, not the evidence — attached material must now be
       shot in Jigged, so that it is known to be of this job at this moment rather
       than of something a photo happens to depict. The cost is real and was
       accepted: an operator who shoots at the machine and files the note later must
       now open Jigged at the machine. Watch `composer_focused` against `note_saved`
       for it; a widening gap is this, not general capture friction.

       `multiple` is gone with it. HTML Media Capture is one shot per invocation, so
       the attribute had no meaning left — several clips or photos per note come from
       tapping again, each appending to the strip. */
  }
  const picker = (
    <input
      ref={fileInputRef}
      type="file"
      accept="image/*"
      capture="environment"
      hidden
      onChange={capture.pickPhotos}
    />
  );

  const recorder = videoOffered ? (
    <VideoRecorderDialog
      open={recorderOpen}
      onClose={() => setRecorderOpen(false)}
      onCaptured={capture.addVideo}
    />
  ) : null;

  const errorAlert = capture.error ? (
    <Alert severity="error" onClose={capture.clearError}>
      {capture.error}
    </Alert>
  ) : null;

  if (compact) {
    return (
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
        <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 0.5 }}>
          {field}
          {picker}
          <IconButton
            aria-label="Take photo"
            onClick={() => fileInputRef.current?.click()}
            disabled={captureDisabled}
            sx={{ width: 48, height: 48, flexShrink: 0 }}
          >
            <PhotoCameraIcon />
          </IconButton>
          {videoOffered && (
            <IconButton
              aria-label="Record video"
              onClick={() => setRecorderOpen(true)}
              disabled={captureDisabled}
              sx={{ width: 48, height: 48, flexShrink: 0 }}
            >
              <VideocamIcon />
            </IconButton>
          )}
        </Box>
        {recorder}
        {/* A CAPTION, not an icon button. The icon version sat beside a real
            camera button and read as "tap here to dictate" — but nothing can
            invoke the OS keyboard's dictation from a web page, so tapping it only
            dismissed the tip. A false affordance is worse than the line of text it
            replaced, and this costs a line at most five times per device. */}
        {capture.showMicHint && <MicHint onDismiss={capture.dismissMicHint} />}
        {capture.pending.length > 0 && <PendingThumbs capture={capture} />}
        {errorAlert}
      </Box>
    );
  }

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
      {field}

      {capture.showMicHint && <MicHint onDismiss={capture.dismissMicHint} />}

      {capture.pending.length > 0 && <PendingThumbs capture={capture} />}
      {errorAlert}

      {picker}
      {recorder}
      <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
        <Button
          variant="outlined"
          startIcon={<PhotoCameraIcon />}
          onClick={() => fileInputRef.current?.click()}
          disabled={captureDisabled}
          sx={{ minHeight: 48 }}
        >
          Take photo
        </Button>
        {videoOffered && (
          <Button
            variant="outlined"
            startIcon={<VideocamIcon />}
            onClick={() => setRecorderOpen(true)}
            disabled={captureDisabled}
            sx={{ minHeight: 48 }}
          >
            Record video
          </Button>
        )}
      </Box>
    </Box>
  );
}
