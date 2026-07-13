'use client';

import { useEffect, useMemo, useState, type MouseEvent } from 'react';
import Box from '@mui/material/Box';
import TextField from '@mui/material/TextField';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Typography from '@mui/material/Typography';
import MenuItem from '@mui/material/MenuItem';
import InputAdornment from '@mui/material/InputAdornment';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Switch from '@mui/material/Switch';
import FormControlLabel from '@mui/material/FormControlLabel';
import Link from 'next/link';

import PartAutocomplete, { type PartSelectOption } from '@/components/parts/PartAutocomplete';
import { getPartUnitConversions } from '@/utils/partsAccess';
import { defaultConsumeWholeUnits, unitShortLabel } from '@/lib/standardUnits';
import MissingFieldsNotice from '@/components/common/MissingFieldsNotice';

export type { PartSelectOption };

export interface MaterialEditorValue {
  childPart: PartSelectOption | null;
  /** Per-part consumption of the material, in `unit`. Canonical stored value. */
  quantity: string;
  unit: string;
  /** Ceiling consumption to whole units at the order qty (discrete stock). */
  consume_whole_units: boolean;
}

/** Format a yield ratio for display — collapse near-integers to a clean int. */
function formatYield(y: number): string {
  if (!Number.isFinite(y) || y <= 0) return '';
  const rounded = Math.round(y);
  return Math.abs(y - rounded) < 1e-9 ? String(rounded) : String(Number(y.toFixed(4)));
}

