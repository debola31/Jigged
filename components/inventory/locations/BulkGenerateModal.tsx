'use client';

import { useEffect, useMemo, useState } from 'react';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import TextField from '@mui/material/TextField';
import Button from '@mui/material/Button';
import Stack from '@mui/material/Stack';
import Alert from '@mui/material/Alert';
import Typography from '@mui/material/Typography';

import type { BulkGenerateSpec } from '@/types/inventoryLocations';

interface BulkGenerateModalProps {
  open: boolean;
  parentPath: string[];
  onClose: () => void;
  onSubmit: (spec: BulkGenerateSpec) => Promise<void>;
}

/** Bulk-generate repetitive structure, e.g. 10 rows × {Left, Right}. */
export default function BulkGenerateModal({ open, parentPath, onClose, onSubmit }: BulkGenerateModalProps) {
  const [count, setCount] = useState('10');
  const [kind, setKind] = useState('row');
  const [namePattern, setNamePattern] = useState('Row {n}');
  const [leaves, setLeaves] = useState('Left, Right');
  const [leafKind, setLeafKind] = useState('side');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setCount('10');
    setKind('row');
    setNamePattern('Row {n}');
    setLeaves('Left, Right');
    setLeafKind('side');
    setError(null);
  }, [open]);

  const leafList = useMemo(
    () => leaves.split(',').map((s) => s.trim()).filter(Boolean),
    [leaves],
  );
  const n = Math.max(0, parseInt(count, 10) || 0);
  const total = n * (leafList.length > 0 ? 1 + leafList.length : 1);

  const handleSubmit = async () => {
    if (n <= 0) {
      setError('Count must be at least 1.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSubmit({
        count: n,
        kind: kind.trim() || undefined,
        namePattern: namePattern.trim() || '{n}',
        leaves: leafList.length > 0 ? leafList : undefined,
        leafKind: leafKind.trim() || undefined,
      });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to generate locations.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onClose={saving ? undefined : onClose} maxWidth="xs" fullWidth>
      <DialogTitle>Bulk-generate sub-locations</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <Alert severity="info" sx={{ py: 0 }}>
            Under <strong>{parentPath.join(' › ') || '(root)'}</strong>
          </Alert>
          <TextField
            label="How many"
            type="number"
            value={count}
            onChange={(e) => setCount(e.target.value)}
            inputProps={{ min: 1 }}
            fullWidth
          />
          <TextField
            label="Name pattern"
            value={namePattern}
            onChange={(e) => setNamePattern(e.target.value)}
            helperText="{n} is replaced with the number, e.g. “Row {n}”."
            fullWidth
          />
          <TextField label="Kind" value={kind} onChange={(e) => setKind(e.target.value)} fullWidth />
          <TextField
            label="Leaves per node (optional)"
            value={leaves}
            onChange={(e) => setLeaves(e.target.value)}
            helperText="Comma-separated, e.g. “Left, Right”. Leave blank for none."
            fullWidth
          />
          {leafList.length > 0 && (
            <TextField label="Leaf kind" value={leafKind} onChange={(e) => setLeafKind(e.target.value)} fullWidth />
          )}
          <Typography variant="body2" color="text.secondary">
            Will create <strong>{total}</strong> location{total === 1 ? '' : 's'}
            {leafList.length > 0
              ? ` (${n} × ${kind || 'node'} + ${leafList.length} leaves each)`
              : ''}
            .
          </Typography>
          {error && <Alert severity="error">{error}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        <Button onClick={handleSubmit} variant="contained" disabled={saving || total === 0}>
          Generate
        </Button>
      </DialogActions>
    </Dialog>
  );
}
