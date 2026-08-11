'use client';

import { useEffect, useMemo, useState } from 'react';
import Box from '@mui/material/Box';
import TextField from '@mui/material/TextField';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import MenuItem from '@mui/material/MenuItem';
import InputAdornment from '@mui/material/InputAdornment';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';

import PartAutocomplete, { type PartSelectOption } from '@/components/parts/PartAutocomplete';
import { getPartUnitConversions } from '@/utils/partsAccess';
import { defaultConsumeWholeUnits, unitShortLabel } from '@/lib/standardUnits';
import { getStandardUnitsForUnit } from '@/lib/unitPresets';
import { type ChargeBasis } from '@/types/bom';

export type { PartSelectOption };

export interface MaterialEditorValue {
  childPart: PartSelectOption | null;
  /** Per-part consumption of the material, in `unit`. Canonical stored value. */
  quantity: string;
  unit: string;
  /** Ceiling consumption to whole units at the order qty (discrete stock). */
  consume_whole_units: boolean;
  /**
   * What this material contributes to the parent's cost (#727). Carried, not
   * edited: the control is one per part on the Materials panel, not one per row,
   * because "we mark up purchased material" is a shop habit rather than a
   * per-material decision. An edit here must preserve whatever the line has.
   */
  charge_basis: ChargeBasis;
}

/** Format a yield ratio for display — collapse near-integers to a clean int. */
function formatYield(y: number): string {
  if (!Number.isFinite(y) || y <= 0) return '';
  const rounded = Math.round(y);
  return Math.abs(y - rounded) < 1e-9 ? String(rounded) : String(Number(y.toFixed(4)));
}

/**
 * Parse a per-part quantity that may be a whole number, a decimal, or a simple
 * fraction ("1/20"). Returns a positive number, or null when empty/invalid.
 * The fraction form lets a machinist enter "one strip makes 20" as `1/20`
 * without doing the 0.05 division by hand.
 */
function parseQty(s: string): number | null {
  const t = s.trim();
  if (!t) return null;
  const frac = t.match(/^(\d*\.?\d+)\s*\/\s*(\d*\.?\d+)$/);
  if (frac) {
    const num = parseFloat(frac[1]);
    const den = parseFloat(frac[2]);
    if (Number.isFinite(num) && Number.isFinite(den) && den > 0) {
      const v = num / den;
      return v > 0 ? v : null;
    }
    return null;
  }
  const n = parseFloat(t);
  return Number.isFinite(n) && n > 0 && /^[0-9.]+$/.test(t) ? n : null;
}

export interface MaterialRowEditorProps {
  companyId: string;
  /** Part IDs to hide from the child-part picker (e.g. the parent itself). */
  excludeIds?: string[];
  /** When provided, the editor is in edit mode for an existing material row. */
  initial?: MaterialEditorValue;
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
  charge_basis: 'cost',
};

/**
 * Inline editor for a single Materials row on the part detail page.
 *
 * Three fields, nothing else: the material part, its unit, and one
 * quantity-per-part field. The quantity accepts a whole number, a decimal, or a
 * simple fraction ("1/20") — a value below 1 is a yield (many parts from one
 * unit), so there is no separate yield mode. Whether discrete stock is drawn in
 * whole units is derived automatically from the unit (count → whole). A made
 * child's costing batch (for setup amortization) is set on that child's own
 * page, not here.
 *
 * **Charge basis is deliberately NOT a field here.** It briefly was, and a
 * fourth control on every material row bought nothing: a shop that marks up
 * purchased material marks up all of it, so the decision belongs once per part,
 * on the Materials panel. The value still rides along in
 * `MaterialEditorValue.charge_basis` so editing a row preserves it.
 */
