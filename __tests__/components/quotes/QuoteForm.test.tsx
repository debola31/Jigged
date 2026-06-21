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
}));

// Customers: dropdown + defaults
const getAllCustomers = vi.fn();
vi.mock('@/utils/customerAccess', () => ({
  getAllCustomers: (...args: unknown[]) => getAllCustomers(...args),
  pickBillingAddress: vi.fn(() => null),
  pickShippingAddress: vi.fn(() => null),
  pickPrimaryContact: vi.fn(() => null),
}));

// Pricing tiers — return non-empty so the validation tier-check passes
const getTiersWithComputedPrices = vi.fn();
vi.mock('@/utils/partPricingTiersAccess', () => ({
  getTiersWithComputedPrices: (...args: unknown[]) => getTiersWithComputedPrices(...args),
}));

vi.mock('@/utils/quotePricingResolver', () => ({
  // Always-resolves stub so validation only blocks on the cases this file tests.
  resolveTier: vi.fn(() => ({
    qty_break: 1,
    markup_percent: 25,
    unit_price: 50,
  })),
}));

// Modal/autocomplete children — render nothing so the surface stays clean
vi.mock('@/components/customers/CustomerFormModal', () => ({
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
  lead_time_days: '',
  expiration_date: '',
};

const initialPopulated: QuoteFormData = {
  customer_id: 'cust-1',
  contact_id: '',
  billing_address_id: '',
  shipping_address_id: '',
  parts: [{ part_id: 'part-1', order_quantity: 5 }],
  lead_time_days: '14',
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
        initialData={{ ...initialBlank, customer_id: 'cust-1', lead_time_days: '14' }}
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
    expect(payload.lead_time_days).toBe('14');
    expect(payload.parts).toEqual([{ part_id: 'part-1', order_quantity: 5 }]);

    await waitFor(() => {
      expect(routerMocks.push).toHaveBeenCalledWith(
        '/dashboard/test-company-id/quotes/new-quote-id',
      );
    });
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
