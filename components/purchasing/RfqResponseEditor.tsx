'use client';

/**
 * Record one invited vendor's quote (plan §3.9 "Response grid"; criterion Q2).
 *
 * A price per the RFQ line's unit at each quantity, and per line the lead time, the minimum order,
 * how long the price is good for and the vendor's part number — or No bid.
 *
 * `saveVendorRfqResponses` REPLACES the vendor's whole quote: an answer the payload leaves out is
 * deleted, and a key a response leaves out is cleared. So this editor sends everything it means to
 * keep, which is three rules the tests hold it to:
 *   - an AWARDED line is read-only and goes back exactly as stored (the database refuses any change);
 *   - a note recorded elsewhere (the AI assistant can record one) rides along unchanged;
 *   - a per-line field whose stored values differ by quantity starts blank, and blank keeps each
 *     quantity's own value — typing one applies it to every quantity on the line.
 * A blank price at a quantity means "not quoted at that quantity" and is left out.
 */
import { useMemo, useState } from 'react';
import posthog from 'posthog-js';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import FormControlLabel from '@mui/material/FormControlLabel';
import InputAdornment from '@mui/material/InputAdornment';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';

import ErrorAlert from '@/components/common/ErrorAlert';
import MissingFieldsNotice from '@/components/common/MissingFieldsNotice';
import { formatMoney } from '@/lib/money';
import { vendorPoLineAmount } from '@/lib/purchasing/amount';
import { formatUnitQuantity, unitLabel } from '@/lib/purchasing/purchaseUnits';
import { saveVendorRfqResponses } from '@/utils/vendorRfqAccess';
import type { VendorRfqDetail, VendorRfqLine, VendorRfqResponse, VendorRfqResponseInput } from '@/types/vendorRfq';

export interface RfqResponseEditorProps {
  open: boolean;
  rfq: VendorRfqDetail;
  /** The invited vendor whose quote this is. */
  invitationId: string | null;
  onClose: () => void;
  /** After a save: the page refreshes once. */
  onSaved: () => void;
}

type LineField = 'leadTime' | 'moq' | 'validUntil' | 'vendorPartNumber';
const LINE_FIELDS: readonly LineField[] = ['leadTime', 'moq', 'validUntil', 'vendorPartNumber'];

interface LineDraft {
  lineId: string;
  noBid: boolean;
  /** Price text per quantity, keyed by the quantity as a string. */
  prices: Record<string, string>;
  fields: Record<LineField, string>;
  /** The stored values of a field differ by quantity: blank keeps each one. */
  mixed: Record<LineField, boolean>;
  awarded: boolean;
}

const DECIMAL = /^(\d+(\.\d*)?|\.\d+)$/;
const WHOLE = /^\d+$/;

function valueOf(r: VendorRfqResponse, field: LineField): string | number | null {
  if (field === 'leadTime') return r.leadTimeDays;
  if (field === 'moq') return r.minimumOrderQuantity;
  if (field === 'validUntil') return r.validUntil;
  return r.vendorPartNumber;
}

function seedLine(line: VendorRfqLine, own: readonly VendorRfqResponse[]): LineDraft {
  const prices: Record<string, string> = {};
  for (const q of line.quantities) {
    const r = own.find((x) => x.quantity === q);
    prices[String(q)] = r && !r.noBid && r.unitPrice !== null ? String(r.unitPrice) : '';
  }
  const fields: Record<LineField, string> = { leadTime: '', moq: '', validUntil: '', vendorPartNumber: '' };
  const mixed: Record<LineField, boolean> = { leadTime: false, moq: false, validUntil: false, vendorPartNumber: false };
  for (const field of LINE_FIELDS) {
    const values = new Set(own.map((r) => valueOf(r, field)));
    if (values.size > 1) mixed[field] = true;
    else if (values.size === 1) {
      const [v] = [...values];
      fields[field] = v === null || v === undefined ? '' : String(v);
    }
  }
  return {
    lineId: line.id,
    noBid: own.length > 0 && own.every((r) => r.noBid),
    prices,
    fields,
    mixed,
    awarded: own.some((r) => r.awardedAt !== null),
  };
}

