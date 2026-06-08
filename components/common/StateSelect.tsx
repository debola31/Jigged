'use client';

import { SyntheticEvent } from 'react';
import Autocomplete from '@mui/material/Autocomplete';
import TextField from '@mui/material/TextField';
import { subdivisionsForCountry } from '@/lib/geo';

interface StateSelectProps {
  /** Stored state/province value — a name, a code, or free text. */
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
 * State / province picker. When the selected country has a known subdivision
 * list (US, CA) it renders a dropdown of those names; otherwise it falls back to
 * a plain free-text field. Uses `freeSolo` so existing saved values (which may be
 * codes like "CA" or arbitrary text) still display and stay editable.
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
        label="State / Province"
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

  const options = subdivisions.map((s) => s.name);

  const handleChange = (_e: SyntheticEvent, newValue: string | null) => {
    onChange(newValue ?? '');
  };

  return (
    <Autocomplete
      freeSolo
      autoHighlight
      handleHomeEndKeys
      options={options}
      value={value || null}
      onChange={handleChange}
      onInputChange={(_e, newInput) => onChange(newInput)}
      disabled={disabled}
      fullWidth={fullWidth}
      renderInput={(params) => (
        <TextField
          {...params}
          label={label}
          required={required}
          size={size}
          helperText={helperText}
        />
      )}
    />
  );
}
