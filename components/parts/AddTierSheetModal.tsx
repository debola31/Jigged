'use client';

import { useEffect, useMemo, useState } from 'react';
import Box from '@mui/material/Box';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import TextField from '@mui/material/TextField';
import Button from '@mui/material/Button';
import Alert from '@mui/material/Alert';
import Autocomplete from '@mui/material/Autocomplete';
import CircularProgress from '@mui/material/CircularProgress';
import Typography from '@mui/material/Typography';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import Divider from '@mui/material/Divider';
import AddIcon from '@mui/icons-material/Add';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import { addTier } from '@/utils/procurementTiersAccess';
import { getAllVendors } from '@/utils/vendorsAccess';
import type { Vendor } from '@/types/vendor';

interface VendorOption {
  id: string;
  name: string;
}

const INTERNAL_ESTIMATE_OPTION: VendorOption = {
  id: '__internal__',
  name: 'Internal estimate (no vendor)',
};

interface TierRowDraft {
  /** Stable key for React (not persisted). */
  key: string;
  min_quantity: string;
  cost_per_unit: string;
  notes: string;
}

interface AddTierSheetModalProps {
  open: boolean;
  onClose: () => void;
  partId: string;
  companyId: string;
  /**
   * When provided, the vendor picker is pre-filled and disabled. Use the
   * exact value `null` (not `undefined`) to lock the modal to the
   * "Internal estimate" group.
   */
  existingVendorId?: string | null;
  onSaved: () => void;
}

function makeRowKey(): string {
  return `row_${Math.random().toString(36).slice(2, 10)}`;
}

function emptyRow(): TierRowDraft {
  return { key: makeRowKey(), min_quantity: '', cost_per_unit: '', notes: '' };
}

/**
 * Add a new tier sheet (one or more tier rows) for a part, all sharing the
 * same vendor + quoted_at + expires_at metadata.
 *
 * Partial-success handling: each row is its own INSERT. If the user adds 4
 * rows and one trips the unique-break constraint, the others succeed —
 * we surface a clear error indicating which rows failed and leave the
 * succeeded rows in place. The user can fix the failing rows and re-submit
 * (the failing-row drafts remain in the modal until the user fixes them).
 *
 * This is the simplification called out in the chunk plan: rolling back
 * succeeded inserts would require a transactional RPC, which is out of
 * scope for Phase 1. Surfacing the failures clearly is the contract.
 */
