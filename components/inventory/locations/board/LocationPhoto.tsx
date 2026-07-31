'use client';

/**
 * A photo of the actual place, in the detail sheet.
 *
 * §5.5 decision 5: *"A photo of the actual rack beats any icon."* The board draws furniture from a
 * free-text `kind`, which is a guess at what the thing looks like — a photograph is how someone
 * recognises the shelf they're standing in front of.
 *
 * Reuses the pipeline the job feed already proved on the shop floor: `compressPhoto` (2048px /
 * 1.5MB / JPEG, EXIF baked into pixels) then a plain upload into the private `attachments` bucket.
 */
import { useRef, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import AddAPhotoOutlinedIcon from '@mui/icons-material/AddAPhotoOutlined';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';

import { compressPhoto } from '@/utils/imageCompression';

export interface LocationPhotoProps {
  /** Current photo URL, already signed. Null when there's no photo or it couldn't be read. */
  url: string | null;
  locationName: string;
  /** Compressed file in, saved location out. */
  onPick: (file: File) => Promise<void>;
  onClear: () => Promise<void>;
  /** True when the location has a `photo_path` — so "couldn't load" is distinguishable from "none". */
  hasPhoto: boolean;
}

export default function LocationPhoto({
  url,
  locationName,
  onPick,
  onClear,
  hasPhoto,
}: LocationPhotoProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handlePick = async (file: File | undefined) => {
    // Clear the input first, so picking the same file twice in a row still fires a change event.
    if (inputRef.current) inputRef.current.value = '';
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const prepared = await compressPhoto(file);
      await onPick(prepared.file);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save that photo.');
    } finally {
      setBusy(false);
    }
  };

  const handleClear = async () => {
    setBusy(true);
    setError(null);
    try {
      await onClear();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not remove that photo.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Box sx={{ mb: 2 }}>
      {/* No `capture` attribute — deliberately, and the same call JobFeed documents: omitting it
          makes iOS/Android show the whole native sheet (Photo Library / Take Photo / Choose File),
          so an existing camera-roll shot can be attached. `capture="environment"` would force the
          camera and hide the library, and the observed failure mode was photos already taken and
          stuck in the roll. */}
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => void handlePick(e.target.files?.[0])}
      />

      {url ? (
        <Box
          component="img"
          src={url}
          alt={`Photo of ${locationName}`}
          /* `contain` for the same reason as the board tile: `maxHeight` clamps a portrait phone
             photo to roughly a third of its height, and `cover` then cropped the missing two-thirds
             away rather than scaling to fit. The whole object has to be visible for the photo to do
             its job. */
          sx={{
            width: '100%',
            height: 200,
            objectFit: 'contain',
            bgcolor: 'action.hover',
            borderRadius: 1,
            display: 'block',
            border: 1,
            borderColor: 'divider',
          }}
        />
      ) : hasPhoto ? (
        // A path exists but no URL came back — say so rather than showing an empty frame that
        // reads as "no photo" and invites someone to add a second one.
        <Alert severity="warning" sx={{ mb: 1 }}>
          This place has a photo, but it couldn&apos;t be loaded.
        </Alert>
      ) : null}

      <Stack direction="row" spacing={1} sx={{ mt: url ? 1 : 0 }} alignItems="center">
        <Button
          size="small"
          startIcon={busy ? <CircularProgress size={14} /> : <AddAPhotoOutlinedIcon />}
          onClick={() => inputRef.current?.click()}
          disabled={busy}
        >
          {hasPhoto ? 'Replace photo' : 'Add a photo'}
        </Button>
        {hasPhoto && (
          <Button
            size="small"
            color="inherit"
            startIcon={<DeleteOutlineIcon />}
            onClick={handleClear}
            disabled={busy}
          >
            Remove
          </Button>
        )}
        {!hasPhoto && !busy && (
          <Typography variant="caption" color="text.secondary">
            Easier to recognise than an icon.
          </Typography>
        )}
      </Stack>

      {error && (
        <Alert severity="error" sx={{ mt: 1 }}>
          {error}
        </Alert>
      )}
    </Box>
  );
}
