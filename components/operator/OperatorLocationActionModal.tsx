'use client';

import { useState } from 'react';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import TextField from '@mui/material/TextField';
import MenuItem from '@mui/material/MenuItem';
import Button from '@mui/material/Button';
import Stack from '@mui/material/Stack';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Autocomplete from '@mui/material/Autocomplete';
import Alert from '@mui/material/Alert';

import {
  addStockAtLocation,
  depleteStockAtLocation,
  adjustStockAtLocation,
} from '@/utils/inventoryLocationsAccess';
import { getAllJobs } from '@/utils/jobsAccess';
import type { JobWithRelations, ProductionStatus } from '@/types/job';

// Active jobs an operator could be consuming material for.
const ACTIVE_STATUSES: ProductionStatus[] = ['not_started', 'in_progress'];

/** "Part A, Part B" — the job's parts, to disambiguate look-alike job numbers. */
const jobPartsLabel = (j: JobWithRelations): string =>
  (j.job_parts ?? [])
    .map((jp) => jp.parts?.part_name)
    .filter((n): n is string => Boolean(n))
    .join(', ');

export type OperatorLocationAction = 'add' | 'deplete' | 'adjust';

const TITLES: Record<OperatorLocationAction, string> = {
  add: 'Add stock',
  deplete: 'Remove stock',
  adjust: 'Set stock (cycle count)',
};

const CONFIRM: Record<OperatorLocationAction, string> = {
  add: 'Add',
  deplete: 'Remove',
  adjust: 'Set',
};

interface OperatorLocationActionModalProps {
  open: boolean;
  action: OperatorLocationAction;
  companyId: string;
  partId: string;
  partName: string;
  /** Current on-hand at this location, for context. */
  currentQuantity: number;
  primaryUnit: string;
  unitOptions: string[];
  locationId: string;
  locationName: string;
  /** user_company_access.id of the signed-in operator (for the ledger). */
  operatorId: string | null;
  onClose: () => void;
  onDone: () => void | Promise<void>;
}

/**
 * Operator-facing Add / Remove / Set for ONE part at ONE (already-scanned)
 * location. Unlike the admin PartLocationActionModal the part and location are
 * fixed (no pickers), and a removal is ALWAYS graceful — over-consumption is
 * clamped to zero and flagged as a discrepancy rather than blocked, and is
 * stamped with the operator id — matching the shop-floor persona.
 */
export default function OperatorLocationActionModal({
  open,
  action,
  companyId,
  partId,
  partName,
  currentQuantity,
  primaryUnit,
  unitOptions,
  locationId,
  locationName,
  operatorId,
  onClose,
  onDone,
}: OperatorLocationActionModalProps) {
  const [quantity, setQuantity] = useState('');
  const [unit, setUnit] = useState(primaryUnit);
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Optional job tag, deplete only. Loaded on open via onEnter (house
  // convention — not a useEffect, which would trip set-state-in-effect lint).
  const [jobs, setJobs] = useState<JobWithRelations[]>([]);
  const [loadingJobs, setLoadingJobs] = useState(false);
  const [job, setJob] = useState<JobWithRelations | null>(null);

  const handleEnter = async () => {
    setQuantity('');
    setUnit(primaryUnit);
    setNotes('');
    setError(null);
    setJob(null);
    if (action !== 'deplete') return;
    setLoadingJobs(true);
    try {
      setJobs(await getAllJobs(companyId, { productionStatus: ACTIVE_STATUSES }));
    } catch {
      setJobs([]); // job tag is optional — never block the removal
    } finally {
      setLoadingJobs(false);
    }
  };

  const qtyLabel = action === 'adjust' ? 'New quantity here' : 'Quantity';

  const handleSubmit = async () => {
    const qty = parseFloat(quantity);
    if (!Number.isFinite(qty) || (action === 'adjust' ? qty < 0 : qty <= 0)) {
      setError(action === 'adjust' ? 'Quantity cannot be negative.' : 'Quantity must be positive.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (action === 'add') {
        await addStockAtLocation(partId, locationId, qty, unit, notes || undefined);
      } else if (action === 'deplete') {
        await depleteStockAtLocation(partId, locationId, qty, unit, {
          graceful: true,
          notes: notes || undefined,
          operatorId: operatorId || undefined,
          jobId: job?.id || undefined, // tie to the job, not an operation
        });
      } else {
        await adjustStockAtLocation(partId, locationId, qty, unit, notes || undefined);
      }
      await onDone();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update stock.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={saving ? undefined : onClose}
      maxWidth="xs"
      fullWidth
      TransitionProps={{ onEnter: handleEnter }}
    >
      <DialogTitle>{TITLES[action]}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <Typography variant="body2" color="text.secondary">
            <strong>{partName}</strong> at <strong>{locationName}</strong> — {currentQuantity}{' '}
            {primaryUnit} here now
          </Typography>
          <Stack direction="row" spacing={1}>
            <TextField
              label={qtyLabel}
              type="number"
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
              inputProps={{ min: 0, step: 'any', inputMode: 'decimal' }}
              fullWidth
              autoFocus
            />
            <TextField
              select
              label="Unit"
              value={unit}
              onChange={(e) => setUnit(e.target.value)}
              sx={{ minWidth: 120 }}
            >
              {unitOptions.map((u) => (
                <MenuItem key={u} value={u}>
                  {u}
                </MenuItem>
              ))}
            </TextField>
          </Stack>
          {action === 'deplete' && (
            <Typography variant="caption" color="text.secondary">
              Removing more than is here records the shortfall and sets the count to zero — it
              won&apos;t block you.
            </Typography>
          )}
          {action === 'deplete' && (
            <Autocomplete
              options={jobs}
              loading={loadingJobs}
              value={job}
              onChange={(_, v) => setJob(v)}
              getOptionLabel={(j) => j.job_number}
              isOptionEqualToValue={(a, b) => a.id === b.id}
              renderOption={(props, j) => {
                const { key, ...rest } = props;
                return (
                  <Box component="li" key={key} {...rest}>
                    <Box sx={{ display: 'flex', flexDirection: 'column' }}>
                      <Typography variant="body2">{j.job_number}</Typography>
                      {jobPartsLabel(j) && (
                        <Typography variant="caption" color="text.secondary">
                          {jobPartsLabel(j)}
                        </Typography>
                      )}
                    </Box>
                  </Box>
                );
              }}
              renderInput={(params) => <TextField {...params} label="Tag to a job (optional)" />}
              noOptionsText="No active jobs"
              loadingText="Loading jobs…"
            />
          )}
          <TextField
            label="Notes (optional)"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            multiline
            minRows={2}
            fullWidth
          />
          {error && <Alert severity="error">{error}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={saving} size="large">
          Cancel
        </Button>
        <Button onClick={handleSubmit} variant="contained" disabled={saving} size="large">
          {CONFIRM[action]}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
