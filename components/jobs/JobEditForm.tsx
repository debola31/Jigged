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
import InputAdornment from '@mui/material/InputAdornment';
import InputLabel from '@mui/material/InputLabel';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import LockIcon from '@mui/icons-material/Lock';
import SaveIcon from '@mui/icons-material/Save';

import { addressToLines } from '@/components/common/AddressDisplay';
import JobAttachmentsCard from '@/components/jobs/JobAttachmentsCard';
import {
  updateJobDetails,
  updateJobAddressContact,
  updateJobPartQuantity,
  updateJobPartPrice,
} from '@/utils/jobsAccess';
import type { JobWithRelations, JobPartWithRelations } from '@/types/job';
import { isValidQuantityInput } from '@/lib/quantityInput';

const ADD_NEW_ADDRESS_ID = '__add_new_address__';

interface LineDraft {
  qtyStr: string;
  priceStr: string;
}

interface JobEditFormProps {
  job: JobWithRelations;
  companyId: string;
  /** job_part_id -> already-shipped quantity (part of the quantity floor). */
  shippedByPart: Map<string, number>;
  /** job_part_id -> already-invoiced quantity. Locks that part's price and joins the
   *  quantity floor (can't drop below what's shipped OR invoiced). */
  invoicedByPart: Map<string, number>;
  onCancel: () => void;
  onSaved: () => void | Promise<void>;
}

/**
 * The single edit surface for a job (mirrors the quote edit form): one screen to
 * change PO number, due date, billing/shipping address, contact, and each line's
 * quantity + unit price, with one Save.
 *
 * Per-part locks reflect the progressive-invoicing model: a part's UNIT PRICE is
 * frozen once ANY quantity of it is invoiced (each invoice snapshotted its price);
 * QUANTITY stays editable upward even after invoicing (that's how you bill more —
 * raise the order, then invoice the delta) but can't drop below max(shipped,
 * invoiced). A cancelled part is fully locked. Header details + addresses always edit.
 */
