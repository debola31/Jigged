'use client';

import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useState,
} from 'react';
import posthog from 'posthog-js';
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
  ShippingMethod,
} from '@/types/shipment';
import { CARRIER_OPTIONS, SHIPPING_METHOD_OPTIONS } from '@/types/shipment';
import {
  createShipment,
  getJobPartShipmentSummaries,
  getOpenJobPartsForCustomer,
} from '@/utils/shipmentsAccess';
import {
  lineShipConsequence,
  type ShipConsequence,
} from '@/components/shipments/shipmentMath';

/** UI-only carrier selection. 'other' reveals a free-text field whose value
 *  is what actually gets stored in shipments.carrier. */
type CarrierChoice = '' | (typeof CARRIER_OPTIONS)[number] | 'other';

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
  const [shippingMethod, setShippingMethod] = useState<ShippingMethod | ''>('');
  const [carrierChoice, setCarrierChoice] = useState<CarrierChoice>('');
  const [carrierOther, setCarrierOther] = useState('');

  const [lines, setLines] = useState<LineRow[]>([]);

  // Customer-mode UI state. Ignored in job mode.
  const [readyToShipOnly, setReadyToShipOnly] = useState(true);
  const [searchInput, setSearchInput] = useState('');
  const deferredSearch = useDeferredValue(searchInput);

  const isCustomerMode = source.kind === 'customer';

  // ---------- Initial load ----------
  // `loading` starts true (useState init), so the effect needs no synchronous
  // setLoading(true) here (which would trip react-hooks/set-state-in-effect);
  // every setState below runs inside the async IIFE, guarded by `cancelled`.
  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const supabase = getSupabase();

        // 1. Company defaults
        const { data: companyRow, error: companyErr } = await supabase
          .from('companies')
          .select(
            'id, name, logo_url, address_line1, address_line2, city, state, postal_code, country, phone, email, website, settings',
          )
          .eq('id', companyId)
          .single();
        // Clear any prior error only after the first await boundary so no
        // setState runs synchronously in the effect body. `loading` is true
        // throughout the load, so the error Alert isn't rendered meanwhile.
        if (!cancelled) setError(null);
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
              `id, name,
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
            // Customer mode: nothing checked by default — the shipping
            // clerk picks what they're actually boxing.
            selected: false,
          }));
        }

        if (cancelled) return;

        setCustomer(ctx);
        setCompany(companyRow as unknown as Company);
        setLines(initialLines);

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
    /** The single job being shipped (null when none, or >1 — a blocking error). */
    selectedJobId: string | null;
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

    // One packing slip belongs to exactly one job.
    const jobIds = Array.from(new Set(contributing.map((c) => c.row.job_id)));
    const selectedJobId = jobIds.length === 1 ? jobIds[0] : null;

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
    if (jobIds.length > 1) {
      blockingMessages.push(
        'A packing slip can only cover one job — deselect lines from the other job(s).',
      );
    }
    if (!shippingAddressId) {
      blockingMessages.push('Shipping address is required.');
    }
    if (shippingMethod === '') {
      blockingMessages.push('Select a shipping method.');
    }
    if (shippingMethod === 'shipment') {
      if (carrierChoice === '') {
        blockingMessages.push('Select a carrier for the shipment.');
      } else if (carrierChoice === 'other' && !carrierOther.trim()) {
        blockingMessages.push('Enter the carrier name.');
      }
    }

    return {
      contributing,
      selectedJobId,
      canSubmit: blockingMessages.length === 0,
      warnings,
      blockingMessages,
    };
  }, [lines, isCustomerMode, shippingAddressId, shippingMethod, carrierChoice, carrierOther]);

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

    // Carrier only applies to a true shipment; "Other" stores the typed name.
    const resolvedCarrier =
      shippingMethod === 'shipment'
        ? (carrierChoice === 'other' ? carrierOther.trim() : carrierChoice) || null
        : null;

    const payload: CreateShipmentPayload = {
      customer_id: customer.id,
      shipping_address_id: shippingAddressId,
      one_time_address: null,
      ship_date: shipDate || todayLocalISODate(),
      carrier: resolvedCarrier,
      shipping_method: shippingMethod === '' ? null : shippingMethod,
      line_items: validation.contributing.map((c) => ({
        job_part_id: c.job_part_id,
        quantity: c.quantity,
      })),
    };

    try {
      const result = await createShipment(companyId, payload);
      posthog.capture('shipment_created', {
        line_item_count: payload.line_items.length,
        shipping_method: payload.shipping_method,
      });
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
    customer, validation, shippingAddressId, shipDate, carrierChoice, carrierOther,
    shippingMethod, companyId, onCreated,
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

      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} alignItems="flex-start">
        <FormControl fullWidth required>
          <InputLabel id="shipping-method-label">Shipping Method</InputLabel>
          <Select
            labelId="shipping-method-label"
            label="Shipping Method"
            value={shippingMethod}
            onChange={(e) => {
              const next = e.target.value as ShippingMethod | '';
              setShippingMethod(next);
              // Carrier only applies to a true shipment — clear it otherwise.
              if (next !== 'shipment') {
                setCarrierChoice('');
                setCarrierOther('');
              }
            }}
          >
            <MenuItem value="">
              <em>Select…</em>
            </MenuItem>
            {SHIPPING_METHOD_OPTIONS.map((opt) => (
              <MenuItem key={opt.value} value={opt.value}>{opt.label}</MenuItem>
            ))}
          </Select>
        </FormControl>
        {shippingMethod === 'shipment' && (
          <FormControl fullWidth required>
            <InputLabel id="carrier-label">Carrier</InputLabel>
            <Select
              labelId="carrier-label"
              label="Carrier"
              value={carrierChoice}
              onChange={(e) => setCarrierChoice(e.target.value as CarrierChoice)}
            >
              <MenuItem value="">
                <em>Select…</em>
              </MenuItem>
              {CARRIER_OPTIONS.map((c) => (
                <MenuItem key={c} value={c}>{c}</MenuItem>
              ))}
              <MenuItem value="other">Other</MenuItem>
            </Select>
          </FormControl>
        )}
        {shippingMethod === 'shipment' && carrierChoice === 'other' && (
          <TextField
            label="Carrier name"
            value={carrierOther}
            onChange={(e) => setCarrierOther(e.target.value)}
            fullWidth
          />
        )}
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

        {isCustomerMode && (
          <Typography variant="body2" sx={{ color: 'text.secondary', mb: 1 }}>
            One packing slip per job — selecting a line locks the slip to that job.
          </Typography>
        )}

        {isCustomerMode
          ? renderCustomerLineGroups(linesByJob ?? [], patchLine, validation.selectedJobId)
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
          Note: company profile could not be loaded; the packing-slip header may be blank.
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
          <TableCell align="right" sx={{ width: 230 }}>Ship Now</TableCell>
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
            {/* Caption sits inline to the left of the input on one line, so the row
                stays a single line tall and the input stays vertically centered with
                the numeric cells. */}
            <TableCell align="right">
              <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 1 }}>
                <ConsequenceCaption qtyInput={row.qty_input} qtyRemaining={row.qty_remaining} />
                <TextField
                  value={row.qty_input}
                  onChange={(e) => patchLine(row.job_part_id, { qty_input: e.target.value })}
                  size="small"
                  inputProps={{
                    inputMode: 'decimal',
                    style: { textAlign: 'right' },
                  }}
                  error={Boolean(warnByPart.get(row.job_part_id))}
                  sx={{ width: 90, flexShrink: 0 }}
                />
              </Box>
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
  selectedJobId: string | null,
) {
  if (groups.length === 0) {
    return (
      <Typography variant="body2" sx={{ color: 'text.secondary', py: 2 }}>
        No open lines match the current filter. Toggle &quot;Ready to Ship only&quot; off to see
        lines whose production is still in progress.
      </Typography>
    );
  }
  return (
    <Stack spacing={2}>
      {groups.map((group) => {
        const groupJobId = group.rows[0]?.job_id ?? null;
        // One slip per job: once a job is selected, lines from other jobs
        // are locked out until the selection is cleared.
        const lockedOut = selectedJobId !== null && groupJobId !== selectedJobId;
        return (
          <Box key={group.job_number} sx={{ opacity: lockedOut ? 0.5 : 1 }}>
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
              {lockedOut && (
                <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                  Locked — another job is selected
                </Typography>
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
                  <TableCell align="right" sx={{ width: 230 }}>Ship Now</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {group.rows.map((row) => {
                  const fullyShipped = row.qty_remaining === 0;
                  const rowDisabled = fullyShipped || lockedOut;
                  return (
                    <TableRow key={row.job_part_id} hover>
                      <TableCell padding="checkbox">
                        <Checkbox
                          checked={row.selected && !fullyShipped}
                          disabled={rowDisabled}
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
                          {fullyShipped && (
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
                        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 1 }}>
                          {row.selected && !rowDisabled && (
                            <ConsequenceCaption
                              qtyInput={row.qty_input}
                              qtyRemaining={row.qty_remaining}
                            />
                          )}
                          <TextField
                            value={row.qty_input}
                            onChange={(e) =>
                              patchLine(row.job_part_id, { qty_input: e.target.value })
                            }
                            size="small"
                            disabled={rowDisabled || !row.selected}
                            inputProps={{
                              inputMode: 'decimal',
                              style: { textAlign: 'right' },
                            }}
                            sx={{ width: 90, flexShrink: 0 }}
                          />
                        </Box>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </Box>
        );
      })}
    </Stack>
  );
}

/**
 * Small caption translating a line's Ship-Now quantity into its plain-language
 * consequence + colour. This is what stops the pre-filled "full remaining"
 * default from silently closing a line: a full count reads "Completes this line",
 * a short count reads "N will remain owed", an over-count reads "Over-ships by N".
 * Rendered inline to the LEFT of the input (single line, never wrapping) so the row
 * stays one line tall and the input stays vertically centred with the numeric cells.
 */
function ConsequenceCaption({
  qtyInput,
  qtyRemaining,
}: {
  qtyInput: string;
  qtyRemaining: number;
}) {
  const display = consequenceDisplay(lineShipConsequence(qtyInput, qtyRemaining));
  if (!display) return null;
  return (
    <Typography
      variant="caption"
      sx={{ color: display.color, lineHeight: 1.2, whiteSpace: 'nowrap' }}
    >
      {display.text}
    </Typography>
  );
}

function consequenceDisplay(
  c: ShipConsequence,
): { text: string; color: string } | null {
  switch (c.kind) {
    case 'none':
      return { text: 'Not shipping', color: 'text.disabled' };
    case 'full':
      return { text: 'Completes this line', color: 'success.main' };
    case 'partial':
      return { text: `${c.leftover} will remain owed`, color: 'warning.main' };
    case 'over':
      return { text: `Over-ships by ${c.excess}`, color: 'error.main' };
  }
}
