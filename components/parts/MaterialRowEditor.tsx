'use client';

import { useEffect, useMemo, useState } from 'react';
import Box from '@mui/material/Box';
import TextField from '@mui/material/TextField';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Typography from '@mui/material/Typography';
import MenuItem from '@mui/material/MenuItem';
import InputAdornment from '@mui/material/InputAdornment';
import Switch from '@mui/material/Switch';
import FormControlLabel from '@mui/material/FormControlLabel';
import Link from 'next/link';

import PartAutocomplete, { type PartSelectOption } from '@/components/parts/PartAutocomplete';
import { getPartUnitConversions, getPart, getComputedPartCost } from '@/utils/partsAccess';
import { defaultConsumeWholeUnits, unitShortLabel } from '@/lib/standardUnits';

export type { PartSelectOption };

export interface MaterialEditorValue {
  childPart: PartSelectOption | null;
  /** Per-part consumption of the material, in `unit`. Canonical stored value. */
  quantity: string;
  unit: string;
  /** Ceiling consumption to whole units at the order qty (discrete stock). */
  consume_whole_units: boolean;
  /**
   * The made child's costing batch quantity, to write to the CHILD part on save.
   * `number` = set it, `null` = clear (revert to default), `undefined` = leave
   * untouched. Only surfaced (and thus only ≠ undefined) for a made child
   * consumed as a fraction — the case where a made part's setup-amortized cost
   * needs a fixed batch to be valued against.
   */
  childCostingBatchQuantity?: number | null;
}

/** Format a yield ratio for display — collapse near-integers to a clean int. */
function formatYield(y: number): string {
  if (!Number.isFinite(y) || y <= 0) return '';
  const rounded = Math.round(y);
  return Math.abs(y - rounded) < 1e-9 ? String(rounded) : String(Number(y.toFixed(4)));
}

function parseNum(s: string): number | null {
  const n = parseFloat(s);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export interface MaterialRowEditorProps {
  companyId: string;
  /** Part IDs to hide from the child-part picker (e.g. the parent itself). */
  excludeIds?: string[];
  /** When provided, the editor is in edit mode for an existing material row. */
  initial?: MaterialEditorValue;
  /** When true, the child-part picker is disabled (edit mode). */
  lockChildPart?: boolean;
  saving?: boolean;
  /** Inline error to display under the row (e.g. cycle precheck failure). */
  error?: string | null;
  onSave: (value: MaterialEditorValue) => void;
  onCancel: () => void;
}

const EMPTY_VALUE: MaterialEditorValue = {
  childPart: null,
  quantity: '',
  unit: '',
  consume_whole_units: false,
};

/**
 * Which way the consumption field reads. A stored per-part quantity below 1
 * (e.g. 0.05 strips/part) is the "yield" pattern — many parts cut from one
 * material unit — so edit mode shows it as a yield. New lines default their
 * framing from the material's unit category instead (see the mode effect).
 */
function deriveMode(quantity: string): { mode: 'per_part' | 'yield'; yieldStr: string } {
  const q = parseFloat(quantity);
  if (Number.isFinite(q) && q > 0 && q < 1) {
    return { mode: 'yield', yieldStr: formatYield(1 / q) };
  }
  return { mode: 'per_part', yieldStr: '' };
}

const currency = (n: number): string =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });

/**
 * Inline editor for a single Materials row on the part detail page.
 *
 * The whole material-yield experience lives here (no spillover onto the Pricing
 * card): how much of a material a part consumes — entered as a plain per-part
 * quantity, or as a yield ("20 parts per strip") when the material is discrete
 * stock — whether it's drawn in whole units, and, for a made child consumed as
 * a fraction, the batch it's costed at.
 */
