import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Quote, QuoteFormData, QuoteStatus } from '@/types/quote';

// Use vi.hoisted to define mock variables before vi.mock is called
const { mockQueryBuilder, mockSupabase, mockStorageHelpers } = vi.hoisted(() => {
  // Create a chainable mock query builder
  const builder: Record<string, ReturnType<typeof vi.fn> | unknown> = {};

  const chainMethods = [
    'from',
    'select',
    'insert',
    'update',
    'delete',
    'eq',
    'neq',
    'ilike',
    'or',
    'in',
    'is',
    'not',
    'lt',
    'order',
    'range',
    'single',
    'maybeSingle',
    'limit',
  ];

  chainMethods.forEach((method) => {
    builder[method] = vi.fn().mockImplementation(() => builder);
  });

  // Terminal values
  builder.data = null;
  builder.error = null;
  builder.count = null;

  const supabase = {
    from: vi.fn().mockImplementation(() => builder),
    rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
    auth: {
      getUser: vi.fn().mockResolvedValue({
        data: { user: { id: 'test-user-id' } },
      }),
    },
  };

  const storageHelpers = {
    generateStoragePath: vi.fn().mockImplementation(
      (companyId: string, entityType: string, entityId: string, filename: string) =>
        `${companyId}/${entityType}/${entityId}/${filename}`
    ),
    generateTempStoragePath: vi.fn().mockImplementation(
      (companyId: string, sessionId: string, filename: string) =>
        `${companyId}/temp/${sessionId}/${filename}`
    ),
    uploadFileToStorage: vi.fn().mockResolvedValue(undefined),
    deleteFileFromStorage: vi.fn().mockResolvedValue(undefined),
    downloadFileFromStorage: vi.fn().mockResolvedValue(new Blob()),
    moveFileInStorage: vi.fn().mockResolvedValue(undefined),
    getSignedUrl: vi.fn().mockResolvedValue('https://signed-url.example.com'),
  };

  return { mockQueryBuilder: builder, mockSupabase: supabase, mockStorageHelpers: storageHelpers };
});

// Mock the supabase module. quotesAccess.ts uses the typed client
// (typed-client rollout); include it here returning the same chainable
// mock so the existing tests keep working without rewriting fixtures.
vi.mock('@/lib/supabase', () => ({
  getSupabase: () => mockSupabase,
  createClient: () => mockSupabase,
  supabase: mockSupabase,
}));

// Mock storage helpers
vi.mock('@/utils/storageHelpers', () => mockStorageHelpers);

// Reconcile boundary mocks — quotesAccess.updateQuote calls these
// helpers; we verify dispatch (which got called, with what) rather than
// re-test their internals (covered in quoteLineItemsAccess + resolver
// tests). The hoisted spies are wired below so individual tests can swap
// implementations as needed.
const {
  getLineItemsForQuoteMock,
  insertLineItemForPartMock,
  updateLineItemQuantityMock,
  updateLineItemLeadTimeMock,
  updateLineItemOverrideMock,
  repriceLineItemToCurrentMock,
  deleteLineItemMock,
  getTiersWithComputedPricesMock,
  detectQuoteLineDriftCallsToDb,
} = vi.hoisted(() => ({
  getLineItemsForQuoteMock: vi.fn(),
  insertLineItemForPartMock: vi.fn(),
  updateLineItemQuantityMock: vi.fn(),
  updateLineItemLeadTimeMock: vi.fn(),
  updateLineItemOverrideMock: vi.fn(),
  repriceLineItemToCurrentMock: vi.fn(),
  deleteLineItemMock: vi.fn(),
  getTiersWithComputedPricesMock: vi.fn(),
  detectQuoteLineDriftCallsToDb: vi.fn(),
}));

vi.mock('@/utils/quoteLineItemsAccess', () => ({
  getLineItemsForQuote: getLineItemsForQuoteMock,
  insertLineItemForPart: insertLineItemForPartMock,
  updateLineItemQuantity: updateLineItemQuantityMock,
  updateLineItemLeadTime: updateLineItemLeadTimeMock,
  updateLineItemOverride: updateLineItemOverrideMock,
  repriceLineItemToCurrent: repriceLineItemToCurrentMock,
  deleteLineItem: deleteLineItemMock,
  // clearLineItemsForQuote isn't exercised in these tests but the import
  // exists on quotesAccess — provide a stub so the mocked module is
  // syntactically complete.
  clearLineItemsForQuote: vi.fn(),
}));

vi.mock('@/utils/partPricingTiersAccess', () => ({
  getTiersWithComputedPrices: getTiersWithComputedPricesMock,
}));

// Import functions after mock setup
import {
  getQuotes,
  getAllQuotes,
  getQuotesCount,
  getQuote,
  getQuoteWithRelations,
  createQuote,
  updateQuote,
  deleteQuote,
  bulkDeleteQuotes,
  convertQuoteToJob,
  detectQuoteLineDrift,
  repriceQuoteDriftedLinesToCurrent,
  nextQuoteJobNumber,
} from '@/utils/quotesAccess';

describe('nextQuoteJobNumber — quote-indexed job numbers', () => {
  it('uses the mirror when no job off the quote exists yet', () => {
    expect(nextQuoteJobNumber('Q-0019', [])).toBe('J-0019');
    expect(nextQuoteJobNumber('Q-0019', ['J-0020', 'J-0007'])).toBe('J-0019');
  });

  it('suffixes later jobs off the same quote (J-0019 → J-0019-2 → J-0019-3)', () => {
    expect(nextQuoteJobNumber('Q-0019', ['J-0019'])).toBe('J-0019-2');
    expect(nextQuoteJobNumber('Q-0019', ['J-0019', 'J-0019-2'])).toBe('J-0019-3');
    // Fills a gap left by an archived suffix.
    expect(nextQuoteJobNumber('Q-0019', ['J-0019', 'J-0019-3'])).toBe('J-0019-2');
  });

  it('does not collide with a different quote sharing a number prefix', () => {
    // J-00190 (from Q-00190) must not be treated as a J-0019 suffix.
    expect(nextQuoteJobNumber('Q-0019', ['J-00190'])).toBe('J-0019');
    expect(nextQuoteJobNumber('Q-0019', ['J-0019', 'J-00190'])).toBe('J-0019-2');
  });
});

