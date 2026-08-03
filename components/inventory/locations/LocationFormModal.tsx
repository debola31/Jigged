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

/*
 * There is no "Kind" field any more.
 *
 * It asked for a word — cabinet, row, bin — that **nothing read**. Its one consumer was the
 * board's `unitKind`, which substring-matched it to choose which drawing to render, and the board
 * was replaced by a table. The visual builder never set one either, so this form was the only
 * writer of a user-typed kind, and the only reader was this form echoing it back plus a chip in
 * the detail sheet. A field you fill in so it can be shown back to you is not a field.
 *
 * `kind` stays in the database because `'system'` is load-bearing: it marks the auto-managed
 * `Unassigned` pile, and `resolveFallbackPlace`, `LocationPicker`'s `excludeSystem`, the operator
 * lookup's put-away split and the detail sheet's structural-actions gate all key off it. That
 * value is set by `inv_get_or_create_unassigned`, never by a person — which is now true by
 * construction rather than by a guard.
 */

export interface LocationFormValues {
  name: string;
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
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset form when the dialog opens (codebase convention: Dialog onEnter,
  // not a setState-in-effect).
  const handleEnter = () => {
    setName(location?.name ?? '');
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
      // `kind` is deliberately not sent. Editing keeps whatever the row already has — which for
      // every hand-made place is null, and for the Unassigned pile is `'system'`, set by the RPC.
      await onSubmit({
        name: name.trim(),
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
