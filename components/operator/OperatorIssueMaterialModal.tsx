'use client';

import { useState } from 'react';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import FormControlLabel from '@mui/material/FormControlLabel';
import MenuItem from '@mui/material/MenuItem';
import Radio from '@mui/material/Radio';
import RadioGroup from '@mui/material/RadioGroup';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import ShoppingBasketIcon from '@mui/icons-material/ShoppingBasket';

import { removePartStockGraceful } from '@/utils/partsAccess';
import { depleteStockAtLocation } from '@/utils/inventoryLocationsAccess';
import { addJobNote } from '@/utils/operatorAccess';
import { issueNote, locationLabel, resolveIssueTarget } from '@/lib/materialRequirements';
import type { MaterialRequirement } from '@/types/materialCheck';

interface OperatorIssueMaterialModalProps {
  open: boolean;
  companyId: string;
  jobId: string;
  jobNumber: string;
  /** For the feed note only — inventory_transactions has no job_part_id column. */
  jobPartId: string;
  madePartName: string | null;
  requirement: MaterialRequirement;
  /** The system bucket to fall back to when a tracked part has no stock anywhere. */
  unassigned: { id: string; name: string } | null;
  unitOptions: string[];
  /**
   * user_company_access.id of the signed-in operator. Stamps the ledger AND authors the feed
   * note — `notes.author_id` is an FK to user_company_access, not to the auth user.
   */
  operatorId: string | null;
  onClose: () => void;
  onDone: () => void | Promise<void>;
}

/**
 * "I'm taking this material for this job" — journey J7, the operator half.
 *
 * The entry point is the JOB, not a bin. That reverses the shape of the existing bin-first
 * flow, and it is the single strongest-evidenced decision in the inventory spec: 97 of the 121
 * "locations" in Contour's old ERP were job or work-order numbers, because users had no
 * job↔material link and built one by hand in the wrong field for years.
 *
 * Consequences of that framing, all deliberate:
 *  - **No job picker.** The job is the context; tagging it is not the operator's job to
 *    remember. The depletion is job-linked by construction.
 *  - **Always graceful.** Taking more than the system thinks is there clamps to zero and
 *    records the shortfall rather than blocking. The material is already in their hands.
 *  - **No `jobOperationId`.** The traveler has no operation context, and the spec deliberately
 *    folds the old confirm-at-operation step away — this take-event *is* the consumption
 *    (issue #550 resolves here, by being folded in).
 */
