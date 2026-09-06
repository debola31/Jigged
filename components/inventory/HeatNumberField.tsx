'use client';

import TextField from '@mui/material/TextField';

interface HeatNumberFieldProps {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  size?: 'small' | 'medium';
  label?: string;
}

/**
 * The mill heat number off a bar's tag, typed at RECEIVING.
 *
 * A text box, and only here. This is the one moment a heat legitimately enters the system as
 * something nobody has seen before: the bar is in front of you, the number is stencilled on it,
 * and there is nothing to pick from. Typing it creates the lot.
 *
 * Everywhere else — a take, a move, a count — the heat is chosen from what is physically on the
 * shelf, by {@link LotPicker}. That split is the fix for the fault this field used to have: as a
 * free-text box on a REMOVAL it let a mistyped `4417` become a real record and print on a packing
 * slip as though it had come off a bar. A brief middle version bolted a fixed list plus an
 * `Other…` escape onto this component, which grew without bound and put the same hole back one
 * tap further in.
 *
 * Optional and never nagged. Most shops record no heats, and a blank here stays blank on every
 * surface downstream. Left blank on a part that IS tracked, the database mints a code, so
 * untagged material is still storable.
 */
export default function HeatNumberField({
  value,
  onChange,
  disabled = false,
  size = 'medium',
  label = 'Heat number (optional)',
}: HeatNumberFieldProps) {
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
      slotProps={{ htmlInput: { autoCapitalize: 'characters', maxLength: 64 } }}
    />
  );
}
