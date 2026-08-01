'use client';

import { useState } from 'react';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import Button from '@mui/material/Button';
import TextField from '@mui/material/TextField';
import FormControl from '@mui/material/FormControl';
import InputLabel from '@mui/material/InputLabel';
import Select from '@mui/material/Select';
import MenuItem from '@mui/material/MenuItem';
import Autocomplete from '@mui/material/Autocomplete';
import Grid from '@mui/material/Grid';
import Alert from '@mui/material/Alert';
import CircularProgress from '@mui/material/CircularProgress';

import {
  EMPTY_CARRIER_ACCOUNT,
  BILL_TO_PARTY_LABELS,
  type BillToParty,
  type CustomerCarrierAccount,
  type CustomerCarrierAccountFormData,
} from '@/types/customerCarrierAccount';
import {
  createCarrierAccount,
  updateCarrierAccount,
} from '@/utils/customerCarrierAccountsAccess';
import { CARRIER_OPTIONS } from '@/types/shipment';

interface CarrierAccountModalProps {
  open: boolean;
  onClose: () => void;
  companyId: string;
  customerId: string;
  /** Provided when editing; omitted for "Add account". */
  existing?: CustomerCarrierAccount;
  onSaved: () => void;
}

function toFormData(account: CustomerCarrierAccount): CustomerCarrierAccountFormData {
  return {
    carrier: account.carrier,
    bill_to_party: account.bill_to_party,
    account_number: account.account_number ?? '',
    account_postal_code: account.account_postal_code ?? '',
    account_country_code: account.account_country_code,
    notes: account.notes ?? '',
  };
}

/**
 * Add / edit a customer's own carrier account. Mirrors CustomerContactModal.
 *
 * The postal code is asked for because carriers require it, not because we want
 * it: UPS validates the account against the postal code of the account and
 * rejects a mismatch, so an account saved without one may not actually ship.
 */
export default function CarrierAccountModal({
  open,
  onClose,
  companyId,
  customerId,
  existing,
  onSaved,
}: CarrierAccountModalProps) {
  const [formData, setFormData] = useState<CustomerCarrierAccountFormData>(EMPTY_CARRIER_ACCOUNT);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Re-seed the form each time the modal opens (house convention: onEnter, not
  // a reset useEffect, which would trip set-state-in-effect).
  const handleEnter = () => {
    setFormData(existing ? toFormData(existing) : EMPTY_CARRIER_ACCOUNT);
    setError(null);
  };

  // Mirrors the DB's account_required CHECK, so the user is told before the save
  // rather than by a constraint violation after it.
  const needsAccountNumber =
    formData.bill_to_party === 'third_party' && formData.account_number.trim() === '';
  const canSave = formData.carrier.trim() !== '' && !needsAccountNumber;

  const handleSave = async () => {
    setError(null);
    setLoading(true);
    try {
      if (existing) {
        await updateCarrierAccount(existing.id, formData);
      } else {
        await createCarrierAccount(companyId, customerId, formData);
      }
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save the carrier account.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={loading ? undefined : onClose}
      maxWidth="sm"
      fullWidth
      TransitionProps={{ onEnter: handleEnter }}
    >
      <DialogTitle>{existing ? 'Edit carrier account' : 'Add carrier account'}</DialogTitle>
      <DialogContent>
        {error && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {error}
          </Alert>
        )}
        <Grid container spacing={2} sx={{ mt: 0 }}>
          <Grid size={{ xs: 12, sm: 6 }}>
            {/* Free text with suggestions rather than a hard list: the moment a
                shop uses a regional LTL carrier, a fixed dropdown is a dead end. */}
            <Autocomplete
              freeSolo
              options={CARRIER_OPTIONS as readonly string[]}
              value={formData.carrier}
              onChange={(_, next) => setFormData((p) => ({ ...p, carrier: next ?? '' }))}
              onInputChange={(_, next) => setFormData((p) => ({ ...p, carrier: next }))}
              disabled={loading}
              renderInput={(params) => <TextField {...params} label="Carrier" required />}
            />
          </Grid>
          <Grid size={{ xs: 12, sm: 6 }}>
            <FormControl fullWidth disabled={loading}>
              <InputLabel id="bill-to-party-label">Who pays</InputLabel>
              <Select
                labelId="bill-to-party-label"
                label="Who pays"
                value={formData.bill_to_party}
                onChange={(e) =>
                  setFormData((p) => ({ ...p, bill_to_party: e.target.value as BillToParty }))
                }
              >
                {(Object.keys(BILL_TO_PARTY_LABELS) as BillToParty[]).map((key) => (
                  <MenuItem key={key} value={key}>
                    {BILL_TO_PARTY_LABELS[key]}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          </Grid>
          <Grid size={{ xs: 12, sm: 6 }}>
            <TextField
              fullWidth
              label="Account number"
              value={formData.account_number}
              onChange={(e) => setFormData((p) => ({ ...p, account_number: e.target.value }))}
              disabled={loading}
              required={formData.bill_to_party === 'third_party'}
              error={needsAccountNumber}
              helperText={
                needsAccountNumber
                  ? 'Billing a third party needs their account number.'
                  : 'Their account with the carrier. Leave blank for LTL billed on the bill of lading, or FedEx Ground Collect.'
              }
            />
          </Grid>
          <Grid size={{ xs: 12, sm: 3 }}>
            <TextField
              fullWidth
              label="Account ZIP"
              value={formData.account_postal_code}
              onChange={(e) => setFormData((p) => ({ ...p, account_postal_code: e.target.value }))}
              disabled={loading}
              helperText="Carriers check this against the account."
            />
          </Grid>
          <Grid size={{ xs: 12, sm: 3 }}>
            <TextField
              fullWidth
              label="Country"
              value={formData.account_country_code}
              onChange={(e) =>
                setFormData((p) => ({ ...p, account_country_code: e.target.value.toUpperCase() }))
              }
              disabled={loading}
              inputProps={{ maxLength: 2 }}
            />
          </Grid>
          <Grid size={{ xs: 12 }}>
            <TextField
              fullWidth
              label="Notes"
              value={formData.notes}
              onChange={(e) => setFormData((p) => ({ ...p, notes: e.target.value }))}
              disabled={loading}
              helperText="Anything the person shipping needs to know."
            />
          </Grid>
        </Grid>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={loading}>
          Cancel
        </Button>
        <Button
          variant="contained"
          onClick={handleSave}
          disabled={loading || !canSave}
          startIcon={loading ? <CircularProgress size={16} color="inherit" /> : undefined}
        >
          Save
        </Button>
      </DialogActions>
    </Dialog>
  );
}
