'use client';

import { useState } from 'react';
import Box from '@mui/material/Box';
import MenuItem from '@mui/material/MenuItem';
import TextField from '@mui/material/TextField';

import {
  factorLabel,
  formatUnitQuantity,
  purchaseUnitOptions,
  resolvePurchaseUnit,
  unitLabel,
  type UnitConversionRow,
} from '@/lib/purchasing/purchaseUnits';

const ANOTHER_UNIT = '__another_unit__';
const FACTOR_TEXT = /^(\d+\.?\d*|\.\d+)$/;

export interface PurchaseUnitFieldProps {
  /** The part's stock unit (`parts.primary_unit`); null until the part is known. */
  stockUnit: string | null;
  /** The part's `parts_unit_conversions` rows. */
  conversions: readonly UnitConversionRow[];
  /** The unit, spelled as it will be written; '' means the stock unit. */
  value: string;
  /** "Another unit…": how many stock units one `value` holds, as typed. */
  factor: string;
  onChange: (next: { unit: string; factor: string }) => void;
  disabled?: boolean;
  /** Said under a locked field (a line with receipts keeps its unit). */
  disabledReason?: string | null;
  label?: string;
}

/** Is "Another unit…"'s factor usable? A number greater than zero. */
export function isUsableUnitFactor(text: string): boolean {
  const t = text.trim();
  return FACTOR_TEXT.test(t) && Number(t) > 0;
}

/**
 * The unit a PO line buys in (plan §3.5 "Units", criterion L1).
 *
 * Offers exactly what the database can freeze a factor for: the stock unit, the part's own
 * conversions, then same-kind presets (feet on an inches part, hundred on an each part) — each with
 * its factor, "1 bar = 144 in". A unit that cannot be related to the stock unit is NEVER offered as
 * if it could be: it is reachable only through "Another unit…", which asks how many stock units one
 * holds, and the access layer stores that as the part's conversion (add-only) before the PO is
 * saved. A different bar length is a different unit name, not an edit to this one.
 */
export default function PurchaseUnitField({
  stockUnit,
  conversions,
  value,
  factor,
  onChange,
  disabled = false,
  disabledReason,
  label = 'Unit',
}: PurchaseUnitFieldProps) {
  const options = purchaseUnitOptions(stockUnit, conversions);
  const resolved = resolvePurchaseUnit(value, stockUnit, conversions);
  const listed = resolved.kind !== 'incomparable' && options.some((o) => o.unit === resolved.unit);
  // "Another unit…" is open when the person chose it, or when the unit is one the part cannot
  // relate (a saved line whose conversion went away, a sheet in a unit nobody converted).
  const [customOpen, setCustomOpen] = useState(() => value.trim() !== '' && !listed);
  const custom = customOpen || (value.trim() !== '' && !listed);
  const stockLabel = stockUnit ? unitLabel(stockUnit) : 'stock units';
  const name = value.trim();

  if (!stockUnit) {
    return (
      <TextField select label={label} size="small" value="" disabled fullWidth helperText="Choose the part first.">
        <MenuItem value="">—</MenuItem>
      </TextField>
    );
  }

  const selectValue = custom ? ANOTHER_UNIT : listed ? resolved.unit : options[0]?.unit ?? '';
  const customBasis = custom && name ? resolvePurchaseUnit(name, stockUnit, conversions) : null;
  const needsFactor = custom && name !== '' && customBasis?.kind === 'incomparable';
  const factorOk = isUsableUnitFactor(factor);

  let helper: string | null = null;
  let error = false;
  if (disabled && disabledReason) {
    helper = disabledReason;
  } else if (!custom) {
    helper = factorLabel(resolved);
  } else if (customBasis && customBasis.kind !== 'incomparable') {
    helper = factorLabel(customBasis) ?? 'That is the stock unit.';
  } else if (needsFactor && !factorOk) {
    helper = `Say how many ${stockLabel} are in one ${name}.`;
    error = true;
  } else if (needsFactor && factorOk) {
    helper = `1 ${name} = ${formatUnitQuantity(Number(factor))} ${stockLabel}`;
  }

  return (
    <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', alignItems: 'flex-start' }}>
      <TextField
        select
        label={label}
        size="small"
        value={selectValue}
        disabled={disabled}
        onChange={(e) => {
          if (e.target.value === ANOTHER_UNIT) {
            setCustomOpen(true);
            onChange({ unit: '', factor: '' });
          } else {
            setCustomOpen(false);
            onChange({ unit: e.target.value, factor: '' });
          }
        }}
        helperText={custom ? undefined : (helper ?? ' ')}
        error={!custom && error}
        sx={{ minWidth: (theme) => theme.spacing(16) }}
      >
        {options.map((o) => (
          <MenuItem key={o.unit} value={o.unit}>
            {o.kind === 'same' ? `${unitLabel(o.unit)} · stock unit` : `${unitLabel(o.unit)} · ${factorLabel(o)}`}
          </MenuItem>
        ))}
        <MenuItem value={ANOTHER_UNIT}>Another unit…</MenuItem>
      </TextField>
      {custom && (
        <>
          <TextField
            label="New unit name"
            size="small"
            value={value}
            disabled={disabled}
            onChange={(e) => onChange({ unit: e.target.value, factor })}
            sx={{ width: (theme) => theme.spacing(18) }}
            slotProps={{ htmlInput: { maxLength: 40 } }}
          />
          {(needsFactor || name === '') && (
            <TextField
              label={`${stockLabel} in one ${name || 'of these'}`}
              size="small"
              value={factor}
              disabled={disabled}
              onChange={(e) => onChange({ unit: value, factor: e.target.value })}
              error={error}
              helperText={helper ?? ' '}
              sx={{ width: (theme) => theme.spacing(24) }}
              slotProps={{ htmlInput: { inputMode: 'decimal' } }}
            />
          )}
          {!needsFactor && name !== '' && helper && (
            <Box component="span" sx={{ alignSelf: 'center', color: 'text.secondary', typography: 'caption' }}>
              {helper}
            </Box>
          )}
        </>
      )}
    </Box>
  );
}
