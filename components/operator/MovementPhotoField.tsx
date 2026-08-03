'use client';

/**
 * "Here's a photo of where I put it" — optional evidence on a stock movement.
 *
 * ## What it is for
 *
 * The thing an operator can do that no ledger row can: show the next person what the shelf
 * actually looks like now. `inventory_transactions` records who, what, how many and where; a photo
 * records *the state they left behind*, which is what someone hunting for the material actually
 * needs.
 *
 * Sortly — the product whose whole pitch is visual inventory — calls its feature "Inventory
 * Photos": *"visually track inventory by adding photos of your items."* Photos of ITEMS, taken on a
 * phone. We had built the inverse: photos on places, none on items or movements.
 *
 * ## Always optional, and quiet about it
 *
 * A required photo turns a five-second put-away into a chore, and the flow this belongs to is one
 * an operator does dozens of times a shift. No validation, no nag, no empty-state scolding — an
 * unphotographed movement is the normal case and must stay frictionless.
 *
 * ## Selection only; the upload happens on save
 *
 * This component holds a `File` and hands it up. It deliberately does NOT upload on pick: the
 * upload must happen as part of saving, because the RPC needs the path at INSERT and there is no
 * later step to attach one. Uploading on pick would strand a file in the bucket every time someone
 * changed their mind before saving.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import IconButton from '@mui/material/IconButton';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import AddAPhotoOutlinedIcon from '@mui/icons-material/AddAPhotoOutlined';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';

import { compressPhoto } from '@/utils/imageCompression';

export interface MovementPhotoFieldProps {
  /** The compressed file to send, or null. Owned by the parent so it can upload on save. */
  value: File | null;
  onChange: (file: File | null) => void;
  disabled?: boolean;
}

export default function MovementPhotoField({ value, onChange, disabled }: MovementPhotoFieldProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * DERIVED from `value`, never held as its own state.
   *
   * It was separate state at first, and that is a bug rather than a style point: the parent Dialog
   * stays mounted between opens and resets its `photo` to null on entry, so a preview living in
   * here would survive as a stale "Photo attached" thumbnail with no file behind it. Deriving means
   * the two cannot disagree. (The unused-`value` lint warning is what surfaced it.)
   */
  const preview = useMemo(() => (value ? URL.createObjectURL(value) : null), [value]);
  useEffect(() => {
    // Object URLs pin the blob in memory until revoked; on a phone, a shift's worth of put-away
    // photos is real memory.
    return () => {
      if (preview) URL.revokeObjectURL(preview);
    };
  }, [preview]);

  const pick = async (file: File | undefined) => {
    // Clear the input first, so picking the same file twice in a row still fires a change event.
    if (inputRef.current) inputRef.current.value = '';
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      // Same pipeline the job feed and location photos use: 2048px / 1.5MB / JPEG, EXIF baked into
      // pixels. A raw phone photo over shop wifi is the difference between instant and a stall.
      const prepared = await compressPhoto(file);
      onChange(prepared.file);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not use that photo.');
    } finally {
      setBusy(false);
    }
  };

  const clear = () => {
    onChange(null);
    setError(null);
  };

  return (
    <Box>
      {/* No `capture` attribute, deliberately — the same call JobFeed documents. Omitting it makes
          iOS/Android show the whole native sheet (Photo Library / Take Photo / Choose File), so a
          shot already sitting in the camera roll can be attached. `capture="environment"` would
          force the camera and hide the library, and photos-already-taken is the observed case. */}
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        hidden
        disabled={disabled}
        onChange={(e) => void pick(e.target.files?.[0])}
      />

      {preview ? (
        <Stack direction="row" spacing={1.5} alignItems="center">
          <Box
            component="img"
            src={preview}
            alt="Photo to attach to this movement"
            sx={{
              width: 64,
              height: 64,
              borderRadius: 1,
              // `contain` on a mat, not `cover` — a cropped thumbnail of a shelf can hide the very
              // thing it was taken to show. Same call as the board tiles.
              objectFit: 'contain',
              bgcolor: 'action.hover',
              border: 1,
              borderColor: 'divider',
            }}
          />
          <Typography variant="body2" color="text.secondary" sx={{ flex: 1 }}>
            Photo attached
          </Typography>
          <IconButton aria-label="Remove photo" onClick={clear} disabled={disabled || busy}>
            <DeleteOutlineIcon />
          </IconButton>
        </Stack>
      ) : (
        <Button
          startIcon={busy ? <CircularProgress size={14} /> : <AddAPhotoOutlinedIcon />}
          onClick={() => inputRef.current?.click()}
          disabled={disabled || busy}
          sx={{ minHeight: 48 }}
        >
          Add a photo
        </Button>
      )}

      {error && (
        <Alert severity="error" sx={{ mt: 1 }}>
          {error}
        </Alert>
      )}
    </Box>
  );
}
