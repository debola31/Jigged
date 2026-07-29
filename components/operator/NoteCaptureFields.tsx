'use client';

import { useRef } from 'react';
import Box from '@mui/material/Box';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import CloseIcon from '@mui/icons-material/Close';
import MicNoneIcon from '@mui/icons-material/MicNone';
import PhotoCameraIcon from '@mui/icons-material/PhotoCamera';
import type { NoteCapture } from '@/hooks/useNoteCapture';

const THUMB = 76;

/** Shared by both layouts. */
function PendingThumbs({ capture }: { capture: NoteCapture }) {
  return (
    <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
      {capture.pending.map((p) => (
        <Box key={p.id} sx={{ position: 'relative' }}>
          <Box
            component="img"
            src={p.previewUrl}
            alt="Pending photo"
            sx={{
              width: THUMB,
              height: THUMB,
              objectFit: 'cover',
              borderRadius: 1,
              display: 'block',
            }}
          />
          <IconButton
            size="small"
            aria-label="Remove photo"
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
      ))}
    </Box>
  );
}

/**
 * The capture fields: text, photo picker, pending thumbnails, dictation hint.
 *
 * Rendered in two places from one implementation — inside the completion block,
 * where RECORD COMPLETION submits it, and inside the job feed for steps with no
 * completion block left to attach to (an already-complete step, or an outside
 * step). It deliberately owns NO submit button: the surface it sits in decides
 * what "save" means.
 *
 * TWO LAYOUTS. `compact` is one row — single-line field that grows as it fills,
 * camera as an adjacent icon, the dictation tip as an icon rather than a
 * sentence. The four-row version pushed RECORD COMPLETION off the bottom of a
 * 6.9" phone, putting the primary action of the screen below the fold, which is
 * the one thing that must never happen. The full layout stays for the feed, where
 * capture is the only thing on offer and has room to invite.
 */
export default function NoteCaptureFields({
  capture,
  placeholder,
  disabled = false,
  compact = false,
}: {
  capture: NoteCapture;
  placeholder: string;
  disabled?: boolean;
  compact?: boolean;
}) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);

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
        // The completion block's action bar is FIXED, so it overlays whatever
        // sits at that viewport position — the documented hazard of sticky and
        // fixed bars is covering the element the user is currently editing.
        // Centring the field on focus keeps it clear of both the bar and the
        // on-screen keyboard.
        if (compact) {
          e.currentTarget.scrollIntoView({ block: 'center', behavior: 'smooth' });
        }
      }}
      disabled={disabled || capture.saving}
      fullWidth
      size="small"
    />
  );

  {
    /* No `capture` attribute: on iOS/Android this makes the OS present the full
       native sheet (Photo Library / Take Photo / Choose File), so operators can
       attach an EXISTING photo from the camera roll — the observed failure mode
       was setup photos stuck in the roll — not only shoot a new one.
       `capture="environment"` would force the camera and hide the library. */
  }
  const picker = (
    <input
      ref={fileInputRef}
      type="file"
      accept="image/*"
      multiple
      hidden
      onChange={capture.pickPhotos}
    />
  );

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
            aria-label="Add photo"
            onClick={() => fileInputRef.current?.click()}
            disabled={disabled || capture.saving}
            sx={{ width: 48, height: 48, flexShrink: 0 }}
          >
            <PhotoCameraIcon />
          </IconButton>
          {/* The dictation tip as an icon, not a sentence. It used to occupy a
              full line above the primary action — a coach mark outranking the
              button it sat above. */}
          {capture.showMicHint && (
            <Tooltip title="Tap the mic on your keyboard to talk instead of type">
              <IconButton
                aria-label="Tip: tap the mic on your keyboard to talk instead of type"
                onClick={capture.dismissMicHint}
                sx={{ width: 48, height: 48, flexShrink: 0, color: 'text.secondary' }}
              >
                <MicNoneIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          )}
        </Box>
        {capture.pending.length > 0 && <PendingThumbs capture={capture} />}
        {errorAlert}
      </Box>
    );
  }

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
      {field}

      {capture.showMicHint && (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
          <Typography variant="caption" color="text.secondary" sx={{ flex: 1 }}>
            ※ Tip: tap the{' '}
            {/* The iOS keyboard's dictation glyph (outlined mic + cradle + stem +
                base bar), so it reads as the exact key operators tap — not a
                generic emoji. */}
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
          <IconButton
            size="small"
            aria-label="Dismiss tip"
            onClick={capture.dismissMicHint}
            sx={{ p: 0.25 }}
          >
            <CloseIcon sx={{ fontSize: 14 }} />
          </IconButton>
        </Box>
      )}

      {capture.pending.length > 0 && <PendingThumbs capture={capture} />}
      {errorAlert}

      {picker}
      <Box>
        <Button
          variant="outlined"
          startIcon={<PhotoCameraIcon />}
          onClick={() => fileInputRef.current?.click()}
          disabled={disabled || capture.saving}
          sx={{ minHeight: 48 }}
        >
          Add photo
        </Button>
      </Box>
    </Box>
  );
}
