/**
 * QuoteForm tests focus on the contract between the form and its access
 * layer — the calls to createQuote/updateQuote on submit, the cancel
 * paths, and the validation gate. The component is large (~1k LOC) and
 * mostly wires MUI inputs to state; exhaustive UI-interaction coverage
 * isn't valuable here. The tests below assert behavior that would
 * silently regress if the form changed: submit payload shape, navigation
 * targets, and the no-customer/no-parts validation gates.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, routerMocks, resetRouterMocks } from '../../test-utils';
import userEvent from '@testing-library/user-event';
import QuoteForm from '@/components/quotes/QuoteForm';
import type { QuoteFormData } from '@/types/quote';

// Quote access — primary surface under test
const createQuote = vi.fn();
const updateQuote = vi.fn();
const detectQuoteLineDrift = vi.fn();
vi.mock('@/utils/quotesAccess', () => ({
  createQuote: (...args: unknown[]) => createQuote(...args),
  updateQuote: (...args: unknown[]) => updateQuote(...args),
  detectQuoteLineDrift: (...args: unknown[]) => detectQuoteLineDrift(...args),
}));

// Parts: hydrating initial part_ids on edit + by-id lookup
const getPartsForSelectByIds = vi.fn();
vi.mock('@/utils/partsAccess', () => ({
  getPartsForSelectByIds: (...args: unknown[]) => getPartsForSelectByIds(...args),
  // The form prices each row at base(orderQty) × markup; base comes from here.
  // 40 × 25% markup = $50, matching the resolver stub below.
  getComputedPartCost: vi.fn(async () => 40),
}));

// Customers: dropdown + defaults. The pick* resolvers are the real ones in
// spirit — they read the standing-terms columns off the selected customer — so
// they delegate to the actual field rather than returning a fixed stub, which
// is what lets the resolution-chain tests below mean anything.
const getAllCustomers = vi.fn();
vi.mock('@/utils/customerAccess', () => ({
  getAllCustomers: (...args: unknown[]) => getAllCustomers(...args),
  pickBillingAddress: vi.fn(() => null),
  pickShippingAddress: vi.fn(() => null),
  pickPrimaryContact: vi.fn(() => null),
  pickPaymentTerms: (c: { default_payment_terms?: string | null } | null | undefined) =>
    c?.default_payment_terms?.trim() || null,
  pickLeadTimeText: (c: { default_lead_time_text?: string | null } | null | undefined) =>
    c?.default_lead_time_text?.trim() || null,
  pickFobPoint: (c: { default_fob_point?: string | null } | null | undefined) =>
    c?.default_fob_point?.trim() || null,
}));

// Company access — the form loads/persists the company's saved custom payment
// terms. Mocked so tests don't hit the real Supabase-backed access layer.
const getCustomPaymentTerms = vi.fn();
const getCompanyDefaultPaymentTerms = vi.fn();
const addCustomPaymentTerm = vi.fn();
const removeCustomPaymentTerm = vi.fn();
vi.mock('@/utils/companyAccess', () => ({
  getCustomPaymentTerms: (...args: unknown[]) => getCustomPaymentTerms(...args),
  // The shop-wide default payment terms, resolved onto a new quote when the
  // customer has none of their own. Defaults to null below (no shop default),
  // which is the pre-existing behaviour these tests were written against.
  getCompanyDefaultPaymentTerms: (...args: unknown[]) =>
    getCompanyDefaultPaymentTerms(...args),
  addCustomPaymentTerm: (...args: unknown[]) => addCustomPaymentTerm(...args),
  removeCustomPaymentTerm: (...args: unknown[]) => removeCustomPaymentTerm(...args),
}));

// QuickBooks' own payment terms, offered above the local presets when a shop is
// connected. Defaults to "not connected" so these tests keep asserting the
// local-only picker, which is what most shops see.
const listQuickBooksTerms = vi.fn();
vi.mock('@/utils/quickbooksAccess', () => ({
  listQuickBooksTerms: (...args: unknown[]) => listQuickBooksTerms(...args),
}));

// Pricing tiers — return non-empty so the validation tier-check passes
const getTiersWithComputedPrices = vi.fn();
vi.mock('@/utils/partPricingTiersAccess', () => ({
  getTiersWithComputedPrices: (...args: unknown[]) => getTiersWithComputedPrices(...args),
}));

vi.mock('@/utils/quotePricingResolver', () => ({
  // Always-resolves stubs so validation only blocks on the cases this file tests.
  resolveTier: vi.fn(() => ({
    qty_break: 1,
    markup_percent: 25,
    unit_price: 50,
    matched_tier_quantity: 1,
    below_min: false,
  })),
  resolveMarkupAtQty: vi.fn(() => ({
    markup_percent: 25,
    source_tier_id: 't1',
    matched_tier_quantity: 1,
    below_min: false,
  })),
  // Real cost-plus so base(40) × 25% = $50 shows in the row.
  unitPriceFromBase: vi.fn((base: number | null, markup: number | null) =>
    base === null || markup === null ? null : Math.round(base * (1 + markup / 100) * 100) / 100,
  ),
}));

// Modal/autocomplete children — render nothing so the surface stays clean.
// CustomerAddressForm / CustomerContactForm are mocked too: they transitively
// import customer*Access → lib/supabase, which eagerly initializes a browser
// client and throws without test env. The inline-add flows aren't under test here.
vi.mock('@/components/customers/CustomerFormModal', () => ({
  default: () => null,
}));
vi.mock('@/components/customers/CustomerAddressForm', () => ({
  default: () => null,
}));
vi.mock('@/components/customers/CustomerContactForm', () => ({
  default: () => null,
}));
vi.mock('@/components/parts/PartAutocomplete', () => ({
  default: () => null,
}));

const initialBlank: QuoteFormData = {
  customer_id: '',
  contact_id: '',
  billing_address_id: '',
  shipping_address_id: '',
  parts: [],
  lead_time_text: '',
  payment_terms: '',
  fob_point: '',
  expiration_date: '',
};

const initialPopulated: QuoteFormData = {
  customer_id: 'cust-1',
  contact_id: '',
  billing_address_id: '',
  shipping_address_id: '',
  parts: [{ part_id: 'part-1', order_quantity: 5 }],
  lead_time_text: '14 business days',
  // Payment terms are required to submit a quote, so the "populated/complete"
  // fixture carries one. FOB is optional and stays empty.
  payment_terms: 'Net 30',
  fob_point: '',
  expiration_date: '',
};

const hydratedPart = {
  id: 'part-1',
  part_name: 'BRKT-001',
  description: 'Steel bracket',
  has_routing: true,
  is_stocked: false,
  source: 'made' as const,
  primary_unit: 'each',
  quantity: 0,
};

describe('QuoteForm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetRouterMocks();
    getAllCustomers.mockResolvedValue([
      { id: 'cust-1', name: 'Acme Corp', addresses: [], contacts: [] },
      { id: 'cust-2', name: 'Beta LLC', addresses: [], contacts: [] },
    ]);
    getPartsForSelectByIds.mockResolvedValue([hydratedPart]);
    getTiersWithComputedPrices.mockResolvedValue([
      { id: 't1', part_id: 'part-1', qty_break: 1, markup_percent: 25, unit_price: 50 },
    ]);
    createQuote.mockResolvedValue({ quote: { id: 'new-quote-id' } });
    updateQuote.mockResolvedValue({ id: 'edit-quote-id' });
    // Default: no drift. Individual tests override.
    detectQuoteLineDrift.mockResolvedValue([]);
    // Company saved-terms: none by default; add/remove echo back a list.
    getCustomPaymentTerms.mockResolvedValue([]);
    // No shop-wide default by default — the terms field starts empty, which is
    // what every assertion in this file was written against.
    getCompanyDefaultPaymentTerms.mockResolvedValue(null);
    listQuickBooksTerms.mockResolvedValue({ connected: false, terms: [] });
    addCustomPaymentTerm.mockResolvedValue([]);
    removeCustomPaymentTerm.mockResolvedValue([]);
  });

  it('renders the Create-quote button label in create mode', async () => {
    render(<QuoteForm mode="create" initialData={initialBlank} />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /create quote/i })).toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: /save changes/i })).not.toBeInTheDocument();
  });

  it('renders the Save-changes button label in edit mode', async () => {
    render(
      <QuoteForm mode="edit" quoteId="q-1" initialData={initialPopulated} />,
    );
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /save changes/i })).toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: /create quote/i })).not.toBeInTheDocument();
  });

  it('disables submit when validation fails (no customer)', async () => {
    render(<QuoteForm mode="create" initialData={initialBlank} />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /create quote/i })).toBeDisabled();
    });
  });

  it('disables submit when validation passes initial guard but parts array is empty', async () => {
    // Customer set, parts empty → "Add at least one part to the quote."
    render(
      <QuoteForm
        mode="create"
        initialData={{ ...initialBlank, customer_id: 'cust-1', lead_time_text: '2 weeks' }}
      />,
    );
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /create quote/i })).toBeDisabled();
    });
  });

  it('enables submit when initial data is fully valid (populated edit mode)', async () => {
    render(
      <QuoteForm mode="edit" quoteId="q-1" initialData={initialPopulated} />,
    );
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /save changes/i })).toBeEnabled();
    });
  });

  it('requires payment terms — submit stays disabled until they are set', async () => {
    // Everything valid except payment terms (blank) → submit blocked.
    render(
      <QuoteForm
        mode="edit"
        quoteId="q-1"
        initialData={{ ...initialPopulated, payment_terms: '' }}
      />,
    );
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /save changes/i })).toBeDisabled();
    });
  });

  it('calls createQuote with the payload and navigates on success', async () => {
    render(<QuoteForm mode="create" initialData={initialPopulated} />);

    // Wait for hydration + tiers
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /create quote/i })).toBeEnabled();
    });

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /create quote/i }));

    await waitFor(() => {
      expect(createQuote).toHaveBeenCalledTimes(1);
    });
    const [companyId, payload] = createQuote.mock.calls[0];
    expect(companyId).toBe('test-company-id'); // from test-utils useParams mock
    expect(payload.customer_id).toBe('cust-1');
    expect(payload.lead_time_text).toBe('14 business days');
    expect(payload.parts).toEqual([{ part_id: 'part-1', order_quantity: 5 }]);

    await waitFor(() => {
      expect(routerMocks.push).toHaveBeenCalledWith(
        '/dashboard/test-company-id/quotes/new-quote-id',
      );
    });
  });

  it('accepts a fractional order quantity (parts sold by length/weight) and forwards it', async () => {
    render(<QuoteForm mode="create" initialData={initialPopulated} />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /create quote/i })).toBeEnabled();
    });

    const user = userEvent.setup();
    const qtyInput = screen.getByLabelText('Order quantity');
    await user.clear(qtyInput);
    await user.type(qtyInput, '0.32');
    await user.click(screen.getByRole('button', { name: /create quote/i }));

    await waitFor(() => {
      expect(createQuote).toHaveBeenCalledTimes(1);
    });
    const [, payload] = createQuote.mock.calls[0];
    expect(payload.parts).toEqual([{ part_id: 'part-1', order_quantity: 0.32 }]);
  });

  it('forwards a per-item lead time on submit (attached to the part’s row)', async () => {
    render(<QuoteForm mode="create" initialData={initialPopulated} />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /create quote/i })).toBeEnabled();
    });

    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Lead time (optional)'), '2-3 weeks');
    await user.click(screen.getByRole('button', { name: /create quote/i }));

    await waitFor(() => {
      expect(createQuote).toHaveBeenCalledTimes(1);
    });
    const [, payload] = createQuote.mock.calls[0];
    expect(payload.parts).toEqual([
      { part_id: 'part-1', order_quantity: 5, lead_time_text: '2-3 weeks' },
    ]);
  });

  it('offers the trimmed presets (with Prepay) in the payment-terms combobox', async () => {
    render(<QuoteForm mode="edit" quoteId="q-1" initialData={initialPopulated} />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /save changes/i })).toBeEnabled();
    });

    const user = userEvent.setup();
    await user.click(screen.getByRole('combobox', { name: /payment terms/i }));

    // Prepay and 2/10 Net 30 are offered…
    expect(await screen.findByRole('option', { name: 'Prepay', exact: true })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: '2/10 Net 30', exact: true })).toBeInTheDocument();
    // …and the trimmed-out net terms are gone (Net 45 / Net 90).
    expect(screen.queryByRole('option', { name: 'Net 45', exact: true })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Net 90', exact: true })).not.toBeInTheDocument();
  });

  it('adds a term via the "Add New" action and saves it to the company for reuse', async () => {
    addCustomPaymentTerm.mockResolvedValue(['Net 30, 1% late charge']);
    render(
      <QuoteForm mode="edit" quoteId="q-1" initialData={{ ...initialPopulated, payment_terms: '' }} />,
    );

    const user = userEvent.setup();
    await user.click(await screen.findByRole('combobox', { name: /payment terms/i }));
    // Choose the "Add New" row → an inline field appears below the picker.
    await user.click(await screen.findByRole('option', { name: /add new/i }));
    await user.type(await screen.findByLabelText('New payment term'), 'Net 30, 1% late charge');
    await user.click(screen.getByRole('button', { name: 'Add', exact: true }));

    expect(addCustomPaymentTerm).toHaveBeenCalledWith('test-company-id', 'Net 30, 1% late charge');
  });

  it('shows the company’s saved terms in the combobox and can remove one', async () => {
    getCustomPaymentTerms.mockResolvedValue(['Net 30, 1% late charge']);
    render(
      <QuoteForm mode="edit" quoteId="q-1" initialData={{ ...initialPopulated, payment_terms: '' }} />,
    );

    const user = userEvent.setup();
    await user.click(await screen.findByRole('combobox', { name: /payment terms/i }));
    // The saved term appears as an option…
    expect(
      await screen.findByRole('option', { name: /Net 30, 1% late charge/i }),
    ).toBeInTheDocument();
    // …with a remove button wired to removeCustomPaymentTerm.
    await user.click(screen.getByRole('button', { name: 'Remove Net 30, 1% late charge' }));
    expect(removeCustomPaymentTerm).toHaveBeenCalledWith(
      'test-company-id',
      'Net 30, 1% late charge',
    );
  });

  it('offers the terms QuickBooks already has, above the local presets', async () => {
    listQuickBooksTerms.mockResolvedValue({
      connected: true,
      terms: [
        { id: '3', name: 'Net 30', due_days: 30 },
        { id: '7', name: 'Net 45', due_days: 45 },
      ],
    });
    render(
      <QuoteForm mode="edit" quoteId="q-1" initialData={{ ...initialPopulated, payment_terms: '' }} />,
    );

    const user = userEvent.setup();
    await user.click(await screen.findByRole('combobox', { name: /payment terms/i }));

    // "Net 45" exists only in QuickBooks — it is offered because a term
    // QuickBooks knows resolves to a real SalesTermRef on the invoice.
    expect(await screen.findByRole('option', { name: 'Net 45' })).toBeInTheDocument();
    // And it leads: options are ordered most-authoritative first.
    const labels = screen.getAllByRole('option').map((o) => o.textContent);
    expect(labels.indexOf('Net 45')).toBeLessThan(labels.indexOf('Net 60'));
  });

  // QuickBooks ships "Due on receipt"; our preset reads "Due on Receipt". Two
  // rows for one term is the drift this whole feature exists to remove.
  it('shows one row per term when QuickBooks spells it differently', async () => {
    listQuickBooksTerms.mockResolvedValue({
      connected: true,
      terms: [{ id: '1', name: 'Due on receipt', due_days: 0 }],
    });
    render(
      <QuoteForm mode="edit" quoteId="q-1" initialData={{ ...initialPopulated, payment_terms: '' }} />,
    );

    const user = userEvent.setup();
    await user.click(await screen.findByRole('combobox', { name: /payment terms/i }));
    await screen.findByRole('option', { name: 'Due on receipt' });

    const labels = screen.getAllByRole('option').map((o) => o.textContent);
    expect(labels.filter((l) => l?.toLowerCase() === 'due on receipt')).toHaveLength(1);
    // QuickBooks' spelling wins — it is the one that has to match on their side.
    expect(labels).toContain('Due on receipt');
    expect(labels).not.toContain('Due on Receipt');
  });

  it('falls back to the local presets when there is no QuickBooks', async () => {
    // Already the default mock, but stated explicitly: this is what most shops
    // see, and the picker must be complete without QuickBooks.
    listQuickBooksTerms.mockResolvedValue({ connected: false, terms: [] });
    render(
      <QuoteForm mode="edit" quoteId="q-1" initialData={{ ...initialPopulated, payment_terms: '' }} />,
    );

    const user = userEvent.setup();
    await user.click(await screen.findByRole('combobox', { name: /payment terms/i }));
    expect(await screen.findByRole('option', { name: 'Net 30' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Due on Receipt' })).toBeInTheDocument();
  });

  it('shows a highlighted "Add New" row at the bottom of the dropdown', async () => {
    render(
      <QuoteForm mode="edit" quoteId="q-1" initialData={{ ...initialPopulated, payment_terms: '' }} />,
    );

    const user = userEvent.setup();
    await user.click(await screen.findByRole('combobox', { name: /payment terms/i }));
    // The "Add New" affordance is visible in the open dropdown.
    expect(await screen.findByRole('option', { name: /add new/i })).toBeInTheDocument();
  });

  it('calls updateQuote with the payload and navigates on success', async () => {
    render(
      <QuoteForm mode="edit" quoteId="q-existing" initialData={initialPopulated} />,
    );

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /save changes/i })).toBeEnabled();
    });

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => {
      expect(updateQuote).toHaveBeenCalledTimes(1);
    });
    const [quoteId, payload] = updateQuote.mock.calls[0];
    expect(quoteId).toBe('q-existing');
    expect(payload.customer_id).toBe('cust-1');

    await waitFor(() => {
      expect(routerMocks.push).toHaveBeenCalledWith(
        '/dashboard/test-company-id/quotes/q-existing',
      );
    });
    expect(createQuote).not.toHaveBeenCalled();
  });

  it('shows an error Alert when createQuote rejects', async () => {
    createQuote.mockRejectedValueOnce(new Error('Quote-number trigger failed'));
    render(<QuoteForm mode="create" initialData={initialPopulated} />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /create quote/i })).toBeEnabled();
    });

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /create quote/i }));

    expect(
      await screen.findByText(/quote-number trigger failed/i),
    ).toBeInTheDocument();
    expect(routerMocks.push).not.toHaveBeenCalled();
  });

  it('calls onCancel when provided and does not navigate back', async () => {
    const onCancel = vi.fn();
    render(
      <QuoteForm mode="create" initialData={initialBlank} onCancel={onCancel} />,
    );

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument();
    });

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /cancel/i }));

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(routerMocks.back).not.toHaveBeenCalled();
  });

  it('calls router.back when cancelled without an onCancel prop', async () => {
    render(<QuoteForm mode="create" initialData={initialBlank} />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument();
    });

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /cancel/i }));

    expect(routerMocks.back).toHaveBeenCalledTimes(1);
  });

  it('invokes onSave callback after a successful create', async () => {
    const onSave = vi.fn();
    render(
      <QuoteForm mode="create" initialData={initialPopulated} onSave={onSave} />,
    );

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /create quote/i })).toBeEnabled();
    });

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /create quote/i }));

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledTimes(1);
    });
  });

  // ============== Drift UI (Issue #324 / #317 §0 policy) ==============
  //
  // The form correlates blocks to line items via QuoteFormPartBlock.line_item_id
  // (populated by quoteToFormData on edit). detectQuoteLineDrift returns the
  // set of drifted line ids on mount; the form renders a non-blocking chip
  // + per-line "Update to current price" + a top-of-list "Update all flagged"
  // bulk control. Forced-choice was DROPPED in the #325 decision — saving is
  // never blocked by an unresolved drift choice.

  const driftedInitial: QuoteFormData = {
    ...initialPopulated,
    parts: [
      {
        part_id: 'part-1',
        order_quantity: 5,
        line_item_id: 'li-1',
        basis_unknown: false,
      },
    ],
  };

  it('edit-time drift uses non-blocking chip only — save is enabled without making a drift choice', async () => {
    detectQuoteLineDrift.mockResolvedValueOnce([
      {
        line_item_id: 'li-1',
        basis_unknown: false,
        snapshotted_unit_price: 50,
        current_unit_price: 75,
      },
    ]);

    render(<QuoteForm mode="edit" quoteId="q-1" initialData={driftedInitial} />);

    // The drift chip renders and the save button stays enabled. No modal,
    // no error, no required-action gate.
    await waitFor(() => {
      expect(screen.getByTestId('quote-drift-summary')).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: /save changes/i })).toBeEnabled();
  });

  it('renders per-line drift chip and Update-all bulk control on flagged lines', async () => {
    detectQuoteLineDrift.mockResolvedValueOnce([
      {
        line_item_id: 'li-1',
        basis_unknown: false,
        snapshotted_unit_price: 50,
        current_unit_price: 75,
      },
    ]);

    render(<QuoteForm mode="edit" quoteId="q-1" initialData={driftedInitial} />);

    await waitFor(() => {
      expect(screen.getByTestId('drift-chip-0')).toBeInTheDocument();
    });
    // Per-line and "Update all flagged" controls both present.
    expect(screen.getByTestId('drift-update-0')).toBeInTheDocument();
    expect(screen.getByTestId('quote-drift-update-all')).toBeInTheDocument();
  });

  it('untouched drifted line saves without sending its id in acceptDriftLineItemIds (keeps snapshotted price)', async () => {
    detectQuoteLineDrift.mockResolvedValueOnce([
      {
        line_item_id: 'li-1',
        basis_unknown: false,
        snapshotted_unit_price: 50,
        current_unit_price: 75,
      },
    ]);

    render(<QuoteForm mode="edit" quoteId="q-1" initialData={driftedInitial} />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /save changes/i })).toBeEnabled();
    });

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => {
      expect(updateQuote).toHaveBeenCalledTimes(1);
    });
    const opts = updateQuote.mock.calls[0][2];
    expect(opts).toBeDefined();
    expect(opts.acceptDriftLineItemIds).toEqual([]);
  });

  it('per-line update marks line for reprice — drift id flows into acceptDriftLineItemIds on save', async () => {
    detectQuoteLineDrift.mockResolvedValueOnce([
      {
        line_item_id: 'li-1',
        basis_unknown: false,
        snapshotted_unit_price: 50,
        current_unit_price: 75,
      },
    ]);

    render(<QuoteForm mode="edit" quoteId="q-1" initialData={driftedInitial} />);

    await waitFor(() => {
      expect(screen.getByTestId('drift-update-0')).toBeInTheDocument();
    });

    const user = userEvent.setup();
    await user.click(screen.getByTestId('drift-update-0'));
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => {
      expect(updateQuote).toHaveBeenCalledTimes(1);
    });
    const opts = updateQuote.mock.calls[0][2];
    expect(opts.acceptDriftLineItemIds).toEqual(['li-1']);
  });

  it('Update-all bulk control opts every flagged line in at once', async () => {
    const twoDrifted: QuoteFormData = {
      ...initialPopulated,
      parts: [
        { part_id: 'part-1', order_quantity: 5, line_item_id: 'li-1' },
        { part_id: 'part-2', order_quantity: 10, line_item_id: 'li-2' },
      ],
    };
    detectQuoteLineDrift.mockResolvedValueOnce([
      {
        line_item_id: 'li-1',
        basis_unknown: false,
        snapshotted_unit_price: 50,
        current_unit_price: 75,
      },
      {
        line_item_id: 'li-2',
        basis_unknown: false,
        snapshotted_unit_price: 80,
        current_unit_price: 90,
      },
    ]);
    getPartsForSelectByIds.mockResolvedValue([
      hydratedPart,
      { ...hydratedPart, id: 'part-2', part_name: 'NUT-001' },
    ]);
    getTiersWithComputedPrices.mockResolvedValue([
      { id: 't1', part_id: 'part-1', qty_break: 1, markup_percent: 25, unit_price: 50 },
    ]);

    render(<QuoteForm mode="edit" quoteId="q-1" initialData={twoDrifted} />);

    await waitFor(() => {
      expect(screen.getByTestId('quote-drift-update-all')).toBeInTheDocument();
    });

    const user = userEvent.setup();
    await user.click(screen.getByTestId('quote-drift-update-all'));
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => {
      expect(updateQuote).toHaveBeenCalledTimes(1);
    });
    const opts = updateQuote.mock.calls[0][2];
    expect(opts.acceptDriftLineItemIds.sort()).toEqual(['li-1', 'li-2']);
  });

  it('basis-unknown chip renders on pre-snapshot lines', async () => {
    const basisUnknownInitial: QuoteFormData = {
      ...initialPopulated,
      parts: [
        {
          part_id: 'part-1',
          order_quantity: 5,
          line_item_id: 'li-1',
          basis_unknown: true,
        },
      ],
    };
    detectQuoteLineDrift.mockResolvedValueOnce([]);

    render(
      <QuoteForm mode="edit" quoteId="q-1" initialData={basisUnknownInitial} />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('basis-unknown-chip-0')).toBeInTheDocument();
    });
  });

  it('override line never renders drift chip', async () => {
    // detectQuoteLineDrift filters override lines server-side and returns
    // an empty array even when the override line's tier has moved.
    const overrideInitial: QuoteFormData = {
      ...initialPopulated,
      parts: [
        {
          part_id: 'part-1',
          order_quantity: 5,
          line_item_id: 'li-override',
          override: { unit_price: 999, markup_percent: null },
        },
      ],
    };
    detectQuoteLineDrift.mockResolvedValueOnce([]);

    render(<QuoteForm mode="edit" quoteId="q-1" initialData={overrideInitial} />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /save changes/i })).toBeEnabled();
    });
    // No drift chip, no summary alert.
    expect(screen.queryByTestId('drift-chip-0')).not.toBeInTheDocument();
    expect(screen.queryByTestId('quote-drift-summary')).not.toBeInTheDocument();
  });

  // ============== Multi-quantity (price-options) behavior ==============

  it('adding a second quantity turns the quote into a price-options quote (no grand total)', async () => {
    render(<QuoteForm mode="edit" quoteId="q-1" initialData={initialPopulated} />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /save changes/i })).toBeEnabled();
    });

    // One quantity → firm quote → grand total caption shown.
    expect(screen.getByText('Quote total')).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /add quantity/i }));

    // Two quantities for one part → price-options quote, grand total hidden.
    await waitFor(() => {
      expect(screen.getByText('Price options quote')).toBeInTheDocument();
    });
    expect(screen.queryByText('Quote total')).not.toBeInTheDocument();
  });

  it('blocks save when the same quantity is entered twice for one part', async () => {
    render(<QuoteForm mode="edit" quoteId="q-1" initialData={initialPopulated} />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /save changes/i })).toBeEnabled();
    });

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /add quantity/i }));

    // First row already holds qty 5; type 5 into the new (empty) second row.
    const qtyInputs = await screen.findAllByLabelText('Order quantity');
    expect(qtyInputs).toHaveLength(2);
    await user.type(qtyInputs[1], '5');

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /save changes/i })).toBeDisabled();
    });
  });

  it('shows a single part-level "Use custom price" control regardless of how many quantities', async () => {
    render(<QuoteForm mode="edit" quoteId="q-1" initialData={initialPopulated} />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /save changes/i })).toBeEnabled();
    });

    // One quantity row → exactly one custom-price toggle.
    expect(screen.getAllByRole('button', { name: /use custom price/i })).toHaveLength(1);

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /add quantity/i }));
    await user.click(screen.getByRole('button', { name: /add quantity/i }));

    // Three quantity rows → STILL exactly one custom-price toggle (per part).
    await waitFor(() => {
      expect(screen.getAllByLabelText('Order quantity')).toHaveLength(3);
    });
    expect(screen.getAllByRole('button', { name: /use custom price/i })).toHaveLength(1);
  });
});

describe('QuoteForm — standing-terms resolution chain', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetRouterMocks();
    getTiersWithComputedPrices.mockResolvedValue([
      { id: 'tier-1', quantity: 1, unit_price: 50, markup_percent: 25 },
    ]);
    getCustomPaymentTerms.mockResolvedValue([]);
    getCompanyDefaultPaymentTerms.mockResolvedValue(null);
    listQuickBooksTerms.mockResolvedValue({ connected: false, terms: [] });
    addCustomPaymentTerm.mockResolvedValue([]);
    removeCustomPaymentTerm.mockResolvedValue([]);
  });

  /** Pick a customer from the "Customer" autocomplete by visible name. */
  async function selectCustomer(name: string) {
    const user = userEvent.setup();
    await user.click(screen.getByRole('combobox', { name: /customer/i }));
    await user.click(await screen.findByRole('option', { name }));
  }

  it('falls back to the shop default and says so, when the customer has no terms', async () => {
    // The common case for a shop with one house term: most customers carry no
    // agreement of their own, and retyping the house term onto each of them is
    // exactly the data entry this chain exists to remove.
    getAllCustomers.mockResolvedValue([
      { id: 'cust-1', name: 'Acme Corp', addresses: [], customer_contacts: [] },
    ]);
    getCompanyDefaultPaymentTerms.mockResolvedValue('2/10 Net 30');

    render(<QuoteForm mode="create" initialData={initialBlank} />);
    await waitFor(() => expect(getAllCustomers).toHaveBeenCalled());
    await selectCustomer('Acme Corp');

    await waitFor(() => {
      expect(screen.getByRole('combobox', { name: /payment terms/i })).toHaveValue('2/10 Net 30');
    });
    // Naming the LEVEL is the whole safety argument — "why does this say
    // 2/10 Net 30?" has two possible answers and the user must not have to hunt.
    expect(screen.getByText(/from your shop default/i)).toBeInTheDocument();
  });

  it("prefers the customer's own terms over the shop default, and credits the customer", async () => {
    getAllCustomers.mockResolvedValue([
      {
        id: 'cust-1',
        name: 'Acme Corp',
        default_payment_terms: 'Net 60',
        addresses: [],
        customer_contacts: [],
      },
    ]);
    getCompanyDefaultPaymentTerms.mockResolvedValue('2/10 Net 30');

    render(<QuoteForm mode="create" initialData={initialBlank} />);
    await waitFor(() => expect(getAllCustomers).toHaveBeenCalled());
    await selectCustomer('Acme Corp');

    await waitFor(() => {
      expect(screen.getByRole('combobox', { name: /payment terms/i })).toHaveValue('Net 60');
    });
    expect(screen.getByText(/from acme corp.s standing terms/i)).toBeInTheDocument();
  });

  it('leaves the field empty when neither level has a value', async () => {
    // A shop that has filled nothing in must see byte-identical behaviour to
    // before this feature existed — that is the whole rollout gate.
    getAllCustomers.mockResolvedValue([
      { id: 'cust-1', name: 'Acme Corp', addresses: [], customer_contacts: [] },
    ]);
    getCompanyDefaultPaymentTerms.mockResolvedValue(null);

    render(<QuoteForm mode="create" initialData={initialBlank} />);
    await waitFor(() => expect(getAllCustomers).toHaveBeenCalled());
    await selectCustomer('Acme Corp');

    await waitFor(() => {
      expect(screen.getByRole('combobox', { name: /payment terms/i })).toHaveValue('');
    });
    expect(screen.queryByText(/edit to override/i)).not.toBeInTheDocument();
  });

  // A prefilled value belongs to the customer that supplied it. Switching to a
  // customer who has none must CLEAR it, not strand it — otherwise Acme's terms
  // are quoted to Beta, and because the provenance line goes with it, the field
  // then looks hand-typed and no later switch will correct it.
  it('clears a prefilled term when the next customer has none', async () => {
    getAllCustomers.mockResolvedValue([
      {
        id: 'cust-1',
        name: 'Acme Corp',
        default_payment_terms: 'Net 60',
        addresses: [],
        customer_contacts: [],
      },
      { id: 'cust-2', name: 'Beta LLC', addresses: [], customer_contacts: [] },
    ]);
    getCompanyDefaultPaymentTerms.mockResolvedValue(null);

    render(<QuoteForm mode="create" initialData={initialBlank} />);
    await waitFor(() => expect(getAllCustomers).toHaveBeenCalled());

    await selectCustomer('Acme Corp');
    await waitFor(() => {
      expect(screen.getByRole('combobox', { name: /payment terms/i })).toHaveValue('Net 60');
    });

    await selectCustomer('Beta LLC');
    await waitFor(() => {
      expect(screen.getByRole('combobox', { name: /payment terms/i })).toHaveValue('');
    });
    expect(screen.queryByText(/acme corp/i)).not.toBeInTheDocument();
  });

  // The correction has to survive a second hop: after clearing, the field must
  // still be ours, so a third customer's real terms still land.
  it('still applies the next customer’s terms after a clear', async () => {
    getAllCustomers.mockResolvedValue([
      {
        id: 'cust-1',
        name: 'Acme Corp',
        default_payment_terms: 'Net 60',
        addresses: [],
        customer_contacts: [],
      },
      { id: 'cust-2', name: 'Beta LLC', addresses: [], customer_contacts: [] },
      {
        id: 'cust-3',
        name: 'Gamma Inc',
        default_payment_terms: 'Net 15',
        addresses: [],
        customer_contacts: [],
      },
    ]);
    getCompanyDefaultPaymentTerms.mockResolvedValue(null);

    render(<QuoteForm mode="create" initialData={initialBlank} />);
    await waitFor(() => expect(getAllCustomers).toHaveBeenCalled());

    await selectCustomer('Acme Corp');
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: /payment terms/i })).toHaveValue('Net 60'),
    );
    await selectCustomer('Beta LLC');
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: /payment terms/i })).toHaveValue(''),
    );
    await selectCustomer('Gamma Inc');

    await waitFor(() => {
      expect(screen.getByRole('combobox', { name: /payment terms/i })).toHaveValue('Net 15');
    });
    expect(screen.getByText(/from gamma inc.s standing terms/i)).toBeInTheDocument();
  });

  // A term the user typed is theirs, and a customer switch must not touch it.
  it('leaves a hand-typed term alone when the customer changes', async () => {
    getAllCustomers.mockResolvedValue([
      { id: 'cust-1', name: 'Acme Corp', addresses: [], customer_contacts: [] },
      {
        id: 'cust-2',
        name: 'Beta LLC',
        default_payment_terms: 'Net 15',
        addresses: [],
        customer_contacts: [],
      },
    ]);
    getCompanyDefaultPaymentTerms.mockResolvedValue(null);

    render(<QuoteForm mode="create" initialData={initialBlank} />);
    await waitFor(() => expect(getAllCustomers).toHaveBeenCalled());
    await selectCustomer('Acme Corp');

    const user = userEvent.setup();
    await user.click(screen.getByRole('combobox', { name: /payment terms/i }));
    await user.click(await screen.findByRole('option', { name: 'Net 30' }));
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: /payment terms/i })).toHaveValue('Net 30'),
    );

    await selectCustomer('Beta LLC');
    // Beta has Net 15, but the user said Net 30 — their choice wins.
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: /payment terms/i })).toHaveValue('Net 30'),
    );
  });

  // Warns at the moment the customer is picked. Quoting is the earlier of the
  // two places a hold can be caught — at pack time the quote is already written,
  // sent and worked.
  it('warns when the selected customer is on credit hold', async () => {
    getAllCustomers.mockResolvedValue([
      {
        id: 'cust-1',
        name: 'Acme Corp',
        credit_status: 'hold',
        credit_hold_note: '90 days past due — check with Dana',
        addresses: [],
        customer_contacts: [],
      },
    ]);

    render(<QuoteForm mode="create" initialData={initialBlank} />);
    await waitFor(() => expect(getAllCustomers).toHaveBeenCalled());
    await selectCustomer('Acme Corp');

    expect(await screen.findByText(/Acme Corp is on credit hold/i)).toBeInTheDocument();
    expect(screen.getByText(/90 days past due/i)).toBeInTheDocument();
  });

  it('shows no credit banner for a customer in good standing', async () => {
    getAllCustomers.mockResolvedValue([
      {
        id: 'cust-1',
        name: 'Acme Corp',
        credit_status: 'open',
        addresses: [],
        customer_contacts: [],
      },
    ]);

    render(<QuoteForm mode="create" initialData={initialBlank} />);
    await waitFor(() => expect(getAllCustomers).toHaveBeenCalled());
    await selectCustomer('Acme Corp');

    expect(screen.queryByText(/on credit hold/i)).not.toBeInTheDocument();
  });

  // "Warn, never gate" stated as the only thing that actually proves it: the
  // submit button lands in the SAME state either way. Asserting it is simply
  // enabled would be testing the blank form's own completeness rules, which
  // disable it for unrelated reasons and would pass even if the hold did gate.
  it('a credit hold leaves the submit button exactly as it was', async () => {
    const customer = {
      id: 'cust-1',
      name: 'Acme Corp',
      addresses: [],
      customer_contacts: [],
    };
    const submitState = async (credit_status: string) => {
      getAllCustomers.mockResolvedValue([{ ...customer, credit_status }]);
      const { unmount } = render(<QuoteForm mode="create" initialData={initialBlank} />);
      await waitFor(() => expect(getAllCustomers).toHaveBeenCalled());
      await selectCustomer('Acme Corp');
      const disabled = screen
        .getByRole('button', { name: /create quote|save/i })
        .hasAttribute('disabled');
      unmount();
      return disabled;
    };

    expect(await submitState('hold')).toBe(await submitState('open'));
  });
});
