'use client';

import { useState } from 'react';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';

import {
  outsideReceiptCaption,
  outsideReceiptConsequence,
} from '@/components/operations/operationMath';

export interface OpenSlipOption {
  id: string;
  slip_number: string;
  shipped_at: string;
  outstanding: number;
}

export interface ReceiveFromVendorSubmit {
  shipmentId: string | null;
  quantityGood: number;
  quantityScrapped: number;
}

interface ReceiveFromVendorDialogProps {
  open: boolean;
  vendorName: string;
  operationName: string;
  partName: string;
  /** Slips with something still out, OLDEST FIRST. Empty is a legitimate state. */
  openSlips: OpenSlipOption[];
  busy?: boolean;
  onClose: () => void;
  onSubmit: (v: ReceiveFromVendorSubmit) => void;
}

/**
 * Office-side receipt against one slip.
 *
 * OLDEST SLIP FIRST, and it is the default. A plater returns the first batch
 * first, and it is the one whose due-back has aged — so FIFO is both what
 * happened and what the shop is chasing.
 *
 * THE NO-SLIP CASE IS SAID OUT LOUD. When nothing is open — nobody made a slip
 * and the parts came back anyway — the receipt still needs a shipment to hang
 * off, so one is recorded alongside it. That is exactly what the old Mark
 * Received did when it back-filled `sent_at = completed_at`, except silently.
 * A shop that sees this line often has a send flow it is not using.
 */
export default function ReceiveFromVendorDialog({
  open,
  vendorName,
  operationName,
  partName,
  openSlips,
  busy = false,
  onClose,
  onSubmit,
}: ReceiveFromVendorDialogProps) {
  const first = openSlips[0] ?? null;
  // Mounted fresh each open, so props are enough — no reset effect.
  const [slipId, setSlipId] = useState<string>(() => first?.id ?? '');
  const [goodInput, setGoodInput] = useState(() =>
    first && first.outstanding > 0 ? String(first.outstanding) : '',
  );
  const [scrapInput, setScrapInput] = useState('');
  const [showScrap, setShowScrap] = useState(false);

  const slip = openSlips.find((s) => s.id === slipId) ?? first;
  const outstanding = slip?.outstanding ?? 0;
  const consequence = outsideReceiptConsequence(goodInput, scrapInput, outstanding);
  const good = Number(goodInput) || 0;
  const scrapped = Number(scrapInput) || 0;
  const canSubmit = good + scrapped > 0 && !busy;

  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle>Receive from {vendorName}</DialogTitle>
      <DialogContent>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          {operationName} · {partName}
        </Typography>

        {openSlips.length === 0 && (
          <Alert severity="info" sx={{ mb: 2 }}>
            No slip is open for this step. We&apos;ll record the send alongside the receipt so the
            history still shows the parts went out.
          </Alert>
        )}

        {openSlips.length > 1 && (
          <TextField
            select
            label="Against which slip"
            value={slipId}
            onChange={(e) => {
              const next = openSlips.find((s) => s.id === e.target.value);
              setSlipId(e.target.value);
              setGoodInput(next && next.outstanding > 0 ? String(next.outstanding) : '');
            }}
            fullWidth
            helperText="Oldest first — that is usually the batch coming back."
            sx={{ mb: 2 }}
          >
            {openSlips.map((s) => (
              <MenuItem key={s.id} value={s.id}>
                {s.slip_number} — {s.outstanding} still out
              </MenuItem>
            ))}
          </TextField>
        )}
        {openSlips.length === 1 && (
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Against {openSlips[0].slip_number} — {openSlips[0].outstanding} still out
          </Typography>
        )}

        <Stack direction="row" spacing={2} sx={{ mb: 1 }}>
          <TextField
            label="Good received"
            type="number"
            value={goodInput}
            onChange={(e) => setGoodInput(e.target.value)}
            autoFocus
            fullWidth
            slotProps={{ htmlInput: { min: 0, step: 'any' } }}
          />
          {showScrap && (
            <TextField
              label="Scrapped at vendor"
              type="number"
              value={scrapInput}
              onChange={(e) => setScrapInput(e.target.value)}
              fullWidth
              slotProps={{ htmlInput: { min: 0, step: 'any' } }}
            />
          )}
        </Stack>

        {!showScrap && (
          <Button size="small" onClick={() => setShowScrap(true)} sx={{ mb: 1 }}>
            Some were scrapped
          </Button>
        )}

        <Typography
          variant="body2"
          color={consequence.kind === 'over' ? 'warning.main' : 'text.secondary'}
        >
          {outsideReceiptCaption(consequence, vendorName) || ' '}
        </Typography>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} color="inherit" disabled={busy}>
          Cancel
        </Button>
        <Button
          onClick={() =>
            onSubmit({
              shipmentId: slip?.id ?? null,
              quantityGood: good,
              quantityScrapped: scrapped,
            })
          }
          variant="contained"
          disabled={!canSubmit}
        >
          {busy ? 'Recording…' : 'Record receipt'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
