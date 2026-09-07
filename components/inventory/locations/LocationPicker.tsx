'use client';

/**
 * One place to choose a location — and, optionally, to create one without leaving the flow.
 *
 * There were two hand-rolled `Autocomplete`s doing this (the admin part modal and the operator bin
 * modal) and they had drifted: the admin "From" picker showed quantities while its "To" picker
 * didn't, neither excluded the source, and neither excluded the auto-managed `Unassigned` bucket as
 * a *destination* — which is nonsense, since putting something away *into* the pile of unplaced
 * things is what you're trying to escape.
 *
 * **Inline create was deliberately held back until dedupe shipped.** §5.5 decision 2 wanted a
 * create-as-you-type field from the start; a freeSolo create field is also precisely the mechanism
 * that produced `STOCK` beside `ST0CK` in the legacy data. Now that a sibling-name unique index
 * exists, the field can offer creation, and this component suppresses the offer when the typed name
 * already matches something — see `matchesExisting`.
 */
import { useState } from 'react';
import Autocomplete, { createFilterOptions } from '@mui/material/Autocomplete';
import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import AddIcon from '@mui/icons-material/Add';


export interface LocationPickerOption {
  id: string;
  /** Full human path, root → leaf, e.g. `Cabinet 3 › Shelf A`. */
  label: string;
  kind?: string | null;
  /** Stock the subject part holds here, when the caller knows it. Rendered in the dropdown row. */
  quantity?: number;
}

/** The synthetic "create this" row. Not a real id, and never handed to a caller as one. */
const CREATE_ID = '__create__';

const filter = createFilterOptions<LocationPickerOption>();

const num = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 4 });

/** Case- and whitespace-insensitive, matching how the DB's unique index compares names. */
const norm = (s: string) => s.trim().toLowerCase();

export interface LocationPickerProps {
  label: string;
  options: LocationPickerOption[];
  value: LocationPickerOption | null;
  onChange: (value: LocationPickerOption | null) => void;
  /** The source location, excluded so you can't move something to where it already is. */
  excludeId?: string | null;
  /** Unit for the quantity caption. Omit and quantities stay hidden. */
  unit?: string;
  required?: boolean;
  disabled?: boolean;
  /**
   * Field density, forwarded to the input.
   *
   * Exists so this can stand in a toolbar beside `size="small"` fields without being the one
   * control half a line taller than its neighbours — which is exactly how it read next to the
   * count sheet's search box.
   */
  size?: 'small' | 'medium';
  helperText?: string;
  error?: boolean;
  /**
   * Create a location from a typed name and return it, ready-selected.
   *
   * Omit to get a plain picker. The caller owns the write (it knows the company), which keeps this
   * component free of access-layer imports.
   */
  onCreate?: (name: string) => Promise<LocationPickerOption>;
}

export default function LocationPicker({
  label,
  options,
  value,
  onChange,
  excludeId,
  unit,
  required = false,
  disabled = false,
  helperText,
  error = false,
  size = 'medium',
  onCreate,
}: LocationPickerProps) {
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const selectable = options.filter(
    (o) => o.id !== excludeId,
  );

  const handleChange = async (option: LocationPickerOption | null) => {
    if (!option || option.id !== CREATE_ID || !onCreate) {
      setCreateError(null);
      onChange(option);
      return;
    }
    setCreating(true);
    setCreateError(null);
    try {
      onChange(await onCreate(option.label));
    } catch (e) {
      // The DB refuses a duplicate sibling name outright; surface its message rather than a
      // half-selected picker.
      setCreateError(e instanceof Error ? e.message : 'Could not create that location.');
      onChange(null);
    } finally {
      setCreating(false);
    }
  };

  return (
    <Autocomplete
      options={selectable}
      value={value}
      disabled={disabled || creating}
      onChange={(_, v) => void handleChange(v)}
      getOptionLabel={(o) => o.label}
      isOptionEqualToValue={(o, v) => o.id === v.id}
      filterOptions={(opts, params) => {
        const typed = params.inputValue.trim();
        // Filter on the TRIMMED input. MUI's default matcher uses the raw value, so a stray
        // trailing space ("yard ") matched nothing — and because the create offer is suppressed
        // on a name match, the dropdown went completely empty: no existing option and no way to
        // create. A dead end from one keystroke.
        const filtered = filter(opts, { ...params, inputValue: typed });
        // Offer creation only for a name nothing here already answers to. Offering "Create Shelf A"
        // beside an existing "Shelf A" would either duplicate it or be refused by the index — in
        // both cases the user meant the one that exists, and the filter has already surfaced it.
        const matchesExisting = opts.some((o) => norm(o.label) === norm(typed));
        if (onCreate && typed && !matchesExisting) {
          filtered.push({ id: CREATE_ID, label: typed });
        }
        return filtered;
      }}
      renderOption={(props, o) => {
        const { key, ...rest } = props;
        if (o.id === CREATE_ID) {
          return (
            <Box component="li" key={key} {...rest} sx={{ display: 'flex', gap: 1 }}>
              <AddIcon fontSize="small" color="primary" />
              <Typography variant="body2" color="primary">
                Create &ldquo;{o.label}&rdquo;
              </Typography>
            </Box>
          );
        }
        return (
          // The label takes the slack rather than relying on justify-content, which MUI's own
          // option class overrides.
          <Box component="li" key={key} {...rest} sx={{ display: 'flex', gap: 2 }}>
            <Box component="span" sx={{ flex: 1, minWidth: 0 }}>
              {o.label}
            </Box>
            {unit && o.quantity !== undefined && (
              <Typography
                variant="caption"
                color={o.quantity > 0 ? 'text.secondary' : 'text.disabled'}
                sx={{ fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}
              >
                {o.quantity > 0 ? `${num(o.quantity)} ${unit}` : 'empty'}
              </Typography>
            )}
          </Box>
        );
      }}
      renderInput={(params) => (
        <TextField
          {...params}
          size={size}
          label={label}
          required={required}
          error={error || Boolean(createError)}
          helperText={createError ?? helperText}
          slotProps={{
            input: {
              ...params.InputProps,
              endAdornment: (
                <>
                  {creating && <CircularProgress size={18} sx={{ mr: 1 }} />}
                  {params.InputProps.endAdornment}
                </>
              ),
            },
          }}
        />
      )}
    />
  );
}
