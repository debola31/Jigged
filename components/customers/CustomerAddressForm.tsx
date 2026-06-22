'use client';

import { useState } from 'react';
import Button from '@mui/material/Button';
import TextField from '@mui/material/TextField';
import Grid from '@mui/material/Grid';
import Alert from '@mui/material/Alert';
import CircularProgress from '@mui/material/CircularProgress';
import FormControlLabel from '@mui/material/FormControlLabel';
import Checkbox from '@mui/material/Checkbox';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
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
import CountrySelect from '@/components/common/CountrySelect';
import StateSelect from '@/components/common/StateSelect';
import { isValidPostalCode } from '@/lib/validators';

interface CustomerAddressFormProps {
  customerId: string;
  /** Provided when editing an existing address; omitted for "Add Address". */
  existing?: CustomerAddress;
  /**
   * Called after the address has been successfully created or updated, with
   * the saved row so callers can select it immediately (e.g. the quote form's
   * inline add). Callers that don't need it can ignore the argument.
   */
  onSaved: (saved: CustomerAddress) => void;
  /** Called when the user cancels — returns to the address list. */
  onCancel: () => void;
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
    default_billing: addr.default_billing,
    default_shipping: addr.default_shipping,
    attention_to: addr.attention_to ?? '',
  };
}

/**
 * Inline add / edit form for a single customer address. Rendered in place inside
 * the Addresses card on the customer detail page (no modal) — matching the app's
 * inline-editing convention. The State / Country pickers commit canonical values
 * (`CountrySelect` / `StateSelect`); postal codes are validated per country.
 *
 * Default Billing / Default Shipping are checkboxes because we're editing one
 * row in isolation; the access layer clears the same flag on any other row when
 * this row claims it.
 */
export default function CustomerAddressForm({
  customerId,
  existing,
  onSaved,
  onCancel,
}: CustomerAddressFormProps) {
  const [formData, setFormData] = useState<CustomerAddressFormData>(() =>
    existing ? addressToFormData(existing) : { ...EMPTY_CUSTOMER_ADDRESS },
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isEdit = !!existing;

  const handleChange =
    (field: keyof CustomerAddressFormData) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      setFormData((prev) => ({ ...prev, [field]: e.target.value }));
    };

  const postalValid = isValidPostalCode(formData.country, formData.postal_code);

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
          ? await updateCustomerAddress(existing.id, customerId, formData)
          : await createCustomerAddress(customerId, formData);
      onSaved(saved);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save address');
    } finally {
      setLoading(false);
    }
  };

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
            placeholder="e.g. Receiving Dept, John Doe"
            helperText="Prints above the address on packing slips. Leave blank when no specific recipient is needed."
            value={formData.attention_to}
            onChange={handleChange('attention_to')}
            disabled={loading}
          />
        </Grid>
        <Grid size={{ xs: 12 }}>
          <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 2 }}>
            <Typography variant="body2" color="text.secondary">
              Default for:
            </Typography>
            <FormControlLabel
              control={
                <Checkbox
                  checked={formData.default_billing}
                  onChange={(e) =>
                    setFormData((prev) => ({ ...prev, default_billing: e.target.checked }))
                  }
                  disabled={loading}
                />
              }
              label="Billing"
            />
            <FormControlLabel
              control={
                <Checkbox
                  checked={formData.default_shipping}
                  onChange={(e) =>
                    setFormData((prev) => ({ ...prev, default_shipping: e.target.checked }))
                  }
                  disabled={loading}
                />
              }
              label="Shipping"
            />
          </Box>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
            Each customer can have at most one default billing and one default
            shipping address — saving with a default checked will clear it on
            any other address.
          </Typography>
        </Grid>
      </Grid>

      <Stack direction="row" spacing={2} justifyContent="flex-end" sx={{ mt: 3 }}>
        <Button onClick={onCancel} disabled={loading} color="inherit">
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
      </Stack>
    </Box>
  );
}