export interface MaterialRowEditorProps {
  /**
   * Used both by the embedded PartAutocomplete and by the "add a unit
   * conversion on the child part" helper link rendered when the child has
   * only its primary_unit available.
   */
  companyId: string;
  /** Part IDs to hide from the child-part picker (e.g. the parent itself). */
  excludeIds?: string[];
  /** When provided, the editor is in edit mode for an existing material row. */
  initial?: MaterialEditorValue;
  /**
   * When true, the child-part picker is disabled. Used in edit mode —
   * changing the child of an existing line is identical to delete+re-add,
   * so we keep the surface simple by locking it.
   */
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
 * Decide the initial input mode for the quantity field. A stored per-part
 * quantity below 1 (e.g. 0.05 strips/part) is the "yield" pattern — many parts
 * from one material unit — so we show it as a yield (20 parts / strip) which is
 * how the shop thinks about it. 1-or-more reads naturally as "N units/part".
 */
function deriveMode(quantity: string): { mode: 'per_part' | 'yield'; yieldStr: string } {
  const q = parseFloat(quantity);
  if (Number.isFinite(q) && q > 0 && q < 1) {
    return { mode: 'yield', yieldStr: formatYield(1 / q) };
  }
  return { mode: 'per_part', yieldStr: '' };
}

/**
 * Inline editor for a single Materials row on the part detail page. Mirrors
 * the shape of RoutingOperationRowEditor — the operations panel uses an
 * inline-row pattern (no modal) and the materials panel matches it for
 * consistency. The user toggles a row into edit mode in place; "Add
 * Material" appends an editor row at the end of the list.
 *
 * The Unit field is constrained to the child's primary_unit + every
 * parts_unit_conversions.from_unit row for that child — typing an
 * unconvertible unit would silently break the cost rollup later in
 * compute_part_cost_at_qty. The DB CHECK parts_requires_unit guarantees
 * every part has a primary_unit, so there's no free-text fallback path.
 *
 * The editor is purely presentational. Cycle pre-check + addBomLine /
 * updateBomLine calls live in PartBomPanel which holds the state machine.
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

  // Quantity can be entered two ways: "N material units per part" (per_part) or
  // "N parts per material unit" (yield → stored as 1/N). `value.quantity` is
  // always the canonical per-part value; `yieldStr` is the raw yield-field text.
  const [inputMode, setInputMode] = useState<'per_part' | 'yield'>(
    () => deriveMode((initial ?? EMPTY_VALUE).quantity).mode,
  );
  const [yieldStr, setYieldStr] = useState<string>(
    () => deriveMode((initial ?? EMPTY_VALUE).quantity).yieldStr,
  );
  // Whether the user has manually toggled the whole-unit switch. Starts true
  // when editing an existing line (respect its stored value) and false for a
  // new line (so the UoM-category default applies as the unit is chosen).
  const [wholeUnitsTouched, setWholeUnitsTouched] = useState<boolean>(!!initial);

  // Conversions for the currently-selected child part. Drives the Unit picker
  // options: primary_unit + every parts_unit_conversions.from_unit row. Empty
  // until a child is picked or the load resolves.
  const [conversionUnits, setConversionUnits] = useState<string[]>([]);
  const [conversionsLoading, setConversionsLoading] = useState(false);

  // Reset when initial changes (e.g. user cancels add then opens edit on a
  // different row in the same panel mount).
  useEffect(() => {
    const next = initial ?? EMPTY_VALUE;
    setValue(next);
    const derived = deriveMode(next.quantity);
    setInputMode(derived.mode);
    setYieldStr(derived.yieldStr);
    setWholeUnitsTouched(!!initial);
  }, [initial]);

  // Default the whole-unit switch from the unit's category (count → whole,
  // length/weight/etc → fractional) until the user overrides it. Never runs in
  // edit mode (wholeUnitsTouched starts true there), so a stored value is kept.
  useEffect(() => {
    if (wholeUnitsTouched) return;
    // Derived-state sync from the chosen unit (documented false-positive class
    // in eslint.config.mjs); guarded to a no-op when the default already holds.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setValue((prev) => {
      const next = defaultConsumeWholeUnits(prev.unit);
      return prev.consume_whole_units === next ? prev : { ...prev, consume_whole_units: next };
    });
  }, [value.unit, wholeUnitsTouched]);

  // Load the child's secondary units whenever it changes. The Unit picker
  // is constrained to primary_unit + these — entering a unit with no
  // conversion would just blow up later in compute_part_cost_at_qty.
  useEffect(() => {
    const childId = value.childPart?.id;
    if (!childId) {
      setConversionUnits([]);
      return;
    }
    let cancelled = false;
    setConversionsLoading(true);
    getPartUnitConversions(childId)
      .then((rows) => {
        if (cancelled) return;
        setConversionUnits(rows.map((r) => r.from_unit));
      })
      .catch((err) => {
        if (cancelled) return;
        console.error('Failed to load unit conversions for child:', err);
        setConversionUnits([]);
      })
      .finally(() => {
        if (!cancelled) setConversionsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [value.childPart?.id]);

  // Build the constrained option list: primary_unit first, then every
  // conversion `from_unit`, de-duped, preserving order. parts_requires_unit
  // guarantees every child has a primary_unit, so the list is never empty
  // once a child is picked.
  const unitOptions = useMemo<string[]>(() => {
    const child = value.childPart;
    if (!child) return [];
    const list: string[] = [];
    if (child.primary_unit) list.push(child.primary_unit);
    for (const u of conversionUnits) {
      if (!list.includes(u)) list.push(u);
    }
    return list;
  }, [value.childPart, conversionUnits]);

  const onlyPrimaryAvailable =
    !!value.childPart && !!value.childPart.primary_unit && conversionUnits.length === 0;

  // Auto-correct the unit when the child changes and the previously-typed
  // unit isn't valid for the new child. Snap to primary_unit (the canonical
  // default) so the user starts from a working state. We only run this once
  // the conversions load completes for the current child to avoid clobbering
  // an in-flight selection.
  useEffect(() => {
    if (conversionsLoading) return;
    const child = value.childPart;
    if (!child) return;
    if (unitOptions.includes(value.unit)) return;
    setValue((prev) => ({ ...prev, unit: child.primary_unit ?? '' }));
    // value.unit and value.childPart are read; updating value here is fine.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unitOptions, conversionsLoading]);

  const handlePartChange = (option: PartSelectOption | null) => {
    setValue((prev) => ({
      ...prev,
      childPart: option,
      // Default the BOM unit to the child's primary unit on first selection
      // (one-click for the common case). The conversions-load effect will
      // re-snap to primary_unit if the previous typed value is invalid.
      unit: option?.primary_unit ?? '',
    }));
  };

  const unitShort = unitShortLabel(value.unit) ?? (value.unit || 'unit');

  const handleModeChange = (
    _e: MouseEvent<HTMLElement>,
    next: 'per_part' | 'yield' | null,
  ) => {
    if (!next || next === inputMode) return;
    if (next === 'yield') {
      const q = parseFloat(value.quantity);
      setYieldStr(Number.isFinite(q) && q > 0 ? formatYield(1 / q) : '');
    }
    setInputMode(next);
  };

  const handleYieldChange = (s: string) => {
    setYieldStr(s);
    const y = parseFloat(s);
    // Yield N parts per material unit ⇒ 1/N material units per part (canonical).
    setValue((prev) => ({ ...prev, quantity: Number.isFinite(y) && y > 0 ? String(1 / y) : '' }));
  };

  // What's still blocking the save, surfaced inline so the user knows which
  // field needs attention. Mirrors the canSave checks below.
  const missingItems = useMemo(() => {
    const items: string[] = [];
    if (!value.childPart) items.push('Select a material part');
    const qty = parseFloat(value.quantity);
    if (!Number.isFinite(qty) || qty <= 0) items.push('Enter a quantity greater than zero');
    if (value.childPart && (!value.unit?.trim() || !unitOptions.includes(value.unit))) {
      items.push('Choose a unit');
    }
    return items;
  }, [value, unitOptions]);

  const canSave = missingItems.length === 0;

  return (
    <Box
      sx={{
        py: 1.5,
        px: 1,
        bgcolor: 'action.hover',
        borderRadius: 1,
        my: 0.5,
      }}
    >
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

        {/* Consumption entry: either "material units per part" (per_part) or
            "parts per material unit" (yield → stored as 1/N). The stored
            value.quantity is always the per-part figure; the yield field is a
            convenience that round-trips (yield 20 ⇄ 0.05/part). */}
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
          <ToggleButtonGroup
            size="small"
            exclusive
            value={inputMode}
            onChange={handleModeChange}
            disabled={saving}
            aria-label="Consumption entry mode"
          >
            <ToggleButton value="per_part" sx={{ textTransform: 'none', py: 0.25, px: 1 }}>
              Qty / part
            </ToggleButton>
            <ToggleButton value="yield" sx={{ textTransform: 'none', py: 0.25, px: 1 }}>
              Parts / {unitShort}
            </ToggleButton>
          </ToggleButtonGroup>
          {inputMode === 'per_part' ? (
            <TextField
              label={value.unit ? `Quantity (${unitShort})` : 'Quantity'}
              type="number"
              value={value.quantity}
              onChange={(e) => setValue((prev) => ({ ...prev, quantity: e.target.value }))}
              required
              InputLabelProps={{ shrink: true }}
              inputProps={{ min: 0, step: 'any', inputMode: 'decimal' }}
              size="small"
              disabled={saving}
              sx={{ width: 170 }}
              helperText="Material used per part"
            />
          ) : (
            <TextField
              label={`Yield (parts / ${unitShort})`}
              type="number"
              value={yieldStr}
              onChange={(e) => handleYieldChange(e.target.value)}
              required
              InputLabelProps={{ shrink: true }}
              inputProps={{ min: 0, step: 'any', inputMode: 'decimal' }}
              size="small"
              disabled={saving}
              sx={{ width: 170 }}
              helperText={
                value.quantity && parseFloat(value.quantity) > 0
                  ? `= ${Number(parseFloat(value.quantity).toFixed(4))} ${unitShort} / part`
                  : 'Parts made from one material unit'
              }
            />
          )}
        </Box>

        {/* Unit picker: constrained to the child's primary_unit + every
            parts_unit_conversions.from_unit row. Free-text was removed
            because typed-but-unconvertible units silently broke the cost
            rollup later. parts_requires_unit guarantees every child has a
            primary_unit, so the option list is never empty once a child is
            picked. */}
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
      </Box>

      {/* Whole-unit (ceiling) consumption. Defaults from the unit category
          (count → on, length/weight/etc → off) until toggled. When on, a job
          rounds up to whole material units — the strip you can't cut a
          fraction of — which changes per-part cost at order quantities that
          don't divide evenly. */}
      <Box sx={{ mt: 0.5, ml: 0.5 }}>
        <FormControlLabel
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
            <Typography variant="caption" color="text.secondary">
              Consume whole {unitShort} per job — round up (for discrete stock you
              can&apos;t use a fraction of)
            </Typography>
          }
        />
      </Box>

      {value.childPart?.primary_unit &&
        value.unit?.trim() &&
        value.unit !== value.childPart.primary_unit && (
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.75, ml: 1 }}>
            Child&apos;s primary unit: {value.childPart.primary_unit}. The cost
            calculation will use the matching conversion to bridge.
          </Typography>
        )}

      {onlyPrimaryAvailable && (
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.75, ml: 1 }}>
          Only the child&apos;s primary unit ({value.childPart?.primary_unit}) is
          available. To use a different unit,{' '}
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

      <MissingFieldsNotice items={missingItems} />

      {/* Footer button row mirrors the operations editor: text buttons at
          the bottom, not icon controls inline with the inputs. Save label
          flips between Add to BOM (create) and Save changes (edit) so the
          user knows what the click commits. */}
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
          onClick={() => canSave && onSave(value)}
          disabled={!canSave || saving}
          startIcon={saving ? <CircularProgress size={14} color="inherit" /> : null}
        >
          {lockChildPart ? 'Save changes' : 'Add to BOM'}
        </Button>
      </Box>

      {/* Hidden Save button for keyboard users — Enter on any input submits. */}
      <Box sx={{ position: 'absolute', width: 0, height: 0, overflow: 'hidden' }}>
        <Button type="submit" onClick={() => canSave && onSave(value)}>
          Save
        </Button>
      </Box>
    </Box>
  );
}
