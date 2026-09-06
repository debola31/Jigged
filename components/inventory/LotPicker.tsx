'use client';

import Autocomplete from '@mui/material/Autocomplete';
import Box from '@mui/material/Box';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';

import type { LotOnHand } from '@/utils/inventoryLocationsAccess';

const num = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 4 });

interface LotPickerProps {
  /** The lots actually at this place, most stock first. */
  options: LotOnHand[];
  value: string | null;
  onChange: (lotId: string | null) => void;
  /** The part's primary unit, so a row can say how much of that heat is here. */
  unit?: string | null;
  /** True when the part is lot-tracked, which is what makes this field required. */
  required?: boolean;
  disabled?: boolean;
  size?: 'small' | 'medium';
  label?: string;
}

/**
 * Which heat is leaving this shelf — chosen from the heats that are on it.
 *
 * ## Why this is a picker and not a text box
 *
 * The first version of heat capture was free text on every movement, and it let a take name a
 * heat that had never been received: a mistyped `4417` became a real record and printed on a
 * packing slip as though it had come off a bar. There is no phrasing of a text field that
 * prevents that. So a take picks, and picks from what is physically here.
 *
 * The second version fixed the typo by offering a fixed `Select` of every heat ever *received*
 * for the part, with an `Other…` escape. Both halves were wrong. The list grows without bound —
 * a bar delivered monthly for three years is 36 entries, most long consumed — and `Other…` put
 * the free-text hole back behind one extra tap. This reads **balances**, so the list is short by
 * construction and every row on it is material you could actually walk up to.
 *
 * ## An autocomplete, because the list is short but not always tiny
 *
 * A bin usually holds one or two heats of a part; a busy rack can hold a dozen. `Autocomplete`
 * costs nothing at one option and stays usable at twenty, which a `Select` does not.
 * Deliberately **not** `freeSolo`: typing must filter, never create.
 *
 * ## What it does when there is nothing to pick
 *
 * Renders disabled, saying so. That state means the part is tracked but this place holds none of
 * it, and the honest response is to say the shelf is empty rather than to offer an empty box that
 * looks like it is still loading.
 */
export default function LotPicker({
  options,
  value,
  onChange,
  unit,
  required = false,
  disabled = false,
  size = 'medium',
  label = 'Heat number',
}: LotPickerProps) {
  const selected = options.find((o) => o.lotId === value) ?? null;
  const empty = options.length === 0;

  return (
    <Autocomplete
      options={options}
      value={selected}
      onChange={(_, lot) => onChange(lot?.lotId ?? null)}
      getOptionLabel={(o) => o.heatNumber ?? o.lotCode}
      isOptionEqualToValue={(a, b) => a.lotId === b.lotId}
      disabled={disabled || empty}
      size={size}
      fullWidth
      renderOption={(props, o) => {
        const { key, ...rest } = props;
        return (
          <Box component="li" key={key} {...rest} sx={{ display: 'flex', gap: 1 }}>
            <Typography variant="body2" sx={{ flex: 1, minWidth: 0 }} noWrap>
              {o.heatNumber ?? o.lotCode}
              {/* A minted code is not a mill heat, and saying so stops it being read back to a
                  customer as one. */}
              {!o.heatNumber && (
                <Typography component="span" variant="caption" color="text.secondary">
                  {' '}
                  · no mill heat
                </Typography>
              )}
            </Typography>
            {/* How much of THIS heat is here — the number that decides which bar you reach for. */}
            <Typography variant="caption" color="text.secondary" sx={{ flexShrink: 0 }}>
              {num(o.quantity)} {unit ?? ''}
            </Typography>
          </Box>
        );
      }}
      renderInput={(params) => (
        <TextField
          {...params}
          label={label}
          required={required}
          /*
           * Only the state you could not work out by looking.
           *
           * "Pick the heat you are taking from" used to sit under every removal, and it told a
           * required, labelled dropdown to be a required, labelled dropdown — a sentence per row
           * on a form that can hold forty of them. The empty case stays, because "there is nothing
           * to pick" is a fact about the shelf that an empty dropdown states ambiguously: it looks
           * the same as one that has not loaded.
           */
          helperText={empty ? 'None of this part is recorded here yet.' : undefined}
          slotProps={{ input: params.InputProps }}
        />
      )}
    />
  );
}
