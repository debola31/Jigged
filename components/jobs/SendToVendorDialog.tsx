'use client';

import { useEffect, useState } from 'react';
import NextLink from 'next/link';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import MuiLink from '@mui/material/Link';
import MenuItem from '@mui/material/MenuItem';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';

import {
  outsideSendCaption,
  outsideSendConsequence,
} from '@/components/operations/operationMath';
import { resolveVendorShipTo } from '@/utils/outsideShipmentsAccess';

export interface SendToVendorSubmit {
  quantity: number;
  dueBackOn: string | null;
  vendorAddressId: string | null;
  notes: string | null;
}

/** The vendor PO line this send will ship against — the slip links itself to it. */
export interface SendToVendorPoLine {
  poNumber: string;
  lineNumber: number;
  /** The PO's page. */
  href: string;
  /** The line's need-by date, which prefills Due back. `null`: nothing to take it from. */
  needByOn: string | null;
}

interface SendToVendorDialogProps {
  open: boolean;
  vendorId: string | null;
  vendorName: string;
  operationName: string;
  partName: string;
  /** ordered − already sent, clamped ≥ 0. Prefills the field. */
  qtyToSend: number;
  /** The routing step's own text — the natural first draft of what to tell the vendor. */
  defaultInstructions?: string | null;
  /**
   * The step's open vendor PO line, or `null` when it is on none (then `createPoHref` offers one).
   * `undefined` while that is unknown: the dialog then says nothing about POs at all.
   */
  poLine?: SendToVendorPoLine | null;
  /** The new-PO form, prefilled with this step. */
  createPoHref?: string;
  busy?: boolean;
  onClose: () => void;
  onSubmit: (v: SendToVendorSubmit) => void;
}

/**
 * Office-side send. The field states its own outcome — prefilled with everything
 * that has not gone out yet — so the common case is one click, and dialling it
 * down is what makes send-50-now-50-later reachable at all.
 *
 * TWO THINGS ARE DELIBERATELY NOT INVENTED:
 *
 * - **Due back comes from the vendor PO line, or nowhere.** The shop's own
 *   need-by date on the step's PO line is a date somebody chose for exactly this
 *   work, so it prefills. Without one the field stays empty: there is no vendor
 *   lead-time data anywhere in the product, so any other date would be invented,
 *   and an invented promise on a printed document is worse than a blank line the
 *   shop fills in.
 * - **A vendor's ship-to is not guessed** when there is more than one and none is
 *   marked default. A second address is as likely to be an accounts-receivable
 *   desk as a second plant.
 *
 * THE PO LINE IS NAMED, NOT PICKED. `create_outside_shipment` links the slip
 * itself to the step's one open outside line (a draft counts), and the PO writers
 * allow only one per step and vendor — so a picker would offer one choice. The
 * dialog says which line, read-only, with a link; correcting a link is the PO
 * page's job. A step on no PO gets a "Create PO for this step" link instead.
 *
 * Missing address WARNS and does not block: the slip prints "(No address on
 * file)" and the parts still need to go out today.
 */
