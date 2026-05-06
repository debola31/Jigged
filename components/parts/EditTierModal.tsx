'use client';

import { useEffect, useState } from 'react';
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
import { updateTier } from '@/utils/procurementTiersAccess';
import { getAllVendors } from '@/utils/vendorsAccess';
import type { ProcurementTier } from '@/types/procurementTier';
import type { Vendor } from '@/types/vendor';

interface VendorOption {
  id: string;
  name: string;
}

const INTERNAL_ESTIMATE_OPTION: VendorOption = {
  id: '__internal__',
  name: 'Internal estimate (no vendor)',
};

interface EditTierModalProps {
  open: boolean;
  onClose: () => void;
  companyId: string;
  tier: ProcurementTier | null;
  onSaved: () => void;
}

/**
 * Edit a single procurement tier row. Used when the user clicks the pencil
 * on an existing row in PartProcurementPricingPanel.
 *
 * Vendor is editable (rare but legitimate — a tier might be moved from
 * "Internal estimate" to a real vendor once sourcing is finalized). The
 * unique constraint on (part_id, vendor_id, min_quantity) is enforced by
 * the DB and surfaced as a friendly error by the access layer.
 */
export default function EditTierModal({
  open,
  onClose,
  companyId,
  tier,
  onSaved,
}: EditTierModalProps) {
  const [vendors, setVendors] = useState<VendorOption[]>([]);
  const [vendorsLoading, setVendorsLoading] = useState(false);
  const [vendorPick, setVendorPick] = useState<VendorOption | null>(null);
  const [minQty, setMinQty] = useState('');
  const [cost, setCost] = useState('');
  const [quotedAt, setQuotedAt] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Hydrate the form whenever a new tier is selected for edit.
  useEffect(() => {
    if (!open || !tier) return;
    setMinQty(String(tier.min_quantity));
    setCost(String(tier.cost_per_unit));
    setQuotedAt(tier.quoted_at ?? '');
    setExpiresAt(tier.expires_at ?? '');
    setNotes(tier.notes ?? '');
    setError(null);
  }, [open, tier]);

  // Vendor list (refresh each open for parity with the add modal).
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
        console.error('Failed to load vendors for edit tier modal:', err);
        setError('Failed to load vendor list.');
      })
      .finally(() => {
        if (!cancelled) setVendorsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, companyId]);

  // Sync the vendor pick to the tier's current vendor once vendors load.
  useEffect(() => {
    if (!open || !tier || vendors.length === 0) return;
    if (tier.vendor_id === null) {
      setVendorPick(INTERNAL_ESTIMATE_OPTION);
    } else {
      setVendorPick(
        vendors.find((v) => v.id === tier.vendor_id) ??
          INTERNAL_ESTIMATE_OPTION,
      );
    }
  }, [open, tier, vendors]);

  const handleSubmit = async () => {
    if (!tier) return;
    if (!vendorPick) {
      setError('Please pick a vendor.');
      return;
    }
    if (quotedAt && expiresAt && quotedAt > expiresAt) {
      setError('Expiration date must be on or after the quote date.');
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      await updateTier(tier.id, {
        part_id: tier.part_id,
        vendor_id:
          vendorPick.id === INTERNAL_ESTIMATE_OPTION.id ? null : vendorPick.id,
        min_quantity: minQty,
        cost_per_unit: cost,
        quoted_at: quotedAt || null,
        expires_at: expiresAt || null,
        notes,
      });
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save tier.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      open={open && !!tier}
      onClose={submitting ? undefined : onClose}
      maxWidth="sm"
      fullWidth
    >
      <DialogTitle>Edit tier</DialogTitle>
      <DialogContent dividers>
        {error && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {error}
          </Alert>
        )}

        <Autocomplete
          options={vendors}
          loading={vendorsLoading}
          value={vendorPick}
          onChange={(_, option) => setVendorPick(option)}
          getOptionLabel={(option) => option.name}
          isOptionEqualToValue={(option, value) => option.id === value.id}
          sx={{ mb: 2 }}
          renderInput={(params) => (
            <TextField
              {...params}
              label="Vendor"
              required
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

        <Box sx={{ display: 'flex', gap: 2, mb: 2 }}>
          <TextField
            label="Min qty"
            type="number"
            value={minQty}
            onChange={(e) => setMinQty(e.target.value)}
            required
            inputProps={{ min: 0, step: 'any' }}
            sx={{ flex: 1 }}
          />
          <TextField
            label="Unit cost"
            type="number"
            value={cost}
            onChange={(e) => setCost(e.target.value)}
            required
            inputProps={{ min: 0, step: 'any' }}
            sx={{ flex: 1 }}
          />
        </Box>

        <Box sx={{ display: 'flex', gap: 2, mb: 2 }}>
          <TextField
            label="Quoted on"
            type="date"
            value={quotedAt}
            onChange={(e) => setQuotedAt(e.target.value)}
            InputLabelProps={{ shrink: true }}
            sx={{ flex: 1 }}
          />
          <TextField
            label="Expires on"
            type="date"
            value={expiresAt}
            onChange={(e) => setExpiresAt(e.target.value)}
            InputLabelProps={{ shrink: true }}
            sx={{ flex: 1 }}
          />
        </Box>

        <TextField
          fullWidth
          label="Notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          multiline
          rows={2}
        />
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
          {submitting ? 'Saving...' : 'Save changes'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