export default function AddTierSheetModal({
  open,
  onClose,
  partId,
  companyId,
  existingVendorId,
  onSaved,
}: AddTierSheetModalProps) {
  const vendorLocked = existingVendorId !== undefined;

  const [vendors, setVendors] = useState<VendorOption[]>([]);
  const [vendorsLoading, setVendorsLoading] = useState(false);
  const [vendorPick, setVendorPick] = useState<VendorOption | null>(
    INTERNAL_ESTIMATE_OPTION,
  );
  const [quotedAt, setQuotedAt] = useState<string>('');
  const [expiresAt, setExpiresAt] = useState<string>('');
  const [rows, setRows] = useState<TierRowDraft[]>([emptyRow()]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [partialErrors, setPartialErrors] = useState<
    { rowIndex: number; message: string }[]
  >([]);

  // Reset every time the modal opens.
  useEffect(() => {
    if (!open) return;
    setRows([emptyRow()]);
    setQuotedAt('');
    setExpiresAt('');
    setError(null);
    setPartialErrors([]);
  }, [open]);

  // Load vendor list whenever the modal opens (fresh — vendors might have
  // been added since the last open). Prepend the "Internal estimate" option.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setVendorsLoading(true);
    getAllVendors(companyId)
      .then((rows) => {
        if (cancelled) return;
        const opts: VendorOption[] = (rows as Vendor[]).map((v) => ({
          id: v.id,
          name: v.name,
        }));
        opts.sort((a, b) => a.name.localeCompare(b.name));
        const all = [INTERNAL_ESTIMATE_OPTION, ...opts];
        setVendors(all);
      })
      .catch((err) => {
        if (cancelled) return;
        console.error('Failed to load vendors for tier sheet modal:', err);
        setError('Failed to load vendor list.');
      })
      .finally(() => {
        if (!cancelled) setVendorsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, companyId]);

  // Sync the vendor pick to the locked vendor (or default to "Internal
  // estimate") whenever the vendor list arrives or the modal reopens.
  useEffect(() => {
    if (!open) return;
    if (vendors.length === 0) return;
    if (vendorLocked) {
      const target =
        existingVendorId === null
          ? INTERNAL_ESTIMATE_OPTION
          : vendors.find((v) => v.id === existingVendorId) ??
            INTERNAL_ESTIMATE_OPTION;
      setVendorPick(target);
    } else {
      setVendorPick(INTERNAL_ESTIMATE_OPTION);
    }
  }, [open, vendors, vendorLocked, existingVendorId]);

  const updateRow = (idx: number, patch: Partial<TierRowDraft>) => {
    setRows((prev) => {
      const next = prev.slice();
      next[idx] = { ...next[idx], ...patch };
      return next;
    });
  };

  const addRow = () => {
    setRows((prev) => [...prev, emptyRow()]);
  };

  const removeRow = (idx: number) => {
    setRows((prev) =>
      prev.length === 1 ? prev : prev.filter((_, i) => i !== idx),
    );
  };

  const trimmedRows = useMemo(
    () =>
      rows
        .map((r, i) => ({ ...r, _index: i }))
        .filter(
          (r) => r.min_quantity.trim() !== '' || r.cost_per_unit.trim() !== '',
        ),
    [rows],
  );

  const handleSubmit = async () => {
    setError(null);
    setPartialErrors([]);

    if (!vendorPick) {
      setError('Please pick a vendor (or "Internal estimate").');
      return;
    }
    if (trimmedRows.length === 0) {
      setError('Add at least one tier row before saving.');
      return;
    }
    if (quotedAt && expiresAt && quotedAt > expiresAt) {
      setError('Expiration date must be on or after the quote date.');
      return;
    }

    // Pre-validate every row before any inserts so we don't half-write a
    // sheet just because the user typed a non-numeric value into row 3.
    const invalidRows: { rowIndex: number; message: string }[] = [];
    for (const row of trimmedRows) {
      const minQty = parseFloat(row.min_quantity);
      if (!Number.isFinite(minQty) || minQty <= 0) {
        invalidRows.push({
          rowIndex: row._index,
          message: 'Minimum quantity must be greater than zero.',
        });
        continue;
      }
      const cost = parseFloat(row.cost_per_unit);
      if (!Number.isFinite(cost) || cost <= 0) {
        invalidRows.push({
          rowIndex: row._index,
          message: 'Cost per unit must be greater than zero.',
        });
      }
    }
    if (invalidRows.length > 0) {
      setPartialErrors(invalidRows);
      setError('Fix the highlighted rows before saving.');
      return;
    }

    // Pre-check duplicate min_quantity within the SUBMITTED batch (the DB
    // would reject it with 23505 anyway, but we get a clearer message
    // before any inserts happen).
    const seen = new Set<number>();
    for (const row of trimmedRows) {
      const minQty = parseFloat(row.min_quantity);
      if (seen.has(minQty)) {
        setError(
          `Two tier rows share the same minimum quantity (${minQty}). Each break must be unique.`,
        );
        return;
      }
      seen.add(minQty);
    }

    setSubmitting(true);

    const failures: { rowIndex: number; message: string }[] = [];
    const succeededIndexes: number[] = [];
    const vendor_id =
      vendorPick.id === INTERNAL_ESTIMATE_OPTION.id ? null : vendorPick.id;

    // Insert sequentially so each row's friendly error message is reported
    // against the correct row index. With Promise.all we'd have to weave
    // settlement-order back to row order anyway.
    for (const row of trimmedRows) {
      try {
        await addTier({
          part_id: partId,
          vendor_id,
          min_quantity: row.min_quantity,
          cost_per_unit: row.cost_per_unit,
          quoted_at: quotedAt || null,
          expires_at: expiresAt || null,
          notes: row.notes,
        });
        succeededIndexes.push(row._index);
      } catch (err) {
        failures.push({
          rowIndex: row._index,
          message:
            err instanceof Error ? err.message : 'Failed to save tier row.',
        });
      }
    }

    setSubmitting(false);

    if (failures.length === 0) {
      onSaved();
      onClose();
      return;
    }

    setPartialErrors(failures);
    if (succeededIndexes.length === 0) {
      setError(
        `Failed to save ${failures.length} tier row${failures.length === 1 ? '' : 's'}. See per-row errors below.`,
      );
    } else {
      // Drop the rows that succeeded so the user can fix only the failures
      // and re-submit; refresh the parent to show the saved tiers.
      setRows((prev) =>
        prev.filter((_, idx) => !succeededIndexes.includes(idx)),
      );
      // Recompute partial errors against the new (filtered) row indexes.
      const survivorMap = new Map<number, number>();
      let newIdx = 0;
      for (let oldIdx = 0; oldIdx < rows.length; oldIdx++) {
        if (!succeededIndexes.includes(oldIdx)) {
          survivorMap.set(oldIdx, newIdx);
          newIdx += 1;
        }
      }
      setPartialErrors(
        failures.map((f) => ({
          rowIndex: survivorMap.get(f.rowIndex) ?? f.rowIndex,
          message: f.message,
        })),
      );
      setError(
        `Saved ${succeededIndexes.length} tier${succeededIndexes.length === 1 ? '' : 's'}, but ${failures.length} row${failures.length === 1 ? '' : 's'} failed. Fix the remaining rows and click Save again.`,
      );
      onSaved();
    }
  };

  return (
    <Dialog
      open={open}
      onClose={submitting ? undefined : onClose}
      maxWidth="md"
      fullWidth
    >
      <DialogTitle>Add tier sheet</DialogTitle>
      <DialogContent dividers>
        {error && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {error}
          </Alert>
        )}

        {/* Section 1: vendor + quote/expiry metadata */}
        <Typography variant="subtitle2" sx={{ mb: 1, fontWeight: 600 }}>
          Sheet metadata
        </Typography>
        <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap', mb: 3 }}>
          <Autocomplete
            options={vendors}
            loading={vendorsLoading}
            value={vendorPick}
            onChange={(_, option) => setVendorPick(option)}
            getOptionLabel={(option) => option.name}
            isOptionEqualToValue={(option, value) => option.id === value.id}
            disabled={vendorLocked}
            sx={{ minWidth: 280, flex: 1 }}
            renderInput={(params) => (
              <TextField
                {...params}
                label="Vendor"
                required
                helperText={
                  vendorLocked
                    ? 'Locked to the existing tier sheet.'
                    : 'Pick "Internal estimate" to sketch a cost before sourcing.'
                }
                InputProps={{
                  ...params.InputProps,
                  endAdornment: (
                    <>
                      {vendorsLoading ? <CircularProgress size={18} /> : null}
                      {params.InputProps.endAdornment}
                    </>
                  ),
                }}
              />
            )}
          />
          <TextField
            label="Quoted on"
            type="date"
            value={quotedAt}
            onChange={(e) => setQuotedAt(e.target.value)}
            InputLabelProps={{ shrink: true }}
            sx={{ width: 180 }}
          />
          <TextField
            label="Expires on"
            type="date"
            value={expiresAt}
            onChange={(e) => setExpiresAt(e.target.value)}
            InputLabelProps={{ shrink: true }}
            helperText={'Leave blank if open-ended.'}
            sx={{ width: 180 }}
          />
        </Box>

        <Divider sx={{ mb: 2 }} />

        {/* Section 2: tier rows */}
        <Box
          sx={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            mb: 1,
          }}
        >
          <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
            Tier rows
          </Typography>
          <Button
            size="small"
            startIcon={<AddIcon />}
            onClick={addRow}
            disabled={submitting}
          >
            Add tier row
          </Button>
        </Box>

        {rows.map((row, idx) => {
          const rowError = partialErrors.find((e) => e.rowIndex === idx);
          return (
            <Box
              key={row.key}
              sx={{
                display: 'flex',
                gap: 1.5,
                alignItems: 'flex-start',
                mb: 1.5,
              }}
            >
              <TextField
                label="Min qty"
                type="number"
                value={row.min_quantity}
                onChange={(e) => updateRow(idx, { min_quantity: e.target.value })}
                inputProps={{ min: 0, step: 'any' }}
                error={!!rowError}
                sx={{ width: 140 }}
                size="small"
              />
              <TextField
                label="Unit cost"
                type="number"
                value={row.cost_per_unit}
                onChange={(e) =>
                  updateRow(idx, { cost_per_unit: e.target.value })
                }
                inputProps={{ min: 0, step: 'any' }}
                error={!!rowError}
                sx={{ width: 160 }}
                size="small"
              />
              <TextField
                label="Notes"
                value={row.notes}
                onChange={(e) => updateRow(idx, { notes: e.target.value })}
                error={!!rowError}
                helperText={rowError?.message ?? ' '}
                sx={{ flex: 1 }}
                size="small"
              />
              <Tooltip title={rows.length === 1 ? 'At least one row required' : 'Remove row'}>
                <span>
                  <IconButton
                    onClick={() => removeRow(idx)}
                    disabled={rows.length === 1 || submitting}
                    sx={{
                      mt: 0.5,
                      color: 'text.secondary',
                      '&:hover': { color: 'error.main' },
                    }}
                  >
                    <DeleteOutlineIcon fontSize="small" />
                  </IconButton>
                </span>
              </Tooltip>
            </Box>
          );
        })}

        <Typography variant="caption" color="text.secondary">
          Tier ordering on the part page is derived from minimum quantity
          (smallest first). Each (vendor, min qty) pair must be unique.
        </Typography>
      </DialogContent>

      <DialogActions>
        <Button onClick={onClose} disabled={submitting}>
          Cancel
        </Button>
        <Button
          variant="contained"
          onClick={handleSubmit}
          disabled={submitting}
          startIcon={submitting ? <CircularProgress size={16} color="inherit" /> : null}
        >
          {submitting ? 'Saving...' : 'Save tier sheet'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