export default function SendToVendorDialog({
  open,
  vendorId,
  vendorName,
  operationName,
  partName,
  qtyToSend,
  defaultInstructions,
  poLine,
  createPoHref,
  busy = false,
  onClose,
  onSubmit,
}: SendToVendorDialogProps) {
  // Mounted fresh each open (the parent renders it only while an op is
  // selected), so initialising from props is enough — no reset effect.
  const [qtyInput, setQtyInput] = useState(() => (qtyToSend > 0 ? String(qtyToSend) : ''));
  const [dueBack, setDueBack] = useState(() => poLine?.needByOn ?? '');
  const [notes, setNotes] = useState(() => defaultInstructions?.trim() ?? '');
  const [addressId, setAddressId] = useState<string>('');
  const [choices, setChoices] = useState<{ id: string; label: string }[]>([]);
  const [requiresChoice, setRequiresChoice] = useState(false);
  const [addressLoaded, setAddressLoaded] = useState(false);

  useEffect(() => {
    if (!open || !vendorId) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await resolveVendorShipTo(vendorId);
        if (cancelled) return;
        setChoices(r.choices);
        setRequiresChoice(r.requiresChoice);
        setAddressId(r.address?.id ?? '');
      } catch {
        // "Couldn't check" is not "no address". Leave the picker empty and let
        // the RPC resolve the default server-side rather than asserting a gap.
        if (!cancelled) setChoices([]);
      } finally {
        if (!cancelled) setAddressLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, vendorId]);

  const consequence = outsideSendConsequence(qtyInput, qtyToSend);
  const qty = Number(qtyInput);
  const canSubmit = Number.isFinite(qty) && qty > 0 && !busy;
  const noAddress = addressLoaded && choices.length === 0;

  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle>Send to {vendorName}</DialogTitle>
      <DialogContent>
        <Typography variant="body2" color="text.secondary" sx={{ mb: poLine === undefined ? 2 : 0.5 }}>
          {operationName} · {partName}
        </Typography>
        {poLine && (
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Ships against{' '}
            <MuiLink component={NextLink} href={poLine.href} sx={{ fontWeight: 500 }}>
              {poLine.poNumber} line {poLine.lineNumber}
            </MuiLink>
          </Typography>
        )}
        {poLine === null && (
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Not on a purchase order
            {createPoHref && (
              <>
                {' · '}
                <MuiLink component={NextLink} href={createPoHref}>
                  Create PO for this step
                </MuiLink>
              </>
            )}
          </Typography>
        )}

        <TextField
          label="Pieces going out"
          type="number"
          value={qtyInput}
          onChange={(e) => setQtyInput(e.target.value)}
          autoFocus
          fullWidth
          slotProps={{ htmlInput: { min: 0, step: 'any' } }}
          helperText={outsideSendCaption(consequence, vendorName) || ' '}
          sx={{ mb: 2 }}
        />

        <TextField
          label="Due back"
          type="date"
          value={dueBack}
          onChange={(e) => setDueBack(e.target.value)}
          fullWidth
          slotProps={{ inputLabel: { shrink: true } }}
          helperText={
            poLine?.needByOn && dueBack === poLine.needByOn
              ? `From ${poLine.poNumber}'s need-by date. Prints on the slip.`
              : 'Optional. Prints on the slip so the vendor knows when you need them.'
          }
          sx={{ mb: 2 }}
        />

        {requiresChoice && (
          <Alert severity="info" sx={{ mb: 2 }}>
            {vendorName} has more than one address and none is marked as the default. Pick where
            these parts go.
          </Alert>
        )}
        {choices.length > 1 && (
          <TextField
            select
            label="Ship to"
            value={addressId}
            onChange={(e) => setAddressId(e.target.value)}
            fullWidth
            sx={{ mb: 2 }}
          >
            {choices.map((c) => (
              <MenuItem key={c.id} value={c.id}>
                {c.label}
              </MenuItem>
            ))}
          </TextField>
        )}
        {choices.length === 1 && (
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Ship to: {choices[0].label}
          </Typography>
        )}
        {noAddress && (
          <Alert severity="warning" sx={{ mb: 2 }}>
            No address on file for {vendorName}. The slip will print without a ship-to block — add
            one on the vendor if you want it on future slips.
          </Alert>
        )}

        <TextField
          label="Instructions for the vendor"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          fullWidth
          multiline
          minRows={2}
          helperText="Prints on the slip."
        />

        <Box sx={{ mt: 1 }} />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} color="inherit" disabled={busy}>
          Cancel
        </Button>
        <Button
          onClick={() =>
            onSubmit({
              quantity: qty,
              dueBackOn: dueBack || null,
              vendorAddressId: addressId || null,
              notes: notes.trim() || null,
            })
          }
          variant="contained"
          disabled={!canSubmit}
        >
          {busy ? 'Sending…' : 'Send & print slip'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
