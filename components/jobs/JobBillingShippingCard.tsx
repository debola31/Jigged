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
import Link from '@mui/material/Link';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import EditIcon from '@mui/icons-material/Edit';

import AddressDisplay, { addressToLines } from '@/components/common/AddressDisplay';
import { updateJobAddressContact } from '@/utils/jobsAccess';
import { FREIGHT_TERMS_LABELS, type FreightTerms } from '@/types/shipment';
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
  readOnly = false,
}: {
  job: JobWithRelations;
  companyId: string;
  onUpdated: () => void | Promise<void>;
  /** Hide the in-card Edit button — editing happens via the job's single edit form. */
  readOnly?: boolean;
}) {
  const router = useRouter();
  const addresses: JobAddress[] = job.customers?.addresses ?? [];
  const contacts: JobContact[] = job.customers?.customer_contacts ?? [];
  // Archived accounts stay out of the picker, but one this job already points
  // at is kept so editing an old job doesn't silently blank its freight.
  const carrierAccounts = (job.customers?.carrier_accounts ?? []).filter(
    (a) => a.deleted_at === null || a.id === job.customer_carrier_account_id,
  );

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
  // Freight as the PO stated it. This card is the ONLY place a per-order freight
  // instruction can be entered — without it the job columns stay NULL forever
  // and the shipper falls back to a customer default that may contradict the PO.
  const [freightTerms, setFreightTerms] = useState<FreightTerms | ''>(job.freight_terms ?? '');
  const [carrierAccountId, setCarrierAccountId] = useState(job.customer_carrier_account_id ?? '');
  const [shipVia, setShipVia] = useState(job.ship_via ?? '');
  const [shippingInstructions, setShippingInstructions] = useState(job.shipping_instructions ?? '');

  // Read-only display renders the job's frozen snapshots (Document Snapshot
  // Standard), not the live address book — so a deleted/edited address doesn't
  // blank or rewrite what the job was issued with. Editing still picks from the
  // live book (addresses/contacts) below.
  const shippingAddress = job.ship_to_address;
  const billingAddress = job.bill_to_address;
  const contact = job.contact_snapshot;
  const billingSameAsShipping =
    !!job.shipping_address_id && job.billing_address_id === job.shipping_address_id;

  // Read-only layout: collapse the Billing column when it equals shipping (the
  // common case) so the remaining columns get room in this half-width card —
  // mirrors the quote card. An explicit note keeps the "same as shipping" fact.
  const showBillingColumn = !billingSameAsShipping;
  const infoColSize = showBillingColumn ? { xs: 12, sm: 4 } : { xs: 12, sm: 6 };

  const customerHref = `/dashboard/${companyId}/customers/${job.customer_id}`;

  const startEdit = () => {
    setShippingId(job.shipping_address_id ?? '');
    setBillingId(job.billing_address_id ?? '');
    setContactId(job.contact_id ?? '');
    setBillingSame(!job.billing_address_id || job.billing_address_id === job.shipping_address_id);
    setFreightTerms(job.freight_terms ?? '');
    setCarrierAccountId(job.customer_carrier_account_id ?? '');
    setShipVia(job.ship_via ?? '');
    setShippingInstructions(job.shipping_instructions ?? '');
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
        freight_terms: freightTerms === '' ? null : freightTerms,
        customer_carrier_account_id: carrierAccountId,
        ship_via: shipVia,
        shipping_instructions: shippingInstructions,
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
          {!editing && !readOnly && (
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
            <Grid size={infoColSize} sx={{ minWidth: 0 }}>
              <Typography variant="body2" color="text.secondary">
                Contact
              </Typography>
              {contact ? (
                <Box>
                  <Typography variant="body1" sx={{ fontWeight: 500 }}>
                    {contact.name}
                  </Typography>
                  {contact.email && (
                    <Link
                      href={`mailto:${contact.email}`}
                      variant="body2"
                      sx={{ display: 'block', overflowWrap: 'anywhere' }}
                    >
                      {contact.email}
                    </Link>
                  )}
                  {contact.phone && (
                    <Link
                      href={`tel:${contact.phone}`}
                      variant="body2"
                      sx={{ display: 'block' }}
                    >
                      {contact.phone}
                    </Link>
                  )}
                </Box>
              ) : (
                <Typography variant="body1" color="text.secondary">
                  Not set
                </Typography>
              )}
            </Grid>
            <Grid size={infoColSize} sx={{ minWidth: 0 }}>
              <Typography variant="body2" color="text.secondary">
                Shipping address
              </Typography>
              <AddressDisplay address={shippingAddress} />
              {!showBillingColumn && (
                <Typography
                  variant="caption"
                  color="text.secondary"
                  sx={{ display: 'block', mt: 1, fontStyle: 'italic' }}
                >
                  Billing address — same as shipping
                </Typography>
              )}
            </Grid>
            {showBillingColumn && (
              <Grid size={infoColSize} sx={{ minWidth: 0 }}>
                <Typography variant="body2" color="text.secondary">
                  Billing address
                </Typography>
                <AddressDisplay address={billingAddress} />
              </Grid>
            )}
            {/* Freight, read-only. Shown only when the PO actually said
                something — a job with no freight instruction ships the way it
                always did, and an empty "Freight: —" row would just be noise. */}
            {(job.freight_terms || job.ship_via || job.shipping_instructions) && (
              <Grid size={{ xs: 12 }}>
                <Divider sx={{ my: 1.5 }} />
                <Typography variant="body2" color="text.secondary">
                  Freight
                </Typography>
                <Typography variant="body2">
                  {[
                    job.freight_terms ? FREIGHT_TERMS_LABELS[job.freight_terms] : null,
                    job.ship_via,
                  ]
                    .filter(Boolean)
                    .join(' · ') || '—'}
                </Typography>
                {job.shipping_instructions && (
                  <Typography variant="body2" color="text.secondary">
                    {job.shipping_instructions}
                  </Typography>
                )}
              </Grid>
            )}
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

            {/* Freight — what the customer's PO said for THIS order. Kept
                visually apart from the addresses above because it answers a
                different question: not where it goes, but who pays. */}
            <Divider sx={{ my: 3 }} />
            <Typography variant="subtitle2" sx={{ fontWeight: 600, mb: 0.5 }}>
              Freight
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              As the customer&rsquo;s PO states it. Leave blank to use their
              standing arrangement when this ships.
            </Typography>

            <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
              <FormControl sx={{ minWidth: 220, flex: '1 1 220px' }}>
                <InputLabel id="job-freight-terms-label">Who pays</InputLabel>
                <Select
                  labelId="job-freight-terms-label"
                  label="Who pays"
                  value={freightTerms}
                  onChange={(e) => setFreightTerms(e.target.value as FreightTerms | '')}
                >
                  <MenuItem value="">
                    <em>Not stated</em>
                  </MenuItem>
                  {(Object.keys(FREIGHT_TERMS_LABELS) as FreightTerms[]).map((k) => (
                    <MenuItem key={k} value={k}>
                      {FREIGHT_TERMS_LABELS[k]}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>

              {/* Only this customer's accounts are offered, and the DB enforces
                  it too — the customer-match trigger rejects another customer's
                  account outright, so a mis-set FK cannot bill the wrong firm. */}
              {carrierAccounts.length > 0 && (
                <FormControl sx={{ minWidth: 220, flex: '1 1 220px' }}>
                  <InputLabel id="job-carrier-account-label">Their account</InputLabel>
                  <Select
                    labelId="job-carrier-account-label"
                    label="Their account"
                    value={carrierAccountId}
                    onChange={(e) => setCarrierAccountId(e.target.value)}
                  >
                    <MenuItem value="">
                      <em>None</em>
                    </MenuItem>
                    {carrierAccounts.map((a) => (
                      <MenuItem key={a.id} value={a.id}>
                        {a.carrier}
                        {a.account_number ? ` · ${a.account_number}` : ''}
                      </MenuItem>
                    ))}
                  </Select>
                </FormControl>
              )}
            </Box>

            <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap', mt: 2 }}>
              <TextField
                label="Ship via"
                value={shipVia}
                onChange={(e) => setShipVia(e.target.value)}
                sx={{ minWidth: 220, flex: '1 1 220px' }}
                helperText="The PO's words, e.g. UPS Ground"
              />
              <TextField
                label="Shipping instructions"
                value={shippingInstructions}
                onChange={(e) => setShippingInstructions(e.target.value)}
                sx={{ minWidth: 220, flex: '1 1 320px' }}
                helperText="Anything the shipper needs to honour"
              />
            </Box>

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
