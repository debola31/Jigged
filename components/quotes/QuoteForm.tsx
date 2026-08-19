'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useRouter, useParams } from 'next/navigation';
import posthog from 'posthog-js';
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
import InputAdornment from '@mui/material/InputAdornment';
import Collapse from '@mui/material/Collapse';
import AddIcon from '@mui/icons-material/Add';
import RefreshIcon from '@mui/icons-material/Refresh';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';

import type { QuoteFormData } from '@/types/quote';
import {
  getCompanyDefaultPaymentTerms,
} from '@/utils/companyAccess';
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
  pickPaymentTerms,
} from '@/utils/customerAccess';
import { getTiersWithComputedPrices } from '@/utils/partPricingTiersAccess';
import { resolveTier } from '@/utils/quotePricingResolver';
import { isValidQuantityInput } from '@/lib/quantityInput';
import { quantityUnitSuffix } from '@/lib/standardUnits';
import type { ComputedPartPricingTier } from '@/types/partPricing';
import CustomerFormModal from '@/components/customers/CustomerFormModal';
import CustomerAddressForm from '@/components/customers/CustomerAddressForm';
import CustomerContactForm from '@/components/customers/CustomerContactForm';
import PartAutocomplete, { type PartSelectOption } from '@/components/parts/PartAutocomplete';
import PaymentTermsPicker from '@/components/common/PaymentTermsPicker';
import type {
  Customer,
  CustomerAddress,
  CustomerListContact,
  CustomerWithRelations,
} from '@/types/customer';
import type { CustomerContact } from '@/types/customerContact';

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
 * (part, quantity) is an independent quote_line_items row — and, for the same
 * reason, its own price.
 */
interface QtyRowState {
  /** Stable React key for the row (mirrors RoutingOperationsList temp ids). */
  rowKey: string;
  /** Working-copy string so the input can be empty mid-edit. */
  quantity: string;
  /**
   * Working-copy unit price. Always editable, seeded from the matched tier's
   * listed price while untouched — so the common path is "the tier price is
   * already there" and pricing one break differently is just typing over it.
   * Empty means "not yet resolved" (no quantity, or the part has no tier).
   */
  unit_price: string;
  /**
   * True once the user types in the price field. Kept as a flag rather than
   * inferred by comparing against the tier price, because the two are equal at
   * the moment of typing an identical number, and because it is what stops the
   * seed from overwriting a deliberate entry when the quantity changes.
   */
  price_touched: boolean;
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
   * Part-level lead time (free text). Applies to every quantity row of this
   * part; on save it's written onto each resulting line item. Blank ⇒ the line
   * falls back to the quote-level lead time.
   */
  lead_time_text: string;
  /**
   * Whether the per-part lead-time override is disclosed. A separate flag
   * rather than `lead_time_text !== ''` because "checked the box, hasn't typed
   * yet" is a real state that can't be derived from the value — but it is
   * SEEDED from the value on hydration, so a saved quote that carries a
   * per-part lead time opens expanded rather than hiding it behind an
   * unchecked box.
   */
  lead_time_open: boolean;
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
/**
 * One option in the payment-terms picker. `group` tags whether the term is one
 * of the shop's saved custom terms (which get a remove control) or a built-in
 * preset. Adding a new term happens via the dropdown's "Add New" footer, not by
 * free-typing, so there's no synthetic create option in the list.
 */
/** Sentinel value for the "Add New" action row at the bottom of the picker. */

/**
 * The quote fields that can be pre-filled from the customer's standing terms.
 * All three share one mechanism — resolve at customer-select, show provenance,
 * release ownership on edit — so they're driven off one list rather than three
 * copies of the same branch.
 */
// Lead time is NOT here. It is a quote field, but it has no customer-level
// default to inherit from: lead time follows current shop load and the specific
// part, not the customer, so a standing value was a stale promise waiting to be
// quoted. The column was dropped; the field stays on the quote, typed when
// someone can actually see the backlog.
const STANDING_TERM_FIELDS = ['payment_terms'] as const;
type StandingTermField = (typeof STANDING_TERM_FIELDS)[number];

function formatCurrency(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value);
}

/**
 * Height of one `size="small"` MUI input — the quantity-row baseline.
 *
 * The row is top-aligned so the Qty and Unit price boxes stay on one line no
 * matter how much the price column grows beneath them (caption, custom-price
 * notice, drift chip). Cells that carry no input use this to re-centre against
 * that first line instead of riding the top of a tall row.
 */
const ROW_CONTROL_HEIGHT = 40;

const newRowKey = () => `temp-qty-${crypto.randomUUID()}`;

function emptyRow(): QtyRowState {
  return {
    rowKey: newRowKey(),
    quantity: '',
    unit_price: '',
    price_touched: false,
  };
}

function emptyBlock(): PartBlockState {
  return {
    part: null,
    rows: [emptyRow()],
    lead_time_text: '',
    lead_time_open: false,
    tiers: [],
    loading: false,
    error: null,
  };
}

