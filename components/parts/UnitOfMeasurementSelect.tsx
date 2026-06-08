'use client';

import { useEffect, useMemo, useState } from 'react';
import Autocomplete, { autocompleteClasses } from '@mui/material/Autocomplete';
import TextField from '@mui/material/TextField';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import Alert from '@mui/material/Alert';
import CircularProgress from '@mui/material/CircularProgress';
import Typography from '@mui/material/Typography';
import AddIcon from '@mui/icons-material/Add';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';

import {
  STANDARD_UNITS,
  STANDARD_UNITS_BY_KEY,
  CATEGORY_LABELS,
  type UnitCategoryKey,
} from '@/lib/standardUnits';
import {
  getCompanyCustomUnits,
  addCompanyCustomUnit,
} from '@/utils/unitsAccess';
import type { CompanyCustomUnit } from '@/types/units';
import MissingFieldsNotice from '@/components/common/MissingFieldsNotice';

/**
 * Internal option shape. The Autocomplete renders one of three kinds:
 *  - 'standard' — from `STANDARD_UNITS` (label + short symbol)
 *  - 'custom'   — from `company_custom_units` (label only)
 *  - 'unknown'  — the part's existing unit doesn't match either; pinned at
 *    the top with a warning chip so legacy data stays editable
 *  - 'add'      — sentinel "+ Add custom unit..." row that opens the modal
 *
 * The shared `key` is used as the Autocomplete `value` and the unit string
 * persisted to the parts table.
 */
type UnitOption =
  | { kind: 'standard'; key: string; label: string; short: string; group: string }
  | { kind: 'custom'; key: string; label: string; group: string }
  | { kind: 'unknown'; key: string; label: string; group: string }
  | { kind: 'add'; key: '__add_custom__'; label: string; group: string };

const ADD_CUSTOM_KEY = '__add_custom__';
const CUSTOM_GROUP = 'Custom';
const ACTIONS_GROUP = ' '; // sorts last visually because it's a non-letter

interface UnitOfMeasurementSelectProps {
  value: string | null;
  onChange: (newValue: string | null) => void;
  companyId: string;
  label?: string;
  required?: boolean;
  disabled?: boolean;
  helperText?: string;
  error?: boolean;
}

const groupOrder: Record<string, number> = {
  [CATEGORY_LABELS.count]: 1,
  [CATEGORY_LABELS.weight]: 2,
  [CATEGORY_LABELS.length]: 3,
  [CATEGORY_LABELS.volume]: 4,
  [CATEGORY_LABELS.area]: 5,
  [CATEGORY_LABELS.time]: 6,
  [CUSTOM_GROUP]: 7,
  [ACTIONS_GROUP]: 8,
  Unknown: 0, // pinned at the top for legacy values
};

