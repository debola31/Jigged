'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Divider from '@mui/material/Divider';
import FormControl from '@mui/material/FormControl';
import InputLabel from '@mui/material/InputLabel';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';

import { getSupabase } from '@/lib/supabase';
import type { Company } from '@/utils/companyAccess';
import type { CustomerAddress } from '@/types/customer';
import type { CreateShipmentPayload, ShippingArrangement } from '@/types/shipment';
import { SHIPPING_ARRANGEMENT_OPTIONS } from '@/types/shipment';
import {
  createShipment,
  getJobPartShipmentSummaries,
} from '@/utils/shipmentsAccess';

/**
 * Today as YYYY-MM-DD in the user's local timezone. Mirrors the helper
 * in utils/jobsAccess so the modal default matches the rest of the
 * shipment date handling.
 */
function todayLocalISODate(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

interface JobContext {
  id: string;
  job_number: string;
  company_id: string;
  customer: {
    id: string;
    name: string;
    default_carrier: string | null;
    default_shipping_arrangement: ShippingArrangement | null;
    default_coc_text: string | null;
    addresses: CustomerAddress[];
  };
}

interface PartRowState {
  job_part_id: string;
  part_name: string;
  part_number: string | null;
  qty_ordered: number;
  qty_shipped_prior: number;
  qty_remaining: number;
  /** User-edited input string so empties don't immediately collapse to 0. */
  qty_input: string;
}

export interface CreateShipmentModalProps {
  open: boolean;
  jobId: string;
  companyId: string;
  onClose: () => void;
  /** Called after the RPC commits. pdfError is set when post-RPC PDF generation failed. */
  onCreated: (result: {
    shipmentId: string;
    packingSlipNumber: string;
    pdfError?: Error | null;
  }) => void | Promise<void>;
}

export default function CreateShipmentModal({
  open,
  jobId,
  companyId,
  onClose,
  onCreated,
}: CreateShipmentModalProps) {
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [jobCtx, setJobCtx] = useState<JobContext | null>(null);
  const [company, setCompany] = useState<Company | null>(null);

  const [shipDate, setShipDate] = useState<string>(todayLocalISODate());
  const [shippingAddressId, setShippingAddressId] = useState<string | null>(null);
  const [carrier, setCarrier] = useState('');
  const [trackingNumber, setTrackingNumber] = useState('');
  const [shippingArrangement, setShippingArrangement] = useState<ShippingArrangement | ''>('');
  const [shippingArrangementOther, setShippingArrangementOther] = useState('');
  const [weightLbs, setWeightLbs] = useState('');
  const [packageCount, setPackageCount] = useState('');
  const [packageType, setPackageType] = useState('');
  const [notes, setNotes] = useState('');
  const [cocText, setCocText] = useState('');

  const [parts, setParts] = useState<PartRowState[]>([]);

  // ---------- Initial load ----------
  useEffect(() => {
    if (!open) return;

    let cancelled = false;
    setLoading(true);
    setError(null);

    (async () => {
      try {
        const supabase = getSupabase();

        // Job + customer + parts + part metadata in one query.
        const { data: jobRow, error: jobErr } = await supabase
          .from('jobs')
          .select(
            `id, job_number, company_id,
             customer:customers!left (
               id, name,
               default_carrier, default_shipping_arrangement, default_coc_text,
               addresses:customer_addresses (
                 id, customer_id, address_line1, address_line2, city, state,
                 postal_code, country, default_billing, default_shipping, attention_to
               )
             ),
             job_parts (
               id, sequence, quantity,
               parts (id, part_name, part_number)
             )`,
          )
          .eq('id', jobId)
          .single();
        if (jobErr || !jobRow) {
          throw new Error(jobErr?.message ?? 'Job not found.');
        }

        const { data: companyRow, error: companyErr } = await supabase
          .from('companies')
          .select('id, name, logo_url, address_line1, address_line2, city, state, postal_code, country, phone, email, website, default_coc_text, packing_slip_number_format, settings')
          .eq('id', companyId)
          .single();
        if (companyErr || !companyRow) {
          throw new Error(companyErr?.message ?? 'Company not found.');
        }

        const summaries = await getJobPartShipmentSummaries(jobId);
        const remainingByPart = new Map(summaries.map((s) => [s.job_part_id, s]));

        if (cancelled) return;

        const ctx = jobRow as unknown as JobContext & {
          job_parts: Array<{
            id: string;
            sequence: number;
            quantity: number;
            parts: { id: string; part_name: string; part_number: string | null } | null;
          }>;
        };
        setJobCtx(ctx);
        setCompany(companyRow as unknown as Company);

        // Form defaults — customer-level shipping defaults.
        const customer = ctx.customer;
        setCarrier(customer?.default_carrier ?? '');
        setShippingArrangement(customer?.default_shipping_arrangement ?? '');
        setShippingArrangementOther('');
        setCocText(
          customer?.default_coc_text?.trim()
            || (companyRow as unknown as Company).default_coc_text?.trim()
            || '',
        );

        // Default shipping address: default_shipping → default_billing → null
        const defaultShip = customer?.addresses?.find((a) => a.default_shipping)
          ?? customer?.addresses?.find((a) => a.default_billing)
          ?? null;
        setShippingAddressId(defaultShip?.id ?? null);

        const rows: PartRowState[] = (ctx.job_parts ?? [])
          .sort((a, b) => a.sequence - b.sequence)
          .map((jp) => {
            const summary = remainingByPart.get(jp.id);
            const remaining = summary?.qty_remaining ?? Number(jp.quantity);
            const prior = summary?.qty_shipped ?? 0;
            return {
              job_part_id: jp.id,
              part_name: jp.parts?.part_name ?? 'Part',
              part_number: jp.parts?.part_number ?? null,
              qty_ordered: Number(jp.quantity),
              qty_shipped_prior: prior,
              qty_remaining: remaining,
              qty_input: remaining > 0 ? String(remaining) : '0',
            };
          });
        setParts(rows);
      } catch (err) {
        if (cancelled) return;
        console.error('CreateShipmentModal load failed:', err);
        setError(err instanceof Error ? err.message : 'Failed to load job context.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [open, jobId, companyId]);

  const selectedAddress = useMemo(() => {
    if (!shippingAddressId || !jobCtx) return null;
    return jobCtx.customer.addresses.find((a) => a.id === shippingAddressId) ?? null;
  }, [shippingAddressId, jobCtx]);

  const attentionText = selectedAddress?.attention_to?.trim() ?? '';

  // ---------- Validation ----------
  type Validation = {
    quantities: Array<{ job_part_id: string; quantity: number; warn: boolean }>;
    hasAnyShipping: boolean;
    canSubmit: boolean;
    warnings: string[];
    blockingMessages: string[];
  };

  const validation: Validation = useMemo(() => {
    const quantities = parts.map((row) => {
      const parsed = Number(row.qty_input);
      const quantity = Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
      const warn = quantity > row.qty_remaining;
      return { job_part_id: row.job_part_id, quantity, warn };
    });
    const hasAnyShipping = quantities.some((q) => q.quantity > 0);

    const warnings: string[] = [];
    const blockingMessages: string[] = [];

    quantities.forEach((q, i) => {
      if (q.warn) {
        warnings.push(
          `${parts[i].part_name}: shipping ${q.quantity} exceeds remaining ${parts[i].qty_remaining}.`,
        );
      }
    });

    if (!hasAnyShipping) {
      blockingMessages.push('At least one line item must have a non-zero quantity.');
    }
    if (!shippingAddressId) {
      blockingMessages.push('Shipping address is required.');
    }
    if (shippingArrangement === 'other' && !shippingArrangementOther.trim()) {
      blockingMessages.push('Provide free-text detail when selecting "Other" arrangement.');
    }

    return {
      quantities,
      hasAnyShipping,
      canSubmit: blockingMessages.length === 0,
      warnings,
      blockingMessages,
    };
  }, [parts, shippingAddressId, shippingArrangement, shippingArrangementOther]);

  // ---------- Submit ----------
  const handleSubmit = useCallback(async () => {
    if (!jobCtx) return;
    if (!validation.canSubmit) return;
    setSubmitting(true);
    setError(null);

    const payload: CreateShipmentPayload = {
      customer_id: jobCtx.customer.id,
      shipping_address_id: shippingAddressId,
      one_time_address: null,
      ship_date: shipDate || todayLocalISODate(),
      carrier: carrier.trim() || null,
      tracking_number: trackingNumber.trim() || null,
      shipping_arrangement: shippingArrangement === '' ? null : shippingArrangement,
      shipping_arrangement_other:
        shippingArrangement === 'other'
          ? shippingArrangementOther.trim() || null
          : null,
      weight_lbs: weightLbs.trim() === '' ? null : Number(weightLbs),
      package_count: packageCount.trim() === '' ? null : Math.round(Number(packageCount)),
      package_type: packageType.trim() || null,
      notes: notes.trim() || null,
      coc_text: cocText.trim() || null,
      line_items: validation.quantities
        .filter((q) => q.quantity > 0)
        .map((q) => ({ job_part_id: q.job_part_id, quantity: q.quantity })),
    };

    try {
      const result = await createShipment(companyId, payload);
      await onCreated({
        shipmentId: result.shipmentId,
        packingSlipNumber: result.packingSlipNumber,
        pdfError: null,
      });
    } catch (err) {
      console.error('createShipment failed:', err);
      setError(err instanceof Error ? err.message : 'Failed to create shipment.');
    } finally {
      setSubmitting(false);
    }
  }, [
    jobCtx, validation, shippingAddressId, shipDate, carrier, trackingNumber,
    shippingArrangement, shippingArrangementOther, weightLbs, packageCount,
    packageType, notes, cocText, companyId, onCreated,
  ]);

  const handleClose = () => {
    if (submitting) return;
    onClose();
  };

  // ---------- Render ----------
  return (
    <Dialog open={open} onClose={handleClose} maxWidth="md" fullWidth>
      <DialogTitle>
        Create Shipment{jobCtx ? ` — ${jobCtx.job_number}` : ''}
      </DialogTitle>
      <DialogContent dividers>
        {loading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
            <CircularProgress />
          </Box>
        ) : !jobCtx ? (
          <Alert severity="error">{error ?? 'Job not available.'}</Alert>
        ) : (
          <Stack spacing={3}>
            {error && <Alert severity="error">{error}</Alert>}

            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
              <TextField
                label="Customer"
                value={jobCtx.customer.name}
                fullWidth
                InputProps={{ readOnly: true }}
              />
              <TextField
                label="Ship Date"
                type="date"
                value={shipDate}
                onChange={(e) => setShipDate(e.target.value)}
                fullWidth
                InputLabelProps={{ shrink: true }}
              />
            </Stack>

            <Box>
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} alignItems="flex-start">
                <FormControl fullWidth>
                  <InputLabel id="shipping-address-label">Shipping Address</InputLabel>
                  <Select
                    labelId="shipping-address-label"
                    label="Shipping Address"
                    value={shippingAddressId ?? ''}
                    onChange={(e) => setShippingAddressId(e.target.value || null)}
                  >
                    {jobCtx.customer.addresses.map((addr) => (
                      <MenuItem key={addr.id} value={addr.id}>
                        <Stack spacing={0}>
                          <Typography variant="body1">
                            {[addr.address_line1, addr.address_line2].filter(Boolean).join(', ') || '(no street)'}
                          </Typography>
                          <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                            {[addr.city, addr.state, addr.postal_code].filter(Boolean).join(' ')}
                          </Typography>
                        </Stack>
                      </MenuItem>
                    ))}
                  </Select>
                </FormControl>
              </Stack>
              {attentionText ? (
                <Typography variant="body2" sx={{ mt: 1, color: 'text.secondary' }}>
                  ATTN on packing slip: <Box component="span" sx={{ color: 'text.primary', fontWeight: 600 }}>{attentionText}</Box>
                </Typography>
              ) : (
                <Typography variant="body2" sx={{ mt: 1, color: 'text.secondary' }}>
                  No ATTN line — set <Box component="i">attention_to</Box> on the address to add one.
                </Typography>
              )}
            </Box>

            <Divider />

            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
              <TextField
                label="Carrier"
                value={carrier}
                onChange={(e) => setCarrier(e.target.value)}
                fullWidth
              />
              <TextField
                label="Tracking Number"
                value={trackingNumber}
                onChange={(e) => setTrackingNumber(e.target.value)}
                fullWidth
              />
            </Stack>

            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} alignItems="flex-start">
              <FormControl fullWidth>
                <InputLabel id="shipping-arrangement-label">Shipping Arrangement</InputLabel>
                <Select
                  labelId="shipping-arrangement-label"
                  label="Shipping Arrangement"
                  value={shippingArrangement}
                  onChange={(e) => setShippingArrangement(e.target.value as ShippingArrangement | '')}
                >
                  <MenuItem value="">
                    <em>None</em>
                  </MenuItem>
                  {SHIPPING_ARRANGEMENT_OPTIONS.map((opt) => (
                    <MenuItem key={opt.value} value={opt.value}>{opt.label}</MenuItem>
                  ))}
                </Select>
              </FormControl>
              {shippingArrangement === 'other' && (
                <TextField
                  label='Arrangement detail (required for "Other")'
                  value={shippingArrangementOther}
                  onChange={(e) => setShippingArrangementOther(e.target.value)}
                  fullWidth
                />
              )}
            </Stack>

            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
              <TextField
                label="Weight (lbs)"
                value={weightLbs}
                onChange={(e) => setWeightLbs(e.target.value)}
                inputProps={{ inputMode: 'decimal' }}
                fullWidth
              />
              <TextField
                label="Package Count"
                value={packageCount}
                onChange={(e) => setPackageCount(e.target.value)}
                inputProps={{ inputMode: 'numeric' }}
                fullWidth
              />
              <TextField
                label="Package Type"
                value={packageType}
                onChange={(e) => setPackageType(e.target.value)}
                placeholder="e.g., box, pallet"
                fullWidth
              />
            </Stack>

            <Divider />

            <Box>
              <Typography variant="subtitle1" sx={{ mb: 1 }}>
                Line Items
              </Typography>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Part</TableCell>
                    <TableCell align="right">Ordered</TableCell>
                    <TableCell align="right">Already Shipped</TableCell>
                    <TableCell align="right">Remaining</TableCell>
                    <TableCell align="right" sx={{ width: 120 }}>Ship Now</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {parts.map((row) => {
                    const v = validation.quantities.find(
                      (q) => q.job_part_id === row.job_part_id,
                    );
                    return (
                      <TableRow key={row.job_part_id}>
                        <TableCell>
                          <Typography variant="body2" sx={{ fontWeight: 600 }}>
                            {row.part_number || row.part_name}
                          </Typography>
                          {row.part_number && row.part_name !== row.part_number ? (
                            <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                              {row.part_name}
                            </Typography>
                          ) : null}
                        </TableCell>
                        <TableCell align="right">{row.qty_ordered}</TableCell>
                        <TableCell align="right">{row.qty_shipped_prior}</TableCell>
                        <TableCell align="right">{row.qty_remaining}</TableCell>
                        <TableCell align="right">
                          <TextField
                            value={row.qty_input}
                            onChange={(e) => {
                              const next = [...parts];
                              const idx = next.findIndex(
                                (p) => p.job_part_id === row.job_part_id,
                              );
                              next[idx] = { ...row, qty_input: e.target.value };
                              setParts(next);
                            }}
                            size="small"
                            inputProps={{
                              inputMode: 'decimal',
                              style: { textAlign: 'right' },
                            }}
                            error={Boolean(v?.warn)}
                          />
                        </TableCell>
                      </TableRow>
                    );
                  })}
                  {parts.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={5}>
                        <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                          No job parts.
                        </Typography>
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>

              {validation.warnings.length > 0 && (
                <Alert severity="warning" sx={{ mt: 2 }}>
                  <Stack spacing={0.5}>
                    {validation.warnings.map((w, i) => (
                      <Typography key={i} variant="body2">
                        {w}
                      </Typography>
                    ))}
                  </Stack>
                </Alert>
              )}
            </Box>

            <Divider />

            <TextField
              label="Notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              multiline
              minRows={2}
              fullWidth
            />

            <TextField
              label="Certificate of Conformance"
              value={cocText}
              onChange={(e) => setCocText(e.target.value)}
              multiline
              minRows={3}
              fullWidth
              helperText="Defaults to customer.default_coc_text, falling back to company.default_coc_text. Leave empty to omit."
            />

            {!validation.canSubmit && validation.blockingMessages.length > 0 && (
              <Alert severity="info">
                <Stack spacing={0.5}>
                  {validation.blockingMessages.map((m, i) => (
                    <Typography key={i} variant="body2">{m}</Typography>
                  ))}
                </Stack>
              </Alert>
            )}
          </Stack>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={handleClose} disabled={submitting}>
          Cancel
        </Button>
        <Button
          variant="contained"
          color="primary"
          onClick={handleSubmit}
          disabled={loading || submitting || !jobCtx || !validation.canSubmit}
        >
          {submitting ? 'Creating…' : 'Create Shipment & Print'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
