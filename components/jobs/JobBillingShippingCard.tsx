'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Alert from '@mui/material/Alert';
import Autocomplete from '@mui/material/Autocomplete';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Checkbox from '@mui/material/Checkbox';
import CircularProgress from '@mui/material/CircularProgress';
import Divider from '@mui/material/Divider';
import FormControl from '@mui/material/FormControl';
import FormControlLabel from '@mui/material/FormControlLabel';
import Grid from '@mui/material/Grid';
import InputLabel from '@mui/material/InputLabel';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import EditIcon from '@mui/icons-material/Edit';

import AddressDisplay, { addressToLines } from '@/components/common/AddressDisplay';
import { updateJobAddressContact } from '@/utils/jobsAccess';
import type { JobWithRelations } from '@/types/job';

const ADD_NEW_ADDRESS_ID = '__add_new_address__';

type JobAddress = NonNullable<NonNullable<JobWithRelations['customers']>['addresses']>[number];
type JobContact = NonNullable<NonNullable<JobWithRelations['customers']>['customer_contacts']>[number];

/**
 * Billing/shipping address + contact for a job. Read-only by default; the
 * Edit button reveals dropdowns sourced from the customer's saved address
 * book (same model as the quote form). Saving writes the FK ids to the job
 * via updateJobAddressContact; the customer-match trigger guards integrity.
 */