export default function UnitOfMeasurementSelect({
  value,
  onChange,
  companyId,
  label = 'Unit of measurement',
  required = false,
  disabled = false,
  helperText,
  error = false,
}: UnitOfMeasurementSelectProps) {
  const [customUnits, setCustomUnits] = useState<CompanyCustomUnit[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [modalOpen, setModalOpen] = useState(false);
  const [newUnitName, setNewUnitName] = useState('');
  const [savingNewUnit, setSavingNewUnit] = useState(false);
  const [modalError, setModalError] = useState<string | null>(null);

  // Initial load. We refetch after each successful "add custom" so the
  // dropdown reflects the new unit immediately.
  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const data = await getCompanyCustomUnits(companyId);
        if (!cancelled) setCustomUnits(data);
      } catch (err) {
        if (!cancelled) {
          setLoadError(
            err instanceof Error ? err.message : 'Failed to load custom units',
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [companyId]);

  /**
   * Build the option list from STANDARD_UNITS + customUnits. Includes:
   *  - an "Unknown" pinned option if `value` doesn't match anything (legacy
   *    data fallback)
   *  - the "+ Add custom unit..." sentinel always at the bottom
   */
  const options = useMemo<UnitOption[]>(() => {
    const standardOpts: UnitOption[] = STANDARD_UNITS.map((u) => ({
      kind: 'standard',
      key: u.key,
      label: u.label,
      short: u.short,
      group: CATEGORY_LABELS[u.category as UnitCategoryKey],
    }));

    const customOpts: UnitOption[] = customUnits.map((u) => ({
      kind: 'custom',
      key: u.unit_name,
      label: u.unit_name,
      group: CUSTOM_GROUP,
    }));

    const result: UnitOption[] = [...standardOpts, ...customOpts];

    // Legacy-data fallback: pin the unrecognized value at the top so the
    // user can keep it (or replace it with a known unit).
    if (
      value &&
      !STANDARD_UNITS_BY_KEY[value] &&
      !customUnits.some((u) => u.unit_name === value)
    ) {
      result.unshift({
        kind: 'unknown',
        key: value,
        label: value,
        group: 'Unknown',
      });
    }

    result.push({
      kind: 'add',
      key: ADD_CUSTOM_KEY,
      label: '+ Add custom unit...',
      group: ACTIONS_GROUP,
    });

    return result;
  }, [customUnits, value]);

  const selectedOption = useMemo<UnitOption | null>(() => {
    if (!value) return null;
    return options.find((o) => o.key === value && o.kind !== 'add') ?? null;
  }, [options, value]);

  const handleChange = (
    _event: React.SyntheticEvent,
    next: UnitOption | null,
  ) => {
    if (next?.kind === 'add') {
      // Sentinel row — open the modal instead of "selecting" it.
      setNewUnitName('');
      setModalError(null);
      setModalOpen(true);
      return;
    }
    onChange(next ? next.key : null);
  };

  const closeModal = () => {
    if (savingNewUnit) return;
    setModalOpen(false);
    setNewUnitName('');
    setModalError(null);
  };

  const handleSaveNewUnit = async () => {
    const trimmed = newUnitName.trim();
    setModalError(null);

    if (!trimmed) {
      setModalError('Unit name is required');
      return;
    }

    // Case-insensitive uniqueness against both standard + existing custom
    // units. The DB enforces case-sensitive uniqueness on `unit_name`; we
    // tighten that to case-insensitive at the form layer to avoid "Inches"
    // and "inches" both appearing in the picker.
    const lower = trimmed.toLowerCase();
    const dupStandard = STANDARD_UNITS.some(
      (u) => u.key.toLowerCase() === lower || u.short.toLowerCase() === lower,
    );
    const dupCustom = customUnits.some(
      (u) => u.unit_name.toLowerCase() === lower,
    );
    if (dupStandard || dupCustom) {
      setModalError(`Unit "${trimmed}" already exists`);
      return;
    }

    setSavingNewUnit(true);
    try {
      const created = await addCompanyCustomUnit(companyId, trimmed);
      // Refresh the list so the new unit shows up in the dropdown.
      const refreshed = await getCompanyCustomUnits(companyId);
      setCustomUnits(refreshed);
      // Auto-select the unit the user just created.
      onChange(created.unit_name);
      setModalOpen(false);
      setNewUnitName('');
    } catch (err) {
      setModalError(
        err instanceof Error ? err.message : 'Failed to add custom unit',
      );
    } finally {
      setSavingNewUnit(false);
    }
  };

  return (
    <>
      <Autocomplete<UnitOption, false, false, false>
        options={options}
        value={selectedOption}
        onChange={handleChange}
        disabled={disabled || loading}
        getOptionLabel={(opt) => opt.label}
        isOptionEqualToValue={(opt, val) => opt.key === val.key}
        groupBy={(opt) => opt.group}
        // Sort groups by `groupOrder` so categories appear in a stable order
        // and "Custom" + the add-action row stay at the bottom.
        renderGroup={(p) => (
          <li key={p.key} data-group-order={groupOrder[p.group] ?? 99}>
            <Box
              sx={{
                px: 2,
                py: 0.5,
                fontSize: '0.75rem',
                fontWeight: 600,
                color: 'text.secondary',
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
                bgcolor: 'background.default',
              }}
            >
              {p.group === ACTIONS_GROUP ? '' : p.group}
            </Box>
            <ul style={{ padding: 0 }}>{p.children}</ul>
          </li>
        )}
        renderOption={(props, option) => {
          const { key: _propsKey, ...rest } = props as React.HTMLAttributes<HTMLLIElement> & {
            key: string;
          };

          if (option.kind === 'add') {
            return (
              <li
                key={option.key}
                {...rest}
                style={{
                  ...rest.style,
                  borderTop: '1px solid rgba(255,255,255,0.08)',
                  fontWeight: 500,
                }}
              >
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                  <AddIcon fontSize="small" />
                  <Typography variant="body2">Add custom unit...</Typography>
                </Box>
              </li>
            );
          }

          if (option.kind === 'unknown') {
            return (
              <li key={option.key} {...rest}>
                <Box
                  sx={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 1,
                    width: '100%',
                  }}
                >
                  <WarningAmberIcon fontSize="small" color="warning" />
                  <Typography variant="body2" sx={{ flex: 1 }}>
                    {option.label}
                  </Typography>
                  <Chip
                    size="small"
                    label="unknown"
                    color="warning"
                    variant="outlined"
                  />
                </Box>
              </li>
            );
          }

          if (option.kind === 'standard') {
            return (
              <li key={option.key} {...rest}>
                <Box
                  sx={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 1,
                    width: '100%',
                  }}
                >
                  <Typography variant="body2" sx={{ flex: 1 }}>
                    {option.label}
                  </Typography>
                  <Chip size="small" label={option.short} variant="outlined" />
                </Box>
              </li>
            );
          }

          // custom
          return (
            <li key={option.key} {...rest}>
              <Typography variant="body2">{option.label}</Typography>
            </li>
          );
        }}
        renderInput={(params) => (
          <TextField
            {...params}
            label={label}
            required={required}
            error={error || !!loadError}
            helperText={loadError ?? helperText}
            slotProps={{
              input: {
                ...params.InputProps,
                endAdornment: (
                  <>
                    {loading ? (
                      <CircularProgress color="inherit" size={18} />
                    ) : null}
                    {params.InputProps.endAdornment}
                  </>
                ),
              },
            }}
          />
        )}
        sx={{
          // Make sure the popper is wide enough to show the chip + label
          [`& .${autocompleteClasses.option}`]: {
            paddingY: 1,
          },
        }}
      />

      {/* Add-custom-unit modal. Inline so the user doesn't lose context. */}
      <Dialog open={modalOpen} onClose={closeModal} maxWidth="xs" fullWidth>
        <DialogTitle>Add custom unit</DialogTitle>
        <DialogContent>
          {modalError && (
            <Alert severity="error" sx={{ mb: 2 }}>
              {modalError}
            </Alert>
          )}
          <TextField
            autoFocus
            fullWidth
            required
            label="Unit name"
            value={newUnitName}
            onChange={(e) => {
              setNewUnitName(e.target.value);
              if (modalError) setModalError(null);
            }}
            disabled={savingNewUnit}
            placeholder="e.g. billet, skein, spool"
            helperText="A short name unique to your company. Avoid abbreviations of standard units (use the standard list for those)."
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                handleSaveNewUnit();
              }
            }}
          />
          <MissingFieldsNotice
            items={!newUnitName.trim() ? ['Enter a unit name'] : []}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={closeModal} disabled={savingNewUnit}>
            Cancel
          </Button>
          <Button
            onClick={handleSaveNewUnit}
            variant="contained"
            disabled={savingNewUnit || !newUnitName.trim()}
            startIcon={
              savingNewUnit ? <CircularProgress size={16} color="inherit" /> : null
            }
          >
            {savingNewUnit ? 'Saving...' : 'Save'}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
