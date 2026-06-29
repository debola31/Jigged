'use client';

import { useEffect, useState } from 'react';
import Autocomplete from '@mui/material/Autocomplete';
import TextField from '@mui/material/TextField';
import CircularProgress from '@mui/material/CircularProgress';
import type { SxProps, Theme } from '@mui/material/styles';

import { getAllVendors } from '@/utils/vendorsAccess';
import type { Vendor } from '@/types/vendor';

export interface VendorAutocompleteProps {
  companyId: string;
  /**
   * Current selection. Pass either this (fully-resolved Vendor) or `valueId`
   * (just the id — convenient when the parent only stores the foreign key
   * and doesn't want to maintain a duplicate vendor object in state).
   */
  value?: Vendor | null;
  /** Convenience: when `value` is unset, looks up the vendor by id from the loaded list. */
  valueId?: string | null;
  onChange: (vendor: Vendor | null) => void;
  label: string;
  placeholder?: string;
  helperText?: React.ReactNode;
  required?: boolean;
  disabled?: boolean;
  error?: boolean;
  size?: 'small' | 'medium';
  /** MUI Autocomplete renderOption hook for custom dropdown rendering. */
  renderOption?: (
    props: React.HTMLAttributes<HTMLLIElement> & { key?: React.Key },
    option: Vendor,
  ) => React.ReactNode;
  sx?: SxProps<Theme>;
}

/**
 * Shared vendor picker. Bulk-loads via `getAllVendors` on mount — vendors
 * are a bounded collection (~hundreds per company), so client-side filter
 * is the right pattern. Compare with `PartAutocomplete` which scales to
 * 10k+ via server-side search.
 *
 * When the vendor list comes back empty, the helper text falls through to
 * a default "No vendors yet" message so admins know what to do next.
 */
export default function VendorAutocomplete({
  companyId,
  value,
  valueId,
  onChange,
  label,
  placeholder,
  helperText,
  required,
  disabled,
  error,
  size = 'small',
  renderOption,
  sx,
}: VendorAutocompleteProps) {
  const [vendors, setVendors] = useState<Vendor[]>([]);
  // Starts true so the load effect needs no synchronous setLoading(true) (which
  // would trip set-state-in-effect); all setState happens in the async callback.
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);

  // Resolve effective value. Prefer the explicit Vendor; fall back to id
  // lookup once the vendor list has loaded. While loading, return null so
  // MUI doesn't warn about an out-of-options value.
  const effectiveValue =
    value ?? (valueId && loaded ? vendors.find((v) => v.id === valueId) ?? null : null);

  useEffect(() => {
    let cancelled = false;
    getAllVendors(companyId)
      .then((rows) => {
        if (!cancelled) setVendors(rows);
      })
      .catch((err) => {
        if (!cancelled) console.warn('Failed to load vendors:', err);
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
        setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [companyId]);

  const finalHelperText =
    helperText ??
    (loaded && vendors.length === 0
      ? 'No vendors yet — add one in Vendors first.'
      : undefined);

  return (
    <Autocomplete<Vendor>
      openOnFocus
      options={vendors}
      value={effectiveValue}
      onChange={(_, v) => onChange(v)}
      getOptionLabel={(o) => o.name}
      isOptionEqualToValue={(o, v) => o.id === v.id}
      loading={loading}
      disabled={disabled}
      size={size}
      sx={sx}
      renderOption={renderOption}
      renderInput={(params) => (
        <TextField
          {...params}
          label={label}
          placeholder={placeholder}
          required={required}
          error={error}
          helperText={finalHelperText}
          slotProps={{
            input: {
              ...params.InputProps,
              endAdornment: (
                <>
                  {loading ? <CircularProgress color="inherit" size={16} /> : null}
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