export default function OperatorIssueMaterialModal({
  open,
  companyId,
  jobId,
  jobNumber,
  jobPartId,
  madePartName,
  requirement,
  unassigned,
  unitOptions,
  operatorId,
  onClose,
  onDone,
}: OperatorIssueMaterialModalProps) {
  const stockUnit = requirement.stockUnit ?? requirement.bomUnit;
  const target = resolveIssueTarget(requirement.isLocationTracked, requirement.locations, unassigned);

  const [quantity, setQuantity] = useState('');
  const [unit, setUnit] = useState(stockUnit);
  const [locationId, setLocationId] = useState<string>('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // House convention: reset on open via TransitionProps.onEnter, not a useEffect.
  const handleEnter = () => {
    // Prefill what's left to fetch. NOT clamped to on-hand — clamping would silently
    // under-record when the bin is short, and graceful depletion exists to record the truth.
    // Empty when the units can't be compared, since there is no honest number to suggest.
    setQuantity(
      requirement.remainingToIssue !== null && requirement.remainingToIssue > 0
        ? String(requirement.remainingToIssue)
        : '',
    );
    setUnit(stockUnit);
    setLocationId(target.kind === 'choose' ? target.defaultLocationId : '');
    setError(null);
  };

  const handleSubmit = async () => {
    const qty = parseFloat(quantity);
    if (!Number.isFinite(qty) || qty <= 0) {
      setError('Enter how much you took.');
      return;
    }
    if (target.kind === 'blocked') {
      setError(target.reason);
      return;
    }

    setSaving(true);
    setError(null);
    const note = issueNote(jobNumber, madePartName);

    try {
      let fromLabel = '';
      if (target.kind === 'aggregate') {
        // Untracked part: the aggregate engine. This is removePartStockGraceful's first real
        // caller — it is job-aware and clamps, but had zero call sites until now.
        await removePartStockGraceful(
          requirement.partId, qty, unit, note, jobId, undefined, operatorId ?? undefined,
        );
      } else {
        let destId: string;
        if (target.kind === 'choose') {
          const chosen =
            target.options.find((o) => o.locationId === locationId) ?? target.options[0];
          destId = chosen.locationId;
          fromLabel = locationLabel(chosen);
        } else {
          destId = target.locationId;
          fromLabel = target.locationName;
        }
        await depleteStockAtLocation(requirement.partId, destId, qty, unit, {
          graceful: true,
          notes: note,
          jobId,
          operatorId: operatorId ?? undefined,
        });
      }

      // Best-effort trace in the feed operators actually read. The stock write has already
      // landed and cannot be undone, so a failed note must never surface as a failed take.
      if (operatorId) {
        try {
          await addJobNote(
            jobId,
            companyId,
            operatorId,
            `Took ${qty} ${unit} of ${requirement.partName}${fromLabel ? ` from ${fromLabel}` : ''}`,
            { jobPartId, noteType: 'event' },
          );
        } catch (noteErr) {
          // Logged, never surfaced: the stock write has landed and cannot be undone, so a
          // failed note must not read as a failed take. Logging matters — a silent swallow
          // hid an author_id FK mismatch here once.
          console.error('Issue recorded, but the job feed note failed:', noteErr);
        }
      }

      await onDone();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not record what you took.');
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
      <DialogTitle sx={{ pb: 0.5 }}>Take material</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <Typography variant="body2" color="text.secondary">
            <strong>{requirement.partName}</strong> for <strong>{jobNumber}</strong>
          </Typography>

          {target.kind === 'blocked' && <Alert severity="error">{target.reason}</Alert>}

          {target.kind === 'location' && (
            target.quantityHere > 0 ? (
              <Typography variant="body2">
                Take from <strong>{target.locationName}</strong> — {target.quantityHere} {stockUnit} here.
              </Typography>
            ) : (
              <Alert severity="warning">
                Nothing is recorded at any location for this part. Taking it will record a
                shortfall — that&apos;s fine, it just means the count was already wrong.
              </Alert>
            )
          )}

          {target.kind === 'choose' && (
            <div>
              <Typography variant="overline" color="text.secondary">
                Which one did you open?
              </Typography>
              <RadioGroup value={locationId} onChange={(e) => setLocationId(e.target.value)}>
                {target.options.map((o) => (
                  <FormControlLabel
                    key={o.locationId}
                    value={o.locationId}
                    control={<Radio />}
                    sx={{ minHeight: 56, m: 0 }}
                    label={
                      <span>
                        {locationLabel(o)}
                        <Typography component="span" variant="caption" color="text.secondary" sx={{ ml: 1 }}>
                          {o.quantity} {stockUnit}
                        </Typography>
                      </span>
                    }
                  />
                ))}
              </RadioGroup>
            </div>
          )}

          <Stack direction="row" spacing={1}>
            <TextField
              label="How much did you take?"
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
                <MenuItem key={u} value={u}>{u}</MenuItem>
              ))}
            </TextField>
          </Stack>

          {requirement.status === 'incomparable' && (
            <Alert severity="warning">
              This job&apos;s list is in {requirement.bomUnit} but stock is counted in {stockUnit}
              , so we can&apos;t suggest a number. Enter what you actually took in {stockUnit}.
            </Alert>
          )}

          <Typography variant="caption" color="text.secondary">
            Taking more than the system shows won&apos;t block you — it records the shortfall.
          </Typography>

          {error && <Alert severity="error">{error}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2.5, flexDirection: 'column', gap: 1 }}>
        <Button
          onClick={handleSubmit}
          variant="contained"
          fullWidth
          disabled={saving || target.kind === 'blocked'}
          startIcon={saving ? undefined : <ShoppingBasketIcon />}
          sx={{ minHeight: 64, fontSize: '1.15rem', fontWeight: 600 }}
        >
          {saving ? <CircularProgress size={24} /> : 'TAKE MATERIAL'}
        </Button>
        <Button onClick={onClose} disabled={saving} fullWidth sx={{ minHeight: 48 }}>
          Cancel
        </Button>
      </DialogActions>
    </Dialog>
  );
}
