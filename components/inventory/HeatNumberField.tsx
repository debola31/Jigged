'use client';

import { useState } from 'react';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';

/** The sentinel the select uses for "a heat that is not on the list". Never saved. */
const OTHER = '__other__';

interface HeatNumberFieldProps {
  value: string;
  onChange: (value: string) => void;
  /**
   * The heats already RECEIVED for this part (this place's first). When there are any, the field
   * is a list of them plus *Other…*; when there are none it is a plain text box. A receipt passes
   * nothing — the heat is being typed for the first time there.
   */
  suggestions?: string[];
  disabled?: boolean;
  size?: 'small' | 'medium';
  label?: string;
}

/**
 * The mill heat / lot number off a bar's tag — one optional field, shared by every dialog that
 * adds or takes stock, so the label, the keyboard and the 64-character cap cannot drift apart.
 *
 * TWO SHAPES, decided by whether a heat exists for the part:
 *
 *  - **A list, with *Other…***, when receipts have recorded heats. A take must name a heat that
 *    actually came in — a free box here is how "4471" becomes "4417" on a packing slip. The list
 *    is what was received; *Other…* opens a text box for the one honest exception, a bar whose
 *    delivery was stocked without its heat and is being corrected on the spot.
 *  - **A text box**, when no receipt for this part ever carried a heat: the receipt itself, or a
 *    part that has never been traced. There is nothing to choose from, and a list of one entry
 *    ("Other…") would be a box with an extra tap in front of it.
 *
 * No validation beyond length: a heat is whatever the mill printed, and the database upper-cases
 * and trims it on the way in. Stock is not tracked per heat (docs/modules/inventory.md §5.6), so
 * picking from the list narrows what gets typed; it does not decrement a lot.
 *
 * Optional everywhere and never nagged. Most shops do not record heats; a blank here stays blank
 * on every surface downstream.
 */
export default function HeatNumberField({
  value,
  onChange,
  suggestions = [],
  disabled = false,
  size = 'medium',
  label = 'Heat number (optional)',
}: HeatNumberFieldProps) {
  const [pickedOther, setPickedOther] = useState(false);

  const htmlInput = { autoCapitalize: 'characters', maxLength: 64 };

  if (suggestions.length === 0) {
    return (
      <TextField
        label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        size={size}
        fullWidth
        // Upper-case keyboard on a phone because mill tags are upper-case alphanumerics.
        // Convenience, not correctness — the database normalises whatever arrives.
        slotProps={{ htmlInput }}
      />
    );
  }

  // A value the list does not know is, by definition, an "other" — whether it got there by the
  // *Other…* pick or by a parent restoring a typed value.
  const showOther = pickedOther || (value !== '' && !suggestions.includes(value));

  return (
    <Stack spacing={1}>
      <TextField
        select
        label={label}
        value={showOther ? OTHER : value}
        onChange={(e) => {
          const picked = e.target.value;
          if (picked === OTHER) {
            setPickedOther(true);
            onChange('');
          } else {
            setPickedOther(false);
            onChange(picked);
          }
        }}
        disabled={disabled}
        size={size}
        fullWidth
      >
        <MenuItem value="">
          <em>None</em>
        </MenuItem>
        {suggestions.map((heat) => (
          <MenuItem key={heat} value={heat}>
            {heat}
          </MenuItem>
        ))}
        <MenuItem value={OTHER}>Other…</MenuItem>
      </TextField>
      {showOther && (
        <TextField
          label="Other heat number"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          size={size}
          fullWidth
          autoFocus
          slotProps={{ htmlInput }}
        />
      )}
    </Stack>
  );
}