export default function JobEditForm({
  job,
  companyId,
  shippedByPart,
  invoicedByPart,
  onCancel,
  onSaved,
}: JobEditFormProps) {
  const router = useRouter();
  const addresses = job.customers?.addresses ?? [];
  const contacts = job.customers?.customer_contacts ?? [];
  const parts: JobPartWithRelations[] = job.job_parts ?? [];
  const customerHref = `/dashboard/${companyId}/customers/${job.customer_id}`;

  const [po, setPo] = useState(job.customer_po_number ?? '');
  const [dueDate, setDueDate] = useState(job.due_date ?? '');
  const [shippingId, setShippingId] = useState(job.shipping_address_id ?? '');
  const [billingId, setBillingId] = useState(job.billing_address_id ?? '');
  const [contactId, setContactId] = useState(job.contact_id ?? '');
  const [billingSame, setBillingSame] = useState(
    !job.billing_address_id || job.billing_address_id === job.shipping_address_id,
  );
  const [lines, setLines] = useState<Record<string, LineDraft>>(() => {
    const m: Record<string, LineDraft> = {};
    for (const p of parts) {
      m[p.id] = {
        qtyStr: String(p.quantity),
        priceStr: p.unit_price != null ? String(p.unit_price) : '',
      };
    }
    return m;
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const setLine = (id: string, patch: Partial<LineDraft>) =>
    setLines((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));

  const isCancelled = (p: JobPartWithRelations) => p.production_status === 'cancelled';
  const qtyInvoiced = (p: JobPartWithRelations) => invoicedByPart.get(p.id) ?? 0;
  // Price freezes once any quantity is invoiced; a cancelled part is fully locked.
  const priceLocked = (p: JobPartWithRelations) => isCancelled(p) || qtyInvoiced(p) > 0;

  const qtyError = (p: JobPartWithRelations): string | null => {
    const d = lines[p.id];
    if (!isValidQuantityInput(d.qtyStr) || d.qtyStr.trim() === '') return 'Enter a quantity.';
    const q = parseFloat(d.qtyStr);
    if (!(q > 0)) return 'Quantity must be greater than zero.';
    const shipped = shippedByPart.get(p.id) ?? 0;
    const floor = Math.max(shipped, qtyInvoiced(p));
    if (q < floor) {
      return qtyInvoiced(p) > shipped
        ? `${floor} already invoiced — can't go below that.`
        : `${floor} already shipped — can't go below that.`;
    }
    return null;
  };
  const priceError = (p: JobPartWithRelations): string | null => {
    const s = lines[p.id].priceStr.trim();
    if (s === '') return null;
    const n = parseFloat(s);
    return Number.isFinite(n) && n >= 0 ? null : 'Enter a price of zero or more.';
  };

  // A cancelled part is uneditable; otherwise quantity must be valid, and price must
  // be valid unless it's locked (invoiced) — a locked price field is disabled anyway.
  const canSave =
    !saving &&
    parts.every((p) => isCancelled(p) || (!qtyError(p) && (priceLocked(p) || !priceError(p))));

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      await updateJobDetails(job.id, companyId, { customer_po_number: po, due_date: dueDate });
      await updateJobAddressContact(job.id, companyId, {
        shipping_address_id: shippingId,
        billing_address_id: billingSame ? shippingId : billingId,
        contact_id: contactId,
      });
      // Per line: quantity first (keeps the agreed price and recomputes the
      // total), then a manual price if the user changed it — same order the
      // access layer expects.
      for (const p of parts) {
        if (isCancelled(p)) continue;
        const d = lines[p.id];
        // Quantity is always editable (upward) — even on an invoiced part.
        const newQty = parseFloat(d.qtyStr);
        if (Number.isFinite(newQty) && newQty !== Number(p.quantity)) {
          await updateJobPartQuantity(p.id, newQty);
        }
        // Price only when not locked (no invoiced quantity on this part).
        if (!priceLocked(p)) {
          const trimmed = d.priceStr.trim();
          if (trimmed !== '') {
            const newPrice = parseFloat(trimmed);
            if (Number.isFinite(newPrice) && newPrice !== (p.unit_price ?? NaN)) {
              await updateJobPartPrice(p.id, newPrice);
            }
          }
        }
      }
      await onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save job.');
      setSaving(false);
    }
  };

  const renderAddressValue = (value: string) => {
    const a = addresses.find((x) => x.id === value);
    return a ? addressToLines(a).join(', ') : '';
  };

  const addressMenuItems = addresses.map((a) => (
    <MenuItem key={a.id} value={a.id} sx={{ whiteSpace: 'normal' }}>
      <Box>
        {addressToLines(a).map((line, i) => (
          <Typography key={i} variant="body2">
            {line}
          </Typography>
        ))}
      </Box>
    </MenuItem>
  ));

  return (
    <Box>
      <Box
        sx={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          mb: 2,
          gap: 2,
          flexWrap: 'wrap',
        }}
      >
        <Typography variant="h5" sx={{ fontWeight: 600 }}>
          Edit {job.job_number}
        </Typography>
        <Box sx={{ display: 'flex', gap: 1 }}>
          <Button onClick={onCancel} disabled={saving}>
            Cancel
          </Button>
          <Button
            variant="contained"
            onClick={handleSave}
            disabled={!canSave}
            startIcon={saving ? <CircularProgress size={16} color="inherit" /> : <SaveIcon />}
          >
            {saving ? 'Saving…' : 'Save changes'}
          </Button>
        </Box>
      </Box>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      <Grid container spacing={3}>
        {/* Job details */}
        <Grid size={{ xs: 12, md: 6 }}>
          <Card elevation={2} sx={{ height: '100%' }}>
            <CardContent>
              <Typography variant="h6" gutterBottom sx={{ fontWeight: 600 }}>
                Job details
              </Typography>
              <Divider sx={{ mb: 2 }} />
              <TextField
                label="Customer PO number"
                value={po}
                onChange={(e) => setPo(e.target.value)}
                fullWidth
                size="small"
                sx={{ mb: 2 }}
              />
              <TextField
                label="Due date"
                type="date"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
                fullWidth
                size="small"
                slotProps={{ inputLabel: { shrink: true } }}
              />
            </CardContent>
          </Card>
        </Grid>

        {/* Billing & shipping */}
        <Grid size={{ xs: 12, md: 6 }}>
          <Card elevation={2} sx={{ height: '100%' }}>
            <CardContent>
              <Typography variant="h6" gutterBottom sx={{ fontWeight: 600 }}>
                Billing &amp; Shipping
              </Typography>
              <Divider sx={{ mb: 2 }} />
              {addresses.length === 0 && contacts.length === 0 && (
                <Alert severity="info" sx={{ mb: 2 }}>
                  This customer has no saved addresses or contacts.{' '}
                  <Button size="small" onClick={() => router.push(customerHref)}>
                    Add on customer
                  </Button>
                </Alert>
              )}
              <Autocomplete
                size="small"
                options={contacts}
                getOptionLabel={(c) => c.name}
                value={contacts.find((c) => c.id === contactId) ?? null}
                onChange={(_, v) => setContactId(v?.id ?? '')}
                isOptionEqualToValue={(o, v) => o.id === v.id}
                renderInput={(params) => <TextField {...params} label="Contact" />}
                sx={{ mb: 2 }}
              />
              <FormControl fullWidth size="small">
                <InputLabel id="job-edit-shipping-label">Shipping address</InputLabel>
                <Select
                  labelId="job-edit-shipping-label"
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
                  {addressMenuItems}
                  <MenuItem value={ADD_NEW_ADDRESS_ID} sx={{ fontStyle: 'italic' }}>
                    + Add new address
                  </MenuItem>
                </Select>
              </FormControl>
              <FormControlLabel
                sx={{ mt: 1 }}
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
                <FormControl fullWidth size="small" sx={{ mt: 1 }}>
                  <InputLabel id="job-edit-billing-label">Billing address</InputLabel>
                  <Select
                    labelId="job-edit-billing-label"
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
                    {addressMenuItems}
                    <MenuItem value={ADD_NEW_ADDRESS_ID} sx={{ fontStyle: 'italic' }}>
                      + Add new address
                    </MenuItem>
                  </Select>
                </FormControl>
              )}
            </CardContent>
          </Card>
        </Grid>

        {/* Line items */}
        <Grid size={{ xs: 12 }}>
          <Card elevation={2}>
            <CardContent>
              <Typography variant="h6" gutterBottom sx={{ fontWeight: 600 }}>
                Line items
              </Typography>
              <Divider sx={{ mb: 2 }} />
              <Stack spacing={2}>
                {parts.map((p) => {
                  const cancelled = isCancelled(p);
                  const shipped = shippedByPart.get(p.id) ?? 0;
                  const invoiced = qtyInvoiced(p);
                  const pLocked = priceLocked(p);
                  const qErr = qtyError(p);
                  const pErr = priceError(p);
                  const qtyHelp =
                    !cancelled && qErr
                      ? qErr
                      : invoiced > 0
                        ? `${invoiced} invoiced${shipped > invoiced ? `, ${shipped} shipped` : ''}`
                        : shipped > 0
                          ? `${shipped} shipped`
                          : ' ';
                  return (
                    <Box
                      key={p.id}
                      sx={{
                        display: 'flex',
                        gap: 2,
                        flexWrap: 'wrap',
                        alignItems: 'flex-start',
                        p: 1.5,
                        borderRadius: 1,
                        border: '1px solid',
                        borderColor: 'divider',
                      }}
                    >
                      <Box sx={{ flex: 1, minWidth: 160 }}>
                        <Typography fontWeight={600}>
                          {p.parts?.part_name ?? 'Part'}
                        </Typography>
                        {cancelled && (
                          <Typography variant="caption" color="error.main">
                            Cancelled
                          </Typography>
                        )}
                      </Box>
                      <TextField
                        label="Quantity"
                        value={lines[p.id].qtyStr}
                        onChange={(e) => {
                          if (isValidQuantityInput(e.target.value)) {
                            setLine(p.id, { qtyStr: e.target.value });
                          }
                        }}
                        size="small"
                        disabled={cancelled}
                        error={!cancelled && !!qErr}
                        helperText={qtyHelp}
                        sx={{ width: 160 }}
                        slotProps={{ htmlInput: { inputMode: 'decimal' } }}
                      />
                      <TextField
                        label="Unit price"
                        value={lines[p.id].priceStr}
                        onChange={(e) => {
                          if (/^\d*\.?\d*$/.test(e.target.value)) {
                            setLine(p.id, { priceStr: e.target.value });
                          }
                        }}
                        size="small"
                        disabled={pLocked}
                        error={!pLocked && !!pErr}
                        helperText={
                          pLocked && invoiced > 0
                            ? 'Invoiced — price locked'
                            : !pLocked && pErr
                              ? pErr
                              : ' '
                        }
                        sx={{ width: 170 }}
                        slotProps={{
                          htmlInput: { inputMode: 'decimal' },
                          input: {
                            startAdornment: <InputAdornment position="start">$</InputAdornment>,
                            ...(pLocked && invoiced > 0
                              ? {
                                  endAdornment: (
                                    <InputAdornment position="end">
                                      <LockIcon fontSize="small" color="disabled" />
                                    </InputAdornment>
                                  ),
                                }
                              : {}),
                          },
                        }}
                      />
                    </Box>
                  );
                })}
              </Stack>
            </CardContent>
          </Card>
        </Grid>

        {/* Attachments — the single place to add or remove the customer PO PDF and any
            reference files. Uploads persist immediately (independent of Save changes). */}
        <Grid size={{ xs: 12 }}>
          <JobAttachmentsCard jobId={job.id} companyId={companyId} />
        </Grid>
      </Grid>
    </Box>
  );
}
