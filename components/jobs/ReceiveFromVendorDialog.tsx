'use client';

import { useState } from 'react';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import MenuItem from '@mui/material/MenuItem';
import Checkbox from '@mui/material/Checkbox';
import FormControlLabel from '@mui/material/FormControlLabel';
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
  /** Short-close: nothing more is coming back on this slip. */
  closeShipment: boolean;
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
 * A SHORT RETURN IS A CLOSE, NOT A SCRAP NUMBER. "That's everything we're
 * getting" settles the slip's remainder without pretending it came back -- the
 * pieces stay missing from the operation's good total, so the step is still
 * short. That is Sage's short-close and Oracle's quantity-cancelled, and it
 * replaced a `quantity_scrapped` field that disagreed with our own in-house
 * completions, which are deliberately good-only.
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
  const [closeSlip, setCloseSlip] = useState(false);

  const slip = openSlips.find((s) => s.id === slipId) ?? first;
  const outstanding = slip?.outstanding ?? 0;
  const consequence = outsideReceiptConsequence(goodInput, outstanding);
  const good = Number(goodInput) || 0;

  /**
   * THE CLOSE ONLY APPEARS WHEN THERE IS SOMETHING TO WRITE OFF.
   *
   * The field is prefilled with the whole outstanding balance, so the common
   * case is "it all came back" and there is nothing to close — an always-visible
   * checkbox there is noise that invites a tick meaning nothing. It appears the
   * moment somebody types a smaller number, which is exactly when the question
   * "is the rest coming?" becomes real.
   */
  const canClose = good < outstanding;
  // `canClose &&` is not belt-and-braces: tick the box, then raise the quantity
  // back to full, and the control is gone while the state it set is not.
  const willClose = canClose && closeSlip;
  // A close with no receipt is legitimate -- the vendor returned nothing and the
  // shop is writing the slip off.
  const canSubmit = (good > 0 || willClose) && !busy;

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

        <TextField
          label="Amount received"
          type="number"
          value={goodInput}
          onChange={(e) => setGoodInput(e.target.value)}
          autoFocus
          fullWidth
          slotProps={{ htmlInput: { min: 0, step: 'any' } }}
          sx={{ mb: 1 }}
        />

        {/* ONE CHECKBOX, not a second number. The shortfall is settled by
            closing the slip rather than by reconciling a scrap quantity -- the
            pieces stay missing from the good total either way, so the step is
            still short and the shop still re-runs them or drops the order. */}
        {canClose && (
          <FormControlLabel
            control={
              <Checkbox checked={closeSlip} onChange={(e) => setCloseSlip(e.target.checked)} />
            }
            label={
              <Typography variant="body2">
                That&apos;s everything we&apos;re getting — writes off {outstanding - good}
              </Typography>
            }
            sx={{ mb: 1 }}
          />
        )}

        {/* The checkbox and this line must never contradict each other. Ticked,
            the remainder is being written off -- saying "2 still at the vendor"
            underneath it describes the outcome of NOT ticking it. */}
        <Typography
          variant="body2"
          color={consequence.kind === 'over' ? 'warning.main' : 'text.secondary'}
        >
          {willClose
            ? `${slip?.slip_number ?? 'This slip'} closes — nothing more expected back.`
            : outsideReceiptCaption(consequence, vendorName) || ' '}
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
              closeShipment: willClose,
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
