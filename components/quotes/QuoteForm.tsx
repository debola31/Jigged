'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useRouter, useParams } from 'next/navigation';
import NextLink from 'next/link';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import TextField from '@mui/material/TextField';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import Alert from '@mui/material/Alert';
import CircularProgress from '@mui/material/CircularProgress';
import Grid from '@mui/material/Grid';
import Autocomplete from '@mui/material/Autocomplete';
import Divider from '@mui/material/Divider';
import IconButton from '@mui/material/IconButton';
import Chip from '@mui/material/Chip';
import Link from '@mui/material/Link';
import Tooltip from '@mui/material/Tooltip';
import FormControlLabel from '@mui/material/FormControlLabel';
import Checkbox from '@mui/material/Checkbox';
import Select from '@mui/material/Select';
import MenuItem from '@mui/material/MenuItem';
import FormControl from '@mui/material/FormControl';
import InputLabel from '@mui/material/InputLabel';
import AddIcon from '@mui/icons-material/Add';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';

import type { QuoteFormData } from '@/types/quote';
import {
  createQuote,
  updateQuote,
  detectQuoteLineDrift,
  type QuoteLineDriftInfo,
} from '@/utils/quotesAccess';
import { getPartsForSelectByIds } from '@/utils/partsAccess';
import {
  getAllCustomers,
  pickBillingAddress,
  pickShippingAddress,
  pickPrimaryContact,
} from '@/utils/customerAccess';
import { getTiersWithComputedPrices } from '@/utils/partPricingTiersAccess';
import { resolveTier } from '@/utils/quotePricingResolver';
import type { ComputedPartPricingTier } from '@/types/partPricing';
import CustomerFormModal from '@/components/customers/CustomerFormModal';
import PartFormModal from '@/components/parts/PartFormModal';
import PartAutocomplete, { type PartSelectOption } from '@/components/parts/PartAutocomplete';
import type {
  Customer,
  CustomerAddress,
  CustomerListContact,
  CustomerWithRelations,
} from '@/types/customer';

interface QuoteFormProps {
  mode: 'create' | 'edit';
  initialData: QuoteFormData;
  quoteId?: string;
  onCancel?: () => void;
  onSave?: () => void;
}

interface CustomerOption {
  id: string;
  name: string;
  isCreateNew?: boolean;
}

/**
 * One quoted quantity within a part block. A block with a single row is a firm
 * line; a block with several rows is a price-options menu for that part. Each
 * row carries (on edit) its own line item id + drift state, because each
 * (part, quantity) is an independent quote_line_items row. The custom-price
 * override is part-level (see PartBlockState), not per row.
 */
interface QtyRowState {
  /** Stable React key for the row (mirrors RoutingOperationsList temp ids). */
  rowKey: string;
  /** Working-copy string so the input can be empty mid-edit. */
  quantity: string;
  /** Set on edit-mode rows; absent on newly-added or create-mode rows. */
  line_item_id?: string;
  /** Pre-snapshot Option C — renders the "basis unknown" chip. */
  basis_unknown?: boolean;
}

interface PartBlockState {
  part: PartSelectOption | null;
  /** One row per quoted quantity; always at least one row. */
  rows: QtyRowState[];
  /**
   * Part-level custom price. When open, the typed unit price applies to
   * EVERY quantity row of this part (bypassing tier resolution) and is
   * written as an override onto each resulting line item.
   */
  override_open: boolean;
  override_unit_price: string;
  tiers: ComputedPartPricingTier[];
  loading: boolean;
  error: string | null;
}

const CREATE_NEW_CUSTOMER: CustomerOption = {
  id: '__create_new__',
  name: 'Create New Customer',
  isCreateNew: true,
};

/** Sentinel option IDs for "add new" actions inside the dropdowns. */
const ADD_NEW_CONTACT_ID = '__add_new_contact__';
const ADD_NEW_ADDRESS_ID = '__add_new_address__';

function formatCurrency(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value);
}

const newRowKey = () => `temp-qty-${crypto.randomUUID()}`;

function emptyRow(): QtyRowState {
  return {
    rowKey: newRowKey(),
    quantity: '',
  };
}

function emptyBlock(): PartBlockState {
  return {
    part: null,
    rows: [emptyRow()],
    override_open: false,
    override_unit_price: '',
    tiers: [],
    loading: false,
    error: null,
  };
}

function rowFromInitial(p: QuoteFormData['parts'][number]): QtyRowState {
  return {
    rowKey: newRowKey(),
    quantity: String(p.order_quantity),
    line_item_id: p.line_item_id,
    basis_unknown: p.basis_unknown,
  };
}

/**
 * Group the flat form payload (one entry per (part, quantity)) into one block
 * per part, preserving first-seen order, with one quantity row per entry. The
 * part is a stub carrying only the id; loadData replaces it with the hydrated
 * option (the form renders a spinner until then, so the stub is never shown).
 *
 * The custom-price override is part-level: if any entry carries an override,
 * the whole part is treated as overridden at that unit price (on save every
 * entry for the part is written with the same override).
 */
function groupPartsIntoBlocks(parts: QuoteFormData['parts']): PartBlockState[] {
  const blocks: PartBlockState[] = [];
  const indexByPart = new Map<string, number>();
  for (const p of parts) {
    let idx = indexByPart.get(p.part_id);
    if (idx === undefined) {
      idx = blocks.length;
      indexByPart.set(p.part_id, idx);
      blocks.push({
        part: { id: p.part_id } as PartSelectOption,
        rows: [],
        override_open: false,
        override_unit_price: '',
        tiers: [],
        loading: false,
        error: null,
      });
    }
    if (p.override && !blocks[idx].override_open) {
      blocks[idx].override_open = true;
      blocks[idx].override_unit_price = String(p.override.unit_price);
    }
    blocks[idx].rows.push(rowFromInitial(p));
  }
  return blocks;
}

