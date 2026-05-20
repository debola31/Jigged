'use client';

import { useEffect, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Divider from '@mui/material/Divider';
import FormControl from '@mui/material/FormControl';
import InputLabel from '@mui/material/InputLabel';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import SaveIcon from '@mui/icons-material/Save';

import type { Customer } from '@/types/customer';
import {
  SHIPPING_ARRANGEMENT_OPTIONS,
  type ShippingArrangement,
} from '@/types/shipment';
import { updateCustomerShippingDefaults } from '@/utils/customerAccess';

interface CustomerShippingDefaultsCardProps {
  customer: Pick<
    Customer,
    'id' | 'default_shipping_arrangement' | 'default_carrier' | 'default_coc_text'
  >;
  /** Called after a successful save so the parent can re-fetch. */
  onSaved?: () => void;
}

export default function CustomerShippingDefaultsCard({
  customer,
  onSaved,
}: CustomerShippingDefaultsCardProps) {
  const [arrangement, setArrangement] = useState<ShippingArrangement | ''>(
    customer.default_shipping_arrangement ?? '',
  );
  const [carrier, setCarrier] = useState<string>(customer.default_carrier ?? '');
  const [cocText, setCocText] = useState<string>(customer.default_coc_text ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedTick, setSavedTick] = useState(0);

  // Re-sync local state when the parent re-fetches the customer.
  useEffect(() => {
    setArrangement(customer.default_shipping_arrangement ?? '');
    setCarrier(customer.default_carrier ?? '');
    setCocText(customer.default_coc_text ?? '');
  }, [customer.default_shipping_arrangement, customer.default_carrier, customer.default_coc_text]);

  const dirty =
    (customer.default_shipping_arrangement ?? '') !== arrangement
    || (customer.default_carrier ?? '') !== carrier
    || (customer.default_coc_text ?? '') !== cocText;

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      await updateCustomerShippingDefaults(customer.id, {
        default_shipping_arrangement: arrangement === '' ? null : arrangement,
        default_carrier: carrier.trim() ? carrier.trim() : null,
        default_coc_text: cocText.trim() ? cocText.trim() : null,
      });
      setSavedTick((t) => t + 1);
      onSaved?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card elevation={2}>
      <CardContent>
        <Typography variant="h6" sx={{ fontWeight: 600, mb: 1 }}>
          Shipping Defaults
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Prefilled on every new shipment for this customer. Editable per shipment.
        </Typography>
        <Divider sx={{ mb: 2 }} />

        <Stack spacing={2}>
          {error && <Alert severity="error">{error}</Alert>}
          {savedTick > 0 && !dirty && !error && (
            <Alert severity="success">Saved.</Alert>
          )}

          <FormControl fullWidth>
            <InputLabel id="default-shipping-arrangement-label">
              Default Shipping Arrangement
            </InputLabel>
            <Select
              labelId="default-shipping-arrangement-label"
              label="Default Shipping Arrangement"
              value={arrangement}
              onChange={(e) => setArrangement(e.target.value as ShippingArrangement | '')}
            >
              <MenuItem value="">
                <em>None</em>
              </MenuItem>
              {SHIPPING_ARRANGEMENT_OPTIONS.map((opt) => (
                <MenuItem key={opt.value} value={opt.value}>
                  {opt.label}
                </MenuItem>
              ))}
            </Select>
          </FormControl>

          <TextField
            label="Default Carrier"
            value={carrier}
            onChange={(e) => setCarrier(e.target.value)}
            placeholder="e.g., UPS, FedEx Ground"
            fullWidth
          />

          <TextField
            label="Default Certificate of Conformance"
            value={cocText}
            onChange={(e) => setCocText(e.target.value)}
            multiline
            minRows={3}
            placeholder="Pre-fills the CoC block on packing slips when the shipment doesn't override it."
            fullWidth
            helperText="Cascade: shipment.coc_text → customer.default_coc_text → company.default_coc_text → omit."
          />

          <Box sx={{ display: 'flex', justifyContent: 'flex-end' }}>
            <Button
              variant="contained"
              startIcon={<SaveIcon />}
              onClick={handleSave}
              disabled={!dirty || saving}
            >
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </Box>
        </Stack>
      </CardContent>
    </Card>
  );
}
