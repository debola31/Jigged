'use client';

import { useState } from 'react';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import TextField from '@mui/material/TextField';
import Button from '@mui/material/Button';
import Stack from '@mui/material/Stack';
import Autocomplete from '@mui/material/Autocomplete';
import Alert from '@mui/material/Alert';

import type { InventoryLocation } from '@/types/inventoryLocations';
import { LOCATION_KINDS } from '@/lib/locationKinds';

// One vocabulary, shared with the builder's templates — see lib/locationKinds.ts for why the two
// lists having nothing in common was a real problem and not just untidiness.
const KIND_SUGGESTIONS: readonly string[] = LOCATION_KINDS;

export interface LocationFormValues {
  name: string;
  kind: string | null;
  code: string | null;
}

interface LocationFormModalProps {
  open: boolean;
  /** Existing location when editing; null when creating. */
  location: InventoryLocation | null;
  /** Human path of the parent (for the "Adding under …" hint). */
  parentPath?: string[];
  /**
   * Names already used under the same parent.
   *
   * The DB now refuses a duplicate sibling name outright, so this is the half that keeps someone
   * from *reaching* that error: the field warns while you type, and offers the existing names so
   * "Shelf A" is picked rather than retyped as "shelf a". Nothing exact catches `ST0CK` for
   * `STOCK` — a warning you read is the only defence against that one.
   */
  siblingNames?: string[];
  onClose: () => void;
  onSubmit: (values: LocationFormValues) => Promise<void>;
}

export default function LocationFormModal({
  open,
  location,
  parentPath,
  siblingNames,
  onClose,
  onSubmit,
}: LocationFormModalProps) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset form when the dialog opens (codebase convention: Dialog onEnter,
  // not a setState-in-effect).
  const handleEnter = () => {
    setName(location?.name ?? '');
    setKind(location?.kind ?? null);
    setCode(location?.code ?? '');
    setError(null);
  };

  /**
   * Whether the typed name already belongs to a sibling.
   *
   * Matched the way the DB index does (case- and whitespace-insensitive) so the warning and the
   * constraint agree — a warning that fires on names the DB accepts, or stays quiet on names it
   * rejects, is worse than none. Editing a location doesn't warn about its own current name.
   */
  const trimmed = name.trim();
  const duplicateOf = trimmed
    ? (siblingNames ?? []).find(
        (n) =>
          n.trim().toLowerCase() === trimmed.toLowerCase() &&
          n.trim().toLowerCase() !== (location?.name ?? '').trim().toLowerCase(),
      )
    : undefined;
  const parentLabel = parentPath?.length ? parentPath[parentPath.length - 1] : 'This company';

  const handleSubmit = async () => {
    if (!name.trim()) {
      setError('Name is required.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSubmit({
        name: name.trim(),
        kind: kind?.trim() || null,
        code: code.trim() || null,
      });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save location.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={saving ? undefined : onClose}
      maxWidth="xs"
      fullWidth
      TransitionProps={{ onEnter: handleEnter }}
    >
      <DialogTitle>{location ? 'Edit location' : 'New location'}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          {parentPath && parentPath.length > 0 && (
            <Alert severity="info" sx={{ py: 0 }}>
              Adding under <strong>{parentPath.join(' › ')}</strong>
            </Alert>
          )}
          {/* freeSolo, so it stays a name field that happens to suggest — not a picker. Choosing
              an existing name is how you avoid typing a second spelling of it. */}
          <Autocomplete
            freeSolo
            options={siblingNames ?? []}
            value={name}
            onInputChange={(_, v) => setName(v)}
            renderInput={(params) => (
              <TextField
                {...params}
                label="Name"
                placeholder="Cabinet 1, Row 3, Left…"
                autoFocus
                required
                error={Boolean(duplicateOf)}
                helperText={
                  duplicateOf ? `${parentLabel} already has a ${duplicateOf}.` : undefined
                }
              />
            )}
          />
          <Autocomplete
            freeSolo
            options={KIND_SUGGESTIONS}
            value={kind}
            onChange={(_, v) => setKind(v)}
            onInputChange={(_, v) => setKind(v)}
            renderInput={(params) => (
              <TextField {...params} label="Kind (optional)" placeholder="cabinet, row, bin…" />
            )}
          />
          <TextField
            label="Code (optional)"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="CAB1-R3-L"
            helperText="Printed on the label; the QR itself always encodes the location ID."
            fullWidth
          />
          {error && <Alert severity="error">{error}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        <Button onClick={handleSubmit} variant="contained" disabled={saving}>
          {location ? 'Save' : 'Create'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