export default function MaterialRowEditor({
  companyId,
  excludeIds,
  initial,
  saving = false,
  error,
  onSave,
  onCancel,
}: MaterialRowEditorProps) {
  const [value, setValue] = useState<MaterialEditorValue>(initial ?? EMPTY_VALUE);

  const [conversionUnits, setConversionUnits] = useState<string[]>([]);
  const [conversionsLoading, setConversionsLoading] = useState(false);

  // Reset when initial changes (cancel-add then edit a different row).
  useEffect(() => {
    setValue(initial ?? EMPTY_VALUE);
  }, [initial]);

  const isCountUnit = defaultConsumeWholeUnits(value.unit);

  // Load the child's secondary units on selection.
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
    return () => {
      cancelled = true;
    };
  }, [value.childPart]);

  // Unit options: the child's primary, plus standard same-dimension units (feet,
  // meters, … for an inches part — known conversion factors, materialized on
  // save), plus any custom conversions already defined on the child.
  const unitOptions = useMemo<string[]>(() => {
    const child = value.childPart;
    if (!child?.primary_unit) return [];
    const primary = child.primary_unit;
    const list: string[] = [primary];
    for (const u of getStandardUnitsForUnit(primary)) if (!list.includes(u)) list.push(u);
    for (const u of conversionUnits) if (!list.includes(u)) list.push(u);
    return list;
  }, [value.childPart, conversionUnits]);

  const onlyPrimaryAvailable = !!value.childPart?.primary_unit && unitOptions.length <= 1;

  // Snap the unit to the child's primary when the current one isn't valid.
  useEffect(() => {
    if (conversionsLoading) return;
    const child = value.childPart;
    if (!child) return;
    if (unitOptions.includes(value.unit)) return;
    setValue((prev) => ({ ...prev, unit: child.primary_unit ?? '' }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unitOptions, conversionsLoading]);

  const unitShort = unitShortLabel(value.unit) ?? (value.unit || 'unit');
  const perPartQty = parseQty(value.quantity);
  const qtyInvalid = value.quantity.trim() !== '' && perPartQty === null;
  // A count material consumed as a fraction reads as a yield — show the
  // reciprocal so "0.05 per ea" is confirmed as "20 parts per ea".
  const showYieldReciprocal = isCountUnit && perPartQty !== null && perPartQty < 1;

  const handlePartChange = (option: PartSelectOption | null) => {
    setValue((prev) => ({ ...prev, childPart: option, unit: option?.primary_unit ?? '' }));
  };

  const canSave =
    !!value.childPart &&
    perPartQty !== null &&
    !!value.unit?.trim() &&
    unitOptions.includes(value.unit);

  const submit = () => {
    if (!canSave || perPartQty === null) return;
    onSave({
      ...value,
      // Canonicalize the quantity (a fraction like "1/20" → "0.05").
      quantity: String(perPartQty),
      // Whole-unit consumption is derived from the unit, not a manual toggle:
      // count/discrete stock rounds up, continuous material is fractional.
      consume_whole_units: defaultConsumeWholeUnits(value.unit),
      charge_basis: value.charge_basis,
    });
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
            disabled={saving}
            label="Material part"
            required
            autoFocus={!initial}
          />
        </Box>

        <Tooltip
          title={
            onlyPrimaryAvailable
              ? `Only ${unitShort} is available for this part. Add a unit conversion on the child part to use other units.`
              : ''
          }
          disableHoverListener={!onlyPrimaryAvailable}
        >
          {/* span so the tooltip still fires when the Select is disabled */}
          <span>
            <TextField
              select
              label="Unit"
              value={value.childPart && unitOptions.includes(value.unit) ? value.unit : ''}
              onChange={(e) => setValue((prev) => ({ ...prev, unit: e.target.value }))}
              required
              size="small"
              disabled={saving || !value.childPart || conversionsLoading || onlyPrimaryAvailable}
              sx={{ width: 150 }}
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
          </span>
        </Tooltip>

        {/* One quantity field: whole number, decimal, or fraction ("1/20"). A
            value below 1 is a yield; the caption confirms the reciprocal. */}
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.25, minWidth: 200 }}>
          <TextField
            label="Quantity per part"
            value={value.quantity}
            onChange={(e) => setValue((prev) => ({ ...prev, quantity: e.target.value }))}
            required
            error={qtyInvalid}
            placeholder="Whole number or fraction"
            InputLabelProps={{ shrink: true }}
            inputProps={{ inputMode: 'text' }}
            size="small"
            disabled={saving}
            sx={{ width: 230 }}
            helperText={
              qtyInvalid
                ? 'Enter a whole number, decimal, or fraction (e.g. 1/20)'
                : showYieldReciprocal
                  ? `= ${formatYield(1 / perPartQty!)} parts from one ${unitShort}`
                  : undefined
            }
          />
        </Box>

      </Box>

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
          {initial ? 'Save changes' : 'Add to BOM'}
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
