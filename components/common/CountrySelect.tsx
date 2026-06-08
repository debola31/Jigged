'use client';

import { SyntheticEvent } from 'react';
import Autocomplete from '@mui/material/Autocomplete';
import TextField from '@mui/material/TextField';
import { COUNTRIES } from '@/lib/geo';

interface CountrySelectProps {
  /** Stored country value — a display name (e.g. "United States") or free text. */
  value: string;
  /** Receives the selected country display name (or typed free-text). */
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
 * Country picker over the ISO 3166 list. Stores the display name (matching the
 * existing free-text `country` columns) rather than the code, and uses
 * `freeSolo` so a previously-saved value that isn't in the list (or a country we
 * don't list) still displays and remains editable instead of being blanked.
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
  const handleChange = (_e: SyntheticEvent, newValue: string | null) => {
    onChange(newValue ?? '');
  };

  return (
    <Autocomplete
      freeSolo
      autoHighlight
      handleHomeEndKeys
      options={COUNTRY_NAMES}
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
