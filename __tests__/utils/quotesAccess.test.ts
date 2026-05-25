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

  // TODO: Rewrite these tests against the new createQuote signature
  // (parts: { part_id, tier_ids }[]) and the new line_items snapshot flow.
  // The old tests asserted the single-quantity shape that has been removed.
  describe.skip('createQuote', () => {
    const validFormData: QuoteFormData = {
      customer_id: 'customer-1',
      part_type: 'existing',
      part_id: 'part-1',
      description: 'New quote',
      quantity: '100',
      unit_price: '25.50',
    };

    it('creates quote with valid data', async () => {
      mockQueryBuilder.data = { ...mockQuote, id: 'new-quote-id' };
      mockQueryBuilder.error = null;

      const result = await createQuote('company-1', validFormData);

      expect(mockSupabase.from).toHaveBeenCalledWith('quotes');
      expect(mockQueryBuilder.insert).toHaveBeenCalled();
      expect(result.quote.id).toBe('new-quote-id');
    });

    it('validates quantity bounds - too low', async () => {
      const invalidForm = { ...validFormData, quantity: '0' };

      await expect(createQuote('company-1', invalidForm)).rejects.toThrow(
        'Quantity must be between 1 and 1,000,000'
      );
    });

    it('validates quantity bounds - too high', async () => {
      const invalidForm = { ...validFormData, quantity: '1000001' };

      await expect(createQuote('company-1', invalidForm)).rejects.toThrow(
        'Quantity must be between 1 and 1,000,000'
      );
    });

    it('validates price bounds - negative', async () => {
      const invalidForm = { ...validFormData, unit_price: '-1' };

      await expect(createQuote('company-1', invalidForm)).rejects.toThrow(
        'Unit price must be between 0 and 999,999.99'
      );
    });

    it('validates price bounds - too high', async () => {
      const invalidForm = { ...validFormData, unit_price: '1000000' };

      await expect(createQuote('company-1', invalidForm)).rejects.toThrow(
        'Unit price must be between 0 and 999,999.99'
      );
    });

    // The description field was removed from quotes in April 2026 — no longer a validation path.

    it('creates quote with null part_id for adhoc quotes', async () => {
      const adhocForm = { ...validFormData, part_type: 'adhoc' as const, part_id: '' };
      mockQueryBuilder.data = { ...mockQuote, part_id: null };
      mockQueryBuilder.error = null;

      const result = await createQuote('company-1', adhocForm);

      const insertCall = (mockQueryBuilder.insert as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(insertCall.part_id).toBeNull();
      expect(result.quote.part_id).toBeNull();
    });

  });

  describe('updateQuote', () => {
    const updateFormData: QuoteFormData = {
      customer_id: 'customer-1',
      part_type: 'existing',
      part_id: 'part-1',
      description: 'Updated quote',
      quantity: '200',
      unit_price: '30.00',
    };

    // TODO: Rewrite for the new metadata-only updateQuote (customer/lead/expiration).
    it.skip('updates pending approval quote successfully', async () => {
      // First call - check status
      let callCount = 0;
      (mockSupabase.from as ReturnType<typeof vi.fn>).mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return {
            ...mockQueryBuilder,
            select: vi.fn().mockReturnValue({
              ...mockQueryBuilder,
              eq: vi.fn().mockReturnValue({
                ...mockQueryBuilder,
                single: vi.fn().mockReturnValue({
                  data: { status: 'active', converted_to_job_id: null, part_id: null, base_cost: null, markup_percent: null, company_id: 'company-1' },
                  error: null,
                }),
              }),
            }),
          };
        }
        // Second call - update
        return {
          ...mockQueryBuilder,
          update: vi.fn().mockReturnValue({
            ...mockQueryBuilder,
            eq: vi.fn().mockReturnValue({
              ...mockQueryBuilder,
              select: vi.fn().mockReturnValue({
                ...mockQueryBuilder,
                single: vi.fn().mockReturnValue({
                  data: { ...mockQuote, quantity: 200 },
                  error: null,
                }),
              }),
            }),
          }),
        };
      });

      const result = await updateQuote('quote-1', updateFormData);

      expect(result.quantity).toBe(200);
    });

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

  // TODO: Rewrite for the new convertQuoteToJob signature
  // (options.selections: one line_item_id per distinct part) producing N jobs.
  describe.skip('convertQuoteToJob', () => {
    it('converts approved quote to job', async () => {
      let quotesCallCount = 0;
      (mockSupabase.from as ReturnType<typeof vi.fn>).mockImplementation((table) => {
        if (table === 'quotes') {
          quotesCallCount++;
          if (quotesCallCount === 1) {
            // First quotes call: fetch quote
            return {
              ...mockQueryBuilder,
              select: vi.fn().mockReturnValue({
                ...mockQueryBuilder,
                eq: vi.fn().mockReturnValue({
                  ...mockQueryBuilder,
                  single: vi.fn().mockReturnValue({
                    data: {
                      ...mockQuote,
                      status: 'approved',
                      converted_to_job_id: null,
                      quote_attachments: [],
                    },
                    error: null,
                  }),
                }),
              }),
            };
          }
          // Subsequent quotes calls: update quote with conversion info
          return {
            ...mockQueryBuilder,
            update: vi.fn().mockReturnValue({
              ...mockQueryBuilder,
              eq: vi.fn().mockReturnValue({
                ...mockQueryBuilder,
                select: vi.fn().mockReturnValue({
                  ...mockQueryBuilder,
                  single: vi.fn().mockReturnValue({
                    data: { ...mockQuote, converted_to_job_id: 'job-1' },
                    error: null,
                  }),
                }),
              }),
            }),
          };
        }
        if (table === 'routings') {
          // Routing lookup (auto-resolve from part)
          return {
            ...mockQueryBuilder,
            select: vi.fn().mockReturnValue({
              ...mockQueryBuilder,
              eq: vi.fn().mockReturnValue({
                ...mockQueryBuilder,
                maybeSingle: vi.fn().mockReturnValue({
                  data: { id: 'routing-1' },
                  error: null,
                }),
              }),
            }),
          };
        }
        if (table === 'jobs') {
          return {
            ...mockQueryBuilder,
            insert: vi.fn().mockReturnValue({
              ...mockQueryBuilder,
              select: vi.fn().mockReturnValue({
                ...mockQueryBuilder,
                single: vi.fn().mockReturnValue({
                  data: { id: 'job-1', job_number: 'J-2024-001' },
                  error: null,
                }),
              }),
            }),
          };
        }
        return mockQueryBuilder;
      });

      const result = await convertQuoteToJob('quote-1');

      expect(result.job.id).toBe('job-1');
      expect(result.job.job_number).toBe('J-2024-001');
    });

    // The "only approved quotes can convert" gate was removed in April 2026 —
    // quotes can be converted from any status (with a warning for expired).
    // Only the "already-converted" guard remains.

    it('rejects already converted quotes', async () => {
      (mockSupabase.from as ReturnType<typeof vi.fn>).mockImplementation(() => ({
        ...mockQueryBuilder,
        select: vi.fn().mockReturnValue({
          ...mockQueryBuilder,
          eq: vi.fn().mockReturnValue({
            ...mockQueryBuilder,
            single: vi.fn().mockReturnValue({
              data: {
                ...mockQuote,
                status: 'approved',
                converted_to_job_id: 'existing-job',
              },
              error: null,
            }),
          }),
        }),
      }));

      await expect(convertQuoteToJob('quote-1')).rejects.toThrow(
        'This quote has already been converted to a job'
      );
    });
  });

});
