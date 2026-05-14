'use client';

import { useState, useEffect } from 'react';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import Button from '@mui/material/Button';
import TextField from '@mui/material/TextField';
import Grid from '@mui/material/Grid';
import Alert from '@mui/material/Alert';
import CircularProgress from '@mui/material/CircularProgress';
import FormControlLabel from '@mui/material/FormControlLabel';
import Checkbox from '@mui/material/Checkbox';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';

import type {
  CustomerAddress,
  CustomerAddressFormData,
} from '@/types/customer';
import { EMPTY_CUSTOMER_ADDRESS } from '@/types/customer';
import {
  createCustomerAddress,
  updateCustomerAddress,
} from '@/utils/customerAddressesAccess';

interface CustomerAddressModalProps {
  open: boolean;
  onClose: () => void;
  customerId: string;
  /** Provided when editing an existing address; omitted for "Add Address". */
  existing?: CustomerAddress;
  /** Called after the address has been successfully created or updated. */
  onSaved: () => void;
}

function addressToFormData(addr: CustomerAddress): CustomerAddressFormData {
  return {
    id: addr.id,
    address_line1: addr.address_line1 ?? '',
    address_line2: addr.address_line2 ?? '',
    city: addr.city ?? '',
    state: addr.state ?? '',
    postal_code: addr.postal_code ?? '',
    country: addr.country ?? 'USA',
    is_billing: addr.is_billing,
    is_shipping: addr.is_shipping,
  };
}

/**
 * Add / edit modal for a single customer address.
 *
 * Billing / Shipping are checkboxes here (not radios) because in the modal
 * we're editing one row in isolation — there's no list to single-select
 * across. The access layer clears the same role on any other row when this
 * row claims it, mirroring the cross-clear that the form UI used to do
 * inline.
 */
export default function CustomerAddressModal({
  open,
  onClose,
  customerId,
  existing,
  onSaved,
}: CustomerAddressModalProps) {
  const [formData, setFormData] = useState<CustomerAddressFormData>(
    EMPTY_CUSTOMER_ADDRESS,
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setFormData(
      existing ? addressToFormData(existing) : { ...EMPTY_CUSTOMER_ADDRESS },
    );
    setError(null);
  }, [open, existing]);

  const isEdit = !!existing;

  const handleChange =
    (field: keyof CustomerAddressFormData) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      setFormData((prev) => ({ ...prev, [field]: e.target.value }));
    };

  const handleSave = async () => {
    setLoading(true);
    setError(null);
    try {
      if (isEdit && existing) {
        await updateCustomerAddress(existing.id, customerId, formData);
      } else {
        await createCustomerAddress(customerId, formData);
      }
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save address');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onClose={loading ? undefined : onClose} maxWidth="sm" fullWidth>
      <DialogTitle>{isEdit ? 'Edit Address' : 'Add Address'}</DialogTitle>
      <DialogContent>
        {error && (
          <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>
            {error}
          </Alert>
        )}
        <Grid container spacing={2} sx={{ mt: 0 }}>
          <Grid size={{ xs: 12 }}>
            <TextField
              fullWidth
              label="Address Line 1"
              value={formData.address_line1}
              onChange={handleChange('address_line1')}
              disabled={loading}
              autoFocus
            />
          </Grid>
          <Grid size={{ xs: 12 }}>
            <TextField
              fullWidth
              label="Address Line 2"
              placeholder="Suite, unit, etc."
              value={formData.address_line2}
              onChange={handleChange('address_line2')}
              disabled={loading}
            />
          </Grid>
          <Grid size={{ xs: 12, sm: 6, md: 3 }}>
            <TextField
              fullWidth
              label="City"
              value={formData.city}
              onChange={handleChange('city')}
              disabled={loading}
            />
          </Grid>
          <Grid size={{ xs: 12, sm: 6, md: 3 }}>
            <TextField
              fullWidth
              label="State"
              value={formData.state}
              onChange={handleChange('state')}
              disabled={loading}
            />
          </Grid>
          <Grid size={{ xs: 12, sm: 6, md: 3 }}>
            <TextField
              fullWidth
              label="Postal Code"
              value={formData.postal_code}
              onChange={handleChange('postal_code')}
              disabled={loading}
            />
          </Grid>
          <Grid size={{ xs: 12, sm: 6, md: 3 }}>
            <TextField
              fullWidth
              label="Country"
              value={formData.country}
              onChange={handleChange('country')}
              disabled={loading}
            />
          </Grid>
          <Grid size={{ xs: 12 }}>
            <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 2 }}>
              <Typography variant="body2" color="text.secondary">
                Used for:
              </Typography>
              <FormControlLabel
                control={
                  <Checkbox
                    checked={formData.is_billing}
                    onChange={(e) =>
                      setFormData((prev) => ({ ...prev, is_billing: e.target.checked }))
                    }
                    disabled={loading}
                  />
                }
                label="Billing"
              />
              <FormControlLabel
                control={
                  <Checkbox
                    checked={formData.is_shipping}
                    onChange={(e) =>
                      setFormData((prev) => ({ ...prev, is_shipping: e.target.checked }))
                    }
                    disabled={loading}
                  />
                }
                label="Shipping"
              />
            </Box>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
              Each customer can have at most one billing and one shipping address —
              saving with a role checked will clear it on any other address.
            </Typography>
          </Grid>
        </Grid>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={onClose} disabled={loading} color="inherit">
          Cancel
        </Button>
        <Button
          onClick={handleSave}
          variant="contained"
          disabled={loading}
          startIcon={loading ? <CircularProgress size={16} color="inherit" /> : null}
        >
          {loading ? 'Saving...' : isEdit ? 'Save Changes' : 'Add Address'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