function rowFromInitial(p: QuoteFormData['parts'][number]): QtyRowState {
  return {
    rowKey: newRowKey(),
    quantity: String(p.order_quantity),
    // A saved override is a price someone typed — restore it as touched so the
    // tier seed can't quietly overwrite it on the way back in.
    unit_price: p.override ? String(p.override.unit_price) : '',
    price_touched: !!p.override,
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
 * Price is per row: each (part, quantity) is its own `quote_line_items` row with
 * its own `unit_price` / `is_quote_override`, so quoting 50/100/250 can carry
 * three different negotiated prices. (It used to be one price per part, which
 * flattened exactly the quantity curve a price-options quote exists to show.)
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
        lead_time_text: '',
        lead_time_open: false,
        tiers: [],
        loading: false,
        error: null,
      });
    }
    // Lead time is per-part; take it from the first entry that carries one
    // (all entries for a part share the same value on save). A saved value
    // opens the disclosure — otherwise editing a quote would hide a lead time
    // it is still promising the customer.
    if (p.lead_time_text && !blocks[idx].lead_time_text) {
      blocks[idx].lead_time_text = p.lead_time_text;
      blocks[idx].lead_time_open = true;
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
  // A new quote starts with NO part block — the user clicks "Add part".
  //
  // Seeding one looks like a free click saved, and isn't: "Add part" autofocuses
  // the picker it creates, so a pre-seeded block still needs the same click to
  // open the selector. What the button does buy is teaching that a quote can
  // hold several parts, which a form that opens mid-way through its first one
  // never says. (Tried seeded, reverted — this comment is the reason.)
  const [partBlocks, setPartBlocks] = useState<PartBlockState[]>(() =>
    groupPartsIntoBlocks(initialData.parts),
  );
  // Index of the part block whose part picker should grab focus after it
  // mounts — set when the user clicks "Add part" so the new (empty) entry
  // gets focus and scrolls into view. Cleared once consumed so later
  // re-renders (e.g. removing a block) don't steal focus.
  const [focusBlockIndex, setFocusBlockIndex] = useState<number | null>(null);

  useEffect(() => {
    if (focusBlockIndex !== null) setFocusBlockIndex(null);
  }, [focusBlockIndex]);

  /**
   * Live DOM node per part block, so a block can be scrolled into view once it
   * has something to show.
   */
  const blockRefs = useRef<Map<number, HTMLElement>>(new Map());
  /**
   * Block index awaiting a scroll, set when the user PICKS a part.
   *
   * A ref rather than state on purpose: this is a one-shot side effect, and
   * holding it in state would mean clearing it from an effect — the
   * set-state-in-effect shape the lint ratchet is walking back.
   *
   * The gate matters. Tiers load for every block on an edit-mode open too, and
   * scrolling on that would yank the page around the moment a quote is opened.
   * Only a deliberate pick arms it.
   */
  const scrollAfterLoadRef = useRef<number | null>(null);

  /**
   * Reveal a block after its tiers land. Choosing a part makes the block grow —
   * quantity row, price, lead-time disclosure — and all of that appears BELOW
   * the picker the user just used, so on a multi-part quote it lands off-screen
   * and they have to scroll to find what they just created.
   *
   * `block: 'center'`, NOT `'nearest'`. Nearest scrolls the minimum needed,
   * which parks the block hard against the bottom edge — technically visible,
   * but with nothing beneath it, so **+ Add part** and the footer stay off
   * screen and the user scrolls again anyway. Centring leaves half a viewport
   * below the block, which is where the next thing they'll reach for lives.
   *
   * It also means every pick lands the block in the same place, rather than
   * moving sometimes and not others.
   */
  const revealBlockAfterLoad = useCallback((idx: number) => {
    if (scrollAfterLoadRef.current !== idx) return;
    scrollAfterLoadRef.current = null;
    // One frame, so React has committed the rows before we measure them.
    requestAnimationFrame(() => {
      const prefersReducedMotion =
        typeof window !== 'undefined' &&
        window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      blockRefs.current.get(idx)?.scrollIntoView({
        behavior: prefersReducedMotion ? 'auto' : 'smooth',
        block: 'center',
      });
    });
  }, []);

  const [customers, setCustomers] = useState<CustomerOption[]>([]);
  // Full customer rows (with addresses + contacts) keyed by id so the
  // customer-change handler can resolve address/contact defaults without
  // refetching. Source: getAllCustomers — already loaded for the dropdown.
  const [customersById, setCustomersById] = useState<Map<string, CustomerWithRelations>>(
    () => new Map(),
  );
  // Billing address is the primary section: it's the more fundamental field
  // and prints as the CUSTOMER block on the quote PDF. Shipping is
  // de-emphasized into a disclosure that opens when shipping differs from
  // billing. Initial state: ON when shipping address equals billing address
  // (Customer Contact is independent of either).
  const [shippingSameAsBilling, setShippingSameAsBilling] = useState<boolean>(
    () => initialData.shipping_address_id === initialData.billing_address_id,
  );

  // Which standing-terms fields currently hold a value we copied from the
  // customer, and whose name to credit in the helper line under the field.
  // A field leaves this map as soon as the user edits it (handleFieldChange),
  // which is what makes the inheritance VISIBLE rather than silent — and what
  // stops a later customer switch from overwriting a hand-typed term.
  // Never seeded in edit mode: an existing quote owns its terms outright.
  const [prefilledFrom, setPrefilledFrom] = useState<
    Partial<Record<StandingTermField, string>>
  >({});
  const [loading, setLoading] = useState(false);
  const [loadingData, setLoadingData] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [customerModalOpen, setCustomerModalOpen] = useState(false);

  // Which address selector triggered the inline "+ Add new address" form
  // (null = closed). The new address is created against the current customer
  // and auto-selected into this field on save.
  const [addressFormFor, setAddressFormFor] = useState<'shipping' | 'billing' | null>(null);

  // Whether the inline "+ Add new contact" form is open. Mirrors the address
  // inline-add: the new contact is created against the current customer and
  // auto-selected into the Contact field on save.
  const [contactFormOpen, setContactFormOpen] = useState(false);

  // The company's saved custom payment terms (free-text terms kept for reuse),
  // loaded in loadData. They render first in the payment-terms picker (each with
  // a remove control); choosing "Add New" and submitting a term appends here.
  /** The shop-wide default payment terms, used when the customer has none. */
  const [shopDefaultTerms, setShopDefaultTerms] = useState<string | null>(null);
  // Payment-terms "Add New" flow: choosing the picker's "Add New" row sets
  // addingTerm, which reveals an inline field (below the picker) bound to
  // newTermDraft; submitting it selects + saves the term.

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
      const [customersData, hydratedParts, shopDefaultTerms] = await Promise.all([
        getAllCustomers(companyId),
        initialPartIds.length > 0
          ? getPartsForSelectByIds(initialPartIds)
          : Promise.resolve([]),
        // Best-effort: without it a customer with no terms of their own just
        // starts blank, which is exactly the pre-shop-default behaviour.
        // (The saved-terms list is loaded by PaymentTermsPicker itself.)
        getCompanyDefaultPaymentTerms(companyId).catch(() => null),
      ]);
      setShopDefaultTerms(shopDefaultTerms);
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
    } finally {
      // Both paths: the block now shows either its rows or an error, and either
      // way that is what the user needs to see.
      revealBlockAfterLoad(idx);
    }
  }, [revealBlockAfterLoad]);

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
    // The user has taken ownership of this field — drop the "from their standing
    // terms" provenance so the helper line stops claiming the value came from the
    // customer, and so a later customer switch won't overwrite what they typed.
    if (field in prefilledFrom) {
      setPrefilledFrom((prev) => {
        const next = { ...prev };
        delete next[field as StandingTermField];
        return next;
      });
    }
  };

  /**
   * Helper line under a standing-terms field. When the value was inherited we
   * name WHICH LEVEL it came from — "Acme Industrial's standing terms" or "your
   * shop default" — otherwise the field's own hint shows.
   *
   * This one line is what makes the inheritance visible rather than silent —
   * the distinction between this and the `markup_rates` module deleted in July
   * 2026, where a shared default was resolved at read time with nothing on
   * screen to say where the number came from. Naming the level matters more now
   * that there are two of them: "why does this say Net 30?" has two possible
   * answers, and the user should not have to go looking for which.
   */
  const standingTermsHelper = (field: StandingTermField, hint: string) =>
    prefilledFrom[field] ? `From ${prefilledFrom[field]} — edit to override` : hint;



  /**
   * Customer change clears the previous customer's address/contact FKs
   * (they belong to a different customer and would be rejected by the
   * integrity trigger) and pre-populates defaults from the new customer:
   *   - contact_id          → primary contact
   *   - billing_address_id  → default_billing (or the sole address)
   *   - shipping_address_id → default_shipping (falls back to billing)
   *
   * "Shipping same as billing" goes ON when the resolved shipping equals
   * the resolved billing address. Common case (single default address)
   * → ON, disclosure hidden. Customers with separate billing/shipping
   * defaults → OFF, shipping disclosure visible.
   *
   * It also pre-populates the customer's STANDING TERM — payment_terms.
   *
   * OVERWRITE RULE. Unlike the address/contact FKs, which MUST be replaced
   * because they belong to a different customer and the integrity trigger
   * would reject them, terms are free text the user may have typed. So a term
   * is replaced only when it is empty, or when it is still the PREVIOUS
   * customer's prefill (tracked in `prefilledFrom`). Anything the user typed
   * survives a customer switch — the drift chip then shows it doesn't match
   * the new customer's standing terms, rather than us destroying the edit.
   */
  const handleCustomerChange = (customerId: string, justCreated?: CustomerWithRelations) => {
    if (!customerId) {
      setFormData((prev) => ({
        ...prev,
        customer_id: '',
        contact_id: '',
        billing_address_id: '',
        shipping_address_id: '',
      }));
      setShippingSameAsBilling(true);
      return;
    }
    if (customerId === formData.customer_id) return;

    // `justCreated` is the inline-create path handing us the row directly. It has
    // to, because setCustomersById in the same event handler hasn't committed yet
    // — reading the map here would miss the customer entirely and quietly prefill
    // the shop default over the standing terms just typed into the modal.
    const customer = justCreated ?? customersById.get(customerId);
    const billing = customer ? pickBillingAddress(customer) : null;
    const shipping = customer ? pickShippingAddress(customer) : null;
    const primary = customer ? pickPrimaryContact(customer.customer_contacts) : null;

    const billingId = billing?.id ?? '';
    const shippingId = shipping?.id ?? '';
    const contactId = primary?.id ?? '';

    const sameAsBilling = shippingId === billingId;

    // Resolve the standing terms and decide ownership ONCE, against the state
    // of this render, so the two setters below can't disagree about which
    // fields we're allowed to touch.
    //
    // Payment terms have a two-level chain — the customer's own agreement, then
    // the shop-wide default — because a shop typically has one house term with a
    // handful of exceptions, so per-customer-only would mean retyping the house
    // term onto nearly every customer. It is the only standing term left: lead
    // time is judged per quote, and FOB was removed after 96 real quotes left it
    // blank (see the remove_fob_point migration).
    //
    // `source` is the phrase shown under the field. It names WHICH LEVEL the
    // value came from, and that visibility is the entire difference between this
    // and the markup_rates module deleted in July 2026.
    const customerTerms = pickPaymentTerms(customer);
    const standing: Record<StandingTermField, { value: string | null; source: string }> = {
      payment_terms: customerTerms
        ? { value: customerTerms, source: `${customer?.name ?? 'this customer'}’s standing terms` }
        : { value: shopDefaultTerms, source: 'your shop default' },
    };
    const nextTerms: Partial<Record<StandingTermField, string>> = {};
    const nextProvenance: Partial<Record<StandingTermField, string>> = {};
    for (const field of STANDING_TERM_FIELDS) {
      // "Ours" = empty, or filled by a previous prefill. Anything the user typed
      // themselves is theirs and survives a customer switch untouched.
      const ours = !formData[field]?.trim() || prefilledFrom[field] !== undefined;
      if (!ours) continue;
      const resolved = standing[field];
      // A field we own follows the new customer ALL THE WAY, including to empty.
      // Clearing matters as much as filling: pick Acme (lead time "4 weeks"),
      // realise it's the wrong customer, pick Beta (no lead time) — and Acme's
      // "4 weeks" would otherwise sit there as Beta's quoted lead time. Worse, it
      // would look hand-typed once its provenance marker went, so every later
      // switch would refuse to correct it.
      nextTerms[field] = resolved.value ?? '';
      if (resolved.value) nextProvenance[field] = resolved.source;
    }

    setShippingSameAsBilling(sameAsBilling);
    setPrefilledFrom(nextProvenance);
    setFormData((prev) => ({
      ...prev,
      customer_id: customerId,
      contact_id: contactId,
      billing_address_id: billingId,
      shipping_address_id: sameAsBilling ? billingId : shippingId,
      ...nextTerms,
    }));
  };

  /**
   * When the user changes the billing address while "shipping same as
   * billing" is on, mirror the change into the hidden shipping FK so
   * the two stay in sync without the user touching the disclosure.
   */
  const handleBillingAddressChange = (newId: string) => {
    setFormData((prev) => ({
      ...prev,
      billing_address_id: newId,
      ...(shippingSameAsBilling ? { shipping_address_id: newId } : {}),
    }));
  };

  /**
   * Toggling "shipping same as billing".
   * ON  → sync shipping_address_id → billing_address_id immediately.
   * OFF → leave shipping where it is; user opens the disclosure to pick.
   */
  const handleShippingSameToggle = (next: boolean) => {
    setShippingSameAsBilling(next);
    if (next) {
      setFormData((prev) => ({
        ...prev,
        shipping_address_id: prev.billing_address_id,
      }));
    }
  };

  /**
   * A new address was created inline for the current customer. Patch it into
   * the cached customer row (so the selector lists it) and auto-select it into
   * the field that opened the form — mirroring billing→shipping when "same as
   * billing" is on. Then close the inline form.
   */
  const handleAddressCreated = (saved: CustomerAddress) => {
    const target = addressFormFor;
    if (formData.customer_id) {
      setCustomersById((prev) => {
        const existing = prev.get(formData.customer_id);
        if (!existing) return prev;
        const next = new Map(prev);
        next.set(formData.customer_id, {
          ...existing,
          addresses: [...(existing.addresses ?? []), saved],
        });
        return next;
      });
    }
    if (target === 'billing') {
      handleBillingAddressChange(saved.id);
    } else if (target === 'shipping') {
      handleFieldChange('shipping_address_id', saved.id);
    }
    setAddressFormFor(null);
  };

  /**
   * A new contact was created inline for the current customer. Patch it into
   * the cached customer row (mapped to the list-contact shape the selector
   * uses) and auto-select it, then close the inline form. Mirrors
   * handleAddressCreated.
   */
  const handleContactCreated = (saved: CustomerContact) => {
    if (formData.customer_id) {
      const listContact: CustomerListContact = {
        id: saved.id,
        name: saved.name,
        role: saved.role,
        email: saved.email,
        phone: saved.phone,
        is_primary: saved.is_primary,
        is_billing_default: saved.is_billing_default,
        deleted_at: saved.deleted_at,
      };
      setCustomersById((prev) => {
        const existing = prev.get(formData.customer_id);
        if (!existing) return prev;
        const next = new Map(prev);
        next.set(formData.customer_id, {
          ...existing,
          customer_contacts: [...(existing.customer_contacts ?? []), listContact],
        });
        return next;
      });
    }
    handleFieldChange('contact_id', saved.id);
    setContactFormOpen(false);
  };

  /** Addresses + contacts for the currently-selected customer (or empty). */
  const selectedCustomer = formData.customer_id
    ? customersById.get(formData.customer_id) ?? null
    : null;
  const customerAddresses: CustomerAddress[] = selectedCustomer?.addresses ?? [];
  // Archived contacts leave the picker, keeping one this quote already names
  // so editing an older quote never blanks the person it was agreed with.
  const customerContacts: CustomerListContact[] = (
    selectedCustomer?.customer_contacts ?? []
  ).filter((c) => c.deleted_at === null || c.id === formData.contact_id);

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

  const addPartBlock = () => {
    // New block lands at the current end, so its index is the current length.
    setFocusBlockIndex(partBlocks.length);
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
      // Arm the reveal: this is a deliberate pick, so the rows it produces are
      // worth scrolling to once they exist.
      scrollAfterLoadRef.current = idx;
      loadTiersForBlock(idx, option.id);
    }
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
    // The new customer has no addresses or contacts yet, but it DOES carry the
    // standing terms just typed into the modal. Build the shell once and hand it
    // to handleCustomerChange directly — going via customersById would read this
    // render's map, which the setter below hasn't updated yet.
    const created: CustomerWithRelations = {
      ...customer,
      addresses: [],
      customer_contacts: [],
      primary_contact: null,
      quotes_count: 0,
      jobs_count: 0,
    };
    setCustomersById((prev) => {
      const next = new Map(prev);
      next.set(customer.id, created);
      return next;
    });
    handleCustomerChange(customer.id, created);
    setCustomerModalOpen(false);
  };

  /** Per-row live preview: blockPreviews[block][row].
   *
   *  `resolved` is the matched tier — `resolved.unit_price` is the price that
   *  tier LISTS, the same number the part page shows, because the tier ladder is
   *  a price list and a break's price holds for its whole band. `block.tiers`
   *  already carries those prices (getTiersWithComputedPrices, fetched when the
   *  part is picked), so this is synchronous: no per-quantity round trip.
   *
   *  `effectiveUnitPrice` is what the row will actually be quoted at — the typed
   *  price once the user has touched the field, otherwise the tier price.
   *  `isCustom` is the difference between the two, and drives the marker. */
  const blockPreviews = useMemo(() => {
    return partBlocks.map((block) => {
      return block.rows.map((row) => {
        const orderQty = Number(row.quantity);
        const hasQty = Number.isFinite(orderQty) && orderQty > 0;
        const resolved =
          hasQty && block.part ? resolveTier(block.tiers, orderQty) : null;

        const typed = row.price_touched && row.unit_price.trim() !== '' ? Number(row.unit_price) : null;
        const typedValid = typed !== null && Number.isFinite(typed) && typed >= 0;

        const effectiveUnitPrice = typedValid ? typed : resolved?.unit_price ?? null;
        // Custom means "differs from what the ladder would charge" — typing the
        // tier price back in is not an override, so it must not be flagged or
        // written as one. Compared at cent precision, which is the precision
        // both numbers are stored and displayed at.
        const isCustom =
          typedValid &&
          (resolved === null || Math.round(typed * 100) !== Math.round(resolved.unit_price * 100));

        return {
          resolved,
          effectiveUnitPrice,
          isCustom,
          total:
            hasQty && effectiveUnitPrice !== null
              ? Math.round(effectiveUnitPrice * orderQty * 100) / 100
              : null,
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
    // Checks run in the order the cards appear (Customer → Terms → Parts).
    // Only the FIRST failure is shown, on the disabled submit button, so an
    // order that disagrees with the page sends the user to the wrong card —
    // e.g. "add a part" while the empty field is two cards higher.
    if (!formData.customer_id) return 'Pick a customer.';
    // Lead time is free text (e.g. "2–3 weeks", "In stock") but required.
    if (formData.lead_time_text.trim() === '') {
      return 'Enter a lead time.';
    }
    // Payment terms are required on every quote (the custom "Other" field
    // writes back into payment_terms, so this one check covers both paths).
    if (formData.payment_terms.trim() === '') {
      return 'Enter payment terms.';
    }
    if (partBlocks.length === 0) return 'Add at least one part to the quote.';
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
      const seenQty = new Set<number>();
      for (const row of block.rows) {
        const orderQty = Number(row.quantity);
        if (!Number.isFinite(orderQty) || orderQty <= 0) {
          return 'Every quantity must be greater than zero.';
        }
        if (seenQty.has(orderQty)) return 'Each quantity can appear only once per part.';
        seenQty.add(orderQty);

        // Price is per row now. A row is priceable if the user typed a valid
        // price OR the part's ladder resolves one — only the absence of both
        // blocks the save.
        const typedRaw = row.price_touched ? row.unit_price.trim() : '';
        if (typedRaw !== '') {
          const typed = Number(typedRaw);
          if (!Number.isFinite(typed) || typed < 0) {
            return 'Unit price must be a non-negative number.';
          }
          continue;
        }
        if (row.price_touched) {
          // Touched then cleared: the row has no price and no seed to fall back
          // on until Reset restores the tier. Say so rather than silently
          // quoting the tier price they just deleted.
          return 'Enter a unit price, or reset the row to its tier price.';
        }
        if (!resolveTier(block.tiers, orderQty)) {
          return 'At least one part has no priced tiers — add tiers on the part page, or type a unit price.';
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
      parts: partBlocks.flatMap((b, bIdx) =>
        b.rows.map((r, rIdx) => {
          const orderQty = Number(r.quantity);
          const entry: QuoteFormData['parts'][number] = {
            part_id: b.part?.id ?? '',
            order_quantity: orderQty,
          };
          if (r.line_item_id) entry.line_item_id = r.line_item_id;
          if (r.basis_unknown) entry.basis_unknown = r.basis_unknown;
          // Per-part lead time → same value on every row of the part. Omit when
          // blank so an untouched quote's payload shape is unchanged; on edit,
          // reconcile reads a missing value as "use the quote default" and
          // clears any lead time the line previously had.
          if (b.lead_time_text.trim() !== '') entry.lead_time_text = b.lead_time_text;
          // Override only when the typed price actually DIFFERS from the tier's
          // listed price — `isCustom` already draws that line. Typing the tier
          // price back in must stay a normal tier-priced line, or it would be
          // frozen out of drift detection and repricing for no reason.
          const preview = blockPreviews[bIdx]?.[rIdx];
          if (preview?.isCustom && preview.effectiveUnitPrice !== null) {
            entry.override = {
              unit_price: preview.effectiveUnitPrice,
              // Markup % is no longer a quote-form input — leave it null on overrides.
              markup_percent: null,
            };
          }
          return entry;
        }),
      ),
    };

    setLoading(true);
    try {
      if (mode === 'create') {
        const { quote } = await createQuote(companyId, payload);
        posthog.capture('quote created', {
          line_item_count: payload.parts.length,
          // How often the ladder gets overridden is the signal that says whether
          // shops' tiers are actually carrying their pricing. A count, never a
          // price — the amount is the customer's business data.
          custom_priced_line_count: payload.parts.filter((p) => p.override).length,
          customer_id: formData.customer_id,
        });
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

          {/* Credit hold, at the moment the salesperson picks the customer.
              Warns, never gates — nothing here touches canSubmit, and a held
              customer can be quoted exactly as before. Quoting is the earlier
              of the two places this can be caught: catching it at pack time
              means the quote was already written, sent and worked. */}
          {selectedCustomer?.credit_status === 'hold' && (
            <Alert severity="warning" sx={{ mt: 2 }}>
              <Typography variant="body2" sx={{ fontWeight: 600 }}>
                {selectedCustomer.name} is on credit hold.
              </Typography>
              {selectedCustomer.credit_hold_note && (
                <Typography variant="body2">{selectedCustomer.credit_hold_note}</Typography>
              )}
            </Alert>
          )}

          {/* Customer contact + Billing address + Shipping address.
              Hidden until a customer is picked. */}
          {formData.customer_id && (
            <Box sx={{ mt: 3 }}>
              <Grid container spacing={2}>
                <Grid size={{ xs: 12, md: 6 }}>
                  <Autocomplete
                    size="small"
                    options={[
                      ...customerContacts,
                      // Sentinel "+ Add new contact" appears at the bottom of
                      // the dropdown. Selecting it opens the inline add-contact
                      // form instead of setting the FK.
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
                        setContactFormOpen(true);
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
                  <Collapse in={contactFormOpen} unmountOnExit>
                    <Box sx={{ mt: 2, p: 2, borderRadius: 1, bgcolor: 'action.hover' }}>
                      <CustomerContactForm
                        customerId={formData.customer_id}
                        onSaved={handleContactCreated}
                        onCancel={() => setContactFormOpen(false)}
                      />
                    </Box>
                  </Collapse>
                </Grid>
                <Grid size={{ xs: 12, md: 6 }}>
                  <FormControl fullWidth size="small">
                    <InputLabel id="billing-address-label">Billing address</InputLabel>
                    <Select
                      labelId="billing-address-label"
                      label="Billing address"
                      value={formData.billing_address_id}
                      onChange={(e) => {
                        if (e.target.value === ADD_NEW_ADDRESS_ID) {
                          setAddressFormFor('billing');
                          return;
                        }
                        handleBillingAddressChange(e.target.value);
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
                  <Collapse in={addressFormFor === 'billing'} unmountOnExit>
                    <Box sx={{ mt: 2, p: 2, borderRadius: 1, bgcolor: 'action.hover' }}>
                      <CustomerAddressForm
                        customerId={formData.customer_id}
                        onSaved={handleAddressCreated}
                        onCancel={() => setAddressFormFor(null)}
                      />
                    </Box>
                  </Collapse>
                </Grid>
              </Grid>

              <FormControlLabel
                sx={{ mt: 2, mb: 0 }}
                control={
                  <Checkbox
                    checked={shippingSameAsBilling}
                    onChange={(e) => handleShippingSameToggle(e.target.checked)}
                  />
                }
                label={
                  <Typography variant="body2" color="text.secondary">
                    Shipping address same as billing
                  </Typography>
                }
              />

              {!shippingSameAsBilling && (
                <Box sx={{ mt: 1, pl: 4 }}>
                  <FormControl fullWidth size="small">
                    <InputLabel id="shipping-address-label">Shipping address</InputLabel>
                    <Select
                      labelId="shipping-address-label"
                      label="Shipping address"
                      value={formData.shipping_address_id}
                      onChange={(e) => {
                        if (e.target.value === ADD_NEW_ADDRESS_ID) {
                          setAddressFormFor('shipping');
                          return;
                        }
                        handleFieldChange('shipping_address_id', e.target.value);
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
                  <Collapse in={addressFormFor === 'shipping'} unmountOnExit>
                    <Box sx={{ mt: 2, p: 2, borderRadius: 1, bgcolor: 'action.hover' }}>
                      <CustomerAddressForm
                        customerId={formData.customer_id}
                        onSaved={handleAddressCreated}
                        onCancel={() => setAddressFormFor(null)}
                      />
                    </Box>
                  </Collapse>
                </Box>
              )}
            </Box>
          )}
        </CardContent>
      </Card>

      {/* Terms sits ABOVE Parts, deliberately.
          The quote-level lead time has to be on screen before the parts that may
          override it — otherwise each part block's "leave blank to use the
          quote's lead time" is a forward reference to a field the user hasn't
          reached yet. Customer → Terms → Parts also puts the standing-terms
          provenance line next to the customer picker that caused it, instead of
          a whole card away. */}
      <Card elevation={2} sx={{ mb: 3 }}>
        <CardContent>
          <Typography variant="h6" sx={{ mb: 2 }}>
            Terms
          </Typography>
          <Grid container spacing={2}>
            <Grid size={{ xs: 12, sm: 6 }}>
              {/* Free-text lead time — the shop types whatever fits
                  ("2–3 weeks", "In stock", "Call to confirm"). Required
                  (validationError); stored verbatim and no longer drives the
                  job due date (entered manually at conversion).

                  No standing-terms prefill: lead time follows current shop load
                  and the specific part, so it is judged here, per quote, rather
                  than inherited from the customer. */}
              <TextField
                label="Lead time"
                size="small"
                fullWidth
                required
                value={formData.lead_time_text}
                onChange={(e) => handleFieldChange('lead_time_text', e.target.value)}
                helperText="e.g. “2–3 weeks” or “In stock”"
                InputLabelProps={{ shrink: true }}
              />
            </Grid>
            <Grid size={{ xs: 12, sm: 6 }}>
              {/* Column is still `expiration_date`; only the label says
                  "Quote valid until", which is the phrase the PDF already
                  prints ("Valid Until:"). */}
              <TextField
                label="Quote valid until"
                type="date"
                size="small"
                fullWidth
                value={formData.expiration_date}
                onChange={(e) => handleFieldChange('expiration_date', e.target.value)}
                InputLabelProps={{ shrink: true }}
              />
            </Grid>
            <Grid size={{ xs: 12 }}>
              {/* One shared control with the customer page — same vocabulary,
                  same QuickBooks-first ordering. A bare text box on either side
                  is how "net 45" and "Net 45" become two terms. */}
              <PaymentTermsPicker
                companyId={companyId}
                value={formData.payment_terms}
                onChange={(next) => handleFieldChange('payment_terms', next)}
                required
                helperText={
                  prefilledFrom.payment_terms
                    ? standingTermsHelper('payment_terms', '')
                    : undefined
                }
              />
            </Grid>
          </Grid>
        </CardContent>
      </Card>

      {/* Parts */}
      <Card elevation={2} sx={{ mb: 3 }}>
        <CardContent>
          {/* "Add part" lives at the BOTTOM of this card, not up here beside the
              heading. A part block is tall — picker, quantity rows, price
              captions, lead-time disclosure — so on a multi-part quote a header
              button means scrolling back up past everything you just filled in
              to add the next one. Putting it after the list keeps it where the
              user's attention already is when they finish a part. */}
          <Typography variant="h6" sx={{ mb: 2 }}>
            Parts
          </Typography>

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
            /**
             * A typed price IS a price, so the warning has nothing left to warn
             * about — it offered two ways out and then kept complaining after one
             * of them was taken, which reads as "you did it wrong".
             */
            const hasTypedPrice = block.rows.some(
              (r) => r.price_touched && r.unit_price.trim() !== '',
            );
            // Unit symbol for the order-qty field (e.g. "in") so a fractional
            // quantity isn't ambiguous. null for count/unitless parts.
            const orderQtyUnitLabel = quantityUnitSuffix(block.part?.primary_unit);
            // Tier caption reads "Tier 0.5 in" / "Tier 1 ea" — always show a
            // unit here (full label, fallback "ea") so counts stay unchanged.
            // NOTE: the tier caption deliberately carries NO unit. The Qty box
            // beside it already shows one wherever a unit is meaningful
            // (`quantityUnitSuffix` returns null for count units, where a bare
            // number is the convention), so repeating it was redundant there —
            // and worse, the old `?? 'ea'` fallback INVENTED one for parts whose
            // Qty box shows none, which is how "Tier 1 ea" appeared next to a
            // unitless quantity.

            return (
              <Box
                key={idx}
                ref={(el: HTMLElement | null) => {
                  if (el) blockRefs.current.set(idx, el);
                  else blockRefs.current.delete(idx);
                }}
                sx={{ mb: idx === partBlocks.length - 1 ? 0 : 3 }}
              >
                {idx > 0 && <Divider sx={{ mb: 3 }} />}
                <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1, mb: 2 }}>
                  <Box sx={{ flex: 1 }}>
                    <PartAutocomplete
                      companyId={companyId}
                      value={block.part}
                      onChange={(option) => updatePartInBlock(idx, option)}
                      onCreateNew={() =>
                        window.open(
                          `/dashboard/${companyId}/parts/new?from=quotes`,
                          '_blank',
                          'noopener,noreferrer',
                        )
                      }
                      label={`Part ${idx + 1}`}
                      autoFocus={idx === focusBlockIndex}
                    />
                  </Box>
                  {/*
                    Open the part, always — not only when something is wrong with
                    it. The only route here used to be inside the "no pricing
                    tiers" warning, so the moment a part WAS priced there was no
                    way to look at it: to check a cost, a lead time, a drawing, or
                    to fix a price that is merely wrong rather than missing. A new
                    tab, because the quote in progress is not worth losing.
                  */}
                  {block.part && (
                    <Tooltip title="Open this part in a new tab">
                      <IconButton
                        component={NextLink}
                        href={`/dashboard/${companyId}/parts/${block.part.id}`}
                        target="_blank"
                        rel="noopener"
                        aria-label={`Open ${block.part.part_name} in a new tab`}
                      >
                        <OpenInNewIcon />
                      </IconButton>
                    </Tooltip>
                  )}
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

                {!block.loading && block.part && !hasUsableTier && !hasTypedPrice && !block.error && (
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
                        const isOverride = preview?.isCustom ?? false;
                        // The field shows the tier's listed price until the user
                        // types over it. Derived rather than seeded into state by
                        // an effect: there is no sync to get wrong, and a
                        // quantity change re-reads the new tier automatically.
                        const priceFieldValue = row.price_touched
                          ? row.unit_price
                          : matched
                            ? String(matched.unit_price)
                            : '';
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
                              // Top-aligned, NOT centred. The price column grows
                              // downward — a tier caption, a custom-price notice,
                              // a drift chip — and centring re-centres every other
                              // cell against that growth, so the Qty box visibly
                              // drifts down the moment a price is edited. Anchoring
                              // to the top keeps the two inputs on one line
                              // whatever appears beneath them; the trailing cells
                              // re-centre themselves against ROW_CONTROL_HEIGHT.
                              alignItems: 'flex-start',
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
                                // Order quantities are decimal-capable (up to 4 dp)
                                // so a part sold by length/weight can be quoted as
                                // 0.32. isValidQuantityInput allows the empty string.
                                if (!isValidQuantityInput(v)) return;
                                updateRow(idx, rowIdx, { quantity: v });
                              }}
                              inputProps={{ 'aria-label': 'Order quantity', inputMode: 'decimal' }}
                              InputProps={
                                orderQtyUnitLabel
                                  ? {
                                      endAdornment: (
                                        <InputAdornment position="end">
                                          {orderQtyUnitLabel}
                                        </InputAdornment>
                                      ),
                                    }
                                  : undefined
                              }
                              sx={{ width: 110 }}
                              error={hasOrderQty && !isOverride && matched?.below_min === true}
                            />

                            <Box sx={{ flex: 1, minWidth: 120 }}>
                              {/* Always an editable field — no toggle to find.
                                  It holds the tier's listed price by default, so
                                  the common path reads as a plain number and
                                  pricing this break differently is just typing
                                  over it. What was behind "Use custom price" is
                                  now the absence of a control. */}
                              <TextField
                                size="small"
                                value={priceFieldValue}
                                onChange={(e) => {
                                  const v = e.target.value;
                                  if (v !== '' && !/^\d*\.?\d*$/.test(v)) return;
                                  updateRow(idx, rowIdx, {
                                    unit_price: v,
                                    price_touched: true,
                                  });
                                }}
                                disabled={!hasOrderQty}
                                inputProps={{ 'aria-label': 'Unit price', inputMode: 'decimal' }}
                                InputProps={{
                                  startAdornment: (
                                    <InputAdornment position="start">$</InputAdornment>
                                  ),
                                }}
                                sx={{
                                  width: 130,
                                  // Subordinate to Qty, but never hidden. Qty is
                                  // the field you must fill; this one already
                                  // holds the tier's answer, so it rests at a
                                  // lighter border weight and comes up to full
                                  // strength on hover and focus.
                                  //
                                  // The tempting move — no border until hover,
                                  // Notion-style — is the one thing to avoid:
                                  // that pattern's documented failure is nobody
                                  // discovering the value is editable, which is
                                  // exactly the bug the old "Use custom price"
                                  // toggle had. Quieter, not invisible.
                                  '& .MuiOutlinedInput-root:not(.Mui-disabled)': {
                                    '& fieldset': { borderColor: 'divider' },
                                    '&:hover fieldset': { borderColor: 'text.secondary' },
                                    '&.Mui-focused fieldset': { borderColor: 'primary.main' },
                                  },
                                }}
                              />
                              {/* Reset is offered for the whole time the row is
                                  off its tier price — including when the field
                                  has been emptied, which is the state that
                                  blocks the save. Gating it on a *valid* custom
                                  price instead would take the way back off the
                                  screen at exactly the moment the user needs it,
                                  while validation told them to use it. */}
                              {!hasOrderQty ? null : row.price_touched ? (
                                <Box
                                  sx={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: 0.5,
                                    flexWrap: 'wrap',
                                    mt: 0.25,
                                  }}
                                >
                                  {/* warning.main per the row status ladder —
                                      "wants your attention, not wrong yet". An
                                      override is deliberate, so never `error`.
                                      The auto price stays on screen: the old
                                      toggle hid it, leaving nothing to compare
                                      against. */}
                                  <Typography
                                    variant="caption"
                                    color={isOverride || !matched ? 'warning.main' : 'text.secondary'}
                                  >
                                    {!matched
                                      ? isOverride
                                        ? 'Custom price'
                                        : 'Enter a unit price'
                                      : isOverride
                                        ? `Custom · tier ${matched.matched_tier_quantity} is ${formatCurrency(matched.unit_price)}`
                                        : `From tier ${matched.matched_tier_quantity}`}
                                  </Typography>
                                  {matched && (
                                    <Button
                                      size="small"
                                      variant="text"
                                      data-testid={`price-reset-${idx}-${rowIdx}`}
                                      onClick={() =>
                                        updateRow(idx, rowIdx, {
                                          unit_price: '',
                                          price_touched: false,
                                        })
                                      }
                                      sx={{
                                        minWidth: 'auto',
                                        px: 0.5,
                                        py: 0,
                                        textTransform: 'none',
                                        // Match the caption's type exactly. A
                                        // Button's own line-height (1.75) and
                                        // min-height are taller than the caption
                                        // beside it, which both inflated this
                                        // flex row — pushing the caption further
                                        // below the field than on a plain row —
                                        // and drew an oversized hover block
                                        // around a one-word action. Collapsing
                                        // it to caption type fixes both at once.
                                        typography: 'caption',
                                        minHeight: 0,
                                      }}
                                    >
                                      Reset
                                    </Button>
                                  )}
                                </Box>
                              ) : matched ? (
                                <Typography
                                  variant="caption"
                                  color={matched.below_min ? 'warning.main' : 'text.secondary'}
                                  sx={{ display: 'block', mt: 0.25 }}
                                >
                                  {matched.below_min
                                    ? `Below min · from tier ${matched.matched_tier_quantity}`
                                    : `From tier ${matched.matched_tier_quantity}`}
                                </Typography>
                              ) : (
                                <Typography
                                  variant="caption"
                                  color="warning.main"
                                  sx={{ display: 'block', mt: 0.25 }}
                                >
                                  No priced tier — type a price, or add tiers on the part page
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

                            {/* Trailing cells centre themselves inside one
                                input's worth of height, so they read as level
                                with the Qty and Unit price boxes rather than
                                floating at the top of a tall row. */}
                            <Box
                              sx={{
                                width: 110,
                                minHeight: ROW_CONTROL_HEIGHT,
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'flex-end',
                              }}
                            >
                              <Typography variant="body2" sx={{ fontWeight: 600 }}>
                                {hasOrderQty ? formatCurrency(preview?.total ?? null) : '—'}
                              </Typography>
                            </Box>

                            <Box
                              sx={{
                                minHeight: ROW_CONTROL_HEIGHT,
                                display: 'flex',
                                alignItems: 'center',
                              }}
                            >
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
                          </Box>
                        );
                      })}
                    </Box>

                    {/* Price now lives in each row's own field, so the only
                        part-level control left is adding a quantity. The
                        "estimate" caveat still belongs at the part: it is a
                        property of the part having no cost basis, not of any one
                        quantity. */}
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
                      <Button size="small" startIcon={<AddIcon />} onClick={() => addRow(idx)}>
                        Add quantity
                      </Button>
                      <Box sx={{ flex: 1 }} />
                      {!hasUsableTier &&
                        (blockPreviews[idx] ?? []).some((p) => p?.isCustom) && (
                          <Chip
                            size="small"
                            label="estimate — needs cost setup"
                            color="warning"
                            variant="outlined"
                            sx={{ height: 20 }}
                          />
                        )}
                    </Box>

                    {/* Per-item lead time (per-part — applies to every quantity
                        of this part). Blank ⇒ the quote-level lead time is used.
                        Shown under each item on the quote/PDF only when items
                        differ.

                        Collapsed behind a checkbox, mirroring "Shipping address
                        same as billing" above: with Terms now on screen first,
                        this is an OVERRIDE of a value the user has already set,
                        and most quotes never need one. Unchecking clears the
                        text so the line falls back to the quote lead time —
                        leaving a stale value behind a hidden checkbox is how a
                        quote ends up promising a date nobody chose. */}
                    <Box>
                      <FormControlLabel
                        sx={{ mb: 0 }}
                        control={
                          <Checkbox
                            size="small"
                            checked={block.lead_time_open}
                            onChange={(e) =>
                              updateBlock(idx, {
                                lead_time_open: e.target.checked,
                                // Clearing on close is what keeps the flag and
                                // the value from disagreeing.
                                ...(e.target.checked ? {} : { lead_time_text: '' }),
                              })
                            }
                          />
                        }
                        label={
                          <Typography variant="body2" color="text.secondary">
                            Different lead time for this part
                          </Typography>
                        }
                      />
                      <Collapse in={block.lead_time_open} unmountOnExit>
                        <Box
                          sx={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 1,
                            flexWrap: 'wrap',
                            mt: 1,
                          }}
                        >
                          <TextField
                            size="small"
                            label="Lead time (optional)"
                            value={block.lead_time_text}
                            onChange={(e) =>
                              updateBlock(idx, { lead_time_text: e.target.value })
                            }
                            placeholder={'e.g. “2–3 weeks”'}
                            sx={{ width: 220 }}
                            InputLabelProps={{ shrink: true }}
                          />
                          <Typography variant="caption" color="text.secondary">
                            Used instead of the quote’s lead time for this part
                          </Typography>
                        </Box>
                      </Collapse>
                    </Box>
                  </Box>
                )}
              </Box>
            );
          })}

          <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', flexWrap: 'wrap', mt: partBlocks.length > 0 ? 3 : 0 }}>
            <Button
              size="small"
              variant="outlined"
              startIcon={<AddIcon />}
              onClick={addPartBlock}
            >
              Add part
            </Button>

            {/*
              The other half of the part links above.
              
              Fixing a price means opening the part in another tab, and the only
              way to see the result here was to RELOAD — which throws away the
              quote being written: the lines chosen, the quantities typed, the
              customer picked. So the prices are re-read in place instead.
              `loadTiersForBlock` replaces a block's tiers and nothing else, so
              every typed price and quantity survives.
            */}
            {partBlocks.some((b) => b.part) && (
              <Button
                size="small"
                startIcon={<RefreshIcon />}
                onClick={() => {
                  partBlocks.forEach((b, i) => {
                    if (b.part) void loadTiersForBlock(i, b.part.id);
                  });
                }}
              >
                Recheck prices
              </Button>
            )}
          </Box>
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
    </Box>
  );
}
