'use client';

/**
 * Inline editor for one vendor on a part's approved list, with its price sheet (plan §3.8;
 * criteria V1, V2). The MaterialRowEditor shape: it replaces the row while open, and the row is
 * saved as a SET by its own Save — a vendor, a unit and a ladder of breaks mean nothing apart
 * (interaction-standards.md §2, "Row editor → Save/Cancel").
 *
 * What it sends, and why:
 *   - EDITING sends only the fields that changed (`savePartVendor` treats a missing key as
 *     "unchanged"), and the price breaks only when the ladder changed — then the whole ladder,
 *     because a given sheet REPLACES the old one. An unchanged unit is never re-resolved, so a
 *     part whose stock unit moved can still have its lead time fixed.
 *   - ADDING sends the status and unit it showed, and only the other fields that were filled.
 *     Adding a vendor that was on the list before brings the same row back, and a blank field then
 *     keeps what the row had — its price sheet included — rather than wiping it.
 * Breaks are in the purchase unit, priced per that unit. The unit is the stock unit, one of the
 * part's conversions, a same-kind preset, or "Another unit…" with its factor, which the access
 * layer stores as the part's conversion before the RPC (one unit name means one amount of a part).
 *
 * Dirty state is derived from the seed, never latched, and reported up so the workspace's exit
 * guard can ask before a tab switch throws the edit away.
 */