describe('quotesAccess utilities', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset mock implementations
    (mockSupabase.from as ReturnType<typeof vi.fn>).mockImplementation(() => mockQueryBuilder);
    Object.keys(mockQueryBuilder).forEach((key) => {
      const value = mockQueryBuilder[key];
      if (typeof value === 'function' && 'mockClear' in value) {
        (value as ReturnType<typeof vi.fn>).mockClear();
        (value as ReturnType<typeof vi.fn>).mockImplementation(() => mockQueryBuilder);
      }
    });
    mockQueryBuilder.data = null;
    mockQueryBuilder.error = null;
    mockQueryBuilder.count = null;
  });

  const mockQuote: Quote = {
    id: 'quote-1',
    company_id: 'company-1',
    quote_number: 'Q-2024-001',
    customer_id: 'customer-1',
    part_id: 'part-1',
    description: 'Test quote description',
    quantity: 100,
    unit_price: 25.5,
    total_price: 2550,
    status: 'pending_approval' as QuoteStatus,
    status_changed_at: '2024-01-01T00:00:00Z',
    converted_to_job_id: null,
    converted_at: null,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
  };

  // ============== CRUD Operations Tests ==============

  describe('getQuotes', () => {
    it('returns paginated quotes with relations', async () => {
      const mockQuotesWithRelations = [
        {
          ...mockQuote,
          customers: { id: 'customer-1', name: 'Test Customer' },
          parts: { id: 'part-1', part_name: 'PART001', description: 'Test Part', pricing: [] },
          jobs: null,
        },
      ];
      mockQueryBuilder.data = mockQuotesWithRelations;
      mockQueryBuilder.count = 1;
      mockQueryBuilder.error = null;

      const result = await getQuotes('company-1');

      expect(mockSupabase.from).toHaveBeenCalledWith('quotes');
      expect(mockQueryBuilder.eq).toHaveBeenCalledWith('company_id', 'company-1');
      expect(result.data).toHaveLength(1);
      expect(result.total).toBe(1);
    });

    it('applies status filter correctly', async () => {
      mockQueryBuilder.data = [];
      mockQueryBuilder.count = 0;
      mockQueryBuilder.error = null;

      await getQuotes('company-1', { status: 'approved' });

      expect(mockQueryBuilder.eq).toHaveBeenCalledWith('status', 'approved');
    });

    it('applies customer filter correctly', async () => {
      mockQueryBuilder.data = [];
      mockQueryBuilder.count = 0;
      mockQueryBuilder.error = null;

      await getQuotes('company-1', { customerId: 'customer-1' });

      expect(mockQueryBuilder.eq).toHaveBeenCalledWith('customer_id', 'customer-1');
    });

    it('applies search filter with SQL escaping', async () => {
      mockQueryBuilder.data = [];
      mockQueryBuilder.count = 0;
      mockQueryBuilder.error = null;

      await getQuotes('company-1', { search: 'test%query' });

      // After the description column was removed, search targets only quote_number
      // via .ilike (not .or). The % wildcard in the input must still be escaped.
      expect(mockQueryBuilder.ilike).toHaveBeenCalledWith(
        'quote_number',
        expect.stringContaining('\\%')
      );
    });

    it('throws error when Supabase query fails', async () => {
      mockQueryBuilder.data = null;
      mockQueryBuilder.error = { message: 'Database error', code: '500' };

      await expect(getQuotes('company-1')).rejects.toEqual({
        message: 'Database error',
        code: '500',
      });
    });
  });

  describe('getAllQuotes', () => {
    it('fetches all quotes in batches', async () => {
      mockQueryBuilder.data = [mockQuote];
      mockQueryBuilder.error = null;

      const result = await getAllQuotes('company-1');

      expect(mockSupabase.from).toHaveBeenCalledWith('quotes');
      expect(mockQueryBuilder.range).toHaveBeenCalled();
      expect(result).toHaveLength(1);
    });

    it('continues fetching until batch is incomplete', async () => {
      // First call returns full batch (would continue), but mock only returns 1
      mockQueryBuilder.data = [mockQuote];
      mockQueryBuilder.error = null;

      const result = await getAllQuotes('company-1');

      // Should stop because we got fewer than BATCH_SIZE (1000)
      expect(result).toHaveLength(1);
    });
  });

  describe('getQuotesCount', () => {
    it('returns count of quotes', async () => {
      mockQueryBuilder.count = 42;
      mockQueryBuilder.error = null;

      const result = await getQuotesCount('company-1');

      expect(result).toBe(42);
    });

    it('applies filters to count query', async () => {
      mockQueryBuilder.count = 10;
      mockQueryBuilder.error = null;

      await getQuotesCount('company-1', { status: 'pending_approval', customerId: 'cust-1' });

      expect(mockQueryBuilder.eq).toHaveBeenCalledWith('company_id', 'company-1');
      expect(mockQueryBuilder.eq).toHaveBeenCalledWith('status', 'pending_approval');
      expect(mockQueryBuilder.eq).toHaveBeenCalledWith('customer_id', 'cust-1');
    });
  });

  describe('getQuote', () => {
    it('returns single quote by ID', async () => {
      mockQueryBuilder.data = mockQuote;
      mockQueryBuilder.error = null;

      const result = await getQuote('quote-1', 'company-1');

      expect(mockQueryBuilder.eq).toHaveBeenCalledWith('id', 'quote-1');
      expect(mockQueryBuilder.eq).toHaveBeenCalledWith('company_id', 'company-1');
      expect(mockQueryBuilder.single).toHaveBeenCalled();
      expect(result).toEqual(mockQuote);
    });

    it('returns null when quote not found (PGRST116)', async () => {
      mockQueryBuilder.data = null;
      mockQueryBuilder.error = { code: 'PGRST116', message: 'Not found' };

      const result = await getQuote('nonexistent', 'company-1');

      expect(result).toBeNull();
    });

    it('throws error for other errors', async () => {
      mockQueryBuilder.data = null;
      mockQueryBuilder.error = { code: '500', message: 'Server error' };

      await expect(getQuote('quote-1', 'company-1')).rejects.toEqual({
        code: '500',
        message: 'Server error',
      });
    });
  });

  describe('getQuoteWithRelations', () => {
    it('returns quote with customer, part, and attachments', async () => {
      const quoteWithRelations = {
        ...mockQuote,
        customers: {
          id: 'customer-1',
          name: 'Test Customer',
          website: null,
          customer_contacts: [
            {
              id: 'contact-1',
              name: 'Jane Doe',
              role: 'buyer',
              email: 'jane@example.com',
              phone: '555-0100',
              is_primary: true,
            },
          ],
          addresses: [
            {
              id: 'addr-1',
              address_line1: '123 Main St',
              address_line2: null,
              city: 'Springfield',
              state: 'IL',
              postal_code: '62701',
              country: 'USA',
              default_billing: true,
              default_shipping: true,
              attention_to: null,
            },
          ],
        },
        parts: { id: 'part-1', part_name: 'PART001', description: 'Test Part', pricing: [] },
        jobs: null,
        quote_attachments: [],
      };
      mockQueryBuilder.data = quoteWithRelations;
      mockQueryBuilder.error = null;

      const result = await getQuoteWithRelations('quote-1', 'company-1');

      expect(mockQueryBuilder.select).toHaveBeenCalled();
      // Verify the joins the PDF needs are requested: customer_contacts
      // (for the primary contact's name/email/phone) and customer_addresses
      // (for the BILL TO / SHIP TO blocks).
      const selectCall = (mockQueryBuilder.select as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(selectCall).toContain('customer_contacts');
      expect(selectCall).toContain('address_line1');
      expect(selectCall).toContain('postal_code');
      expect(selectCall).toContain('default_billing');
      expect(result).not.toBeNull();
    });
  });

  // ============== Create/Update Tests ==============

  // createQuote takes the multi-part form shape (parts: QuoteFormPartBlock[])
  // and snapshots one line_item per part. These tests cover the validation
  // paths that fail BEFORE any Supabase call — the happy-path tests that
  // require mocking insertLineItemForPart + writeCostSnapshotsForPart are
  // sub-PR 3f+ territory.
  describe('createQuote (validation paths)', () => {
    const baseForm: QuoteFormData = {
      customer_id: 'customer-1',
      contact_id: '',
      billing_address_id: '',
      shipping_address_id: '',
      parts: [{ part_id: 'part-1', order_quantity: 100 }],
      lead_time_text: '14 business days',
      payment_terms: '',
      expiration_date: '',
    };

    it('rejects when parts array is empty', async () => {
      await expect(createQuote('company-1', { ...baseForm, parts: [] })).rejects.toThrow(
        'A quote must include at least one part.',
      );
    });

    it('rejects when a part block has no part_id', async () => {
      await expect(
        createQuote('company-1', { ...baseForm, parts: [{ part_id: '', order_quantity: 5 }] }),
      ).rejects.toThrow('Every part selection must reference a real part.');
    });

    it('allows the same part with multiple quantities (price-options quote)', async () => {
      // Each (part, quantity) becomes its own line item now — no dup-part guard.
      (mockSupabase.from as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
        if (table === 'quotes') {
          return {
            insert: vi.fn().mockReturnValue({
              select: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({
                  data: { id: 'quote-new', company_id: 'company-1' },
                  error: null,
                }),
              }),
            }),
          };
        }
        // writeCostSnapshotsForPart hits other tables; the default chainable
        // builder (data: null) lets it no-op, and it's wrapped in try/catch.
        return mockQueryBuilder;
      });
      getTiersWithComputedPricesMock.mockResolvedValue([]);
      insertLineItemForPartMock.mockResolvedValue({});

      await expect(
        createQuote('company-1', {
          ...baseForm,
          parts: [
            { part_id: 'part-1', order_quantity: 5 },
            { part_id: 'part-1', order_quantity: 10 },
          ],
        }),
      ).resolves.toBeDefined();

      // One line item inserted per quantity (same part_id).
      expect(insertLineItemForPartMock).toHaveBeenCalledTimes(2);
      expect(insertLineItemForPartMock.mock.calls[0][3]).toBe(5);
      expect(insertLineItemForPartMock.mock.calls[1][3]).toBe(10);
    });

    it('forwards a fractional order_quantity unchanged (parts sold by length/weight)', async () => {
      (mockSupabase.from as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
        if (table === 'quotes') {
          return {
            insert: vi.fn().mockReturnValue({
              select: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({
                  data: { id: 'quote-new', company_id: 'company-1' },
                  error: null,
                }),
              }),
            }),
          };
        }
        return mockQueryBuilder;
      });
      getTiersWithComputedPricesMock.mockResolvedValue([]);
      insertLineItemForPartMock.mockResolvedValue({});

      await expect(
        createQuote('company-1', {
          ...baseForm,
          parts: [{ part_id: 'part-1', order_quantity: 0.32 }],
        }),
      ).resolves.toBeDefined();

      // 0.32 reaches the line-item insert intact — no integer coercion.
      expect(insertLineItemForPartMock.mock.calls[0][3]).toBe(0.32);
    });

    it('rejects order_quantity <= 0', async () => {
      await expect(
        createQuote('company-1', { ...baseForm, parts: [{ part_id: 'part-1', order_quantity: 0 }] }),
      ).rejects.toThrow('Every part needs an order quantity greater than zero.');
    });

    it('persists free-text lead time verbatim', async () => {
      const insertSpy = vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({
            data: { id: 'quote-new', company_id: 'company-1' },
            error: null,
          }),
        }),
      });
      (mockSupabase.from as ReturnType<typeof vi.fn>).mockImplementation((table: string) =>
        table === 'quotes' ? { insert: insertSpy } : mockQueryBuilder,
      );
      getTiersWithComputedPricesMock.mockResolvedValue([]);
      insertLineItemForPartMock.mockResolvedValue({});

      await createQuote('company-1', { ...baseForm, lead_time_text: '2–3 weeks' });
      expect(insertSpy.mock.calls[0][0].lead_time_text).toBe('2–3 weeks');
    });

    it('stores a blank lead time as null', async () => {
      const insertSpy = vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({
            data: { id: 'quote-new', company_id: 'company-1' },
            error: null,
          }),
        }),
      });
      (mockSupabase.from as ReturnType<typeof vi.fn>).mockImplementation((table: string) =>
        table === 'quotes' ? { insert: insertSpy } : mockQueryBuilder,
      );
      getTiersWithComputedPricesMock.mockResolvedValue([]);
      insertLineItemForPartMock.mockResolvedValue({});

      await createQuote('company-1', { ...baseForm, lead_time_text: '   ' });
      expect(insertSpy.mock.calls[0][0].lead_time_text).toBeNull();
    });

    it('forwards a per-item lead time to each of the part’s line-item inserts', async () => {
      (mockSupabase.from as ReturnType<typeof vi.fn>).mockImplementation((table: string) =>
        table === 'quotes'
          ? {
              insert: vi.fn().mockReturnValue({
                select: vi.fn().mockReturnValue({
                  single: vi.fn().mockResolvedValue({
                    data: { id: 'quote-new', company_id: 'company-1' },
                    error: null,
                  }),
                }),
              }),
            }
          : mockQueryBuilder,
      );
      getTiersWithComputedPricesMock.mockResolvedValue([]);
      insertLineItemForPartMock.mockResolvedValue({});

      await createQuote('company-1', {
        ...baseForm,
        parts: [
          { part_id: 'part-1', order_quantity: 5, lead_time_text: '2–3 weeks' },
          { part_id: 'part-1', order_quantity: 10, lead_time_text: '2–3 weeks' },
        ],
      });

      // leadTimeText is the 8th positional arg (index 7) — the same value lands
      // on every quantity row of the part (it's per-part, denormalized).
      expect(insertLineItemForPartMock.mock.calls[0][7]).toBe('2–3 weeks');
      expect(insertLineItemForPartMock.mock.calls[1][7]).toBe('2–3 weeks');
    });
  });

  describe('updateQuote', () => {
    const updateFormData: QuoteFormData = {
      customer_id: 'customer-1',
      contact_id: '',
      billing_address_id: '',
      shipping_address_id: '',
      parts: [{ part_id: 'part-1', order_quantity: 200 }],
      lead_time_text: '14 business days',
      payment_terms: '',
      expiration_date: '',
    };

    // The `pending_approval` quote status was removed in April 2026 (CLAUDE.md
    // references the simplified status enum). The `updates pending approval
    // quote successfully` test that used to live here was deleted because the
    // flow it covered no longer exists. Update happy-path coverage against the
    // metadata-only updateQuote is sub-PR 3f territory.

    // Expired quotes ARE editable now — editing reactivates them (covered in
    // the 'updateQuote — status reactivation' block below). Only converted
    // quotes remain hard-locked.
    it('rejects updating converted quotes', async () => {
      (mockSupabase.from as ReturnType<typeof vi.fn>).mockImplementation(() => ({
        ...mockQueryBuilder,
        select: vi.fn().mockReturnValue({
          ...mockQueryBuilder,
          eq: vi.fn().mockReturnValue({
            ...mockQueryBuilder,
            single: vi.fn().mockReturnValue({
              data: { status: 'active', converted_at: '2026-04-16T10:00:00Z', company_id: 'company-1' },
              error: null,
            }),
          }),
        }),
      }));

      await expect(updateQuote('quote-1', updateFormData)).rejects.toThrow(
        /converted to a job/i
      );
    });
  });

  describe('deleteQuote', () => {
    it('archives the quote via deleted_at (soft delete, no attachment cleanup)', async () => {
      const eqId = vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({ data: null, error: null }),
      });
      const updateSpy = vi.fn().mockReturnValue({ eq: eqId });
      (mockSupabase.from as ReturnType<typeof vi.fn>).mockImplementation((table) => {
        if (table === 'quotes') {
          return { ...mockQueryBuilder, update: updateSpy };
        }
        return mockQueryBuilder;
      });

      await expect(deleteQuote('quote-1', 'company-1')).resolves.toBeUndefined();

      // Archive = stamp deleted_at via .update(...), scoped by id + company —
      // never a hard .delete().
      expect(updateSpy).toHaveBeenCalledWith(
        expect.objectContaining({ deleted_at: expect.any(String) }),
      );
      expect(eqId).toHaveBeenCalledWith('id', 'quote-1');
      // Quote attachments survive the archive — storage helper must not be involved.
      expect(mockStorageHelpers.deleteFileFromStorage).not.toHaveBeenCalled();
    });
  });

  describe('bulkDeleteQuotes', () => {
    it('archives multiple quotes in batches via deleted_at', async () => {
      const inSpy = vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({ data: null, error: null }),
      });
      const updateSpy = vi.fn().mockReturnValue({ in: inSpy });
      (mockSupabase.from as ReturnType<typeof vi.fn>).mockImplementation((table) => {
        if (table === 'quotes') {
          return { ...mockQueryBuilder, update: updateSpy };
        }
        return mockQueryBuilder;
      });

      await bulkDeleteQuotes(['quote-1', 'quote-2', 'quote-3'], 'company-1');

      expect(mockSupabase.from).toHaveBeenCalledWith('quotes');
      // Archive = stamp deleted_at via .update(...), scoped by id-set + company.
      expect(updateSpy).toHaveBeenCalledWith(
        expect.objectContaining({ deleted_at: expect.any(String) }),
      );
      expect(inSpy).toHaveBeenCalledWith('id', ['quote-1', 'quote-2', 'quote-3']);
    });

    it('handles empty array gracefully', async () => {
      await bulkDeleteQuotes([], 'company-1');

      expect(mockSupabase.from).not.toHaveBeenCalled();
    });

    it('filters out invalid IDs', async () => {
      const inSpy = vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({ data: null, error: null }),
      });
      const updateSpy = vi.fn().mockReturnValue({ in: inSpy });
      (mockSupabase.from as ReturnType<typeof vi.fn>).mockImplementation((table) => {
        if (table === 'quotes') {
          return { ...mockQueryBuilder, update: updateSpy };
        }
        return mockQueryBuilder;
      });

      await bulkDeleteQuotes(
        ['valid-id', null as unknown as string, undefined as unknown as string, '', 'another-valid'],
        'company-1',
      );

      // Only the truthy string IDs reach the archive .in() clause.
      expect(inSpy).toHaveBeenCalledWith('id', ['valid-id', 'another-valid']);
    });

    // The old "throws a user-friendly error on 23503 FK violation" test was
    // removed: bulk delete now archives (stamps deleted_at) instead of hard
    // deleting, so a quote with associated jobs no longer hits an FK constraint
    // — archiving never blocks on references.
  });

  // ============== Status Transition Tests ==============
  //
  // Approval flow was removed — quotes now move through (active) → (expired)
  // → (converted via converted_to_job_id). The dedicated
  // markQuoteAsApproved/Rejected/PendingApproval functions no longer exist.
  // Tests for the new lazy-expire sweep / manual expire / cost-breakdown
  // snapshot flow should be added in a follow-up.


  // ============== Convert to Job Tests ==============

  // convertQuoteToJob produces a job that owns one job_part per converted
  // quote_line_item. A quote can be converted in SEVERAL passes (one job per
  // customer PO), so converted_at no longer blocks — instead each line can only
  // be converted once (a line already on a live job is skipped). The remaining
  // validation-layer guards: missing line items, every line already converted,
  // price-options-without-a-selection, and the required customer PO. The
  // happy-path test that mocks the full RPC chain (job insert +
  // create_job_part_operations_from_routing) is sub-PR 3f territory.
  describe('convertQuoteToJob (validation paths)', () => {
    it('rejects when every line item is already on a job', async () => {
      // A previously-converted quote whose only line is already on a live job:
      // getQuoteConversionState returns it, so there is nothing left to convert.
      (mockSupabase.from as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
        if (table === 'job_parts') {
          return {
            ...mockQueryBuilder,
            select: vi.fn().mockReturnValue({
              ...mockQueryBuilder,
              eq: vi.fn().mockReturnValue({
                ...mockQueryBuilder,
                neq: vi.fn().mockReturnValue({
                  ...mockQueryBuilder,
                  not: vi.fn().mockResolvedValue({
                    data: [
                      {
                        source_quote_line_item_id: 'li-1',
                        quantity: 5,
                        production_status: 'not_started',
                        jobs: {
                          id: 'job-1',
                          job_number: 'J-0001',
                          customer_po_number: 'PO-1',
                          quote_id: 'quote-1',
                        },
                      },
                    ],
                    error: null,
                  }),
                }),
              }),
            }),
          };
        }
        return {
          ...mockQueryBuilder,
          select: vi.fn().mockReturnValue({
            ...mockQueryBuilder,
            eq: vi.fn().mockReturnValue({
              ...mockQueryBuilder,
              single: vi.fn().mockReturnValue({
                data: {
                  ...mockQuote,
                  converted_at: '2026-04-16T10:00:00Z',
                  line_items: [
                    { id: 'li-1', part_id: 'part-A', sequence: 10, quantity: 5, unit_price: 20, total_price: 100 },
                  ],
                },
                error: null,
              }),
            }),
          }),
        };
      });

      await expect(convertQuoteToJob('quote-1', { customerPoNumber: 'PO-2' })).rejects.toThrow(
        'Every line item on this quote is already on a job',
      );
    });

    it('rejects quotes with no line items', async () => {
      (mockSupabase.from as ReturnType<typeof vi.fn>).mockImplementation(() => ({
        ...mockQueryBuilder,
        select: vi.fn().mockReturnValue({
          ...mockQueryBuilder,
          eq: vi.fn().mockReturnValue({
            ...mockQueryBuilder,
            single: vi.fn().mockReturnValue({
              data: { ...mockQuote, converted_at: null, line_items: [] },
              error: null,
            }),
          }),
        }),
      }));

      await expect(convertQuoteToJob('quote-1', { customerPoNumber: 'PO-1' })).rejects.toThrow(
        'This quote has no line items to convert.',
      );
    });

    it('rejects an options quote (2+ quantities for one part) without a selection', async () => {
      (mockSupabase.from as ReturnType<typeof vi.fn>).mockImplementation(() => ({
        ...mockQueryBuilder,
        select: vi.fn().mockReturnValue({
          ...mockQueryBuilder,
          eq: vi.fn().mockReturnValue({
            ...mockQueryBuilder,
            single: vi.fn().mockReturnValue({
              data: {
                ...mockQuote,
                converted_at: null,
                line_items: [
                  { id: 'li-1', part_id: 'part-A', sequence: 10, quantity: 5, unit_price: 20, total_price: 100 },
                  { id: 'li-2', part_id: 'part-A', sequence: 20, quantity: 10, unit_price: 18, total_price: 180 },
                ],
              },
              error: null,
            }),
          }),
        }),
      }));

      // No selectedLineItemIds → both lines for part-A would convert → guard fires.
      await expect(convertQuoteToJob('quote-1', { customerPoNumber: 'PO-1' })).rejects.toThrow('price-options quote');
    });

    it('rejects conversion when no customer PO is provided', async () => {
      // A firm, convertible quote (one line per part, not yet converted) — the
      // only thing missing is the customer PO, which is now required.
      (mockSupabase.from as ReturnType<typeof vi.fn>).mockImplementation(() => ({
        ...mockQueryBuilder,
        select: vi.fn().mockReturnValue({
          ...mockQueryBuilder,
          eq: vi.fn().mockReturnValue({
            ...mockQueryBuilder,
            single: vi.fn().mockReturnValue({
              data: {
                ...mockQuote,
                converted_at: null,
                line_items: [
                  { id: 'li-1', part_id: 'part-A', sequence: 10, quantity: 5, unit_price: 20, total_price: 100 },
                ],
              },
              error: null,
            }),
          }),
        }),
      }));

      // No customerPoNumber → guard fires before any write.
      await expect(
        convertQuoteToJob('quote-1', { customerPoNumber: '' }),
      ).rejects.toThrow('Customer PO is required');
      // Whitespace-only is also rejected.
      await expect(
        convertQuoteToJob('quote-1', { customerPoNumber: '   ' }),
      ).rejects.toThrow('Customer PO is required');
    });
  });

  // ============== updateQuote reconcile + drift detection ==============
  //
  // The boundary mocks above stub the line-item helpers; these tests
  // verify which helpers updateQuote dispatches given a particular form
  // payload vs existing DB state. The helpers' internals are covered in
  // quotePricingResolver and quoteLineItemsAccess unit tests.

  /**
   * Wire mockSupabase so updateQuote's two `from('quotes')` chains both
   * resolve successfully: first the editability check (returns active +
   * unconverted), then the metadata update (returns the row back).
   */
  function stubUpdateQuoteHappyPath(): void {
    const editableRow = {
      status: 'active',
      converted_at: null,
      company_id: 'company-1',
    };
    const updatedRow = {
      id: 'quote-1',
      company_id: 'company-1',
      status: 'active',
    };
    (mockSupabase.from as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({ data: editableRow, error: null }),
        }),
      }),
      update: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({ data: updatedRow, error: null }),
          }),
        }),
      }),
    }));
  }

  /**
   * Like stubUpdateQuoteHappyPath but lets the caller set the CURRENT db status
   * (to exercise reactivation) and returns the update() spy so a test can read
   * the payload updateQuote wrote (status / status_changed_at / expiration_date).
   */
  function stubUpdateQuoteCapture(existingStatus: 'active' | 'expired') {
    const editableRow = { status: existingStatus, converted_at: null, company_id: 'company-1' };
    const updatedRow = { id: 'quote-1', company_id: 'company-1', status: 'active' };
    const updateSpy = vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({ data: updatedRow, error: null }),
        }),
      }),
    });
    (mockSupabase.from as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({ data: editableRow, error: null }),
        }),
      }),
      update: updateSpy,
    }));
    return { updateSpy };
  }

  describe('updateQuote — reconcile (Issue #324 / #317 policy)', () => {
    const baseFormData: QuoteFormData = {
      customer_id: 'customer-1',
      contact_id: '',
      billing_address_id: '',
      shipping_address_id: '',
      parts: [],
      lead_time_text: '14 business days',
      payment_terms: '',
      expiration_date: '',
    };

    beforeEach(() => {
      getLineItemsForQuoteMock.mockReset();
      insertLineItemForPartMock.mockReset();
      updateLineItemQuantityMock.mockReset();
      updateLineItemLeadTimeMock.mockReset();
      updateLineItemOverrideMock.mockReset();
      repriceLineItemToCurrentMock.mockReset();
      deleteLineItemMock.mockReset();
      getTiersWithComputedPricesMock.mockReset();
      getTiersWithComputedPricesMock.mockResolvedValue([]);
      insertLineItemForPartMock.mockResolvedValue({});
      updateLineItemQuantityMock.mockResolvedValue({});
      updateLineItemLeadTimeMock.mockResolvedValue(undefined);
      updateLineItemOverrideMock.mockResolvedValue({});
      repriceLineItemToCurrentMock.mockResolvedValue({});
      deleteLineItemMock.mockResolvedValue(undefined);
    });

    /**
     * A custom price on an ALREADY-SAVED line. `reconcileQuoteLineItems` used to
     * read `block.override` only on the insert paths, so setting, changing or
     * clearing one on an existing line was accepted by the form and silently
     * dropped. These lock the write in.
     */
    describe('custom price on an existing line', () => {
      const savedLine = (over: Record<string, unknown> = {}) => ({
        id: 'li-A',
        quote_id: 'quote-1',
        company_id: 'company-1',
        part_id: 'part-A',
        source_tier_id: 't1',
        sequence: 10,
        quantity: 10,
        unit_price: 100,
        total_price: 1000,
        markup_percent: 50,
        base_cost_per_unit: 66.67,
        is_quote_override: false,
        pricing_basis_snapshot: {
          tiers: [{ id: 't1', quantity: 1, unit_price: 100, markup_percent: 50 }],
          resolved_tier_id: 't1',
          resolved_quantity: 10,
          captured_at: '',
        },
        basis_unknown: false,
        created_at: '2026-05-01T00:00:00Z',
        ...over,
      });

      const editWith = async (part: QuoteFormData['parts'][number]) => {
        stubUpdateQuoteHappyPath();
        await updateQuote('quote-1', { ...baseFormData, parts: [part] });
      };

      it('sets a custom price on a line that had none', async () => {
        getLineItemsForQuoteMock.mockResolvedValueOnce([savedLine()]);

        await editWith({
          part_id: 'part-A',
          order_quantity: 10,
          line_item_id: 'li-A',
          override: { unit_price: 88, markup_percent: null },
        });

        expect(updateLineItemOverrideMock).toHaveBeenCalledWith('li-A', 88);
      });

      it('changes an existing custom price', async () => {
        getLineItemsForQuoteMock.mockResolvedValueOnce([
          savedLine({ is_quote_override: true, unit_price: 88 }),
        ]);

        await editWith({
          part_id: 'part-A',
          order_quantity: 10,
          line_item_id: 'li-A',
          override: { unit_price: 95, markup_percent: null },
        });

        expect(updateLineItemOverrideMock).toHaveBeenCalledWith('li-A', 95);
      });

      it('clears a custom price back to the tier basis when the form drops it', async () => {
        getLineItemsForQuoteMock.mockResolvedValueOnce([
          savedLine({ is_quote_override: true, unit_price: 88 }),
        ]);

        await editWith({ part_id: 'part-A', order_quantity: 10, line_item_id: 'li-A' });

        expect(updateLineItemOverrideMock).toHaveBeenCalledWith('li-A', null);
      });

      it('writes nothing when the custom price is unchanged', async () => {
        getLineItemsForQuoteMock.mockResolvedValueOnce([
          savedLine({ is_quote_override: true, unit_price: 88 }),
        ]);

        await editWith({
          part_id: 'part-A',
          order_quantity: 10,
          line_item_id: 'li-A',
          override: { unit_price: 88, markup_percent: null },
        });

        expect(updateLineItemOverrideMock).not.toHaveBeenCalled();
      });

      it('leaves a plain tier-priced line alone', async () => {
        getLineItemsForQuoteMock.mockResolvedValueOnce([savedLine()]);

        await editWith({ part_id: 'part-A', order_quantity: 10, line_item_id: 'li-A' });

        expect(updateLineItemOverrideMock).not.toHaveBeenCalled();
      });

      it('applies the override AFTER a quantity change, so the typed price wins', async () => {
        getLineItemsForQuoteMock.mockResolvedValueOnce([savedLine()]);
        const order: string[] = [];
        updateLineItemQuantityMock.mockImplementation(async () => {
          order.push('qty');
          return {};
        });
        updateLineItemOverrideMock.mockImplementation(async () => {
          order.push('override');
          return {};
        });

        await editWith({
          part_id: 'part-A',
          order_quantity: 40,
          line_item_id: 'li-A',
          override: { unit_price: 77, markup_percent: null },
        });

        expect(order).toEqual(['qty', 'override']);
      });
    });

    it('reconciles line items on edit — insert new, update qty, delete removed', async () => {
      stubUpdateQuoteHappyPath();
      // DB has lines for part-A (qty 10) and part-B (qty 5).
      getLineItemsForQuoteMock.mockResolvedValueOnce([
        {
          id: 'li-A',
          quote_id: 'quote-1',
          company_id: 'company-1',
          part_id: 'part-A',
          source_tier_id: 't1',
          sequence: 10,
          quantity: 10,
          unit_price: 100,
          total_price: 1000,
          markup_percent: 50,
          base_cost_per_unit: 66.67,
          is_quote_override: false,
          pricing_basis_snapshot: { tiers: [], resolved_tier_id: 't1', resolved_quantity: 10, captured_at: '' },
          basis_unknown: false,
          created_at: '2026-05-01T00:00:00Z',
        },
        {
          id: 'li-B',
          quote_id: 'quote-1',
          company_id: 'company-1',
          part_id: 'part-B',
          source_tier_id: 't1',
          sequence: 20,
          quantity: 5,
          unit_price: 200,
          total_price: 1000,
          markup_percent: 50,
          base_cost_per_unit: 133.33,
          is_quote_override: false,
          pricing_basis_snapshot: { tiers: [], resolved_tier_id: 't1', resolved_quantity: 5, captured_at: '' },
          basis_unknown: false,
          created_at: '2026-05-01T00:00:00Z',
        },
      ]);

      // Form keeps part-A (qty bumped to 25, carries its line_item_id), drops
      // part-B (absent → delete), adds part-C (no line_item_id → insert).
      const formData: QuoteFormData = {
        ...baseFormData,
        parts: [
          { part_id: 'part-A', order_quantity: 25, line_item_id: 'li-A' },
          { part_id: 'part-C', order_quantity: 1 },
        ],
      };

      await updateQuote('quote-1', formData);

      // part-B removed → deleteLineItem called once with li-B.
      expect(deleteLineItemMock).toHaveBeenCalledTimes(1);
      expect(deleteLineItemMock).toHaveBeenCalledWith('li-B');

      // part-A kept with new qty → updateLineItemQuantity called.
      expect(updateLineItemQuantityMock).toHaveBeenCalledWith('li-A', 25);

      // part-C added → insertLineItemForPart called for it.
      expect(insertLineItemForPartMock).toHaveBeenCalledTimes(1);
      const insertArgs = insertLineItemForPartMock.mock.calls[0];
      expect(insertArgs[2]).toBe('part-C'); // partId
      expect(insertArgs[3]).toBe(1); // orderQuantity

      // Reprice is NEVER called when acceptDriftLineItemIds is empty —
      // pricing is frozen by default.
      expect(repriceLineItemToCurrentMock).not.toHaveBeenCalled();
    });

    it('unchanged lines keep snapshotted unit_price (no reprice on edit)', async () => {
      stubUpdateQuoteHappyPath();
      getLineItemsForQuoteMock.mockResolvedValueOnce([
        {
          id: 'li-A',
          quote_id: 'quote-1',
          company_id: 'company-1',
          part_id: 'part-A',
          source_tier_id: 't1',
          sequence: 10,
          quantity: 10,
          unit_price: 100,
          total_price: 1000,
          markup_percent: 50,
          base_cost_per_unit: 66.67,
          is_quote_override: false,
          pricing_basis_snapshot: { tiers: [], resolved_tier_id: 't1', resolved_quantity: 10, captured_at: '' },
          basis_unknown: false,
          created_at: '2026-05-01T00:00:00Z',
        },
      ]);

      const formData: QuoteFormData = {
        ...baseFormData,
        parts: [{ part_id: 'part-A', order_quantity: 10, line_item_id: 'li-A' }], // unchanged qty
      };

      await updateQuote('quote-1', formData);

      // No quantity change → no update.
      expect(updateLineItemQuantityMock).not.toHaveBeenCalled();
      // No drift acceptance → no reprice.
      expect(repriceLineItemToCurrentMock).not.toHaveBeenCalled();
      // No add → no insert.
      expect(insertLineItemForPartMock).not.toHaveBeenCalled();
    });

    it('persists a per-item lead-time edit even when the quantity is unchanged', async () => {
      stubUpdateQuoteHappyPath();
      getLineItemsForQuoteMock.mockResolvedValueOnce([
        {
          id: 'li-A',
          quote_id: 'quote-1',
          company_id: 'company-1',
          part_id: 'part-A',
          source_tier_id: 't1',
          sequence: 10,
          quantity: 10,
          unit_price: 100,
          total_price: 1000,
          markup_percent: 50,
          base_cost_per_unit: 66.67,
          is_quote_override: false,
          lead_time_text: null,
          pricing_basis_snapshot: { tiers: [], resolved_tier_id: 't1', resolved_quantity: 10, captured_at: '' },
          basis_unknown: false,
          created_at: '2026-05-01T00:00:00Z',
        },
      ]);

      const formData: QuoteFormData = {
        ...baseFormData,
        parts: [
          { part_id: 'part-A', order_quantity: 10, line_item_id: 'li-A', lead_time_text: '3–4 weeks' },
        ],
      };

      await updateQuote('quote-1', formData);

      // Quantity unchanged → no qty update; the lead time changed → it's written.
      expect(updateLineItemQuantityMock).not.toHaveBeenCalled();
      expect(updateLineItemLeadTimeMock).toHaveBeenCalledWith('li-A', '3–4 weeks');
    });

    it('does not write the lead time when it is unchanged (blank ⇄ null normalized)', async () => {
      stubUpdateQuoteHappyPath();
      getLineItemsForQuoteMock.mockResolvedValueOnce([
        {
          id: 'li-A',
          quote_id: 'quote-1',
          company_id: 'company-1',
          part_id: 'part-A',
          source_tier_id: 't1',
          sequence: 10,
          quantity: 10,
          unit_price: 100,
          total_price: 1000,
          markup_percent: 50,
          base_cost_per_unit: 66.67,
          is_quote_override: false,
          lead_time_text: '2 weeks',
          pricing_basis_snapshot: { tiers: [], resolved_tier_id: 't1', resolved_quantity: 10, captured_at: '' },
          basis_unknown: false,
          created_at: '2026-05-01T00:00:00Z',
        },
      ]);

      const formData: QuoteFormData = {
        ...baseFormData,
        parts: [
          { part_id: 'part-A', order_quantity: 10, line_item_id: 'li-A', lead_time_text: '2 weeks' },
        ],
      };

      await updateQuote('quote-1', formData);

      expect(updateLineItemLeadTimeMock).not.toHaveBeenCalled();
    });

    it('reprices a drifted line ONLY when acceptDriftLineItemIds includes it', async () => {
      stubUpdateQuoteHappyPath();
      getLineItemsForQuoteMock.mockResolvedValueOnce([
        {
          id: 'li-A',
          quote_id: 'quote-1',
          company_id: 'company-1',
          part_id: 'part-A',
          source_tier_id: 't1',
          sequence: 10,
          quantity: 10,
          unit_price: 100,
          total_price: 1000,
          markup_percent: 50,
          base_cost_per_unit: 66.67,
          is_quote_override: false,
          pricing_basis_snapshot: { tiers: [], resolved_tier_id: 't1', resolved_quantity: 10, captured_at: '' },
          basis_unknown: false,
          created_at: '2026-05-01T00:00:00Z',
        },
      ]);
      getTiersWithComputedPricesMock.mockResolvedValue([
        { id: 't1', part_id: 'part-A', company_id: 'company-1', sequence: 0, quantity: 1, unit_price: 110, markup_percent: 50, created_at: '', updated_at: '' },
      ]);

      const formData: QuoteFormData = {
        ...baseFormData,
        parts: [{ part_id: 'part-A', order_quantity: 10, line_item_id: 'li-A' }],
      };

      await updateQuote('quote-1', formData, { acceptDriftLineItemIds: ['li-A'] });

      expect(repriceLineItemToCurrentMock).toHaveBeenCalledTimes(1);
      expect(repriceLineItemToCurrentMock).toHaveBeenCalledWith('li-A', expect.any(Array));
    });

    it('NEVER reprices an override line, even if acceptDriftLineItemIds includes it', async () => {
      stubUpdateQuoteHappyPath();
      getLineItemsForQuoteMock.mockResolvedValueOnce([
        {
          id: 'li-A',
          quote_id: 'quote-1',
          company_id: 'company-1',
          part_id: 'part-A',
          source_tier_id: null,
          sequence: 10,
          quantity: 10,
          unit_price: 999, // user-typed override
          total_price: 9990,
          markup_percent: null,
          base_cost_per_unit: null,
          is_quote_override: true,
          pricing_basis_snapshot: { tiers: [], resolved_tier_id: null, resolved_quantity: 10, captured_at: '' },
          basis_unknown: false,
          created_at: '2026-05-01T00:00:00Z',
        },
      ]);

      const formData: QuoteFormData = {
        ...baseFormData,
        parts: [{ part_id: 'part-A', order_quantity: 10, line_item_id: 'li-A' }],
      };

      await updateQuote('quote-1', formData, { acceptDriftLineItemIds: ['li-A'] });

      // Override lines are frozen by design — reprice must NOT be called.
      expect(repriceLineItemToCurrentMock).not.toHaveBeenCalled();
    });

    it('rejects an update with an empty parts array', async () => {
      stubUpdateQuoteHappyPath();
      const formData: QuoteFormData = { ...baseFormData, parts: [] };
      await expect(updateQuote('quote-1', formData)).rejects.toThrow(
        'A quote must include at least one part.',
      );
    });

    it('allows multiple quantities for one part — adds the new quantity as a line', async () => {
      stubUpdateQuoteHappyPath();
      // DB has one line for part-A at qty 10.
      getLineItemsForQuoteMock.mockResolvedValueOnce([
        {
          id: 'li-A',
          quote_id: 'quote-1',
          company_id: 'company-1',
          part_id: 'part-A',
          source_tier_id: 't1',
          sequence: 10,
          quantity: 10,
          unit_price: 100,
          total_price: 1000,
          markup_percent: 50,
          base_cost_per_unit: 66.67,
          is_quote_override: false,
          pricing_basis_snapshot: { tiers: [], resolved_tier_id: 't1', resolved_quantity: 10, captured_at: '' },
          basis_unknown: false,
          created_at: '2026-05-01T00:00:00Z',
        },
      ]);

      // Keep the existing qty-10 line and add a second quantity (25) for the
      // same part — a price-options quote. The new entry has no line_item_id.
      const formData: QuoteFormData = {
        ...baseFormData,
        parts: [
          { part_id: 'part-A', order_quantity: 10, line_item_id: 'li-A' },
          { part_id: 'part-A', order_quantity: 25 },
        ],
      };

      await updateQuote('quote-1', formData);

      // The new quantity is inserted as its own line; nothing deleted.
      expect(insertLineItemForPartMock).toHaveBeenCalledTimes(1);
      expect(insertLineItemForPartMock.mock.calls[0][2]).toBe('part-A');
      expect(insertLineItemForPartMock.mock.calls[0][3]).toBe(25);
      expect(deleteLineItemMock).not.toHaveBeenCalled();
    });
  });

  describe('updateQuote — status reactivation', () => {
    // Computed relative to "now" so the tests don't rot as the calendar moves.
    const futureDate = new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);
    const pastDate = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);

    const formWith = (expiration_date: string): QuoteFormData => ({
      customer_id: 'customer-1',
      contact_id: '',
      billing_address_id: '',
      shipping_address_id: '',
      parts: [{ part_id: 'part-1', order_quantity: 10 }],
      lead_time_text: '14 business days',
      payment_terms: '',
      expiration_date,
    });

    beforeEach(() => {
      // reconcileQuoteLineItems runs after the metadata update; stub its helpers
      // so the save resolves. Empty existing lines → the form's part is inserted.
      getLineItemsForQuoteMock.mockReset();
      insertLineItemForPartMock.mockReset();
      updateLineItemQuantityMock.mockReset();
      repriceLineItemToCurrentMock.mockReset();
      deleteLineItemMock.mockReset();
      getTiersWithComputedPricesMock.mockReset();
      getLineItemsForQuoteMock.mockResolvedValue([]);
      getTiersWithComputedPricesMock.mockResolvedValue([]);
      insertLineItemForPartMock.mockResolvedValue({});
      updateLineItemQuantityMock.mockResolvedValue({});
      repriceLineItemToCurrentMock.mockResolvedValue({});
      deleteLineItemMock.mockResolvedValue(undefined);
    });

    it('reactivates an expired quote when the new date is in the future', async () => {
      const { updateSpy } = stubUpdateQuoteCapture('expired');

      await expect(updateQuote('quote-1', formWith(futureDate))).resolves.toBeDefined();

      const payload = updateSpy.mock.calls[0][0];
      expect(payload.status).toBe('active');
      expect(payload.expiration_date).toBe(futureDate);
      // A real transition (expired → active) stamps status_changed_at.
      expect(payload.status_changed_at).toEqual(expect.any(String));
    });

    it('keeps an expired quote expired when the saved date is still in the past', async () => {
      const { updateSpy } = stubUpdateQuoteCapture('expired');

      await updateQuote('quote-1', formWith(pastDate));

      const payload = updateSpy.mock.calls[0][0];
      expect(payload.status).toBe('expired');
      // No transition → don't churn the audit timestamp.
      expect(payload).not.toHaveProperty('status_changed_at');
    });

    it('does not restamp status_changed_at on a normal active edit', async () => {
      const { updateSpy } = stubUpdateQuoteCapture('active');

      await updateQuote('quote-1', formWith(futureDate));

      const payload = updateSpy.mock.calls[0][0];
      expect(payload.status).toBe('active');
      expect(payload).not.toHaveProperty('status_changed_at');
    });

    it('treats a blank expiration date as active (never past)', async () => {
      const { updateSpy } = stubUpdateQuoteCapture('expired');

      await updateQuote('quote-1', formWith(''));

      const payload = updateSpy.mock.calls[0][0];
      expect(payload.status).toBe('active');
      expect(payload.expiration_date).toBeNull();
      expect(payload.status_changed_at).toEqual(expect.any(String));
    });
  });

  describe('detectQuoteLineDrift', () => {
    beforeEach(() => {
      getLineItemsForQuoteMock.mockReset();
      getTiersWithComputedPricesMock.mockReset();
      detectQuoteLineDriftCallsToDb.mockReset();
    });

    it('returns flagged line IDs when current tier differs from snapshot', async () => {
      getLineItemsForQuoteMock.mockResolvedValueOnce([
        {
          id: 'li-A',
          quote_id: 'quote-1',
          company_id: 'company-1',
          part_id: 'part-A',
          source_tier_id: 't1',
          sequence: 10,
          quantity: 10,
          unit_price: 100,
          total_price: 1000,
          markup_percent: 50,
          base_cost_per_unit: 66.67,
          is_quote_override: false,
          pricing_basis_snapshot: {
            tiers: [{ id: 't1', quantity: 1, unit_price: 100, markup_percent: 50 }],
            resolved_tier_id: 't1',
            resolved_quantity: 10,
            captured_at: '2026-05-01T00:00:00Z',
          },
          basis_unknown: false,
          created_at: '2026-05-01T00:00:00Z',
        },
      ]);
      getTiersWithComputedPricesMock.mockResolvedValue([
        { id: 't1', part_id: 'part-A', company_id: 'company-1', sequence: 0, quantity: 1, unit_price: 120, markup_percent: 60, created_at: '', updated_at: '' },
      ]);

      const flagged = await detectQuoteLineDrift('quote-1');
      expect(flagged).toHaveLength(1);
      expect(flagged[0].line_item_id).toBe('li-A');
      expect(flagged[0].snapshotted_unit_price).toBe(100);
      expect(flagged[0].current_unit_price).toBe(120);
    });

    it('override lines never appear in drift set', async () => {
      getLineItemsForQuoteMock.mockResolvedValueOnce([
        {
          id: 'li-A',
          quote_id: 'quote-1',
          company_id: 'company-1',
          part_id: 'part-A',
          source_tier_id: null,
          sequence: 10,
          quantity: 10,
          unit_price: 999,
          total_price: 9990,
          markup_percent: null,
          base_cost_per_unit: null,
          is_quote_override: true,
          pricing_basis_snapshot: {
            tiers: [{ id: 't1', quantity: 1, unit_price: 100, markup_percent: 50 }],
            resolved_tier_id: null,
            resolved_quantity: 10,
            captured_at: '2026-05-01T00:00:00Z',
          },
          basis_unknown: false,
          created_at: '2026-05-01T00:00:00Z',
        },
      ]);
      getTiersWithComputedPricesMock.mockResolvedValue([
        { id: 't1', part_id: 'part-A', company_id: 'company-1', sequence: 0, quantity: 1, unit_price: 200, markup_percent: 100, created_at: '', updated_at: '' },
      ]);

      const flagged = await detectQuoteLineDrift('quote-1');
      expect(flagged).toEqual([]);
    });

    it('basis-unknown rows use degraded comparison and surface when current resolved price differs', async () => {
      getLineItemsForQuoteMock.mockResolvedValueOnce([
        {
          id: 'li-A',
          quote_id: 'quote-1',
          company_id: 'company-1',
          part_id: 'part-A',
          source_tier_id: null,
          sequence: 10,
          quantity: 10,
          unit_price: 80,
          total_price: 800,
          markup_percent: null,
          base_cost_per_unit: null,
          is_quote_override: false,
          pricing_basis_snapshot: null,
          basis_unknown: true,
          created_at: '2026-01-01T00:00:00Z',
        },
      ]);
      getTiersWithComputedPricesMock.mockResolvedValue([
        { id: 't1', part_id: 'part-A', company_id: 'company-1', sequence: 0, quantity: 1, unit_price: 100, markup_percent: 50, created_at: '', updated_at: '' },
      ]);

      const flagged = await detectQuoteLineDrift('quote-1');
      expect(flagged).toHaveLength(1);
      expect(flagged[0].basis_unknown).toBe(true);
      expect(flagged[0].snapshotted_unit_price).toBe(80);
      expect(flagged[0].current_unit_price).toBe(100);
    });
  });

  describe('repriceQuoteDriftedLinesToCurrent', () => {
    const driftedLine = {
      id: 'li-A',
      quote_id: 'quote-1',
      company_id: 'company-1',
      part_id: 'part-A',
      source_tier_id: 't1',
      sequence: 10,
      quantity: 10,
      unit_price: 100,
      total_price: 1000,
      markup_percent: 50,
      base_cost_per_unit: 66.67,
      is_quote_override: false,
      pricing_basis_snapshot: {
        tiers: [{ id: 't1', quantity: 1, unit_price: 100, markup_percent: 50 }],
        resolved_tier_id: 't1',
        resolved_quantity: 10,
        captured_at: '2026-05-01T00:00:00Z',
      },
      basis_unknown: false,
      created_at: '2026-05-01T00:00:00Z',
    };
    // Current tier moved 100 -> 120, so the snapshot drifts.
    const driftedTiers = [
      { id: 't1', part_id: 'part-A', company_id: 'company-1', sequence: 0, quantity: 1, unit_price: 120, markup_percent: 60, created_at: '', updated_at: '' },
    ];

    beforeEach(() => {
      getLineItemsForQuoteMock.mockReset();
      getTiersWithComputedPricesMock.mockReset();
      repriceLineItemToCurrentMock.mockReset();
      repriceLineItemToCurrentMock.mockResolvedValue({});
    });

    it('reprices each drifted non-override line to its current tiers', async () => {
      mockQueryBuilder.data = { status: 'active', converted_at: null, company_id: 'company-1' };
      getLineItemsForQuoteMock.mockResolvedValue([driftedLine]);
      getTiersWithComputedPricesMock.mockResolvedValue(driftedTiers);

      const result = await repriceQuoteDriftedLinesToCurrent('quote-1', 'company-1');

      expect(result.repricedLineItemIds).toEqual(['li-A']);
      expect(repriceLineItemToCurrentMock).toHaveBeenCalledTimes(1);
      expect(repriceLineItemToCurrentMock).toHaveBeenCalledWith('li-A', driftedTiers);
    });

    it('returns early without repricing when nothing has drifted', async () => {
      mockQueryBuilder.data = { status: 'active', converted_at: null, company_id: 'company-1' };
      getLineItemsForQuoteMock.mockResolvedValue([driftedLine]);
      // Current tiers match the snapshot exactly → no drift.
      getTiersWithComputedPricesMock.mockResolvedValue([
        { id: 't1', part_id: 'part-A', company_id: 'company-1', sequence: 0, quantity: 1, unit_price: 100, markup_percent: 50, created_at: '', updated_at: '' },
      ]);

      const result = await repriceQuoteDriftedLinesToCurrent('quote-1', 'company-1');

      expect(result.repricedLineItemIds).toEqual([]);
      expect(repriceLineItemToCurrentMock).not.toHaveBeenCalled();
    });

    it('refuses a converted quote and never reprices', async () => {
      mockQueryBuilder.data = {
        status: 'active',
        converted_at: '2026-06-01T00:00:00Z',
        company_id: 'company-1',
      };

      await expect(
        repriceQuoteDriftedLinesToCurrent('quote-1', 'company-1'),
      ).rejects.toThrow(/converted/i);
      expect(repriceLineItemToCurrentMock).not.toHaveBeenCalled();
    });

    it('reprices an expired quote — refreshing stale prices is the reactivation case', async () => {
      mockQueryBuilder.data = { status: 'expired', converted_at: null, company_id: 'company-1' };
      getLineItemsForQuoteMock.mockResolvedValue([driftedLine]);
      getTiersWithComputedPricesMock.mockResolvedValue(driftedTiers);

      const result = await repriceQuoteDriftedLinesToCurrent('quote-1', 'company-1');

      expect(result.repricedLineItemIds).toEqual(['li-A']);
      expect(repriceLineItemToCurrentMock).toHaveBeenCalledWith('li-A', driftedTiers);
    });

    it('throws when the quote is not found', async () => {
      mockQueryBuilder.data = null;
      await expect(
        repriceQuoteDriftedLinesToCurrent('quote-1', 'company-1'),
      ).rejects.toBeTruthy();
    });
  });

});
