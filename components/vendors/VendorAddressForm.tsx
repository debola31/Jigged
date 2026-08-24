'use client';

import { useState } from 'react';
import Box from '@mui/material/Box';
import Grid from '@mui/material/Grid';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import Alert from '@mui/material/Alert';
import Checkbox from '@mui/material/Checkbox';
import FormControlLabel from '@mui/material/FormControlLabel';
import CircularProgress from '@mui/material/CircularProgress';

import type { VendorAddress, VendorAddressFormData } from '@/types/vendor';
import { EMPTY_VENDOR_ADDRESS_FORM, vendorAddressToFormData } from '@/types/vendor';
import { createVendorAddress, updateVendorAddress } from '@/utils/vendorAddressesAccess';
import CountrySelect from '@/components/common/CountrySelect';
import StateSelect from '@/components/common/StateSelect';
import { isValidPostalCode } from '@/lib/validators';

interface VendorAddressFormProps {
  vendorId: string;
  /** Provided when editing; omitted for "Add Address". */
  existing?: VendorAddress;
  /** True when this vendor has no addresses yet — the first one is forced
   *  default, so the checkbox explains itself rather than looking optional. */
  isFirst: boolean;
  onSaved: (saved: VendorAddress) => void;
  onCancel: () => void;
}

/**
 * Inline add / edit form for a single vendor address, rendered in place inside
 * the Addresses card — the same shape as `CustomerAddressForm`, which is the
 * app's convention for editing one row of a list.
 *
 * One "Default" checkbox rather than the Billing / Shipping pair customers
 * carry: nothing in the product yet distinguishes where parts go from where
 * payment goes, and two flags nobody reads is two flags nobody keeps true.
 */
export default function VendorAddressForm({
  vendorId,
  existing,
  isFirst,
  onSaved,
  onCancel,
}: VendorAddressFormProps) {
  const [formData, setFormData] = useState<VendorAddressFormData>(() =>
    existing ? vendorAddressToFormData(existing) : { ...EMPTY_VENDOR_ADDRESS_FORM },
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isEdit = !!existing;
  const postalValid = isValidPostalCode(formData.country, formData.postal_code);

  const handleChange =
    (field: keyof VendorAddressFormData) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      setFormData((prev) => ({ ...prev, [field]: e.target.value }));
    };

  const handleSave = async () => {
    if (!postalValid) {
      setError('Enter a valid postal code for the selected country.');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const saved =
        isEdit && existing
          ? await updateVendorAddress(existing.id, vendorId, formData)
          : await createVendorAddress(vendorId, formData);
      onSaved(saved);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save address');
    } finally {
      setLoading(false);
    }
  };

  // The first address is forced default by the access layer, so the control is
  // locked ON rather than quietly overridden after save.
  const defaultLocked = isFirst && !isEdit;

  return (
    <Box>
      <Typography variant="subtitle1" sx={{ fontWeight: 600, mb: 2 }}>
        {isEdit ? 'Edit Address' : 'Add Address'}
      </Typography>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      <Grid container spacing={2}>
        <Grid size={{ xs: 12 }}>
          <TextField
            fullWidth
            autoFocus
            label="Address Line 1"
            value={formData.address_line1}
            onChange={handleChange('address_line1')}
            disabled={loading}
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
        <Grid size={{ xs: 12, sm: 6 }}>
          <TextField
            fullWidth
            label="City"
            value={formData.city}
            onChange={handleChange('city')}
            disabled={loading}
          />
        </Grid>
        <Grid size={{ xs: 12, sm: 6 }}>
          <StateSelect
            value={formData.state}
            onChange={(v) => setFormData((prev) => ({ ...prev, state: v }))}
            country={formData.country}
            disabled={loading}
          />
        </Grid>
        <Grid size={{ xs: 12, sm: 6 }}>
          <TextField
            fullWidth
            label="Postal Code"
            value={formData.postal_code}
            onChange={handleChange('postal_code')}
            error={!postalValid}
            helperText={!postalValid ? 'Invalid postal code for this country' : undefined}
            disabled={loading}
          />
        </Grid>
        <Grid size={{ xs: 12, sm: 6 }}>
          <CountrySelect
            value={formData.country}
            onChange={(v) => setFormData((prev) => ({ ...prev, country: v }))}
            disabled={loading}
          />
        </Grid>
        <Grid size={{ xs: 12 }}>
          <TextField
            fullWidth
            label="Attention To"
            placeholder="e.g. Receiving, John Doe"
            helperText="Goes above the address when you send parts here. Leave blank when no specific recipient is needed."
            value={formData.attention_to}
            onChange={handleChange('attention_to')}
            disabled={loading}
          />
        </Grid>
        <Grid size={{ xs: 12 }}>
          <FormControlLabel
            control={
              <Checkbox
                checked={formData.is_default || defaultLocked}
                onChange={(e) =>
                  setFormData((prev) => ({ ...prev, is_default: e.target.checked }))
                }
                disabled={loading || defaultLocked}
              />
            }
            label={
              defaultLocked
                ? 'Default address (the first one always is)'
                : 'Default address'
            }
          />
        </Grid>
      </Grid>

      <Box sx={{ display: 'flex', gap: 2, mt: 3, justifyContent: 'flex-end' }}>
        <Button onClick={onCancel} disabled={loading}>
          Cancel
        </Button>
        <Button
          variant="contained"
          onClick={handleSave}
          disabled={loading}
          startIcon={loading ? <CircularProgress size={18} color="inherit" /> : undefined}
        >
          Save Address
        </Button>
      </Box>
    </Box>
  );
}
