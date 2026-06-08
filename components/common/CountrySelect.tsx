'use client';

import { SyntheticEvent } from 'react';
import Autocomplete from '@mui/material/Autocomplete';
import TextField from '@mui/material/TextField';
import { COUNTRIES, resolveCountryName } from '@/lib/geo';

interface CountrySelectProps {
  /** Stored country value — a display name, a code, or legacy free text. */
  value: string;
  /** Receives the selected country display name (or '' when cleared). */
  onChange: (value: string) => void;
  label?: string;
  disabled?: boolean;
  required?: boolean;
  size?: 'small' | 'medium';
  fullWidth?: boolean;
  helperText?: string;
}

const COUNTRY_NAMES = COUNTRIES.map((c) => c.name);

/**
 * Country picker over the ISO 3166 list.
 *
 * Type-to-search (so users find their country quickly, tolerating typos), but —
 * unlike a `freeSolo` field — only a real list entry can be committed, so new
 * input can't persist garbage like ",mex". A previously-saved value that isn't
 * in the list (legacy free text, or a code/alias we recognize) still displays:
 * recognized aliases (e.g. "USA") resolve to their canonical name, and anything
 * truly unrecognized is surfaced as a one-off option with a nudge to re-pick.
 * This matches the autocomplete-resolves-to-canonical pattern Baymard recommends.
 */
export default function CountrySelect({
  value,
  onChange,
  label = 'Country',
  disabled = false,
  required = false,
  size = 'medium',
  fullWidth = true,
  helperText,
}: CountrySelectProps) {
  const trimmed = value.trim();
  const canonical = resolveCountryName(value); // canonical name, or null if unknown
  const isKnown = trimmed === '' || canonical !== null;
  // The value shown in the field: the canonical name when we recognize it,
  // otherwise the raw stored string (so legacy values aren't blanked).
  const display = canonical ?? (trimmed === '' ? null : value);
  // Include the raw legacy value as a selectable option when unrecognized, so
  // MUI can render it without an "out of range" warning.
  const options = isKnown ? COUNTRY_NAMES : [value, ...COUNTRY_NAMES];

  const handleChange = (_e: SyntheticEvent, newValue: string | null) => {
    onChange(newValue ?? '');
  };

  return (
    <Autocomplete
      options={options}
      value={display}
      onChange={handleChange}
      disabled={disabled}
      fullWidth={fullWidth}
      autoHighlight
      handleHomeEndKeys
      isOptionEqualToValue={(option, val) => option === val}
      renderInput={(params) => (
        <TextField
          {...params}
          label={label}
          required={required}
          size={size}
          error={!isKnown}
          helperText={
            !isKnown ? 'Not a recognized country — pick from the list' : helperText
          }
        />
      )}
    />
  );
}
