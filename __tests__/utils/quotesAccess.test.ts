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

// Mock the supabase module. quotesAccess.ts adopted getTypedSupabase
// (typed-client rollout); include it here returning the same chainable
// mock so the existing tests keep working without rewriting fixtures.
vi.mock('@/lib/supabase', () => ({
  getSupabase: () => mockSupabase,
  getTypedSupabase: () => mockSupabase,
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
  repriceLineItemToCurrentMock,
  deleteLineItemMock,
  getTiersWithComputedPricesMock,
  detectQuoteLineDriftCallsToDb,
} = vi.hoisted(() => ({
  getLineItemsForQuoteMock: vi.fn(),
  insertLineItemForPartMock: vi.fn(),
  updateLineItemQuantityMock: vi.fn(),
  repriceLineItemToCurrentMock: vi.fn(),
  deleteLineItemMock: vi.fn(),
  getTiersWithComputedPricesMock: vi.fn(),
  detectQuoteLineDriftCallsToDb: vi.fn(),
}));

vi.mock('@/utils/quoteLineItemsAccess', () => ({
  getLineItemsForQuote: getLineItemsForQuoteMock,
  insertLineItemForPart: insertLineItemForPartMock,
  updateLineItemQuantity: updateLineItemQuantityMock,
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
} from '@/utils/quotesAccess';

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
      lead_time_value: '14',
      lead_time_unit: 'business_days',
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

    it('rejects order_quantity <= 0', async () => {
      await expect(
        createQuote('company-1', { ...baseForm, parts: [{ part_id: 'part-1', order_quantity: 0 }] }),
      ).rejects.toThrow('Every part needs an order quantity greater than zero.');
    });

    it('rejects a lead time that normalizes to > 3650 days', async () => {
      // 5000 business days → ceil(5000 * 7/5) = 7000 calendar days.
      await expect(
        createQuote('company-1', { ...baseForm, lead_time_value: '5000' }),
      ).rejects.toThrow('Lead time must be 3,650 days or fewer.');
    });

    it('rejects a negative lead time value', async () => {
      await expect(
        createQuote('company-1', { ...baseForm, lead_time_value: '-5' }),
      ).rejects.toThrow('Lead time must be a whole number');
    });
  });

  describe('updateQuote', () => {
    const updateFormData: QuoteFormData = {
      customer_id: 'customer-1',
      contact_id: '',
      billing_address_id: '',
      shipping_address_id: '',
      parts: [{ part_id: 'part-1', order_quantity: 200 }],
      lead_time_value: '14',
      lead_time_unit: 'business_days',
      payment_terms: '',
      expiration_date: '',
    };

    // The `pending_approval` quote status was removed in April 2026 (CLAUDE.md
    // references the simplified status enum). The `updates pending approval
    // quote successfully` test that used to live here was deleted because the
    // flow it covered no longer exists. Update happy-path coverage against the
    // metadata-only updateQuote is sub-PR 3f territory.

    it('rejects updating expired quotes', async () => {
      (mockSupabase.from as ReturnType<typeof vi.fn>).mockImplementation(() => ({
        ...mockQueryBuilder,
        select: vi.fn().mockReturnValue({
          ...mockQueryBuilder,
          eq: vi.fn().mockReturnValue({
            ...mockQueryBuilder,
            single: vi.fn().mockReturnValue({
              data: { status: 'expired', converted_to_job_id: null, part_id: null, base_cost: null, markup_percent: null, company_id: 'company-1' },
              error: null,
            }),
          }),
        }),
      }));

      await expect(updateQuote('quote-1', updateFormData)).rejects.toThrow(
        'This quote cannot be edited'
      );
    });

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
        'This quote cannot be edited'
      );
    });
  });

  describe('deleteQuote', () => {
    it('deletes the quote row (no attachment cleanup)', async () => {
      (mockSupabase.from as ReturnType<typeof vi.fn>).mockImplementation((table) => {
        if (table === 'quotes') {
          return {
            ...mockQueryBuilder,
            delete: vi.fn().mockReturnValue({
              ...mockQueryBuilder,
              eq: vi.fn().mockReturnValue({
                ...mockQueryBuilder,
                eq: vi.fn().mockReturnValue({
                  data: null,
                  error: null,
                }),
              }),
            }),
          };
        }
        return mockQueryBuilder;
      });

      await expect(deleteQuote('quote-1', 'company-1')).resolves.toBeUndefined();
      // Quote attachments are gone — storage helper must not be involved.
      expect(mockStorageHelpers.deleteFileFromStorage).not.toHaveBeenCalled();
    });
  });

  describe('bulkDeleteQuotes', () => {
    it('deletes multiple quotes in batches', async () => {
      (mockSupabase.from as ReturnType<typeof vi.fn>).mockImplementation((table) => {
        if (table === 'quote_attachments') {
          return {
            ...mockQueryBuilder,
            select: vi.fn().mockReturnValue({
              ...mockQueryBuilder,
              in: vi.fn().mockReturnValue({
                ...mockQueryBuilder,
                eq: vi.fn().mockReturnValue({
                  data: [],
                  error: null,
                }),
              }),
            }),
          };
        }
        if (table === 'quotes') {
          return {
            ...mockQueryBuilder,
            delete: vi.fn().mockReturnValue({
              ...mockQueryBuilder,
              in: vi.fn().mockReturnValue({
                ...mockQueryBuilder,
                eq: vi.fn().mockReturnValue({
                  data: null,
                  error: null,
                }),
              }),
            }),
          };
        }
        return mockQueryBuilder;
      });

      await bulkDeleteQuotes(['quote-1', 'quote-2', 'quote-3'], 'company-1');

      expect(mockSupabase.from).toHaveBeenCalledWith('quotes');
    });

    it('handles empty array gracefully', async () => {
      await bulkDeleteQuotes([], 'company-1');

      expect(mockSupabase.from).not.toHaveBeenCalled();
    });

    it('filters out invalid IDs', async () => {
      (mockSupabase.from as ReturnType<typeof vi.fn>).mockImplementation((table) => {
        if (table === 'quote_attachments') {
          return {
            ...mockQueryBuilder,
            select: vi.fn().mockReturnValue({
              ...mockQueryBuilder,
              in: vi.fn().mockReturnValue({
                ...mockQueryBuilder,
                eq: vi.fn().mockReturnValue({
                  data: [],
                  error: null,
                }),
              }),
            }),
          };
        }
        return {
          ...mockQueryBuilder,
          delete: vi.fn().mockReturnValue({
            ...mockQueryBuilder,
            in: vi.fn().mockReturnValue({
              ...mockQueryBuilder,
              eq: vi.fn().mockReturnValue({
                data: null,
                error: null,
              }),
            }),
          }),
        };
      });

      await bulkDeleteQuotes(
        ['valid-id', null as unknown as string, undefined as unknown as string, '', 'another-valid'],
        'company-1',
      );

      // Should only call with valid IDs
      expect(mockSupabase.from).toHaveBeenCalled();
    });

    it('throws user-friendly error on FK constraint violation', async () => {
      (mockSupabase.from as ReturnType<typeof vi.fn>).mockImplementation((table) => {
        if (table === 'quote_attachments') {
          return {
            ...mockQueryBuilder,
            select: vi.fn().mockReturnValue({
              ...mockQueryBuilder,
              in: vi.fn().mockReturnValue({
                ...mockQueryBuilder,
                eq: vi.fn().mockReturnValue({
                  data: [],
                  error: null,
                }),
              }),
            }),
          };
        }
        return {
          ...mockQueryBuilder,
          delete: vi.fn().mockReturnValue({
            ...mockQueryBuilder,
            in: vi.fn().mockReturnValue({
              ...mockQueryBuilder,
              eq: vi.fn().mockReturnValue({
                data: null,
                error: { code: '23503', message: 'FK violation' },
              }),
            }),
          }),
        };
      });

      await expect(bulkDeleteQuotes(['quote-1'], 'company-1')).rejects.toThrow(
        'Cannot delete some quotes because they have associated jobs.'
      );
    });
  });

  // ============== Status Transition Tests ==============
  //
  // Approval flow was removed — quotes now move through (active) → (expired)
  // → (converted via converted_to_job_id). The dedicated
  // markQuoteAsApproved/Rejected/PendingApproval functions no longer exist.
  // Tests for the new lazy-expire sweep / manual expire / cost-breakdown
  // snapshot flow should be added in a follow-up.


  // ============== Convert to Job Tests ==============

  // convertQuoteToJob produces ONE job that owns one job_part per
  // quote_line_item. The "only approved quotes can convert" gate was removed
  // in April 2026; only the already-converted and missing-line-items guards
  // remain at the validation layer. The happy-path test that mocks the full
  // RPC chain (job insert + create_job_part_operations_from_routing) is
  // sub-PR 3f territory.
  describe('convertQuoteToJob (validation paths)', () => {
    it('rejects already-converted quotes', async () => {
      (mockSupabase.from as ReturnType<typeof vi.fn>).mockImplementation(() => ({
        ...mockQueryBuilder,
        select: vi.fn().mockReturnValue({
          ...mockQueryBuilder,
          eq: vi.fn().mockReturnValue({
            ...mockQueryBuilder,
            single: vi.fn().mockReturnValue({
              data: {
                ...mockQuote,
                converted_at: '2026-04-16T10:00:00Z',
                line_items: [],
              },
              error: null,
            }),
          }),
        }),
      }));

      await expect(convertQuoteToJob('quote-1', { customerPoNumber: 'PO-1' })).rejects.toThrow(
        'This quote has already been converted to a job',
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

  describe('updateQuote — reconcile (Issue #324 / #317 policy)', () => {
    const baseFormData: QuoteFormData = {
      customer_id: 'customer-1',
      contact_id: '',
      billing_address_id: '',
      shipping_address_id: '',
      parts: [],
      lead_time_value: '14',
      lead_time_unit: 'business_days',
      payment_terms: '',
      expiration_date: '',
    };

    beforeEach(() => {
      getLineItemsForQuoteMock.mockReset();
      insertLineItemForPartMock.mockReset();
      updateLineItemQuantityMock.mockReset();
      repriceLineItemToCurrentMock.mockReset();
      deleteLineItemMock.mockReset();
      getTiersWithComputedPricesMock.mockReset();
      getTiersWithComputedPricesMock.mockResolvedValue([]);
      insertLineItemForPartMock.mockResolvedValue({});
      updateLineItemQuantityMock.mockResolvedValue({});
      repriceLineItemToCurrentMock.mockResolvedValue({});
      deleteLineItemMock.mockResolvedValue(undefined);
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

});
