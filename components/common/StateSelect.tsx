'use client';

import { SyntheticEvent } from 'react';
import Autocomplete from '@mui/material/Autocomplete';
import TextField from '@mui/material/TextField';
import { subdivisionsForCountry, resolveSubdivisionName } from '@/lib/geo';

interface StateSelectProps {
  /** Stored state/province value — a name, a code, or legacy free text. */
  value: string;
  /** Receives the selected/typed value. */
  onChange: (value: string) => void;
  /** The currently-selected country (name or code) — drives the option list. */
  country: string | null | undefined;
  label?: string;
  disabled?: boolean;
  required?: boolean;
  size?: 'small' | 'medium';
  fullWidth?: boolean;
  helperText?: string;
}

/**
 * State / province picker.
 *
 * When the country has a known subdivision list (US, CA) this is a type-to-search
 * autocomplete that only commits a real entry — new input can't persist garbage
 * like "ca". Legacy/code values still display: a stored code or odd casing
 * ("CA", "il") resolves to its canonical name; anything unrecognized is surfaced
 * as a one-off option with a nudge. Countries without a known list fall back to a
 * plain free-text field (we have no canonical set to validate against).
 */
export default function StateSelect({
  value,
  onChange,
  country,
  label = 'State / Province',
  disabled = false,
  required = false,
  size = 'medium',
  fullWidth = true,
  helperText,
}: StateSelectProps) {
  const subdivisions = subdivisionsForCountry(country);

  if (!subdivisions) {
    // No known list for this country — plain free text.
    return (
      <TextField
        label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        required={required}
        size={size}
        fullWidth={fullWidth}
        helperText={helperText}
      />
    );
  }

  const names = subdivisions.map((s) => s.name);
  const trimmed = value.trim();
  const canonical = resolveSubdivisionName(country, value); // canonical name or null
  const isKnown = trimmed === '' || canonical !== null;
  const display = canonical ?? (trimmed === '' ? null : value);
  const options = isKnown ? names : [value, ...names];

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
            !isKnown ? 'Not in the list for this country — pick one' : helperText
          }
        />
      )}
    />
  );
}