export default function JobBillingShippingCard({
  job,
  companyId,
  onUpdated,
}: {
  job: JobWithRelations;
  companyId: string;
  onUpdated: () => void | Promise<void>;
}) {
  const router = useRouter();
  const addresses: JobAddress[] = job.customers?.addresses ?? [];
  const contacts: JobContact[] = job.customers?.customer_contacts ?? [];

  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Draft state (only meaningful while editing).
  const [shippingId, setShippingId] = useState(job.shipping_address_id ?? '');
  const [billingId, setBillingId] = useState(job.billing_address_id ?? '');
  const [contactId, setContactId] = useState(job.contact_id ?? '');
  const [billingSame, setBillingSame] = useState(
    !job.billing_address_id || job.billing_address_id === job.shipping_address_id,
  );

  const shippingAddress = addresses.find((a) => a.id === job.shipping_address_id) ?? null;
  const billingAddress = addresses.find((a) => a.id === job.billing_address_id) ?? null;
  const contact = contacts.find((c) => c.id === job.contact_id) ?? null;
  const billingSameAsShipping =
    !!job.shipping_address_id && job.billing_address_id === job.shipping_address_id;

  const customerHref = `/dashboard/${companyId}/customers/${job.customer_id}`;

  const startEdit = () => {
    setShippingId(job.shipping_address_id ?? '');
    setBillingId(job.billing_address_id ?? '');
    setContactId(job.contact_id ?? '');
    setBillingSame(!job.billing_address_id || job.billing_address_id === job.shipping_address_id);
    setError(null);
    setEditing(true);
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      await updateJobAddressContact(job.id, companyId, {
        shipping_address_id: shippingId,
        billing_address_id: billingSame ? shippingId : billingId,
        contact_id: contactId,
      });
      setEditing(false);
      await onUpdated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save.');
    } finally {
      setSaving(false);
    }
  };

  const renderAddressValue = (value: string) => {
    const a = addresses.find((x) => x.id === value);
    if (!a) return '';
    return addressToLines(a).join(', ');
  };

  return (
    <Card elevation={2} sx={{ height: '100%' }}>
      <CardContent>
        <Box
          sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 1 }}
        >
          <Typography variant="h6" sx={{ fontWeight: 600 }}>
            Billing &amp; Shipping
          </Typography>
          {!editing && (
            <Button size="small" startIcon={<EditIcon />} onClick={startEdit}>
              Edit
            </Button>
          )}
        </Box>
        <Divider sx={{ mb: 2 }} />

        {error && (
          <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>
            {error}
          </Alert>
        )}

        {!editing ? (
          <Grid container spacing={2}>
            <Grid size={{ xs: 12, sm: 4 }}>
              <Typography variant="body2" color="text.secondary">
                Contact
              </Typography>
              {contact ? (
                <Box>
                  <Typography variant="body1" sx={{ fontWeight: 500 }}>
                    {contact.name}
                  </Typography>
                  {contact.email && (
                    <Typography variant="body2" color="text.secondary">
                      {contact.email}
                    </Typography>
                  )}
                  {contact.phone && (
                    <Typography variant="body2" color="text.secondary">
                      {contact.phone}
                    </Typography>
                  )}
                </Box>
              ) : (
                <Typography variant="body1" color="text.secondary">
                  Not set
                </Typography>
              )}
            </Grid>
            <Grid size={{ xs: 12, sm: 4 }}>
              <Typography variant="body2" color="text.secondary">
                Shipping address
              </Typography>
              <AddressDisplay address={shippingAddress} />
            </Grid>
            <Grid size={{ xs: 12, sm: 4 }}>
              <Typography variant="body2" color="text.secondary">
                Billing address
              </Typography>
              {billingSameAsShipping ? (
                <Typography variant="body1" color="text.secondary" sx={{ fontStyle: 'italic' }}>
                  Same as shipping
                </Typography>
              ) : (
                <AddressDisplay address={billingAddress} />
              )}
            </Grid>
          </Grid>
        ) : (
          <Box>
            {addresses.length === 0 && contacts.length === 0 && (
              <Alert severity="info" sx={{ mb: 2 }}>
                This customer has no saved addresses or contacts.{' '}
                <Button size="small" onClick={() => router.push(customerHref)}>
                  Add on customer
                </Button>
              </Alert>
            )}
            <Grid container spacing={2}>
              <Grid size={{ xs: 12, md: 6 }}>
                <Autocomplete
                  size="small"
                  options={contacts}
                  getOptionLabel={(c) => c.name}
                  value={contacts.find((c) => c.id === contactId) ?? null}
                  onChange={(_, v) => setContactId(v?.id ?? '')}
                  isOptionEqualToValue={(o, v) => o.id === v.id}
                  renderInput={(params) => <TextField {...params} label="Contact" />}
                />
              </Grid>
              <Grid size={{ xs: 12, md: 6 }}>
                <FormControl fullWidth size="small">
                  <InputLabel id="job-shipping-address-label">Shipping address</InputLabel>
                  <Select
                    labelId="job-shipping-address-label"
                    label="Shipping address"
                    value={shippingId}
                    onChange={(e) => {
                      if (e.target.value === ADD_NEW_ADDRESS_ID) {
                        router.push(customerHref);
                        return;
                      }
                      setShippingId(e.target.value);
                    }}
                    renderValue={renderAddressValue}
                    sx={{ '& .MuiSelect-select': { whiteSpace: 'normal', py: 1 } }}
                  >
                    {addresses.map((a) => (
                      <MenuItem key={a.id} value={a.id} sx={{ whiteSpace: 'normal' }}>
                        <Box>
                          {addressToLines(a).map((line, i) => (
                            <Typography key={i} variant="body2">
                              {line}
                            </Typography>
                          ))}
                        </Box>
                      </MenuItem>
                    ))}
                    <MenuItem value={ADD_NEW_ADDRESS_ID} sx={{ fontStyle: 'italic' }}>
                      + Add new address
                    </MenuItem>
                  </Select>
                </FormControl>
              </Grid>
            </Grid>

            <FormControlLabel
              sx={{ mt: 2, mb: 0 }}
              control={
                <Checkbox
                  checked={billingSame}
                  onChange={(e) => setBillingSame(e.target.checked)}
                />
              }
              label={
                <Typography variant="body2" color="text.secondary">
                  Billing address same as shipping
                </Typography>
              }
            />

            {!billingSame && (
              <Box sx={{ mt: 1, pl: 4 }}>
                <FormControl fullWidth size="small">
                  <InputLabel id="job-billing-address-label">Billing address</InputLabel>
                  <Select
                    labelId="job-billing-address-label"
                    label="Billing address"
                    value={billingId}
                    onChange={(e) => {
                      if (e.target.value === ADD_NEW_ADDRESS_ID) {
                        router.push(customerHref);
                        return;
                      }
                      setBillingId(e.target.value);
                    }}
                    renderValue={renderAddressValue}
                    sx={{ '& .MuiSelect-select': { whiteSpace: 'normal', py: 1 } }}
                  >
                    {addresses.map((a) => (
                      <MenuItem key={a.id} value={a.id} sx={{ whiteSpace: 'normal' }}>
                        <Box>
                          {addressToLines(a).map((line, i) => (
                            <Typography key={i} variant="body2">
                              {line}
                            </Typography>
                          ))}
                        </Box>
                      </MenuItem>
                    ))}
                    <MenuItem value={ADD_NEW_ADDRESS_ID} sx={{ fontStyle: 'italic' }}>
                      + Add new address
                    </MenuItem>
                  </Select>
                </FormControl>
              </Box>
            )}

            <Box sx={{ display: 'flex', gap: 1, mt: 3 }}>
              <Button
                variant="contained"
                onClick={handleSave}
                disabled={saving}
                startIcon={saving ? <CircularProgress size={16} color="inherit" /> : undefined}
              >
                {saving ? 'Saving…' : 'Save'}
              </Button>
              <Button onClick={() => setEditing(false)} disabled={saving}>
                Cancel
              </Button>
            </Box>
          </Box>
        )}
      </CardContent>
    </Card>
  );
}
