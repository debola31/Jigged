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
import FormControlLabel from '@mui/material/FormControlLabel';
import Switch from '@mui/material/Switch';
import Alert from '@mui/material/Alert';

import type { InventoryLocation } from '@/types/inventoryLocations';

const KIND_SUGGESTIONS = ['cabinet', 'shelf', 'rack', 'row', 'drawer', 'side', 'bin', 'zone', 'aisle'];

export interface LocationFormValues {
  name: string;
  kind: string | null;
  code: string | null;
  is_stockable: boolean;
  is_qr_anchor: boolean;
}

interface LocationFormModalProps {
  open: boolean;
  /** Existing location when editing; null when creating. */
  location: InventoryLocation | null;
  /** Human path of the parent (for the "Adding under …" hint). */
  parentPath?: string[];
  onClose: () => void;
  onSubmit: (values: LocationFormValues) => Promise<void>;
}

export default function LocationFormModal({
  open,
  location,
  parentPath,
  onClose,
  onSubmit,
}: LocationFormModalProps) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [isStockable, setIsStockable] = useState(true);
  const [isQrAnchor, setIsQrAnchor] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset form when the dialog opens (codebase convention: Dialog onEnter,
  // not a setState-in-effect).
  const handleEnter = () => {
    setName(location?.name ?? '');
    setKind(location?.kind ?? null);
    setCode(location?.code ?? '');
    setIsStockable(location?.is_stockable ?? true);
    setIsQrAnchor(location?.is_qr_anchor ?? false);
    setError(null);
  };

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
        is_stockable: isStockable,
        is_qr_anchor: isQrAnchor,
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
          <TextField
            label="Name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Cabinet 1, Row 3, Left…"
            autoFocus
            fullWidth
            required
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
          <FormControlLabel
            control={<Switch checked={isStockable} onChange={(e) => setIsStockable(e.target.checked)} />}
            label="Can hold stock"
          />
          <FormControlLabel
            control={<Switch checked={isQrAnchor} onChange={(e) => setIsQrAnchor(e.target.checked)} />}
            label="QR anchor (print a scannable label here)"
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