export default function QuoteForm({ mode, initialData, quoteId, onCancel, onSave }: QuoteFormProps) {
  const router = useRouter();
  const params = useParams();
  const companyId = params.companyId as string;

  const [formData, setFormData] = useState<QuoteFormData>(initialData);
  const [partBlocks, setPartBlocks] = useState<PartBlockState[]>(() =>
    groupPartsIntoBlocks(initialData.parts),
  );

  const [customers, setCustomers] = useState<CustomerOption[]>([]);
  // Full customer rows (with addresses + contacts) keyed by id so the
  // customer-change handler can resolve address/contact defaults without
  // refetching. Source: getAllCustomers — already loaded for the dropdown.
  const [customersById, setCustomersById] = useState<Map<string, CustomerWithRelations>>(
    () => new Map(),
  );
  // Shipping address is the primary section because it's what the quote
  // PDF actually renders. Billing address is captured for the future
  // invoicing flow but de-emphasized into a disclosure that opens when
  // billing differs from shipping. Initial state: ON when billing address
  // equals shipping address (Customer Contact is independent of either).
  const [billingSameAsShipping, setBillingSameAsShipping] = useState<boolean>(
    () => initialData.billing_address_id === initialData.shipping_address_id,
  );
  const [loading, setLoading] = useState(false);
  const [loadingData, setLoadingData] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [customerModalOpen, setCustomerModalOpen] = useState(false);
  const [partModalOpen, setPartModalOpen] = useState(false);
  const [partModalTargetIdx, setPartModalTargetIdx] = useState<number | null>(null);

  // Drift state (edit mode only):
  //   - driftByLineId: server-detected drift map for the lines currently
  //     in the DB. Lines the user has since removed in the form remain in
  //     this map but are simply ignored (the matching block is gone).
  //   - acceptedDriftIds: lines the user explicitly opted in to reprice
  //     via the per-line or "Update all" controls. These ids flow into
  //     updateQuote's options on submit. Untouched drifted lines never
  //     enter this set, so they keep their snapshot on save.
  const [driftByLineId, setDriftByLineId] = useState<Map<string, QuoteLineDriftInfo>>(
    () => new Map(),
  );
  const [acceptedDriftIds, setAcceptedDriftIds] = useState<Set<string>>(() => new Set());

  const loadData = useCallback(async () => {
    try {
      setLoadingData(true);
      // Dedupe ids — a price-options quote repeats a part_id across rows.
      const initialPartIds = Array.from(
        new Set(initialData.parts.map((p) => p.part_id).filter(Boolean)),
      );
      const [customersData, hydratedParts] = await Promise.all([
        getAllCustomers(companyId),
        initialPartIds.length > 0
          ? getPartsForSelectByIds(initialPartIds)
          : Promise.resolve([]),
      ]);
      setCustomers([
        CREATE_NEW_CUSTOMER,
        ...customersData.map((c) => ({ id: c.id, name: c.name })),
      ]);
      setCustomersById(new Map(customersData.map((c) => [c.id, c])));
      if (hydratedParts.length > 0) {
        const byId = new Map(hydratedParts.map((p) => [p.id, p]));
        // Replace each block's stub part (carrying only the id) with the
        // hydrated option, matched by part_id (blocks no longer align by
        // index with the flat initialData.parts payload).
        setPartBlocks((prev) =>
          prev.map((block) => {
            const partId = block.part?.id;
            const hydrated = partId ? byId.get(partId) : undefined;
            return hydrated ? { ...block, part: hydrated } : block;
          }),
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load data');
    } finally {
      setLoadingData(false);
    }
  }, [companyId, initialData.parts]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Edit-mode only: detect drift once on mount. The result is keyed by
  // line item id so each block can decide whether to render the chip.
  // Failures here are logged but non-fatal — the form should still load
  // (drift detection is an enhancement on top of the basic edit path).
  useEffect(() => {
    if (mode !== 'edit' || !quoteId) return;
    let cancelled = false;
    detectQuoteLineDrift(quoteId)
      .then((rows) => {
        if (cancelled) return;
        const m = new Map<string, QuoteLineDriftInfo>();
        for (const r of rows) m.set(r.line_item_id, r);
        setDriftByLineId(m);
      })
      .catch((err) => console.warn('Drift detection failed:', err));
    return () => {
      cancelled = true;
    };
  }, [mode, quoteId]);

  // Load tiers for one block. Shared by the effect (newly-added block) and
  // updatePartInBlock (re-select of the same part wipes the previous tiers,
  // and the effect's id-string dep doesn't change so it won't refire).
  const loadTiersForBlock = useCallback(async (idx: number, partId: string) => {
    setPartBlocks((prev) => {
      const next = [...prev];
      if (!next[idx]) return prev;
      next[idx] = { ...next[idx], loading: true, error: null };
      return next;
    });
    try {
      const tiers = await getTiersWithComputedPrices(partId);
      setPartBlocks((prev) => {
        const next = [...prev];
        if (next[idx] && next[idx].part?.id === partId) {
          next[idx] = { ...next[idx], tiers, loading: false };
        }
        return next;
      });
    } catch (err) {
      setPartBlocks((prev) => {
        const next = [...prev];
        if (next[idx] && next[idx].part?.id === partId) {
          next[idx] = {
            ...next[idx],
            loading: false,
            error: err instanceof Error ? err.message : 'Failed to load tiers',
          };
        }
        return next;
      });
    }
  }, []);

  // Load tiers for each part block when its part_id changes.
  useEffect(() => {
    partBlocks.forEach((block, idx) => {
      const partId = block.part?.id;
      if (partId && block.tiers.length === 0 && !block.loading && !block.error) {
        loadTiersForBlock(idx, partId);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [partBlocks.length, partBlocks.map((b) => b.part?.id ?? '').join(',')]);

  const handleFieldChange = (field: keyof QuoteFormData, value: string | QuoteFormData['parts']) => {
    setFormData((prev) => ({ ...prev, [field]: value } as QuoteFormData));
  };

  /**
   * Customer change clears the previous customer's address/contact FKs
   * (they belong to a different customer and would be rejected by the
   * integrity trigger) and pre-populates defaults from the new customer:
   *   - contact_id          → primary contact
   *   - shipping_address_id → default_shipping (falls back to default_billing)
   *   - billing_address_id  → default_billing
   *
   * "Billing same as shipping" goes ON when the resolved billing equals
   * the resolved shipping address. Common case (single default address)
   * → ON, disclosure hidden. Customers with separate billing/shipping
   * defaults → OFF, billing disclosure visible.
   */
  const handleCustomerChange = (customerId: string) => {
    if (!customerId) {
      setFormData((prev) => ({
        ...prev,
        customer_id: '',
        contact_id: '',
        billing_address_id: '',
        shipping_address_id: '',
      }));
      setBillingSameAsShipping(true);
      return;
    }
    if (customerId === formData.customer_id) return;

    const customer = customersById.get(customerId);
    const billing = customer ? pickBillingAddress(customer) : null;
    const shipping = customer ? pickShippingAddress(customer) : null;
    const primary = customer ? pickPrimaryContact(customer.customer_contacts) : null;

    const billingId = billing?.id ?? '';
    const shippingId = shipping?.id ?? '';
    const contactId = primary?.id ?? '';

    const sameAsShipping = billingId === shippingId;

    setBillingSameAsShipping(sameAsShipping);
    setFormData((prev) => ({
      ...prev,
      customer_id: customerId,
      contact_id: contactId,
      shipping_address_id: shippingId,
      billing_address_id: sameAsShipping ? shippingId : billingId,
    }));
  };

  /**
   * When the user changes the shipping address while "billing same as
   * shipping" is on, mirror the change into the hidden billing FK so
   * the two stay in sync without the user touching the disclosure.
   */
  const handleShippingAddressChange = (newId: string) => {
    setFormData((prev) => ({
      ...prev,
      shipping_address_id: newId,
      ...(billingSameAsShipping ? { billing_address_id: newId } : {}),
    }));
  };

  /**
   * Toggling "billing same as shipping".
   * ON  → sync billing_address_id → shipping_address_id immediately.
   * OFF → leave billing where it is; user opens the disclosure to pick.
   */
  const handleBillingSameToggle = (next: boolean) => {
    setBillingSameAsShipping(next);
    if (next) {
      setFormData((prev) => ({
        ...prev,
        billing_address_id: prev.shipping_address_id,
      }));
    }
  };

  /** Addresses + contacts for the currently-selected customer (or empty). */
  const selectedCustomer = formData.customer_id
    ? customersById.get(formData.customer_id) ?? null
    : null;
  const customerAddresses: CustomerAddress[] = selectedCustomer?.addresses ?? [];
  const customerContacts: CustomerListContact[] = selectedCustomer?.customer_contacts ?? [];

  /**
   * Multi-line address display used in both the Select's renderValue
   * (closed state) and each MenuItem (open state). Surfaces ATTN: when
   * the address carries an attention_to, then address_line1, optional
   * address_line2, then city/state/zip on one line.
   *
   * Uses body1 (primary white) so the addresses match the brightness of
   * the Customer / Contact field values. body2 in the project theme is
   * a muted grey, which makes the address look secondary even though it
   * carries primary information.
   */
  const AddressLines = ({ address }: { address: CustomerAddress }) => {
    const cityStateZip = [address.city, address.state].filter(Boolean).join(', ');
    const cityStateZipFull = [cityStateZip, address.postal_code]
      .filter(Boolean)
      .join(' ')
      .trim();
    return (
      <Box>
        {address.attention_to && (
          <Typography variant="body1" sx={{ fontWeight: 500 }}>
            ATTN: {address.attention_to}
          </Typography>
        )}
        {address.address_line1 && (
          <Typography variant="body1">{address.address_line1}</Typography>
        )}
        {address.address_line2 && (
          <Typography variant="body1">{address.address_line2}</Typography>
        )}
        {cityStateZipFull && (
          <Typography variant="body1">{cityStateZipFull}</Typography>
        )}
      </Box>
    );
  };

  const renderAddressValue = (value: unknown) => {
    const a = customerAddresses.find((x) => x.id === value);
    return a ? <AddressLines address={a} /> : '';
  };

  const customerDetailHref = `/dashboard/${companyId}/customers/${formData.customer_id}`;

  const addPartBlock = () => {
    setPartBlocks((prev) => [...prev, emptyBlock()]);
  };

  const removePartBlock = (idx: number) => {
    setPartBlocks((prev) => {
      const removed = prev[idx];
      // Drop any accept-drift selections referencing this part's rows — the
      // user removed the whole part, so those per-line opt-ins are moot.
      const ids = (removed?.rows ?? [])
        .map((r) => r.line_item_id)
        .filter((id): id is string => !!id);
      if (ids.length > 0) {
        setAcceptedDriftIds((cur) => {
          if (!ids.some((id) => cur.has(id))) return cur;
          const next = new Set(cur);
          for (const id of ids) next.delete(id);
          return next;
        });
      }
      return prev.filter((_, i) => i !== idx);
    });
  };

  const updatePartInBlock = (idx: number, option: PartSelectOption | null) => {
    setPartBlocks((prev) => {
      const next = [...prev];
      // Re-selecting a part on an existing block means the user wants a
      // different part there — drop the line_item_id correlations and any
      // accept-drift selections so reconcile treats every row as new.
      const previous = next[idx];
      const ids = (previous?.rows ?? [])
        .map((r) => r.line_item_id)
        .filter((id): id is string => !!id);
      if (ids.length > 0) {
        setAcceptedDriftIds((cur) => {
          if (!ids.some((id) => cur.has(id))) return cur;
          const nextIds = new Set(cur);
          for (const id of ids) nextIds.delete(id);
          return nextIds;
        });
      }
      next[idx] = { ...emptyBlock(), part: option };
      return next;
    });
    // Re-selecting the same part wipes tiers above, but the load-tiers effect
    // keys off the part-ids string — which doesn't change when the id is the
    // same. Trigger the fetch directly so the block reloads either way.
    if (option) {
      loadTiersForBlock(idx, option.id);
    }
  };

  const openCreatePartModalForBlock = (idx: number) => {
    setPartModalTargetIdx(idx);
    setPartModalOpen(true);
  };

  const addRow = (blockIdx: number) => {
    setPartBlocks((prev) => {
      const block = prev[blockIdx];
      if (!block) return prev;
      const next = [...prev];
      next[blockIdx] = { ...block, rows: [...block.rows, emptyRow()] };
      return next;
    });
  };

  const removeRow = (blockIdx: number, rowIdx: number) => {
    setPartBlocks((prev) => {
      const block = prev[blockIdx];
      if (!block || block.rows.length <= 1) return prev;
      const removed = block.rows[rowIdx];
      if (removed?.line_item_id) {
        setAcceptedDriftIds((cur) => {
          if (!cur.has(removed.line_item_id!)) return cur;
          const nextIds = new Set(cur);
          nextIds.delete(removed.line_item_id!);
          return nextIds;
        });
      }
      const next = [...prev];
      next[blockIdx] = { ...block, rows: block.rows.filter((_, i) => i !== rowIdx) };
      return next;
    });
  };

  const updateRow = (
    blockIdx: number,
    rowIdx: number,
    patch: Partial<QtyRowState> | ((prev: QtyRowState) => Partial<QtyRowState>),
  ) => {
    setPartBlocks((prev) => {
      const block = prev[blockIdx];
      if (!block) return prev;
      const current = block.rows[rowIdx];
      if (!current) return prev;
      const delta = typeof patch === 'function' ? patch(current) : patch;
      const rows = [...block.rows];
      rows[rowIdx] = { ...current, ...delta };
      const next = [...prev];
      next[blockIdx] = { ...block, rows };
      return next;
    });
  };

  /** Patch block-level fields (the part-level custom-price override). */
  const updateBlock = (
    blockIdx: number,
    patch: Partial<PartBlockState> | ((prev: PartBlockState) => Partial<PartBlockState>),
  ) => {
    setPartBlocks((prev) => {
      const block = prev[blockIdx];
      if (!block) return prev;
      const delta = typeof patch === 'function' ? patch(block) : patch;
      const next = [...prev];
      next[blockIdx] = { ...block, ...delta };
      return next;
    });
  };

  const handleCustomerCreated = (customer: Customer) => {
    setCustomers((prev) => [
      CREATE_NEW_CUSTOMER,
      ...prev.filter((c) => !c.isCreateNew),
      { id: customer.id, name: customer.name },
    ]);
    // The new customer has no addresses or contacts yet; insert a blank
    // CustomerWithRelations shell so handleCustomerChange's lookup hits
    // and clears the previous customer's FKs. The salesperson will add
    // address + contacts on the customer page before the quote prints.
    setCustomersById((prev) => {
      const next = new Map(prev);
      next.set(customer.id, {
        ...customer,
        addresses: [],
        customer_contacts: [],
        primary_contact: null,
        quotes_count: 0,
        jobs_count: 0,
      });
      return next;
    });
    handleCustomerChange(customer.id);
    setCustomerModalOpen(false);
  };

  const handlePartCreated = async (part: { id: string }) => {
    const idx = partModalTargetIdx;
    setPartModalOpen(false);
    setPartModalTargetIdx(null);
    if (idx === null) return;
    try {
      const [hydrated] = await getPartsForSelectByIds([part.id]);
      if (!hydrated) return;
      setPartBlocks((prev) => {
        const next = [...prev];
        next[idx] = { ...emptyBlock(), part: hydrated };
        return next;
      });
    } catch (err) {
      console.error('Failed to hydrate created part:', err);
    }
  };

  /** Per-row live preview of the resolved tier + total: blockPreviews[block][row].
   *  A part-level custom price (block.override_*) applies to every row. */
  const blockPreviews = useMemo(() => {
    return partBlocks.map((block) => {
      const overridePrice =
        block.override_open && block.override_unit_price.trim() !== ''
          ? Number(block.override_unit_price)
          : null;
      const overrideValid =
        overridePrice !== null && Number.isFinite(overridePrice) && overridePrice >= 0;
      return block.rows.map((row) => {
        const orderQty = Number(row.quantity);
        if (!Number.isFinite(orderQty) || orderQty <= 0) {
          return {
            resolved: null as ReturnType<typeof resolveTier>,
            total: null as number | null,
          };
        }
        if (overrideValid) {
          return {
            resolved: null as ReturnType<typeof resolveTier>,
            total: Math.round((overridePrice as number) * orderQty * 100) / 100,
          };
        }
        const resolved = resolveTier(block.tiers, orderQty);
        return {
          resolved,
          total: resolved ? Math.round(resolved.unit_price * orderQty * 100) / 100 : null,
        };
      });
    });
  }, [partBlocks]);

  /**
   * Firm order = every part has exactly one quantity → show a grand total.
   * Any part with 2+ quantities makes this a price-options quote (no total).
   */
  const isFirmQuote = useMemo(
    () => partBlocks.length > 0 && partBlocks.every((b) => b.rows.length === 1),
    [partBlocks],
  );

  /** Grand total (firm quotes only) = sum of every row with a computable total. */
  const quoteTotal = useMemo(() => {
    let sum = 0;
    let allComputable = true;
    partBlocks.forEach((block, bIdx) => {
      if (!block.part) {
        allComputable = false;
        return;
      }
      block.rows.forEach((_row, rIdx) => {
        const total = blockPreviews[bIdx]?.[rIdx]?.total;
        if (total === null || total === undefined) {
          allComputable = false;
        } else {
          sum += total;
        }
      });
    });
    return { sum: Math.round(sum * 100) / 100, allComputable };
  }, [partBlocks, blockPreviews]);

  /**
   * First reason the form is not submittable, or null when valid.
   * Drives the disabled state of the Create/Save button instead of inline error alerts.
   */
  const validationError = useMemo<string | null>(() => {
    if (!formData.customer_id) return 'Pick a customer.';
    if (partBlocks.length === 0) return 'Add at least one part to the quote.';
    const leadRaw = formData.lead_time_days;
    const leadNum = Number(leadRaw);
    if (
      leadRaw === '' ||
      !Number.isFinite(leadNum) ||
      leadNum < 0 ||
      !Number.isInteger(leadNum)
    ) {
      return 'Enter a lead time (whole number of days).';
    }
    const seenParts = new Set<string>();
    for (const block of partBlocks) {
      if (!block.part) return 'Every part block must have a part selected.';
      // A part lives in ONE block; multiple quantities are rows within it.
      if (seenParts.has(block.part.id)) {
        return 'A part can only appear in one block — add its quantities as rows in a single block.';
      }
      seenParts.add(block.part.id);
      if (block.loading) return 'Loading pricing tiers…';
      if (block.rows.length === 0) return 'Every part needs at least one quantity.';
      // Part-level custom price: validate once; when active it covers every row.
      if (block.override_open) {
        const overridePrice = Number(block.override_unit_price);
        if (
          block.override_unit_price.trim() === '' ||
          !Number.isFinite(overridePrice) ||
          overridePrice < 0
        ) {
          return 'Custom unit price must be a non-negative number.';
        }
      }
      const seenQty = new Set<number>();
      for (const row of block.rows) {
        const orderQty = Number(row.quantity);
        if (!Number.isFinite(orderQty) || orderQty <= 0) {
          return 'Every quantity must be greater than zero.';
        }
        if (!Number.isInteger(orderQty)) return 'Quantity must be a whole number.';
        if (seenQty.has(orderQty)) return 'Each quantity can appear only once per part.';
        seenQty.add(orderQty);
        if (!block.override_open) {
          const resolved = resolveTier(block.tiers, orderQty);
          if (!resolved) {
            return 'At least one part has no priced tiers — add tiers on the part page or use a custom price.';
          }
        }
      }
    }
    return null;
  }, [formData, partBlocks]);

  const handleSubmit = async () => {
    if (validationError) return;
    setError(null);

    const payload: QuoteFormData = {
      ...formData,
      parts: partBlocks.flatMap((b) => {
        const overrideActive = b.override_open && b.override_unit_price.trim() !== '';
        const overrideUnitPrice = overrideActive ? Number(b.override_unit_price) : null;
        return b.rows.map((r) => {
          const orderQty = Number(r.quantity);
          const entry: QuoteFormData['parts'][number] = {
            part_id: b.part?.id ?? '',
            order_quantity: orderQty,
          };
          if (r.line_item_id) entry.line_item_id = r.line_item_id;
          if (r.basis_unknown) entry.basis_unknown = r.basis_unknown;
          if (overrideUnitPrice !== null) {
            // Part-level custom price → same override on every row of the part.
            entry.override = {
              unit_price: overrideUnitPrice,
              // Markup % is no longer a quote-form input — leave it null on overrides.
              markup_percent: null,
            };
          }
          return entry;
        });
      }),
    };

    setLoading(true);
    try {
      if (mode === 'create') {
        const { quote } = await createQuote(companyId, payload);
        onSave?.();
        router.push(`/dashboard/${companyId}/quotes/${quote.id}`);
      } else if (mode === 'edit' && quoteId) {
        await updateQuote(quoteId, payload, {
          acceptDriftLineItemIds: Array.from(acceptedDriftIds),
        });
        onSave?.();
        router.push(`/dashboard/${companyId}/quotes/${quoteId}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save quote');
    } finally {
      setLoading(false);
    }
  };

  const handleCancel = () => {
    if (onCancel) onCancel();
    else router.back();
  };

  if (loadingData) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: 300 }}>
        <CircularProgress />
      </Box>
    );
  }

  return (
    <Box sx={{ pb: 12 }}>
      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      <Card elevation={2} sx={{ mb: 3 }}>
        <CardContent>
          <Typography variant="h6" sx={{ mb: 2 }}>
            Customer
          </Typography>
          <Autocomplete
            size="small"
            options={customers}
            getOptionLabel={(o) => o.name}
            value={customers.find((c) => c.id === formData.customer_id) ?? null}
            onChange={(_, v) => {
              if (v?.isCreateNew) {
                setCustomerModalOpen(true);
                return;
              }
              handleCustomerChange(v?.id ?? '');
            }}
            renderInput={(params) => <TextField {...params} label="Customer" required />}
          />

          {/* Customer contact + Shipping address + Billing address.
              Hidden until a customer is picked. */}
          {formData.customer_id && (
            <Box sx={{ mt: 3 }}>
              <Grid container spacing={2}>
                <Grid size={{ xs: 12, md: 6 }}>
                  <Autocomplete
                    size="small"
                    options={[
                      ...customerContacts,
                      // Sentinel "+ Add new contact" appears at the bottom
                      // of the dropdown. Selecting it navigates to the
                      // customer detail page instead of setting the FK.
                      {
                        id: ADD_NEW_CONTACT_ID,
                        name: '+ Add new contact',
                        role: 'other',
                        email: null,
                        phone: null,
                        is_primary: false,
                      } as CustomerListContact,
                    ]}
                    getOptionLabel={(c) => c.name}
                    value={
                      customerContacts.find((c) => c.id === formData.contact_id) ?? null
                    }
                    onChange={(_, v) => {
                      if (v?.id === ADD_NEW_CONTACT_ID) {
                        router.push(customerDetailHref);
                        return;
                      }
                      handleFieldChange('contact_id', v?.id ?? '');
                    }}
                    isOptionEqualToValue={(o, v) => o.id === v.id}
                    renderOption={(props, option) => (
                      <li
                        {...props}
                        style={
                          option.id === ADD_NEW_CONTACT_ID
                            ? { fontStyle: 'italic' }
                            : undefined
                        }
                      >
                        {option.name}
                      </li>
                    )}
                    renderInput={(params) => (
                      <TextField {...params} label="Contact" />
                    )}
                  />
                </Grid>
                <Grid size={{ xs: 12, md: 6 }}>
                  <FormControl fullWidth size="small">
                    <InputLabel id="shipping-address-label">Shipping address</InputLabel>
                    <Select
                      labelId="shipping-address-label"
                      label="Shipping address"
                      value={formData.shipping_address_id}
                      onChange={(e) => {
                        if (e.target.value === ADD_NEW_ADDRESS_ID) {
                          router.push(customerDetailHref);
                          return;
                        }
                        handleShippingAddressChange(e.target.value);
                      }}
                      renderValue={renderAddressValue}
                      sx={{
                        '& .MuiSelect-select': { whiteSpace: 'normal', py: 1 },
                      }}
                    >
                      {customerAddresses.map((a) => (
                        <MenuItem key={a.id} value={a.id} sx={{ whiteSpace: 'normal' }}>
                          <AddressLines address={a} />
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
                    checked={billingSameAsShipping}
                    onChange={(e) => handleBillingSameToggle(e.target.checked)}
                  />
                }
                label={
                  <Typography variant="body2" color="text.secondary">
                    Billing address same as shipping
                  </Typography>
                }
              />

              {!billingSameAsShipping && (
                <Box sx={{ mt: 1, pl: 4 }}>
                  <FormControl fullWidth size="small">
                    <InputLabel id="billing-address-label">Billing address</InputLabel>
                    <Select
                      labelId="billing-address-label"
                      label="Billing address"
                      value={formData.billing_address_id}
                      onChange={(e) => {
                        if (e.target.value === ADD_NEW_ADDRESS_ID) {
                          router.push(customerDetailHref);
                          return;
                        }
                        handleFieldChange('billing_address_id', e.target.value);
                      }}
                      renderValue={renderAddressValue}
                      sx={{
                        '& .MuiSelect-select': { whiteSpace: 'normal', py: 1 },
                      }}
                    >
                      {customerAddresses.map((a) => (
                        <MenuItem key={a.id} value={a.id} sx={{ whiteSpace: 'normal' }}>
                          <AddressLines address={a} />
                        </MenuItem>
                      ))}
                      <MenuItem value={ADD_NEW_ADDRESS_ID} sx={{ fontStyle: 'italic' }}>
                        + Add new address
                      </MenuItem>
                    </Select>
                  </FormControl>
                </Box>
              )}
            </Box>
          )}
        </CardContent>
      </Card>

      {/* Parts */}
      <Card elevation={2} sx={{ mb: 3 }}>
        <CardContent>
          <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2 }}>
            <Typography variant="h6">Parts</Typography>
            <Button size="small" variant="outlined" startIcon={<AddIcon />} onClick={addPartBlock}>
              Add part
            </Button>
          </Box>

          {/* Drift summary: a non-blocking notice above the list when any
              current block correlates to a drifted line. Untouched
              drifted lines simply keep their snapshotted price on save —
              the user can save without ever clicking these controls
              (#325 forced-choice was dropped, 2026-06-04). */}
          {mode === 'edit' &&
            (() => {
              const flagged = partBlocks
                .flatMap((b) => b.rows)
                .map((r) => (r.line_item_id ? driftByLineId.get(r.line_item_id) : undefined))
                .filter((d): d is QuoteLineDriftInfo => !!d);
              const pendingFlagged = flagged.filter(
                (d) => !acceptedDriftIds.has(d.line_item_id),
              );
              if (flagged.length === 0) return null;
              return (
                <Alert
                  severity="info"
                  data-testid="quote-drift-summary"
                  sx={{ mb: 2 }}
                  action={
                    pendingFlagged.length > 0 && (
                      <Button
                        color="inherit"
                        size="small"
                        data-testid="quote-drift-update-all"
                        onClick={() => {
                          setAcceptedDriftIds((cur) => {
                            const next = new Set(cur);
                            for (const d of pendingFlagged) next.add(d.line_item_id);
                            return next;
                          });
                        }}
                      >
                        Update all flagged
                      </Button>
                    )
                  }
                >
                  {flagged.length === 1
                    ? '1 line has a price change since this quote was created. It will keep its original price unless you update it.'
                    : `${flagged.length} lines have price changes since this quote was created. They will keep their original prices unless you update them.`}
                </Alert>
              );
            })()}

          {partBlocks.length === 0 && (
            <Typography variant="body2" color="text.secondary">
              Add at least one part to quote.
            </Typography>
          )}

          {partBlocks.map((block, idx) => {
            // A tier with unit_price=null exists in the DB when
            // `replaceTiersForPart` couldn't compute a cost — e.g. a BOM
            // material has no priced procurement tier. Treat that as the
            // same "no pricing" state as zero tier rows, so the warning
            // fires and the user isn't trapped typing a quantity that
            // can't resolve to a line price.
            const hasUsableTier = block.tiers.some((t) => t.unit_price !== null);
            // Part-level custom price — when active it overrides every row.
            const blockOverrideActive =
              block.override_open && block.override_unit_price.trim() !== '';

            return (
              <Box key={idx} sx={{ mb: idx === partBlocks.length - 1 ? 0 : 3 }}>
                {idx > 0 && <Divider sx={{ mb: 3 }} />}
                <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1, mb: 2 }}>
                  <Box sx={{ flex: 1 }}>
                    <PartAutocomplete
                      companyId={companyId}
                      value={block.part}
                      onChange={(option) => updatePartInBlock(idx, option)}
                      onCreateNew={() => openCreatePartModalForBlock(idx)}
                      label={`Part ${idx + 1}`}
                    />
                  </Box>
                  <IconButton
                    color="error"
                    onClick={() => removePartBlock(idx)}
                    aria-label="Remove part"
                  >
                    <DeleteOutlineIcon />
                  </IconButton>
                </Box>

                {block.loading && (
                  <Box sx={{ py: 2, display: 'flex', justifyContent: 'center' }}>
                    <CircularProgress size={20} />
                  </Box>
                )}

                {block.error && <Alert severity="error">{block.error}</Alert>}

                {!block.loading && block.part && !hasUsableTier && !block.error && (
                  <Alert severity="warning">
                    This part has no pricing tiers yet.{' '}
                    <Link
                      component={NextLink}
                      href={`/dashboard/${companyId}/parts/${block.part.id}`}
                      target="_blank"
                      rel="noopener"
                      underline="always"
                    >
                      Add pricing tiers on the part page
                    </Link>
                    , or enter a custom unit price below.
                  </Alert>
                )}

                {!block.loading && block.part && (
                  <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
                    {/* Compact quantity-break table — column labels appear once
                        as a header, then one tight row per quantity. */}
                    <Box>
                      <Box
                        sx={{ display: 'flex', alignItems: 'center', gap: 2, px: 0.5, pb: 0.5 }}
                      >
                        <Typography variant="caption" color="text.secondary" sx={{ width: 110 }}>
                          Qty
                        </Typography>
                        <Typography
                          variant="caption"
                          color="text.secondary"
                          sx={{ flex: 1, minWidth: 120 }}
                        >
                          Unit price
                        </Typography>
                        <Typography
                          variant="caption"
                          color="text.secondary"
                          sx={{ width: 110, textAlign: 'right' }}
                        >
                          Total
                        </Typography>
                        <Box sx={{ width: 34 }} />
                      </Box>

                      {block.rows.map((row, rowIdx) => {
                        const preview = blockPreviews[idx]?.[rowIdx];
                        const orderQtyNum = Number(row.quantity);
                        const hasOrderQty =
                          row.quantity !== '' && Number.isFinite(orderQtyNum) && orderQtyNum > 0;
                        const matched = preview?.resolved ?? null;
                        // Override is part-level — it applies to every row.
                        const isOverride = blockOverrideActive;
                        // Drift state for this row, if any. Override lines never
                        // appear here (detectQuoteLineDrift filters them out).
                        const drift = row.line_item_id
                          ? driftByLineId.get(row.line_item_id) ?? null
                          : null;
                        const isAcceptedDrift = !!(
                          row.line_item_id && acceptedDriftIds.has(row.line_item_id)
                        );

                        return (
                          <Box
                            key={row.rowKey}
                            sx={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: 2,
                              px: 0.5,
                              py: 0.75,
                              borderTop: '1px solid',
                              borderColor: 'divider',
                            }}
                          >
                            <TextField
                              size="small"
                              value={row.quantity}
                              onChange={(e) => {
                                const v = e.target.value;
                                if (v !== '' && !/^\d+$/.test(v)) return;
                                updateRow(idx, rowIdx, { quantity: v });
                              }}
                              placeholder="Qty"
                              inputProps={{ 'aria-label': 'Order quantity', inputMode: 'numeric' }}
                              sx={{ width: 110 }}
                              error={hasOrderQty && !isOverride && matched?.below_min === true}
                            />

                            <Box sx={{ flex: 1, minWidth: 120 }}>
                              {!hasOrderQty ? (
                                <Typography variant="body2" color="text.secondary">
                                  —
                                </Typography>
                              ) : isOverride ? (
                                <>
                                  <Typography variant="body2" sx={{ fontWeight: 600 }}>
                                    {formatCurrency(Number(block.override_unit_price))}
                                  </Typography>
                                  <Typography variant="caption" color="text.secondary">
                                    custom price
                                  </Typography>
                                </>
                              ) : matched ? (
                                <>
                                  <Typography variant="body2" sx={{ fontWeight: 600 }}>
                                    {formatCurrency(matched.unit_price)}
                                  </Typography>
                                  <Typography
                                    variant="caption"
                                    color={matched.below_min ? 'warning.main' : 'text.secondary'}
                                  >
                                    {matched.below_min
                                      ? `Below min · Tier ${matched.matched_tier_quantity} ea`
                                      : `Tier ${matched.matched_tier_quantity} ea`}
                                  </Typography>
                                </>
                              ) : (
                                <Typography variant="caption" color="warning.main">
                                  No priced tier — add a tier or use a custom price
                                </Typography>
                              )}
                              {row.basis_unknown && (
                                <Chip
                                  size="small"
                                  label="basis unknown"
                                  color="default"
                                  variant="outlined"
                                  data-testid={`basis-unknown-chip-${idx}`}
                                  sx={{ height: 20, alignSelf: 'flex-start', mt: 0.5 }}
                                />
                              )}
                              {drift && !isOverride && (
                                <Box
                                  sx={{
                                    display: 'flex',
                                    flexDirection: 'column',
                                    gap: 0.5,
                                    mt: 0.5,
                                  }}
                                  data-testid={`drift-chip-${idx}`}
                                >
                                  <Chip
                                    size="small"
                                    label={
                                      isAcceptedDrift
                                        ? `Will update to ${formatCurrency(drift.current_unit_price)} / unit`
                                        : `Tier price changed: was ${formatCurrency(
                                            drift.snapshotted_unit_price,
                                          )}, now ${formatCurrency(drift.current_unit_price)}`
                                    }
                                    color={isAcceptedDrift ? 'primary' : 'warning'}
                                    variant="outlined"
                                    sx={{ height: 'auto', py: 0.5, alignSelf: 'flex-start' }}
                                  />
                                  {!isAcceptedDrift && drift.current_unit_price !== null && (
                                    <Button
                                      size="small"
                                      variant="text"
                                      data-testid={`drift-update-${idx}`}
                                      onClick={() => {
                                        if (!row.line_item_id) return;
                                        setAcceptedDriftIds((cur) => {
                                          const next = new Set(cur);
                                          next.add(row.line_item_id!);
                                          return next;
                                        });
                                      }}
                                      sx={{ alignSelf: 'flex-start', textTransform: 'none' }}
                                    >
                                      Update to current price
                                    </Button>
                                  )}
                                  {isAcceptedDrift && (
                                    <Button
                                      size="small"
                                      variant="text"
                                      data-testid={`drift-cancel-${idx}`}
                                      onClick={() => {
                                        if (!row.line_item_id) return;
                                        setAcceptedDriftIds((cur) => {
                                          if (!cur.has(row.line_item_id!)) return cur;
                                          const next = new Set(cur);
                                          next.delete(row.line_item_id!);
                                          return next;
                                        });
                                      }}
                                      sx={{ alignSelf: 'flex-start', textTransform: 'none' }}
                                    >
                                      Keep original price
                                    </Button>
                                  )}
                                </Box>
                              )}
                            </Box>

                            <Typography
                              variant="body2"
                              sx={{ width: 110, textAlign: 'right', fontWeight: 600 }}
                            >
                              {hasOrderQty ? formatCurrency(preview?.total ?? null) : '—'}
                            </Typography>

                            <IconButton
                              color="error"
                              size="small"
                              onClick={() => removeRow(idx, rowIdx)}
                              aria-label="Remove quantity"
                              disabled={block.rows.length === 1}
                            >
                              <DeleteOutlineIcon fontSize="small" />
                            </IconButton>
                          </Box>
                        );
                      })}
                    </Box>

                    {/* Part-level controls: add a quantity, and one custom-price
                        toggle for the whole part (not per row). */}
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
                      <Button size="small" startIcon={<AddIcon />} onClick={() => addRow(idx)}>
                        Add quantity
                      </Button>
                      <Box sx={{ flex: 1 }} />
                      {blockOverrideActive && (
                        <Chip
                          size="small"
                          label="adjusted for this quote"
                          color="success"
                          variant="outlined"
                          sx={{ height: 20 }}
                        />
                      )}
                      <Button
                        size="small"
                        onClick={() =>
                          updateBlock(idx, (prev) => {
                            const firstResolved =
                              (blockPreviews[idx] ?? [])
                                .map((p) => p?.resolved)
                                .find(Boolean) ?? null;
                            return {
                              override_open: !prev.override_open,
                              override_unit_price:
                                !prev.override_open &&
                                prev.override_unit_price === '' &&
                                firstResolved
                                  ? String(firstResolved.unit_price)
                                  : prev.override_unit_price,
                            };
                          })
                        }
                      >
                        {block.override_open ? 'Cancel custom price' : '✏ Use custom price'}
                      </Button>
                    </Box>
                    {block.override_open && (
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
                        <TextField
                          size="small"
                          label="Custom unit price"
                          value={block.override_unit_price}
                          onChange={(e) => {
                            const v = e.target.value;
                            if (v !== '' && !/^\d*\.?\d*$/.test(v)) return;
                            updateBlock(idx, { override_unit_price: v });
                          }}
                          sx={{ width: 180 }}
                          inputMode="decimal"
                        />
                        <Typography variant="caption" color="text.secondary">
                          Applies to every quantity of this part
                        </Typography>
                      </Box>
                    )}
                  </Box>
                )}
              </Box>
            );
          })}
        </CardContent>
      </Card>

      <Card elevation={2} sx={{ mb: 3 }}>
        <CardContent>
          <Typography variant="h6" sx={{ mb: 2 }}>
            Terms
          </Typography>
          <Grid container spacing={2}>
            <Grid size={{ xs: 12, sm: 6 }}>
              <TextField
                label="Lead time (days)"
                type="number"
                size="small"
                fullWidth
                required
                value={formData.lead_time_days}
                onChange={(e) => handleFieldChange('lead_time_days', e.target.value)}
                inputProps={{ min: 0, step: 1, inputMode: 'numeric' }}
              />
            </Grid>
            <Grid size={{ xs: 12, sm: 6 }}>
              <TextField
                label="Expiration date"
                type="date"
                size="small"
                fullWidth
                value={formData.expiration_date}
                onChange={(e) => handleFieldChange('expiration_date', e.target.value)}
                InputLabelProps={{ shrink: true }}
              />
            </Grid>
          </Grid>
        </CardContent>
      </Card>

      {/* Sticky footer with running total + actions */}
      <Box
        sx={{
          position: 'sticky',
          bottom: 0,
          mt: 3,
          py: 2,
          px: 2,
          bgcolor: 'background.paper',
          borderTop: '1px solid',
          borderColor: 'divider',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 2,
          flexWrap: 'wrap',
          zIndex: 1,
        }}
      >
        <Box>
          {isFirmQuote ? (
            <>
              <Typography variant="caption" color="text.secondary">
                Quote total
              </Typography>
              <Typography variant="h6" sx={{ fontWeight: 700 }}>
                {partBlocks.length === 0
                  ? '—'
                  : quoteTotal.allComputable
                    ? formatCurrency(quoteTotal.sum)
                    : `${formatCurrency(quoteTotal.sum)} (incomplete)`}
              </Typography>
            </>
          ) : (
            <>
              <Typography variant="caption" color="text.secondary">
                Price options quote
              </Typography>
              <Typography variant="body2" sx={{ fontWeight: 600 }}>
                Prices shown per quantity — no grand total
              </Typography>
            </>
          )}
        </Box>
        <Box sx={{ display: 'flex', gap: 2 }}>
          <Button onClick={handleCancel} disabled={loading}>
            Cancel
          </Button>
          <Tooltip title={validationError ?? ''} disableHoverListener={!validationError}>
            <span>
              <Button
                variant="contained"
                onClick={handleSubmit}
                disabled={loading || !!validationError}
                startIcon={loading ? <CircularProgress size={14} color="inherit" /> : null}
              >
                {mode === 'create' ? 'Create quote' : 'Save changes'}
              </Button>
            </span>
          </Tooltip>
        </Box>
      </Box>

      <CustomerFormModal
        open={customerModalOpen}
        onClose={() => setCustomerModalOpen(false)}
        onCreated={handleCustomerCreated}
        companyId={companyId}
      />
      <PartFormModal
        open={partModalOpen}
        onClose={() => {
          setPartModalOpen(false);
          setPartModalTargetIdx(null);
        }}
        onCreated={handlePartCreated}
        companyId={companyId}
      />
    </Box>
  );
}