/** Exactly as stored — the shape the database compares an awarded answer against. */
function asStored(r: VendorRfqResponse): VendorRfqResponseInput {
  return {
    lineId: r.lineId,
    quantity: r.quantity,
    ...(r.noBid ? {} : { unitPrice: r.unitPrice }),
    noBid: r.noBid,
    leadTimeDays: r.leadTimeDays,
    minimumOrderQuantity: r.minimumOrderQuantity,
    validUntil: r.validUntil,
    vendorPartNumber: r.vendorPartNumber,
    notes: r.notes,
  };
}

export default function RfqResponseEditor({ open, rfq, invitationId, onClose, onSaved }: RfqResponseEditorProps) {
  const invitation = rfq.invitations.find((i) => i.id === invitationId) ?? null;
  const lines = useMemo(() => [...rfq.lines].sort((a, b) => a.lineNumber - b.lineNumber), [rfq.lines]);
  const own = useMemo(
    () => rfq.responses.filter((r) => r.invitationId === invitationId),
    [rfq.responses, invitationId],
  );

  const [drafts, setDrafts] = useState<Record<string, LineDraft>>(() =>
    Object.fromEntries(lines.map((l) => [l.id, seedLine(l, own.filter((r) => r.lineId === l.id))])),
  );
  const [reference, setReference] = useState(invitation?.vendorQuoteReference ?? '');
  const [quotedOn, setQuotedOn] = useState(invitation?.quotedOn ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const update = (lineId: string, change: (d: LineDraft) => LineDraft) =>
    setDrafts((prev) => ({ ...prev, [lineId]: change(prev[lineId]) }));

  const problems = useMemo(() => {
    const out: string[] = [];
    for (const line of lines) {
      const d = drafts[line.id];
      if (!d || d.awarded) continue;
      const label = `Line ${line.lineNumber}`;
      if (!d.noBid && Object.values(d.prices).some((p) => p.trim() !== '' && !DECIMAL.test(p.trim()))) {
        out.push(`${label}: enter prices as numbers.`);
      }
      const lead = d.fields.leadTime.trim();
      if (lead && (!WHOLE.test(lead) || Number(lead) > 730)) {
        out.push(`${label}: lead time is a whole number of days, up to 730.`);
      }
      const moq = d.fields.moq.trim();
      if (moq && (!DECIMAL.test(moq) || !(Number(moq) > 0))) {
        out.push(`${label}: a minimum order must be more than zero.`);
      }
      if (d.fields.vendorPartNumber.trim().length > 64) {
        out.push(`${label}: a vendor part number can be at most 64 characters.`);
      }
    }
    if (reference.trim().length > 64) out.push('Their quote # can be at most 64 characters.');
    return out;
  }, [lines, drafts, reference]);

  const buildPayload = (): VendorRfqResponseInput[] => {
    const payload: VendorRfqResponseInput[] = [];
    for (const line of lines) {
      const d = drafts[line.id];
      const stored = own.filter((r) => r.lineId === line.id);
      if (d.awarded) {
        payload.push(...stored.map(asStored));
        continue;
      }
      const resolve = (field: LineField, existing: VendorRfqResponse | undefined): string | null => {
        const typed = d.fields[field].trim();
        if (typed !== '') return typed;
        if (d.mixed[field] && existing) {
          const v = valueOf(existing, field);
          return v === null || v === undefined ? null : String(v);
        }
        return null;
      };
      for (const q of line.quantities) {
        const existing = stored.find((r) => r.quantity === q);
        const priceText = d.prices[String(q)]?.trim() ?? '';
        if (!d.noBid && priceText === '') continue; // not quoted at this quantity
        const lead = resolve('leadTime', existing);
        const moq = resolve('moq', existing);
        payload.push({
          lineId: line.id,
          quantity: q,
          ...(d.noBid ? {} : { unitPrice: Number(priceText) }),
          noBid: d.noBid,
          leadTimeDays: lead === null ? null : Number(lead),
          minimumOrderQuantity: moq === null ? null : Number(moq),
          validUntil: resolve('validUntil', existing),
          vendorPartNumber: resolve('vendorPartNumber', existing),
          notes: existing?.notes ?? null,
        });
      }
    }
    return payload;
  };

  const handleSave = async () => {
    if (!invitation || problems.length > 0) return;
    setSaving(true);
    setError(null);
    const payload = buildPayload();
    try {
      await saveVendorRfqResponses(invitation.id, payload, {
        vendorQuoteReference: reference.trim() === '' ? null : reference.trim(),
        quotedOn: quotedOn === '' ? null : quotedOn,
      });
      posthog.capture('vendor rfq response recorded', {
        priced_cell_count: payload.filter((r) => !r.noBid && r.unitPrice !== null && r.unitPrice !== undefined).length,
        no_bid_count: payload.filter((r) => r.noBid).length,
        has_lead_time: payload.some((r) => r.leadTimeDays !== null && r.leadTimeDays !== undefined),
        has_valid_until: payload.some((r) => Boolean(r.validUntil)),
      });
      onSaved();
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setSaving(false);
    }
  };

  const declined = invitation?.declinedAt != null;

  return (
    <Dialog open={open} onClose={() => !saving && onClose()} fullWidth maxWidth="md">
      <DialogTitle>{invitation ? `Record ${invitation.vendorName}'s quote` : 'Record a quote'}</DialogTitle>
      <DialogContent dividers>
        {!invitation ? (
          <Alert severity="info">That vendor isn&apos;t on this RFQ.</Alert>
        ) : declined ? (
          <Alert severity="info">
            {invitation.vendorName} declined this RFQ. Undo the decline to record their quote.
          </Alert>
        ) : (
          <>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              Type the prices as {invitation.vendorName} quoted them, per each line&apos;s unit. Leave a price blank if
              they didn&apos;t quote that quantity.
            </Typography>
            <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap', mb: 2 }}>
              <TextField
                label="Their quote #"
                size="small"
                value={reference}
                onChange={(e) => setReference(e.target.value)}
                disabled={saving}
                sx={{ width: 220 }}
              />
              <TextField
                label="Quoted on"
                type="date"
                size="small"
                value={quotedOn}
                onChange={(e) => setQuotedOn(e.target.value)}
                disabled={saving}
                slotProps={{ inputLabel: { shrink: true } }}
                sx={{ width: 200 }}
              />
            </Box>

            {lines.map((line) => {
              const d = drafts[line.id];
              const unit = unitLabel(line.unit);
              const label = `Line ${line.lineNumber} · ${line.partName ?? line.description}`;
              const locked = saving || d.awarded;
              const mixedHelp = 'Differs by quantity. Leave blank to keep each.';
              return (
                <Box
                  key={line.id}
                  role="group"
                  aria-label={label}
                  sx={{ border: 1, borderColor: 'divider', borderRadius: 1, p: 2, mb: 2 }}
                >
                  <Box
                    sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1, flexWrap: 'wrap' }}
                  >
                    <Box>
                      <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
                        {label}
                      </Typography>
                      {line.partName && line.description !== line.partName && (
                        <Typography variant="caption" color="text.secondary" component="div">
                          {line.description}
                        </Typography>
                      )}
                    </Box>
                    <FormControlLabel
                      control={
                        <Checkbox
                          checked={d.noBid}
                          disabled={locked}
                          onChange={(e) => {
                            const noBid = e.target.checked;
                            update(line.id, (prev) => ({
                              ...prev,
                              noBid,
                              // No bid clears the prices: a no-bid has none.
                              prices: noBid
                                ? Object.fromEntries(Object.keys(prev.prices).map((k) => [k, '']))
                                : prev.prices,
                            }));
                          }}
                        />
                      }
                      label="No bid on this line"
                    />
                  </Box>

                  {d.awarded && (
                    <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                      Awarded — this line&apos;s quote can&apos;t change.
                    </Typography>
                  )}

                  <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap', mt: 1 }}>
                    {line.quantities.map((q) => {
                      const key = String(q);
                      const text = d.prices[key] ?? '';
                      const valid = text.trim() !== '' && DECIMAL.test(text.trim());
                      return (
                        <TextField
                          key={key}
                          label={`Price at ${formatUnitQuantity(q)} ${unit}`}
                          size="small"
                          value={text}
                          disabled={locked || d.noBid}
                          error={text.trim() !== '' && !valid}
                          onChange={(e) =>
                            update(line.id, (prev) => ({ ...prev, prices: { ...prev.prices, [key]: e.target.value } }))
                          }
                          helperText={valid ? `= ${formatMoney(vendorPoLineAmount(q, Number(text)))}` : ' '}
                          slotProps={{
                            htmlInput: { inputMode: 'decimal' },
                            input: {
                              startAdornment: <InputAdornment position="start">$</InputAdornment>,
                              endAdornment: <InputAdornment position="end">/ {unit}</InputAdornment>,
                            },
                          }}
                          sx={{ width: 210 }}
                        />
                      );
                    })}
                  </Box>

                  <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap', mt: 1 }}>
                    <TextField
                      label="Lead time (days)"
                      size="small"
                      value={d.fields.leadTime}
                      disabled={locked}
                      onChange={(e) =>
                        update(line.id, (prev) => ({ ...prev, fields: { ...prev.fields, leadTime: e.target.value } }))
                      }
                      helperText={d.mixed.leadTime && !d.fields.leadTime ? mixedHelp : ' '}
                      slotProps={{ htmlInput: { inputMode: 'numeric' } }}
                      sx={{ width: 170 }}
                    />
                    <TextField
                      label={`Minimum order (${unit})`}
                      size="small"
                      value={d.fields.moq}
                      disabled={locked}
                      onChange={(e) =>
                        update(line.id, (prev) => ({ ...prev, fields: { ...prev.fields, moq: e.target.value } }))
                      }
                      helperText={d.mixed.moq && !d.fields.moq ? mixedHelp : ' '}
                      slotProps={{ htmlInput: { inputMode: 'decimal' } }}
                      sx={{ width: 190 }}
                    />
                    <TextField
                      label="Price good until"
                      type="date"
                      size="small"
                      value={d.fields.validUntil}
                      disabled={locked}
                      onChange={(e) =>
                        update(line.id, (prev) => ({ ...prev, fields: { ...prev.fields, validUntil: e.target.value } }))
                      }
                      helperText={d.mixed.validUntil && !d.fields.validUntil ? mixedHelp : ' '}
                      slotProps={{ inputLabel: { shrink: true } }}
                      sx={{ width: 190 }}
                    />
                    <TextField
                      label="Their part #"
                      size="small"
                      value={d.fields.vendorPartNumber}
                      disabled={locked}
                      onChange={(e) =>
                        update(line.id, (prev) => ({
                          ...prev,
                          fields: { ...prev.fields, vendorPartNumber: e.target.value },
                        }))
                      }
                      helperText={d.mixed.vendorPartNumber && !d.fields.vendorPartNumber ? mixedHelp : ' '}
                      sx={{ width: 190 }}
                    />
                  </Box>
                </Box>
              );
            })}

            <ErrorAlert error={error} entity="quote" onClose={() => setError(null)} sx={{ mt: 1 }} />
            <MissingFieldsNotice items={problems} />
          </>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={saving}>
          {invitation && !declined ? 'Cancel' : 'Close'}
        </Button>
        {invitation && !declined && (
          <Button variant="contained" onClick={handleSave} disabled={saving || problems.length > 0}>
            {saving ? 'Saving…' : 'Save quote'}
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}