export default function MaterialRowEditor({
  companyId,
  excludeIds,
  initial,
  lockChildPart = false,
  saving = false,
  error,
  onSave,
  onCancel,
}: MaterialRowEditorProps) {
  const [value, setValue] = useState<MaterialEditorValue>(initial ?? EMPTY_VALUE);

  // `value.quantity` is always the canonical per-part figure; `yieldStr` is the
  // raw yield-field text when the field is showing the yield framing.
  const [inputMode, setInputMode] = useState<'per_part' | 'yield'>(
    () => deriveMode((initial ?? EMPTY_VALUE).quantity).mode,
  );
  const [yieldStr, setYieldStr] = useState<string>(
    () => deriveMode((initial ?? EMPTY_VALUE).quantity).yieldStr,
  );
  // Manual overrides latch so the unit-category defaults don't clobber a choice.
  const [modeTouched, setModeTouched] = useState<boolean>(!!initial);
  const [wholeUnitsTouched, setWholeUnitsTouched] = useState<boolean>(!!initial);

  // Batch qty for the made child (string field), + its derived unit cost.
  const [batchQtyStr, setBatchQtyStr] = useState<string>(
    initial?.childCostingBatchQuantity != null ? String(initial.childCostingBatchQuantity) : '',
  );
  const [batchCost, setBatchCost] = useState<number | null | 'loading'>(null);

  const [conversionUnits, setConversionUnits] = useState<string[]>([]);
  const [conversionsLoading, setConversionsLoading] = useState(false);

  // Reset when initial changes (cancel-add then edit a different row).
  useEffect(() => {
    const next = initial ?? EMPTY_VALUE;
    setValue(next);
    const derived = deriveMode(next.quantity);
    setInputMode(derived.mode);
    setYieldStr(derived.yieldStr);
    setModeTouched(!!initial);
    setWholeUnitsTouched(!!initial);
    setBatchQtyStr(next.childCostingBatchQuantity != null ? String(next.childCostingBatchQuantity) : '');
  }, [initial]);

  const isCountUnit = defaultConsumeWholeUnits(value.unit);

  // Default the consumption framing + whole-unit switch from the unit category,
  // until the user overrides either. Count/discrete stock reads as a yield and
  // draws in whole units; bulk material reads as amount-per-part and fractional.
  useEffect(() => {
    if (!value.unit) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setValue((prev) => {
      if (wholeUnitsTouched) return prev;
      const nextWhole = defaultConsumeWholeUnits(prev.unit);
      return prev.consume_whole_units === nextWhole
        ? prev
        : { ...prev, consume_whole_units: nextWhole };
    });
    if (!modeTouched) {
      const desired = isCountUnit ? 'yield' : 'per_part';
      if (desired !== inputMode) {
        if (desired === 'yield') {
          const q = parseFloat(value.quantity);
          setYieldStr(Number.isFinite(q) && q > 0 ? formatYield(1 / q) : '');
        }
        setInputMode(desired);
      }
    }
    // inputMode / value.quantity are read only to seed the switch; unit drives this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value.unit, wholeUnitsTouched, modeTouched, isCountUnit]);

  // Load the child's secondary units + current batch qty on selection.
  useEffect(() => {
    const child = value.childPart;
    if (!child?.id) {
      setConversionUnits([]);
      return;
    }
    let cancelled = false;
    setConversionsLoading(true);
    getPartUnitConversions(child.id)
      .then((rows) => !cancelled && setConversionUnits(rows.map((r) => r.from_unit)))
      .catch(() => !cancelled && setConversionUnits([]))
      .finally(() => !cancelled && setConversionsLoading(false));

    // Pull the child's stored batch qty so editing it here starts from truth.
    // Only for made children (bought parts have no batch-cost basis). Skipped
    // in edit mode, where `initial.childCostingBatchQuantity` already seeded it.
    if (!initial && child.source === 'made') {
      getPart(child.id)
        .then((p) => {
          if (cancelled || !p) return;
          setBatchQtyStr(p.costing_batch_quantity != null ? String(p.costing_batch_quantity) : '');
        })
        .catch(() => undefined);
    }
    return () => {
      cancelled = true;
    };
  }, [value.childPart, initial]);

  const unitOptions = useMemo<string[]>(() => {
    const child = value.childPart;
    if (!child) return [];
    const list: string[] = [];
    if (child.primary_unit) list.push(child.primary_unit);
    for (const u of conversionUnits) if (!list.includes(u)) list.push(u);
    return list;
  }, [value.childPart, conversionUnits]);

  const onlyPrimaryAvailable =
    !!value.childPart && !!value.childPart.primary_unit && conversionUnits.length === 0;

  // Snap the unit to the child's primary when the typed one isn't valid.
  useEffect(() => {
    if (conversionsLoading) return;
    const child = value.childPart;
    if (!child) return;
    if (unitOptions.includes(value.unit)) return;
    setValue((prev) => ({ ...prev, unit: child.primary_unit ?? '' }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unitOptions, conversionsLoading]);

  const unitShort = unitShortLabel(value.unit) ?? (value.unit || 'unit');
  const perPartQty = parseNum(value.quantity);
  // Rounding to whole units only changes the cost when consumption is fractional
  // (a yield, or a non-integer per-part amount): ceil(N×q) = N×q for integer q.
  // So the whole-unit control is only meaningful — and only shown — then.
  const isFractionalConsumption = perPartQty !== null && !Number.isInteger(perPartQty);
  // A made child consumed as a fraction (< 1 per part) is exactly when the
  // batch-cost basis matters — surface the field then and only then.
  const showBatchBasis = value.childPart?.source === 'made' && perPartQty !== null && perPartQty < 1;
  const batchQty = parseNum(batchQtyStr);

  // Derive the child's unit cost at the entered batch, so "batch of 25" reads
  // as the concrete "$109 / strip" the shop cares about.
  useEffect(() => {
    if (!showBatchBasis || !value.childPart?.id || batchQty === null) {
      setBatchCost(null);
      return;
    }
    let cancelled = false;
    setBatchCost('loading');
    const handle = setTimeout(() => {
      getComputedPartCost(value.childPart!.id, batchQty)
        .then((c) => !cancelled && setBatchCost(c))
        .catch(() => !cancelled && setBatchCost(null));
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [showBatchBasis, value.childPart, batchQty]);

  const handlePartChange = (option: PartSelectOption | null) => {
    setValue((prev) => ({ ...prev, childPart: option, unit: option?.primary_unit ?? '' }));
    setBatchQtyStr('');
  };

  const switchMode = (next: 'per_part' | 'yield') => {
    setModeTouched(true);
    if (next === 'yield') {
      const q = parseFloat(value.quantity);
      setYieldStr(Number.isFinite(q) && q > 0 ? formatYield(1 / q) : '');
    }
    setInputMode(next);
  };

  const handleYieldChange = (s: string) => {
    setYieldStr(s);
    const y = parseFloat(s);
    setValue((prev) => ({ ...prev, quantity: Number.isFinite(y) && y > 0 ? String(1 / y) : '' }));
  };

  const canSave =
    !!value.childPart &&
    perPartQty !== null &&
    !!value.unit?.trim() &&
    unitOptions.includes(value.unit);

  const submit = () => {
    if (!canSave) return;
    // Only touch the child's batch qty when the field applied (made + fractional);
    // undefined tells PartBomPanel to leave it alone otherwise.
    onSave({ ...value, childCostingBatchQuantity: showBatchBasis ? batchQty : undefined });
  };

  return (
    <Box sx={{ py: 1.5, px: 1, bgcolor: 'action.hover', borderRadius: 1, my: 0.5 }}>
      <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1.5, flexWrap: 'wrap' }}>
        <Box sx={{ flex: '1 1 240px', minWidth: 200 }}>
          <PartAutocomplete
            companyId={companyId}
            value={value.childPart}
            onChange={handlePartChange}
            excludeIds={excludeIds}
            disabled={lockChildPart || saving}
            label="Material part"
            required
            autoFocus={!lockChildPart}
          />
        </Box>

        <TextField
          select
          label="Unit"
          value={value.childPart && unitOptions.includes(value.unit) ? value.unit : ''}
          onChange={(e) => setValue((prev) => ({ ...prev, unit: e.target.value }))}
          required
          size="small"
          disabled={saving || !value.childPart || conversionsLoading || onlyPrimaryAvailable}
          sx={{ width: 130 }}
          slotProps={{
            input: {
              endAdornment: conversionsLoading ? (
                <InputAdornment position="end">
                  <CircularProgress size={14} />
                </InputAdornment>
              ) : undefined,
            },
          }}
        >
          {unitOptions.length === 0 && (
            <MenuItem value="" disabled>
              {value.childPart ? 'No units available' : 'Pick a part first'}
            </MenuItem>
          )}
          {unitOptions.map((u) => (
            <MenuItem key={u} value={u}>
              {u}
              {value.childPart?.primary_unit === u ? ' (primary)' : ''}
            </MenuItem>
          ))}
        </TextField>

        {/* Consumption: a single field framed by the material's unit — a yield
            for discrete/count stock, an amount-per-part for bulk material — with
            a legible action to switch framing. `value.quantity` stays the
            canonical per-part value regardless of framing. */}
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5, minWidth: 220 }}>
          {inputMode === 'yield' ? (
            <TextField
              label={`Yield — parts per ${unitShort}`}
              type="number"
              value={yieldStr}
              onChange={(e) => handleYieldChange(e.target.value)}
              required
              InputLabelProps={{ shrink: true }}
              inputProps={{ min: 0, step: 'any', inputMode: 'decimal' }}
              size="small"
              disabled={saving}
              sx={{ width: 230 }}
              helperText={
                perPartQty !== null
                  ? `Uses ${Number(perPartQty.toFixed(4))} ${unitShort} per part`
                  : `How many parts you get from one ${unitShort}`
              }
            />
          ) : (
            <TextField
              label={value.unit ? `${unitShort} per part` : 'Qty per part'}
              type="number"
              value={value.quantity}
              onChange={(e) => setValue((prev) => ({ ...prev, quantity: e.target.value }))}
              required
              InputLabelProps={{ shrink: true }}
              inputProps={{ min: 0, step: 'any', inputMode: 'decimal' }}
              size="small"
              disabled={saving}
              sx={{ width: 230 }}
              helperText="Material used to make one part"
            />
          )}
          {/* Yield is the reason this feature exists (many parts from one
              discrete unit) — surface it as a legible action, not a faint link. */}
          <Button
            variant="text"
            size="small"
            onClick={() => switchMode(inputMode === 'yield' ? 'per_part' : 'yield')}
            disabled={saving}
            sx={{ alignSelf: 'flex-start', textTransform: 'none', px: 0.75, fontWeight: 600 }}
          >
            {inputMode === 'yield'
              ? '← Switch to amount per part'
              : `Cut several parts from one ${unitShort}? Switch to yield →`}
          </Button>
        </Box>
      </Box>

      {/* Whole-unit (ceiling) consumption. Only meaningful — and only shown —
          when consumption is fractional (a yield, or a non-integer per-part
          amount); for whole-number consumption ceil(N×q)=N×q, so it is a no-op.
          Defaulted from the unit category (count → on); overridable. */}
      {isFractionalConsumption && (
        <Box sx={{ mt: 1, ml: 0.5 }}>
          <FormControlLabel
            sx={{ mr: 0 }}
            control={
              <Switch
                size="small"
                checked={value.consume_whole_units}
                onChange={(e) => {
                  setWholeUnitsTouched(true);
                  setValue((prev) => ({ ...prev, consume_whole_units: e.target.checked }));
                }}
                disabled={saving}
              />
            }
            label={
              <Typography variant="body2">
                {`Round up to whole ${unitShort} per job`}
              </Typography>
            }
          />
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', ml: 6 }}>
            {value.consume_whole_units
              ? `Discrete stock — a job can't use part of one ${unitShort}, so it rounds up.`
              : `Continuous material — a job can use a fraction of one ${unitShort}.`}
          </Typography>
        </Box>
      )}

      {/* Batch cost basis — shown only for a made child consumed as a fraction,
          which is exactly when a made part's setup-amortized cost needs a fixed
          batch to be valued against. Writes to the child part. */}
      {showBatchBasis && (
        <Box
          sx={{
            mt: 1,
            p: 1.25,
            borderRadius: 1,
            border: (theme) => `1px solid ${theme.palette.divider}`,
            display: 'flex',
            alignItems: 'center',
            gap: 1.5,
            flexWrap: 'wrap',
          }}
        >
          <Typography variant="body2" sx={{ flexBasis: '100%' }}>
            <strong>{value.childPart?.part_name}</strong> is made — cost it at the batch you
            produce it in (setup spreads across the batch). Applies wherever it&apos;s used.
          </Typography>
          <TextField
            label={`Batch qty (${unitShort})`}
            type="number"
            value={batchQtyStr}
            onChange={(e) => setBatchQtyStr(e.target.value)}
            placeholder="Default"
            InputLabelProps={{ shrink: true }}
            inputProps={{ min: 0, step: 'any', inputMode: 'decimal' }}
            size="small"
            disabled={saving}
            sx={{ width: 150 }}
          />
          <Typography variant="body2" sx={{ fontWeight: batchQty === null ? 400 : 600 }}>
            {batchQty === null
              ? 'valued at the quantity each order draws'
              : batchCost === 'loading'
                ? '…'
                : batchCost != null
                  ? `= ${currency(batchCost)} / ${unitShort}`
                  : ''}
          </Typography>
        </Box>
      )}

      {value.childPart?.primary_unit &&
        value.unit?.trim() &&
        value.unit !== value.childPart.primary_unit && (
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.75, ml: 1 }}>
            Child&apos;s primary unit: {value.childPart.primary_unit}. The cost calculation uses the
            matching conversion to bridge.
          </Typography>
        )}

      {onlyPrimaryAvailable && (
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.75, ml: 1 }}>
          Only the child&apos;s primary unit ({value.childPart?.primary_unit}) is available. To use a
          different unit,{' '}
          <Link
            href={`/dashboard/${companyId}/parts/${value.childPart?.id ?? ''}`}
            target="_blank"
            style={{ textDecoration: 'underline', color: 'inherit' }}
          >
            add a unit conversion on the child part
          </Link>
          .
        </Typography>
      )}

      {error && (
        <Typography variant="caption" color="error" sx={{ display: 'block', mt: 0.75, ml: 1 }}>
          {error}
        </Typography>
      )}

      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'flex-end',
          gap: 1,
          mt: 1.5,
          flexWrap: 'wrap',
        }}
      >
        <Button size="small" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button
          size="small"
          variant="contained"
          onClick={submit}
          disabled={!canSave || saving}
          startIcon={saving ? <CircularProgress size={14} color="inherit" /> : null}
        >
          {lockChildPart ? 'Save changes' : 'Add to BOM'}
        </Button>
      </Box>

      {/* Hidden Save button for keyboard users — Enter on any input submits. */}
      <Box sx={{ position: 'absolute', width: 0, height: 0, overflow: 'hidden' }}>
        <Button type="submit" onClick={submit}>
          Save
        </Button>
      </Box>
    </Box>
  );
}
