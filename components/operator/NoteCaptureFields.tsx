'use client';

import { useRef } from 'react';
import Box from '@mui/material/Box';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import CloseIcon from '@mui/icons-material/Close';
import PhotoCameraIcon from '@mui/icons-material/PhotoCamera';
import type { NoteCapture } from '@/hooks/useNoteCapture';

const THUMB = 76;

/**
 * The capture fields: text, dictation hint, photo picker, pending thumbnails.
 *
 * Rendered in two places from one implementation — inside the completion block,
 * where RECORD COMPLETION submits it, and inside the job feed for steps that
 * have no completion block left to attach to (an already-complete step, or an
 * outside step that uses send/receive). It deliberately owns NO submit button:
 * the surface it sits in decides what "save" means.
 */
export default function NoteCaptureFields({
  capture,
  placeholder,
  disabled = false,
}: {
  capture: NoteCapture;
  placeholder: string;
  disabled?: boolean;
}) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
      <TextField
        multiline
        minRows={2}
        placeholder={placeholder}
        value={capture.draft}
        onChange={(e) => capture.setDraft(e.target.value)}
        onFocus={capture.noteFocused}
        disabled={disabled || capture.saving}
        fullWidth
        size="small"
      />

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

      {capture.pending.length > 0 && (
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
      )}

      {capture.error && (
        <Alert severity="error" onClose={capture.clearError}>
          {capture.error}
        </Alert>
      )}

      {/* No `capture` attribute: on iOS/Android this makes the OS present the
          full native sheet (Photo Library / Take Photo / Choose File), so
          operators can attach an EXISTING photo from the camera roll — the
          observed failure mode was setup photos stuck in the roll — not only
          shoot a new one. `capture="environment"` would force the camera and
          hide the library. */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={capture.pickPhotos}
      />
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
