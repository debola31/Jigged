'use client';

import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useState,
} from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Divider from '@mui/material/Divider';
import FormControl from '@mui/material/FormControl';
import FormControlLabel from '@mui/material/FormControlLabel';
import InputAdornment from '@mui/material/InputAdornment';
import InputLabel from '@mui/material/InputLabel';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import Stack from '@mui/material/Stack';
import Switch from '@mui/material/Switch';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import SearchIcon from '@mui/icons-material/Search';

import { getSupabase } from '@/lib/supabase';
import type { Company } from '@/utils/companyAccess';
import type { CustomerAddress } from '@/types/customer';
import type {
  CreateShipmentPayload,
  OpenJobPartRow,
  ShippingArrangement,
} from '@/types/shipment';
import { SHIPPING_ARRANGEMENT_OPTIONS } from '@/types/shipment';
import {
  createShipment,
  getJobPartShipmentSummaries,
  getOpenJobPartsForCustomer,
} from '@/utils/shipmentsAccess';

function todayLocalISODate(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Loaded customer context. In both modes we end up with the same shape:
 * the customer's name + default carrier/arrangement/coc + the list of
 * addresses available for ship-to.
 */
interface CustomerContext {
  id: string;
  name: string;
  default_carrier: string | null;
  default_shipping_arrangement: ShippingArrangement | null;
  default_coc_text: string | null;
  addresses: CustomerAddress[];
}

/**
 * One line in the form's picker. job mode has all rows sharing one
 * job_number; customer mode mixes jobs.
 */
interface LineRow {
  job_part_id: string;
  job_id: string;
  job_number: string;
  customer_po_number: string | null;
  part_name: string;
  description: string | null;
  qty_ordered: number;
  qty_shipped_prior: number;
  qty_remaining: number;
  production_status: 'not_started' | 'in_progress' | 'completed' | 'cancelled';
  /** User-edited input string so an empty box doesn't collapse to 0. */
  qty_input: string;
  /** Customer mode only — whether the user has ticked this row. */
  selected: boolean;
}

export type ShipmentFormSource =
  | { kind: 'job'; jobId: string }
  | { kind: 'customer'; customerId: string };

export interface ShipmentFormProps {
  source: ShipmentFormSource;
  companyId: string;
  onCreated: (result: {
    shipmentId: string;
    packingSlipNumber: string;
  }) => void | Promise<void>;
  onCancel?: () => void;
  submitLabel?: string;
}

export default function ShipmentForm({
  source,
  companyId,
  onCreated,
  onCancel,
  submitLabel = 'Create Shipment & Print',
}: ShipmentFormProps) {
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [customer, setCustomer] = useState<CustomerContext | null>(null);
  const [company, setCompany] = useState<Company | null>(null);
  const [jobNumberForTitle, setJobNumberForTitle] = useState<string | null>(null);

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

  const [lines, setLines] = useState<LineRow[]>([]);

  // Customer-mode UI state. Ignored in job mode.
  const [readyToShipOnly, setReadyToShipOnly] = useState(true);
  const [searchInput, setSearchInput] = useState('');
  const deferredSearch = useDeferredValue(searchInput);

  const isCustomerMode = source.kind === 'customer';

  // ---------- Initial load ----------
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    (async () => {
      try {
        const supabase = getSupabase();

        // 1. Company defaults
        const { data: companyRow, error: companyErr } = await supabase
          .from('companies')
          .select(
            'id, name, logo_url, address_line1, address_line2, city, state, postal_code, country, phone, email, website, default_coc_text, packing_slip_number_format, settings',
          )
          .eq('id', companyId)
          .single();
        if (companyErr || !companyRow) {
          throw new Error(companyErr?.message ?? 'Company not found.');
        }

        // 2. Customer context + lines, depending on source.
        let ctx: CustomerContext;
        let initialLines: LineRow[];

        if (source.kind === 'job') {
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
               customer_po_number,
               job_parts (
                 id, sequence, quantity, production_status, fulfillment_status,
                 parts (id, part_name, description)
               )`,
            )
            .eq('id', source.jobId)
            .single();
          if (jobErr || !jobRow) {
            throw new Error(jobErr?.message ?? 'Job not found.');
          }

          type JobShape = {
            id: string;
            job_number: string;
            customer_po_number: string | null;
            customer: CustomerContext | null;
            job_parts: Array<{
              id: string;
              sequence: number;
              quantity: number;
              production_status: LineRow['production_status'];
              fulfillment_status: 'unshipped' | 'partially_shipped' | 'fully_shipped';
              parts: { id: string; part_name: string; description: string | null } | null;
            }>;
          };
          const job = jobRow as unknown as JobShape;
          if (!job.customer) {
            throw new Error('Job is missing customer.');
          }
          ctx = job.customer;
          setJobNumberForTitle(job.job_number);

          const summaries = await getJobPartShipmentSummaries(source.jobId);
          const summaryByPart = new Map(summaries.map((s) => [s.job_part_id, s]));

          initialLines = (job.job_parts ?? [])
            .slice()
            .sort((a, b) => a.sequence - b.sequence)
            .map((jp) => {
              const summary = summaryByPart.get(jp.id);
              const qtyOrdered = Number(jp.quantity);
              const qtyShippedPrior = summary?.qty_shipped ?? 0;
              const qtyRemaining = summary?.qty_remaining ?? qtyOrdered;
              return {
                job_part_id: jp.id,
                job_id: job.id,
                job_number: job.job_number,
                customer_po_number: job.customer_po_number,
                part_name: jp.parts?.part_name ?? 'Part',
                description: jp.parts?.description ?? null,
                qty_ordered: qtyOrdered,
                qty_shipped_prior: qtyShippedPrior,
                qty_remaining: qtyRemaining,
                production_status: jp.production_status,
                qty_input: qtyRemaining > 0 ? String(qtyRemaining) : '0',
                // Job mode: every line is implicitly "selected"; the qty
                // input alone decides whether it's included on submit.
                selected: true,
              };
            });
        } else {
          // Customer mode
          const { data: customerRow, error: customerErr } = await supabase
            .from('customers')
            .select(
              `id, name, default_carrier, default_shipping_arrangement, default_coc_text,
               addresses:customer_addresses (
                 id, customer_id, address_line1, address_line2, city, state,
                 postal_code, country, default_billing, default_shipping, attention_to
               )`,
            )
            .eq('id', source.customerId)
            .single();
          if (customerErr || !customerRow) {
            throw new Error(customerErr?.message ?? 'Customer not found.');
          }
          ctx = customerRow as unknown as CustomerContext;

          const openParts = await getOpenJobPartsForCustomer(
            companyId,
            source.customerId,
          );
          initialLines = openParts.map((p: OpenJobPartRow) => ({
            job_part_id: p.job_part_id,
            job_id: p.job_id,
            job_number: p.job_number,
            customer_po_number: p.customer_po_number,
            part_name: p.part_name,
            description: p.description,
            qty_ordered: p.qty_ordered,
            qty_shipped_prior: p.qty_shipped,
            qty_remaining: p.qty_remaining,
            production_status: p.production_status,
            qty_input: p.qty_remaining > 0 ? String(p.qty_remaining) : '0',
            // Customer mode: nothing checked by default — Bri picks what
            // she's actually boxing.
            selected: false,
          }));
        }

        if (cancelled) return;

        setCustomer(ctx);
        setCompany(companyRow as unknown as Company);
        setLines(initialLines);

        // Form defaults from customer (carrier/arrangement/coc) +
        // company fallback for coc.
        setCarrier(ctx.default_carrier ?? '');
        setShippingArrangement(ctx.default_shipping_arrangement ?? '');
        setShippingArrangementOther('');
        setCocText(
          ctx.default_coc_text?.trim()
            || (companyRow as unknown as Company).default_coc_text?.trim()
            || '',
        );

        // Default shipping address: default_shipping → default_billing → null.
        const defaultShip = ctx.addresses?.find((a) => a.default_shipping)
          ?? ctx.addresses?.find((a) => a.default_billing)
          ?? null;
        setShippingAddressId(defaultShip?.id ?? null);
      } catch (err) {
        if (cancelled) return;
        console.error('ShipmentForm load failed:', err);
        setError(err instanceof Error ? err.message : 'Failed to load shipment context.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [source, companyId]);

  // ---------- Derived: filtered + grouped lines (customer mode) ----------
  const filteredLines = useMemo(() => {
    if (!isCustomerMode) return lines;
    const term = deferredSearch.trim().toLowerCase();
    return lines.filter((l) => {
      if (readyToShipOnly && l.production_status !== 'completed') {
        // Always keep already-selected rows visible so a previously-ticked
        // line doesn't silently disappear when the filter toggles.
        if (!l.selected) return false;
      }
      if (term) {
        const hay = `${l.part_name} ${l.job_number} ${l.customer_po_number ?? ''}`.toLowerCase();
        if (!hay.includes(term)) return false;
      }
      return true;
    });
  }, [lines, isCustomerMode, readyToShipOnly, deferredSearch]);

  const linesByJob = useMemo(() => {
    if (!isCustomerMode) return null;
    const groups = new Map<string, { job_number: string; customer_po_number: string | null; rows: LineRow[] }>();
    for (const l of filteredLines) {
      const existing = groups.get(l.job_id);
      if (existing) {
        existing.rows.push(l);
      } else {
        groups.set(l.job_id, {
          job_number: l.job_number,
          customer_po_number: l.customer_po_number,
          rows: [l],
        });
      }
    }
    return Array.from(groups.values()).sort((a, b) =>
      a.job_number.localeCompare(b.job_number, undefined, { numeric: true, sensitivity: 'base' }),
    );
  }, [filteredLines, isCustomerMode]);

  const selectedAddress = useMemo(() => {
    if (!shippingAddressId || !customer) return null;
    return customer.addresses.find((a) => a.id === shippingAddressId) ?? null;
  }, [shippingAddressId, customer]);

  const attentionText = selectedAddress?.attention_to?.trim() ?? '';

  // ---------- Validation ----------
  type Validation = {
    contributing: Array<{ job_part_id: string; quantity: number; warn: boolean; row: LineRow }>;
    canSubmit: boolean;
    warnings: string[];
    blockingMessages: string[];
  };

  const validation: Validation = useMemo(() => {
    const contributing = lines
      .map((row) => {
        const parsed = Number(row.qty_input);
        const quantity = Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
        const warn = quantity > row.qty_remaining;
        return { job_part_id: row.job_part_id, quantity, warn, row };
      })
      .filter((c) => {
        // Job mode: include any positive-qty row.
        // Customer mode: only checked rows with positive qty.
        if (isCustomerMode && !c.row.selected) return false;
        return c.quantity > 0;
      });

    const warnings: string[] = [];
    const blockingMessages: string[] = [];

    for (const c of contributing) {
      if (c.warn) {
        warnings.push(
          `${c.row.part_name} (job ${c.row.job_number}): shipping ${c.quantity} exceeds remaining ${c.row.qty_remaining}.`,
        );
      }
    }
    if (contributing.length === 0) {
      blockingMessages.push(
        isCustomerMode
          ? 'Select at least one line and set a non-zero quantity to ship.'
          : 'At least one line item must have a non-zero quantity.',
      );
    }
    if (!shippingAddressId) {
      blockingMessages.push('Shipping address is required.');
    }
    if (shippingArrangement === 'other' && !shippingArrangementOther.trim()) {
      blockingMessages.push('Provide free-text detail when selecting "Other" arrangement.');
    }

    return {
      contributing,
      canSubmit: blockingMessages.length === 0,
      warnings,
      blockingMessages,
    };
  }, [lines, isCustomerMode, shippingAddressId, shippingArrangement, shippingArrangementOther]);

  // ---------- Helpers to mutate a single line by id ----------
  const patchLine = useCallback((jobPartId: string, patch: Partial<LineRow>) => {
    setLines((prev) =>
      prev.map((row) => (row.job_part_id === jobPartId ? { ...row, ...patch } : row)),
    );
  }, []);

  // ---------- Submit ----------
  const handleSubmit = useCallback(async () => {
    if (!customer) return;
    if (!validation.canSubmit) return;
    setSubmitting(true);
    setError(null);

    const payload: CreateShipmentPayload = {
      customer_id: customer.id,
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
      line_items: validation.contributing.map((c) => ({
        job_part_id: c.job_part_id,
        quantity: c.quantity,
      })),
    };

    try {
      const result = await createShipment(companyId, payload);
      await onCreated({
        shipmentId: result.shipmentId,
        packingSlipNumber: result.packingSlipNumber,
      });
    } catch (err) {
      console.error('createShipment failed:', err);
      setError(err instanceof Error ? err.message : 'Failed to create shipment.');
    } finally {
      setSubmitting(false);
    }
  }, [
    customer, validation, shippingAddressId, shipDate, carrier, trackingNumber,
    shippingArrangement, shippingArrangementOther, weightLbs, packageCount,
    packageType, notes, cocText, companyId, onCreated,
  ]);

  // ---------- Render ----------
  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
        <CircularProgress />
      </Box>
    );
  }

  if (!customer) {
    return <Alert severity="error">{error ?? 'Shipment context not available.'}</Alert>;
  }

  return (
    <Stack spacing={3}>
      {error && <Alert severity="error">{error}</Alert>}

      {jobNumberForTitle && !isCustomerMode && (
        <Typography variant="subtitle1" sx={{ color: 'text.secondary' }}>
          Job {jobNumberForTitle}
        </Typography>
      )}

      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
        <TextField
          label="Customer"
          value={customer.name}
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
        <FormControl fullWidth>
          <InputLabel id="shipping-address-label">Shipping Address</InputLabel>
          <Select
            labelId="shipping-address-label"
            label="Shipping Address"
            value={shippingAddressId ?? ''}
            onChange={(e) => setShippingAddressId(e.target.value || null)}
          >
            {customer.addresses.map((addr) => (
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
        {attentionText ? (
          <Typography variant="body2" sx={{ mt: 1, color: 'text.secondary' }}>
            ATTN on packing slip:{' '}
            <Box component="span" sx={{ color: 'text.primary', fontWeight: 600 }}>
              {attentionText}
            </Box>
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
            onChange={(e) =>
              setShippingArrangement(e.target.value as ShippingArrangement | '')
            }
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

        {isCustomerMode && (
          <Stack
            direction={{ xs: 'column', sm: 'row' }}
            spacing={2}
            alignItems={{ xs: 'flex-start', sm: 'center' }}
            sx={{ mb: 2 }}
          >
            <FormControlLabel
              control={
                <Switch
                  checked={readyToShipOnly}
                  onChange={(e) => setReadyToShipOnly(e.target.checked)}
                />
              }
              label="Ready to Ship only"
            />
            <Typography variant="body2" sx={{ color: 'text.secondary' }}>
              Lines where production is complete
            </Typography>
            <Box sx={{ flex: 1 }} />
            <TextField
              size="small"
              placeholder="Search part, job, or PO"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              InputProps={{
                startAdornment: (
                  <InputAdornment position="start">
                    <SearchIcon fontSize="small" />
                  </InputAdornment>
                ),
              }}
              sx={{ width: { xs: '100%', sm: 280 } }}
            />
          </Stack>
        )}

        {isCustomerMode
          ? renderCustomerLineGroups(linesByJob ?? [], patchLine)
          : renderJobLineTable(filteredLines, patchLine, validation)}

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

      <Stack direction="row" spacing={2} justifyContent="flex-end">
        {onCancel && (
          <Button onClick={onCancel} disabled={submitting}>
            Cancel
          </Button>
        )}
        <Button
          variant="contained"
          color="primary"
          onClick={handleSubmit}
          disabled={submitting || !customer || !validation.canSubmit}
        >
          {submitting ? 'Creating…' : submitLabel}
        </Button>
      </Stack>

      {company === null && (
        <Typography variant="caption" sx={{ color: 'text.secondary' }}>
          Note: company defaults could not be loaded; carrier/CoC defaults may be blank.
        </Typography>
      )}
    </Stack>
  );
}

// ---------- Render helpers ----------

function renderJobLineTable(
  rows: LineRow[],
  patchLine: (id: string, patch: Partial<LineRow>) => void,
  validation: {
    contributing: Array<{ job_part_id: string; quantity: number; warn: boolean; row: LineRow }>;
  },
) {
  const warnByPart = new Map(
    validation.contributing.filter((c) => c.warn).map((c) => [c.job_part_id, true]),
  );
  return (
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
        {rows.map((row) => (
          <TableRow key={row.job_part_id}>
            <TableCell>
              <Typography variant="body2" sx={{ fontWeight: 600 }}>
                {row.part_name}
              </Typography>
            </TableCell>
            <TableCell align="right">{row.qty_ordered}</TableCell>
            <TableCell align="right">{row.qty_shipped_prior}</TableCell>
            <TableCell align="right">{row.qty_remaining}</TableCell>
            <TableCell align="right">
              <TextField
                value={row.qty_input}
                onChange={(e) => patchLine(row.job_part_id, { qty_input: e.target.value })}
                size="small"
                inputProps={{
                  inputMode: 'decimal',
                  style: { textAlign: 'right' },
                }}
                error={Boolean(warnByPart.get(row.job_part_id))}
              />
            </TableCell>
          </TableRow>
        ))}
        {rows.length === 0 && (
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
  );
}

function renderCustomerLineGroups(
  groups: Array<{ job_number: string; customer_po_number: string | null; rows: LineRow[] }>,
  patchLine: (id: string, patch: Partial<LineRow>) => void,
) {
  if (groups.length === 0) {
    return (
      <Typography variant="body2" sx={{ color: 'text.secondary', py: 2 }}>
        No open lines match the current filter. Toggle "Ready to Ship only" off to see
        lines whose production is still in progress.
      </Typography>
    );
  }
  return (
    <Stack spacing={2}>
      {groups.map((group) => (
        <Box key={group.job_number}>
          <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 0.5 }}>
            <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
              Job {group.job_number}
            </Typography>
            {group.customer_po_number && (
              <Chip
                size="small"
                label={`PO ${group.customer_po_number}`}
                variant="outlined"
              />
            )}
          </Stack>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell padding="checkbox" />
                <TableCell>Part</TableCell>
                <TableCell align="right">Ordered</TableCell>
                <TableCell align="right">Shipped</TableCell>
                <TableCell align="right">Remaining</TableCell>
                <TableCell align="right" sx={{ width: 120 }}>Ship Now</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {group.rows.map((row) => {
                const disabled = row.qty_remaining === 0;
                return (
                  <TableRow key={row.job_part_id} hover>
                    <TableCell padding="checkbox">
                      <Checkbox
                        checked={row.selected && !disabled}
                        disabled={disabled}
                        onChange={(e) =>
                          patchLine(row.job_part_id, { selected: e.target.checked })
                        }
                      />
                    </TableCell>
                    <TableCell>
                      <Stack spacing={0}>
                        <Typography variant="body2" sx={{ fontWeight: 600 }}>
                          {row.part_name}
                        </Typography>
                        {disabled && (
                          <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                            Already shipped in full
                          </Typography>
                        )}
                      </Stack>
                    </TableCell>
                    <TableCell align="right">{row.qty_ordered}</TableCell>
                    <TableCell align="right">{row.qty_shipped_prior}</TableCell>
                    <TableCell align="right">{row.qty_remaining}</TableCell>
                    <TableCell align="right">
                      <TextField
                        value={row.qty_input}
                        onChange={(e) =>
                          patchLine(row.job_part_id, { qty_input: e.target.value })
                        }
                        size="small"
                        disabled={disabled || !row.selected}
                        inputProps={{
                          inputMode: 'decimal',
                          style: { textAlign: 'right' },
                        }}
                      />
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </Box>
      ))}
    </Stack>
  );
}
