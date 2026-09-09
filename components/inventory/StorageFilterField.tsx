'use client';

import InputAdornment from '@mui/material/InputAdornment';
import TextField from '@mui/material/TextField';
import SearchIcon from '@mui/icons-material/Search';

interface StorageFilterFieldProps {
  label: string;
  value: string;
  onChange: (next: string) => void;
}

/**
 * The filter box on both Storage tabs.
 *
 * ONE component because they are one control in two places, and the version where each tab built
 * its own drifted immediately: Inventory's lost the magnifying glass, and the two ended up
 * different widths. A filter that looks like a different control on the next tab reads as a
 * different capability.
 *
 * What differs between them is the LABEL, which is the only thing that should — each says what it
 * narrows, because each narrows the thing its own tab is about.
 */
export default function StorageFilterField({ label, value, onChange }: StorageFilterFieldProps) {
  return (
    <TextField
      size="small"
      label={label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      sx={{ width: { xs: '100%', sm: 320 } }}
      slotProps={{
        input: {
          startAdornment: (
            <InputAdornment position="start">
              <SearchIcon fontSize="small" />
            </InputAdornment>
          ),
        },
      }}
    />
  );
}