import { useEffect, useMemo, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import InputAdornment from '@mui/material/InputAdornment';
import MenuItem from '@mui/material/MenuItem';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import AddIcon from '@mui/icons-material/Add';

import DeleteIconButton from '@/components/common/DeleteIconButton';
import ErrorAlert from '@/components/common/ErrorAlert';
import MissingFieldsNotice from '@/components/common/MissingFieldsNotice';
import VendorAutocomplete from '@/components/vendors/VendorAutocomplete';
import { isValidQuantityInput } from '@/lib/quantityInput';
import {
  factorLabel,
  purchaseUnitOptions,
  unitLabel,
  type UnitConversionRow,
} from '@/lib/purchasing/purchaseUnits';
import { PART_VENDOR_STATUSES, PART_VENDOR_STATUS_CONFIG, type PartVendorStatus } from '@/lib/purchasing/vendorPoStatus';
import type { PartVendorChanges, PartVendorRow } from '@/types/partVendor';
import type { Vendor } from '@/types/vendor';

/** What the card hands `savePartVendor`, less the part id. */
export interface PriceSheetSubmit {
  vendorId: string;
  vendorName: string;
  changes: PartVendorChanges;
  /** "Another unit…": stock units in one of the new unit. */
  purchaseUnitFactor?: number;
  /** Left out: the sheet is untouched. */
  priceBreaks?: Array<{ minQuantity: number; unitPrice: number }>;
}

export interface PriceSheetRowEditorProps {
  companyId: string;
  /** Edit this vendor's row. Leave out to add a vendor. */
  row?: PartVendorRow;
  stockUnit: string | null;
  conversions: readonly UnitConversionRow[];
  /** Vendors on the live list — adding one of them again is refused here, in words. */
  listedVendors: ReadonlyArray<{ vendorId: string; vendorName: string }>;
  saving: boolean;
  error: unknown;
  onSave: (submit: PriceSheetSubmit) => void;
  onCancel: () => void;
  onDirtyChange?: (dirty: boolean) => void;
}

const ANOTHER_UNIT = '__another_unit__';
const DECIMAL = /^(\d+(\.\d*)?|\.\d+)$/;
const WHOLE = /^\d+$/;

interface BreakDraft {
  key: string;
  minQuantity: string;
  unitPrice: string;
}

interface Draft {
  vendor: Vendor | null;
  status: PartVendorStatus;
  statusNote: string;
  vendorPartNumber: string;
  unit: string;
  customUnit: string;
  customFactor: string;
  leadTime: string;
  moq: string;
  quotedOn: string;
  validUntil: string;
  notes: string;
  breaks: BreakDraft[];
}

let breakSeq = 0;
const breakKey = () => `break-${++breakSeq}`;
const asText = (n: number | null | undefined) => (n === null || n === undefined ? '' : String(n));
const trimOrNull = (s: string) => (s.trim() === '' ? null : s.trim());

function seed(row: PartVendorRow | undefined, stockUnit: string | null): Draft {
  if (!row) {
    return {
      vendor: null,
      status: 'approved',
      statusNote: '',
      vendorPartNumber: '',
      unit: stockUnit ?? '',
      customUnit: '',
      customFactor: '',
      leadTime: '',
      moq: '',
      quotedOn: '',
      validUntil: '',
      notes: '',
      // One empty break to fill in: a new vendor is usually added for its price.
      breaks: [{ key: breakKey(), minQuantity: '', unitPrice: '' }],
    };
  }
  return {
    vendor: null,
    status: row.status,
    statusNote: row.statusNote ?? '',
    vendorPartNumber: row.vendorPartNumber ?? '',
    unit: row.purchaseUnit,
    customUnit: '',
    customFactor: '',
    leadTime: asText(row.leadTimeDays),
    moq: asText(row.minimumOrderQuantity),
    quotedOn: row.quotedOn ?? '',
    validUntil: row.validUntil ?? '',
    notes: row.notes ?? '',
    breaks: row.breaks.map((b) => ({
      key: breakKey(),
      minQuantity: String(b.minQuantity),
      unitPrice: String(b.unitPrice),
    })),
  };
}

/** The ladder as numbers, blank rows dropped, lowest quantity first. */
function parsedBreaks(breaks: readonly BreakDraft[]) {
  return breaks
    .filter((b) => b.minQuantity.trim() !== '' || b.unitPrice.trim() !== '')
    .map((b) => ({ minQuantity: Number(b.minQuantity), unitPrice: Number(b.unitPrice) }))
    .sort((a, b) => a.minQuantity - b.minQuantity);
}

/** A comparable fingerprint of the form (without its React keys). */
function fingerprint(d: Draft): string {
  return JSON.stringify({ ...d, vendor: d.vendor?.id ?? null, breaks: d.breaks.map((b) => [b.minQuantity, b.unitPrice]) });
}

export default function PriceSheetRowEditor({
  companyId,
  row,
  stockUnit,
  conversions,
  listedVendors,
  saving,
  error,
  onSave,
  onCancel,
  onDirtyChange,
}: PriceSheetRowEditorProps) {
  const editing = Boolean(row);
  const [initial] = useState(() => seed(row, stockUnit));
  const [draft, setDraft] = useState<Draft>(initial);
  /** The person picked "Bought in" themselves (rather than leaving the stock unit it opens on). */
  const [unitChosen, setUnitChosen] = useState(false);
  const set = (change: Partial<Draft>) => setDraft((d) => ({ ...d, ...change }));

  const dirty = fingerprint(draft) !== fingerprint(initial);
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
  // Closing the editor (saved, cancelled, or the row went away) is never unsaved work.
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

  const options = useMemo(() => purchaseUnitOptions(stockUnit, conversions), [stockUnit, conversions]);
  const custom = draft.unit === ANOTHER_UNIT;
  const unitName = custom ? draft.customUnit.trim() : draft.unit;
  const u = unitName ? unitLabel(unitName) : 'unit';
  const current = options.find((o) => o.unit === draft.unit) ?? null;
  const currentMissing = !custom && draft.unit !== '' && current === null;
  const stock = stockUnit ? unitLabel(stockUnit) : 'stock units';

  const listedAgain = !editing && draft.vendor ? listedVendors.find((v) => v.vendorId === draft.vendor?.id) : undefined;

  const problems = useMemo(() => {
    const out: string[] = [];
    if (!editing && !draft.vendor) out.push('Choose a vendor.');
    if (listedAgain) out.push(`${listedAgain.vendorName} is already on this list. Edit its row instead.`);
    if (draft.vendorPartNumber.trim().length > 64) out.push('Their part # can be at most 64 characters.');
    if (custom) {
      const f = draft.customFactor.trim();
      if (draft.customUnit.trim() === '' || !DECIMAL.test(f) || !(Number(f) > 0)) {
        out.push(`Name the new unit and say how many ${stock} are in one.`);
      }
    } else if (draft.unit === '') {
      out.push('Say what unit it is bought in.');
    }
    const lead = draft.leadTime.trim();
    if (lead && (!WHOLE.test(lead) || Number(lead) > 730)) out.push('Lead time is a whole number of days, up to 730.');
    const moq = draft.moq.trim();
    if (moq && (!DECIMAL.test(moq) || !(Number(moq) > 0))) out.push('A minimum order must be more than zero.');
    if (draft.quotedOn && draft.validUntil && draft.validUntil < draft.quotedOn) {
      out.push("The price can't run out before the date it was quoted.");
    }
    const filled = draft.breaks.filter((b) => b.minQuantity.trim() !== '' || b.unitPrice.trim() !== '');
    const badBreak = filled.some(
      (b) =>
        !DECIMAL.test(b.minQuantity.trim()) ||
        !(Number(b.minQuantity) > 0) ||
        !DECIMAL.test(b.unitPrice.trim()) ||
        !(Number(b.unitPrice) > 0),
    );
    if (badBreak) out.push('Each price break needs a quantity and a price above zero.');
    else {
      const quantities = filled.map((b) => Number(b.minQuantity));
      if (new Set(quantities).size !== quantities.length) out.push("Two price breaks can't start at the same quantity.");
    }
    return out;
  }, [draft, editing, listedAgain, custom, stock]);

  const submit = () => {
    if (problems.length > 0) return;
    const vendorId = row?.vendorId ?? draft.vendor?.id;
    const vendorName = row?.vendorName ?? draft.vendor?.name ?? '';
    if (!vendorId) return;
    const leadTimeDays = draft.leadTime.trim() === '' ? null : Number(draft.leadTime);
    const minimumOrderQuantity = draft.moq.trim() === '' ? null : Number(draft.moq);
    const next: Required<PartVendorChanges> = {
      status: draft.status,
      statusNote: trimOrNull(draft.statusNote),
      vendorPartNumber: trimOrNull(draft.vendorPartNumber),
      purchaseUnit: unitName,
      leadTimeDays,
      minimumOrderQuantity,
      quotedOn: draft.quotedOn || null,
      validUntil: draft.validUntil || null,
      notes: trimOrNull(draft.notes),
    };
    const breaks = parsedBreaks(draft.breaks);
    const out: PriceSheetSubmit = { vendorId, vendorName, changes: {} };

    if (row) {
      const was: Required<PartVendorChanges> = {
        status: row.status,
        statusNote: row.statusNote,
        vendorPartNumber: row.vendorPartNumber,
        purchaseUnit: row.purchaseUnit,
        leadTimeDays: row.leadTimeDays,
        minimumOrderQuantity: row.minimumOrderQuantity,
        quotedOn: row.quotedOn,
        validUntil: row.validUntil,
        notes: row.notes,
      };
      const changes: PartVendorChanges = {};
      if (next.status !== was.status) changes.status = next.status;
      if (next.statusNote !== was.statusNote) changes.statusNote = next.statusNote;
      if (next.vendorPartNumber !== was.vendorPartNumber) changes.vendorPartNumber = next.vendorPartNumber;
      // "Another unit…" is always sent: its factor has to be stored even if the name matches.
      if (next.purchaseUnit !== was.purchaseUnit || custom) changes.purchaseUnit = next.purchaseUnit;
      if (next.leadTimeDays !== was.leadTimeDays) changes.leadTimeDays = next.leadTimeDays;
      if (next.minimumOrderQuantity !== was.minimumOrderQuantity) {
        changes.minimumOrderQuantity = next.minimumOrderQuantity;
      }
      if (next.quotedOn !== was.quotedOn) changes.quotedOn = next.quotedOn;
      if (next.validUntil !== was.validUntil) changes.validUntil = next.validUntil;
      if (next.notes !== was.notes) changes.notes = next.notes;
      out.changes = changes;
      const before = parsedBreaks(seed(row, stockUnit).breaks);
      if (JSON.stringify(breaks) !== JSON.stringify(before)) out.priceBreaks = breaks;
    } else {
      // A re-added vendor keeps what its old row had wherever this form was left blank — its UNIT
      // included, because the sheet and the minimum it keeps are in that unit. The form opens on
      // the stock unit, so sending that unasked turned a revived "$72 per bar" into "$72 per inch".
      // The unit goes only when the person chose it, or typed prices or a minimum in it; left out,
      // the database keeps a revived row's unit and gives a new row the stock unit.
      const unitStated = unitChosen || custom || breaks.length > 0 || next.minimumOrderQuantity !== null;
      const changes: PartVendorChanges = { status: next.status, ...(unitStated ? { purchaseUnit: next.purchaseUnit } : {}) };
      if (next.statusNote !== null) changes.statusNote = next.statusNote;
      if (next.vendorPartNumber !== null) changes.vendorPartNumber = next.vendorPartNumber;
      if (next.leadTimeDays !== null) changes.leadTimeDays = next.leadTimeDays;
      if (next.minimumOrderQuantity !== null) changes.minimumOrderQuantity = next.minimumOrderQuantity;
      if (next.quotedOn !== null) changes.quotedOn = next.quotedOn;
      if (next.validUntil !== null) changes.validUntil = next.validUntil;
      if (next.notes !== null) changes.notes = next.notes;
      out.changes = changes;
      if (breaks.length > 0) out.priceBreaks = breaks;
    }
    if (custom) out.purchaseUnitFactor = Number(draft.customFactor);
    onSave(out);
  };

  const setBreak = (key: string, field: 'minQuantity' | 'unitPrice', value: string) => {
    if (field === 'minQuantity' && !isValidQuantityInput(value)) return;
    if (field === 'unitPrice' && value !== '' && !/^\d*\.?\d{0,5}$/.test(value)) return;
    setDraft((d) => ({ ...d, breaks: d.breaks.map((b) => (b.key === key ? { ...b, [field]: value } : b)) }));
  };

  const label = row ? `${row.vendorName} — price sheet` : 'New vendor';

  return (
    <Box
      role="group"
      aria-label={label}
      sx={{ py: 1.5, px: 1.5, bgcolor: 'action.hover', borderRadius: 1, my: 0.5 }}
    >
      <Typography variant="subtitle2" sx={{ fontWeight: 600, mb: 1.5 }}>
        {row ? `Edit ${row.vendorName}` : 'Add a vendor'}
      </Typography>

      <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        {!row && (
          <Box sx={{ flex: '1 1 240px', minWidth: 220 }}>
            <VendorAutocomplete
              companyId={companyId}
              value={draft.vendor}
              onChange={(v) => set({ vendor: v })}
              label="Vendor"
              required
              disabled={saving}
              error={Boolean(listedAgain)}
              helperText={listedAgain ? 'Already on this list.' : undefined}
            />
          </Box>
        )}
        <TextField
          select
          label="Status"
          size="small"
          value={draft.status}
          onChange={(e) => {
            const status = PART_VENDOR_STATUSES.find((s) => s === e.target.value);
            if (status) set({ status });
          }}
          disabled={saving}
          sx={{ width: 170 }}
        >
          {PART_VENDOR_STATUSES.map((s) => (
            <MenuItem key={s} value={s}>
              {PART_VENDOR_STATUS_CONFIG[s].label}
            </MenuItem>
          ))}
        </TextField>
        {(draft.status !== 'approved' || draft.statusNote !== '') && (
          <TextField
            label="Why (optional)"
            size="small"
            value={draft.statusNote}
            onChange={(e) => set({ statusNote: e.target.value })}
            disabled={saving}
            sx={{ flex: '1 1 220px' }}
          />
        )}
      </Box>

      <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap', alignItems: 'flex-start', mt: 1.5 }}>
        <TextField
          label="Their part #"
          size="small"
          value={draft.vendorPartNumber}
          onChange={(e) => set({ vendorPartNumber: e.target.value })}
          disabled={saving}
          sx={{ width: 190 }}
        />
        <TextField
          select
          label="Bought in"
          size="small"
          value={draft.unit}
          onChange={(e) => {
            setUnitChosen(true);
            set({ unit: e.target.value });
          }}
          disabled={saving}
          helperText={
            currentMissing
              ? `This unit no longer converts to ${stock}. Choose another.`
              : (current && factorLabel(current)) || ' '
          }
          error={currentMissing}
          sx={{ width: 210 }}
        >
          {options.map((o) => (
            <MenuItem key={o.unit} value={o.unit}>
              {o.unit}
              {o.kind === 'same' ? ' (stock unit)' : ''}
            </MenuItem>
          ))}
          {currentMissing && <MenuItem value={draft.unit}>{draft.unit}</MenuItem>}
          <MenuItem value={ANOTHER_UNIT}>Another unit…</MenuItem>
        </TextField>
        {custom && (
          <>
            <TextField
              label="New unit name"
              size="small"
              value={draft.customUnit}
              onChange={(e) => set({ customUnit: e.target.value })}
              helperText="Bar, box, roll…"
              disabled={saving}
              sx={{ width: 170 }}
            />
            <TextField
              label={`How many ${stock} in one`}
              size="small"
              value={draft.customFactor}
              onChange={(e) => {
                if (isValidQuantityInput(e.target.value)) set({ customFactor: e.target.value });
              }}
              helperText="Saved on the part, so one unit name is always one amount."
              slotProps={{ htmlInput: { inputMode: 'decimal' } }}
              disabled={saving}
              sx={{ width: 260 }}
            />
          </>
        )}
        <TextField
          label="Lead time (days)"
          size="small"
          value={draft.leadTime}
          onChange={(e) => set({ leadTime: e.target.value })}
          slotProps={{ htmlInput: { inputMode: 'numeric' } }}
          disabled={saving}
          sx={{ width: 150 }}
        />
        <TextField
          label={`Minimum order (${u})`}
          size="small"
          value={draft.moq}
          onChange={(e) => {
            if (isValidQuantityInput(e.target.value)) set({ moq: e.target.value });
          }}
          slotProps={{ htmlInput: { inputMode: 'decimal' } }}
          disabled={saving}
          sx={{ width: 180 }}
        />
      </Box>

      <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap', mt: 1.5 }}>
        <TextField
          label="Quoted on"
          type="date"
          size="small"
          value={draft.quotedOn}
          onChange={(e) => set({ quotedOn: e.target.value })}
          slotProps={{ inputLabel: { shrink: true } }}
          disabled={saving}
          sx={{ width: 180 }}
        />
        <TextField
          label="Price good until"
          type="date"
          size="small"
          value={draft.validUntil}
          onChange={(e) => set({ validUntil: e.target.value })}
          slotProps={{ inputLabel: { shrink: true } }}
          helperText="After this date the sheet is named on a PO, never used."
          disabled={saving}
          sx={{ width: 260 }}
        />
      </Box>

      <Typography variant="body2" sx={{ fontWeight: 600, mt: 2, mb: 1 }}>
        Price breaks
      </Typography>
      <Typography variant="caption" color="text.secondary" component="div" sx={{ mb: 1 }}>
        The price per {u} from each quantity up. A PO uses the highest break at or below what it orders.
      </Typography>
      {draft.breaks.map((b) => (
        <Box key={b.key} sx={{ display: 'flex', gap: 1.5, alignItems: 'center', mb: 1, flexWrap: 'wrap' }}>
          <TextField
            label={`From (${u})`}
            size="small"
            value={b.minQuantity}
            onChange={(e) => setBreak(b.key, 'minQuantity', e.target.value)}
            slotProps={{ htmlInput: { inputMode: 'decimal' } }}
            disabled={saving}
            sx={{ width: 140 }}
          />
          <TextField
            label={`Price per ${u}`}
            size="small"
            value={b.unitPrice}
            onChange={(e) => setBreak(b.key, 'unitPrice', e.target.value)}
            slotProps={{
              htmlInput: { inputMode: 'decimal' },
              input: { startAdornment: <InputAdornment position="start">$</InputAdornment> },
            }}
            disabled={saving}
            sx={{ width: 170 }}
          />
          <DeleteIconButton
            ariaLabel="Remove this price break"
            onClick={() => setDraft((d) => ({ ...d, breaks: d.breaks.filter((x) => x.key !== b.key) }))}
            disabled={saving}
          />
        </Box>
      ))}
      <Button
        size="small"
        startIcon={<AddIcon />}
        onClick={() => setDraft((d) => ({ ...d, breaks: [...d.breaks, { key: breakKey(), minQuantity: '', unitPrice: '' }] }))}
        disabled={saving}
      >
        Add a price break
      </Button>

      <TextField
        label="Notes"
        size="small"
        value={draft.notes}
        onChange={(e) => set({ notes: e.target.value })}
        multiline
        minRows={2}
        fullWidth
        disabled={saving}
        sx={{ mt: 2 }}
      />

      <ErrorAlert error={error} entity="vendor" sx={{ mt: 1.5 }} />
      <MissingFieldsNotice items={problems} />

      <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 1, mt: 1.5 }}>
        <Button size="small" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button size="small" variant="contained" onClick={submit} disabled={saving || problems.length > 0}>
          {saving ? 'Saving…' : editing ? 'Save changes' : 'Add vendor'}
        </Button>
      </Box>
    </Box>
  );
}
