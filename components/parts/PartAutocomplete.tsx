'use client';

import { useEffect, useState } from 'react';
import Autocomplete from '@mui/material/Autocomplete';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';

import { searchPartsForSelect, type PartSelectOption } from '@/utils/partsAccess';

export type { PartSelectOption };

interface CreateNewOption {
  id: '__create_new_part__';
  part_name: string;
  isCreateNew: true;
}

type AutocompleteOption = PartSelectOption | CreateNewOption;

function isCreateNewOption(o: AutocompleteOption | null): o is CreateNewOption {
  return !!o && 'isCreateNew' in o && o.isCreateNew === true;
}

export interface PartAutocompleteProps {
  companyId: string;
  value: PartSelectOption | null;
  onChange: (option: PartSelectOption | null) => void;
  /** Server-side filter: which subset of the parts table to search. */
  kind?: 'all' | 'made' | 'stocked' | 'bought';
  /** Hide options whose id is in this list (e.g. already-picked siblings). */
  excludeIds?: string[];
  label: string;
  /** When provided, prepends a "Create New Part" sentinel that calls this. */
  onCreateNew?: () => void;
  createNewLabel?: string;
  size?: 'small' | 'medium';
  disabled?: boolean;
  required?: boolean;
  autoFocus?: boolean;
  helperText?: React.ReactNode;
}

/**
 * Shared autocomplete for picking a part. Uses server-side search
 * (`searchPartsForSelect`) so it scales to companies with 10k+ parts without
 * the page paying a multi-second bulk-load on mount.
 *
 * The dropdown only fetches while open. Typing debounces at 300ms; the
 * initial focus fires immediately so the user sees the top 50 matches as
 * soon as they click.
 *
 * `value` is the source of truth — callers pass the full PartSelectOption
 * (not just an id) so display can show the label without an extra round
 * trip. In edit/initial-load flows the caller should hydrate via
 * `getPartsForSelectByIds`.
 */
export default function PartAutocomplete({
  companyId,
  value,
  onChange,
  kind = 'all',
  excludeIds,
  label,
  onCreateNew,
  createNewLabel = 'Create New Part',
  size = 'small',
  disabled,
  required,
  autoFocus,
  helperText,
}: PartAutocompleteProps) {
  const [open, setOpen] = useState(false);
  const [inputValue, setInputValue] = useState('');
  const [results, setResults] = useState<PartSelectOption[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    let active = true;
    const delay = inputValue.trim() ? 300 : 0;
    // setLoading lives inside the debounce callback (not synchronously in the
    // effect body) so it doesn't trip set-state-in-effect; the spinner shows
    // for the actual fetch rather than during the debounce wait.
    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const data = await searchPartsForSelect(companyId, inputValue, kind, 50);
        if (!active) return;
        setResults(data);
      } catch (err) {
        console.error('Part search failed:', err);
      } finally {
        if (active) setLoading(false);
      }
    }, delay);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [inputValue, companyId, kind, open]);

  const exclude = new Set(excludeIds ?? []);
  const options: AutocompleteOption[] = [
    ...(onCreateNew
      ? [
          {
            id: '__create_new_part__' as const,
            part_name: createNewLabel,
            isCreateNew: true as const,
          },
        ]
      : []),
    ...results.filter((r) => !exclude.has(r.id)),
  ];

  // MUI warns when `value` isn't findable in `options`. Append the current
  // selection if it isn't already in the search results.
  if (value && !options.some((o) => o.id === value.id)) {
    options.push(value);
  }

  return (
    <Autocomplete
      size={size}
      openOnFocus
      open={open}
      onOpen={() => setOpen(true)}
      onClose={() => setOpen(false)}
      options={options}
      filterOptions={(x) => x}
      loading={loading}
      value={value}
      inputValue={inputValue}
      onInputChange={(_, v) => setInputValue(v)}
      onChange={(_, v) => {
        if (isCreateNewOption(v)) {
          onCreateNew?.();
          return;
        }
        onChange((v as PartSelectOption | null) ?? null);
      }}
      getOptionLabel={(o) => o.part_name}
      isOptionEqualToValue={(o, v) => o.id === v.id}
      disabled={disabled}
      renderOption={(props, option) => {
        const { key, ...rest } = props as React.HTMLAttributes<HTMLLIElement> & {
          key?: React.Key;
        };
        const isCreate = isCreateNewOption(option);
        return (
          <Box
            component="li"
            {...rest}
            key={key as React.Key}
            // Keep MUI's single-row option layout; the part name and its
            // description previously ran together ("ASM-GEARBOXGearbox…") because
            // there was no gap. A gap + a shrinking, truncating description gives
            // clear demarcation on one line — the name bold, the description muted.
            sx={{ gap: 1.5, minWidth: 0 }}
          >
            <Typography
              component="span"
              variant="body2"
              sx={{ fontWeight: 600, flexShrink: 0, color: isCreate ? 'primary.main' : undefined }}
            >
              {option.part_name}
            </Typography>
            {!isCreate && (option as PartSelectOption).description && (
              <Typography
                component="span"
                variant="body2"
                color="text.secondary"
                noWrap
                sx={{ minWidth: 0 }}
              >
                {(option as PartSelectOption).description}
              </Typography>
            )}
          </Box>
        );
      }}
      renderInput={(params) => (
        <TextField
          {...params}
          label={label}
          required={required}
          autoFocus={autoFocus}
          size={size}
          helperText={helperText}
          InputProps={{
            ...params.InputProps,
            endAdornment: (
              <>
                {loading ? <CircularProgress size={16} /> : null}
                {params.InputProps.endAdornment}
              </>
            ),
          }}
        />
      )}
    />
  );
}
