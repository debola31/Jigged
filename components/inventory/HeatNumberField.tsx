'use client';

import Autocomplete from '@mui/material/Autocomplete';
import TextField from '@mui/material/TextField';

interface HeatNumberFieldProps {
  value: string;
  onChange: (value: string) => void;
  /**
   * Heats recently RECEIVED for this part at this place, newest first. Offered as options so a
   * take is one tap; empty on a receipt, where the heat is being typed for the first time.
   */
  suggestions?: string[];
  disabled?: boolean;
  size?: 'small' | 'medium';
}

/**
 * The mill heat / lot number off a bar's tag — one optional field, shared by every dialog that
 * adds or takes stock, so the label, the keyboard and the 64-character cap cannot drift apart.
 *
 * `freeSolo`, and deliberately without a "create" affordance or any validation beyond length: a
 * heat is whatever the mill printed, and the database upper-cases and trims it on the way in.
 * The suggestions are a convenience for the operator standing at a shelf with a phone in bright
 * light — the bar in hand almost always carries a heat that was typed when it was put down —
 * never a constraint: stock is not tracked per heat (docs/modules/inventory.md §5.6, reopened
 * 2026-09-04 at the ledger grain), so typing a heat the list has never seen is simply correct.
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
}: HeatNumberFieldProps) {
  return (
    <Autocomplete
      freeSolo
      options={suggestions}
      // Both controlled from the one string: with `freeSolo` the "selected option" and the text
      // are the same thing, and letting MUI keep a second copy is how a tapped suggestion and a
      // typed correction end up disagreeing about what gets saved.
      value={value}
      inputValue={value}
      onInputChange={(_, text) => onChange(text)}
      onChange={(_, picked) => onChange(typeof picked === 'string' ? picked : '')}
      disabled={disabled}
      size={size}
      fullWidth
      renderInput={(params) => (
        <TextField
          {...params}
          label="Heat number (optional)"
          slotProps={{
            input: params.InputProps,
            // Upper-case keyboard on a phone because mill tags are upper-case alphanumerics.
            // Convenience, not correctness — the database normalises whatever arrives.
            htmlInput: { ...params.inputProps, autoCapitalize: 'characters', maxLength: 64 },
          }}
        />
      )}
    />
  );
}
