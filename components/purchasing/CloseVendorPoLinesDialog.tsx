'use client';

import { useState } from 'react';
import posthog from 'posthog-js';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import FormControlLabel from '@mui/material/FormControlLabel';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';

import ErrorAlert from '@/components/common/ErrorAlert';
import MissingFieldsNotice from '@/components/common/MissingFieldsNotice';
import { formatUnitQuantity, unitLabel } from '@/lib/purchasing/purchaseUnits';
import { closeVendorPoLines } from '@/utils/vendorPoAccess';
import type { VendorPoDetail, VendorPoLine } from '@/types/vendorPo';

export interface CloseVendorPoLinesDialogProps {
  open: boolean;
  po: VendorPoDetail;
  /** Start with only these ticked (a row's own "Close short"); default every closable line. */
  initialLineIds?: string[];
  onClose: () => void;
  /** After the close lands: the page refreshes. */
  onClosed: () => void;
}

/** A line that still expects something: not closed, and not already fully received. */
export function isClosableLine(line: VendorPoLine): boolean {
  return line.closedAt === null && line.status !== 'received';
}

/**
 * Close… (plan §3.13 "Close, Reopen"): nothing more is expected on the ticked lines.
 *
 * Every closable line starts ticked, and every line ticked closes the WHOLE PO (one header write,
 * which also tells QuickBooks the PO is done when it is next updated); fewer is a batch line close,
 * atomic in the database. A closed line stops counting as on order and as late. Closing never
 * bumps the revision, and Reopen undoes it.
 */
export default function CloseVendorPoLinesDialog({ open, po, initialLineIds, onClose, onClosed }: CloseVendorPoLinesDialogProps) {
  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth aria-labelledby="close-vendor-po-lines-title">
      <DialogTitle id="close-vendor-po-lines-title">Close lines on {po.header.poNumber}</DialogTitle>
      {open && <CloseBody po={po} initialLineIds={initialLineIds} onClose={onClose} onClosed={onClosed} />}
    </Dialog>
  );
}

function CloseBody({ po, initialLineIds, onClose, onClosed }: Omit<CloseVendorPoLinesDialogProps, 'open'>) {
  const closable = po.lines.filter(isClosableLine);
  const [ticked, setTicked] = useState<Set<string>>(
    () => new Set(initialLineIds ? initialLineIds.filter((id) => closable.some((l) => l.id === id)) : closable.map((l) => l.id)),
  );
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const wholePo = closable.length > 0 && closable.every((l) => ticked.has(l.id));
  const count = ticked.size;
  const toggle = (id: string, on: boolean) =>
    setTicked((s) => {
      const next = new Set(s);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const handleClose = async () => {
    if (count === 0) return;
    setSaving(true);
    setError(null);
    const chosen = closable.filter((l) => ticked.has(l.id));
    try {
      await closeVendorPoLines(po.header.id, wholePo ? 'all' : chosen.map((l) => l.id), reason.trim() || null);
      posthog.capture('vendor po lines closed', {
        whole_po: wholePo,
        line_count: chosen.length,
        had_receipts: chosen.some((l) => l.receivedQuantity > 0),
      });
      onClosed();
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <DialogContent dividers>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Nothing more expected on these lines; they stop counting as on order. You can reopen them later.
        </Typography>
        <Stack spacing={0.5}>
          {closable.map((line) => (
            <FormControlLabel
              key={line.id}
              control={<Checkbox checked={ticked.has(line.id)} onChange={(e) => toggle(line.id, e.target.checked)} />}
              label={
                <Box>
                  <Typography variant="body2" sx={{ fontWeight: 600 }}>
                    Line {line.lineNumber} · {line.description}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    {formatUnitQuantity(line.openQuantity)} {unitLabel(line.unit)} still open of{' '}
                    {formatUnitQuantity(line.quantity)}
                  </Typography>
                </Box>
              }
            />
          ))}
        </Stack>
        <TextField
          label="Note (optional)"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          fullWidth
          size="small"
          sx={{ mt: 2 }}
          slotProps={{ htmlInput: { maxLength: 500 } }}
        />
        {error != null && <ErrorAlert error={error} entity="purchase order" onClose={() => setError(null)} sx={{ mt: 2 }} />}
      </DialogContent>
      <DialogActions sx={{ px: 3, py: 2, flexDirection: 'column', alignItems: 'stretch', gap: 1 }}>
        <MissingFieldsNotice items={count === 0 ? ['Tick the lines to close.'] : []} />
        <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 1 }}>
          <Button onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button
            variant="contained"
            onClick={() => void handleClose()}
            disabled={count === 0 || saving}
            startIcon={saving ? <CircularProgress size={16} color="inherit" /> : undefined}
          >
            {wholePo ? 'Close the PO' : `Close ${count} line${count === 1 ? '' : 's'}`}
          </Button>
        </Box>
      </DialogActions>
    </>
  );
}
