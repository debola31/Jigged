import { describe, it, expect, vi, beforeEach } from 'vitest';

// Use vi.hoisted to define mock variables before vi.mock is called
const { mockQueryBuilder, mockSupabase } = vi.hoisted(() => {
  // Create a chainable mock query builder
  const builder: Record<string, ReturnType<typeof vi.fn> | unknown> = {};

  const chainMethods = [
    'from',
    'select',
    'insert',
    'update',
    'upsert',
    'eq',
    'single',
  ];

  chainMethods.forEach((method) => {
    builder[method] = vi.fn().mockImplementation(() => builder);
  });

  // Terminal values
  builder.data = null;
  builder.error = null;

  const supabase = {
    from: vi.fn().mockImplementation(() => builder),
  };

  return { mockQueryBuilder: builder, mockSupabase: supabase };
});

// Mock the supabase module
vi.mock('@/lib/supabase', () => ({
  getSupabase: () => mockSupabase,
  // companyAccess.ts adopted getTypedSupabase under the typed-client rollout.
  getTypedSupabase: () => mockSupabase,
  createClient: () => mockSupabase,
  supabase: mockSupabase,
}));

// Import functions after mock setup
import {
  getUserCompanies,
  getLastCompany,
  setLastCompany,
  getPostLoginRoute,
  verifyCompanyAccess,
  getUserRole,
} from '@/utils/companyAccess';

describe('companyAccess utilities', () => {
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
  });

  // ============== getUserCompanies Tests ==============

  describe('getUserCompanies', () => {
    it('returns companies user has access to', async () => {
      const mockCompanies = [
        {
          company_id: 'company-1',
          role: 'admin',
          companies: { id: 'company-1', name: 'Acme Corp' },
        },
        {
          company_id: 'company-2',
          role: 'member',
          companies: { id: 'company-2', name: 'Widget Inc' },
        },
      ];
      mockQueryBuilder.data = mockCompanies;
      mockQueryBuilder.error = null;

      const result = await getUserCompanies('user-1');

      expect(mockSupabase.from).toHaveBeenCalledWith('user_company_access');
      expect(mockQueryBuilder.eq).toHaveBeenCalledWith('user_id', 'user-1');
      expect(result).toHaveLength(2);
      expect(result[0].role).toBe('admin');
      expect(result[1].companies.name).toBe('Widget Inc');
    });

    it('returns empty array when user has no companies', async () => {
      mockQueryBuilder.data = [];
      mockQueryBuilder.error = null;

      const result = await getUserCompanies('user-no-access');

      expect(result).toHaveLength(0);
    });

    it('throws error when database query fails', async () => {
      mockQueryBuilder.data = null;
      mockQueryBuilder.error = { message: 'Database error', code: '500' };

      await expect(getUserCompanies('user-1')).rejects.toEqual({
        message: 'Database error',
        code: '500',
      });
    });
  });

  // ============== getLastCompany Tests ==============

  describe('getLastCompany', () => {
    it('returns last company ID when exists', async () => {
      mockQueryBuilder.data = { last_company_id: 'company-1' };
      mockQueryBuilder.error = null;

      const result = await getLastCompany('user-1');

      expect(mockSupabase.from).toHaveBeenCalledWith('user_preferences');
      expect(mockQueryBuilder.eq).toHaveBeenCalledWith('user_id', 'user-1');
      expect(mockQueryBuilder.single).toHaveBeenCalled();
      expect(result).toBe('company-1');
    });

    it('returns null for new user (PGRST116 error)', async () => {
      mockQueryBuilder.data = null;
      mockQueryBuilder.error = { code: 'PGRST116', message: 'No rows found' };

      const result = await getLastCompany('new-user');

      expect(result).toBeNull();
    });

    it('returns null when data has no last_company_id', async () => {
      mockQueryBuilder.data = { last_company_id: null };
      mockQueryBuilder.error = null;

      const result = await getLastCompany('user-1');

      expect(result).toBeNull();
    });

    it('throws error for database errors other than PGRST116', async () => {
      mockQueryBuilder.data = null;
      mockQueryBuilder.error = { code: '500', message: 'Server error' };

      await expect(getLastCompany('user-1')).rejects.toEqual({
        code: '500',
        message: 'Server error',
      });
    });
  });

  // ============== setLastCompany Tests ==============

  describe('setLastCompany', () => {
    it('upserts last company preference', async () => {
      mockQueryBuilder.data = null;
      mockQueryBuilder.error = null;

      await setLastCompany('user-1', 'company-1');

      expect(mockSupabase.from).toHaveBeenCalledWith('user_preferences');
      expect(mockQueryBuilder.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          user_id: 'user-1',
          last_company_id: 'company-1',
        }),
        { onConflict: 'user_id' }
      );
    });

    it('throws error when upsert fails', async () => {
      mockQueryBuilder.data = null;
      mockQueryBuilder.error = { message: 'Upsert failed', code: '500' };

      await expect(setLastCompany('user-1', 'company-1')).rejects.toEqual({
        message: 'Upsert failed',
        code: '500',
      });
    });
  });

  // ============== getPostLoginRoute Tests ==============

  describe('getPostLoginRoute', () => {
    it('returns /no-access when user has no companies', async () => {
      mockQueryBuilder.data = [];
      mockQueryBuilder.error = null;

      const result = await getPostLoginRoute('user-no-access');

      expect(result).toBe('/no-access');
    });

    it('returns dashboard for single company user', async () => {
      (mockSupabase.from as ReturnType<typeof vi.fn>).mockImplementation((table) => {
        if (table === 'user_company_access') {
          return {
            ...mockQueryBuilder,
            select: vi.fn().mockReturnValue({
              ...mockQueryBuilder,
              eq: vi.fn().mockReturnValue({
                data: [
                  {
                    company_id: 'company-1',
                    role: 'admin',
                    companies: { id: 'company-1', name: 'Acme Corp' },
                  },
                ],
                error: null,
              }),
            }),
          };
        }
        if (table === 'user_preferences') {
          return {
            ...mockQueryBuilder,
            upsert: vi.fn().mockReturnValue({
              data: null,
              error: null,
            }),
          };
        }
        return mockQueryBuilder;
      });

      const result = await getPostLoginRoute('user-1');

      expect(result).toBe('/dashboard/company-1');
    });

    it('returns dashboard for multi-company user with valid last company', async () => {
      (mockSupabase.from as ReturnType<typeof vi.fn>).mockImplementation((table) => {
        if (table === 'user_company_access') {
          return {
            ...mockQueryBuilder,
            select: vi.fn().mockReturnValue({
              ...mockQueryBuilder,
              eq: vi.fn().mockReturnValue({
                data: [
                  {
                    company_id: 'company-1',
                    role: 'admin',
                    companies: { id: 'company-1', name: 'Acme Corp' },
                  },
                  {
                    company_id: 'company-2',
                    role: 'member',
                    companies: { id: 'company-2', name: 'Widget Inc' },
                  },
                ],
                error: null,
              }),
            }),
          };
        }
        if (table === 'user_preferences') {
          return {
            ...mockQueryBuilder,
            select: vi.fn().mockReturnValue({
              ...mockQueryBuilder,
              eq: vi.fn().mockReturnValue({
                ...mockQueryBuilder,
                single: vi.fn().mockReturnValue({
                  data: { last_company_id: 'company-2' },
                  error: null,
                }),
              }),
            }),
          };
        }
        return mockQueryBuilder;
      });

      const result = await getPostLoginRoute('user-1');

      expect(result).toBe('/dashboard/company-2');
    });

    it('returns /select-company for multi-company user with no last company', async () => {
      (mockSupabase.from as ReturnType<typeof vi.fn>).mockImplementation((table) => {
        if (table === 'user_company_access') {
          return {
            ...mockQueryBuilder,
            select: vi.fn().mockReturnValue({
              ...mockQueryBuilder,
              eq: vi.fn().mockReturnValue({
                data: [
                  {
                    company_id: 'company-1',
                    role: 'admin',
                    companies: { id: 'company-1', name: 'Acme Corp' },
                  },
                  {
                    company_id: 'company-2',
                    role: 'member',
                    companies: { id: 'company-2', name: 'Widget Inc' },
                  },
                ],
                error: null,
              }),
            }),
          };
        }
        if (table === 'user_preferences') {
          return {
            ...mockQueryBuilder,
            select: vi.fn().mockReturnValue({
              ...mockQueryBuilder,
              eq: vi.fn().mockReturnValue({
                ...mockQueryBuilder,
                single: vi.fn().mockReturnValue({
                  data: null,
                  error: { code: 'PGRST116', message: 'No rows found' },
                }),
              }),
            }),
          };
        }
        return mockQueryBuilder;
      });

      const result = await getPostLoginRoute('user-1');

      expect(result).toBe('/select-company');
    });

    it('returns /select-company when last company is no longer accessible', async () => {
      (mockSupabase.from as ReturnType<typeof vi.fn>).mockImplementation((table) => {
        if (table === 'user_company_access') {
          return {
            ...mockQueryBuilder,
            select: vi.fn().mockReturnValue({
              ...mockQueryBuilder,
              eq: vi.fn().mockReturnValue({
                data: [
                  {
                    company_id: 'company-1',
                    role: 'admin',
                    companies: { id: 'company-1', name: 'Acme Corp' },
                  },
                  {
                    company_id: 'company-2',
                    role: 'member',
                    companies: { id: 'company-2', name: 'Widget Inc' },
                  },
                ],
                error: null,
              }),
            }),
          };
        }
        if (table === 'user_preferences') {
          return {
            ...mockQueryBuilder,
            select: vi.fn().mockReturnValue({
              ...mockQueryBuilder,
              eq: vi.fn().mockReturnValue({
                ...mockQueryBuilder,
                single: vi.fn().mockReturnValue({
                  // User was removed from company-3, but still has it as last company
                  data: { last_company_id: 'company-3' },
                  error: null,
                }),
              }),
            }),
          };
        }
        return mockQueryBuilder;
      });

      const result = await getPostLoginRoute('user-1');

      expect(result).toBe('/select-company');
    });

    it('returns /select-company on error (graceful fallback)', async () => {
      (mockSupabase.from as ReturnType<typeof vi.fn>).mockImplementation(() => ({
        ...mockQueryBuilder,
        select: vi.fn().mockReturnValue({
          ...mockQueryBuilder,
          eq: vi.fn().mockReturnValue({
            data: null,
            error: { code: '500', message: 'Server error' },
          }),
        }),
      }));

      const result = await getPostLoginRoute('user-1');

      expect(result).toBe('/select-company');
    });

    it('returns /operator/ for single-company operator', async () => {
      (mockSupabase.from as ReturnType<typeof vi.fn>).mockImplementation((table) => {
        if (table === 'user_company_access') {
          return {
            ...mockQueryBuilder,
            select: vi.fn().mockReturnValue({
              ...mockQueryBuilder,
              eq: vi.fn().mockReturnValue({
                data: [
                  {
                    company_id: 'company-1',
                    role: 'operator',
                    companies: { id: 'company-1', name: 'Acme Corp' },
                  },
                ],
                error: null,
              }),
            }),
          };
        }
        if (table === 'companies') {
          return {
            ...mockQueryBuilder,
            select: vi.fn().mockReturnValue({
              ...mockQueryBuilder,
              eq: vi.fn().mockReturnValue({
                ...mockQueryBuilder,
                single: vi.fn().mockReturnValue({
                  data: { is_demo: false },
                  error: null,
                }),
              }),
            }),
          };
        }
        if (table === 'user_preferences') {
          return {
            ...mockQueryBuilder,
            upsert: vi.fn().mockReturnValue({
              data: null,
              error: null,
            }),
          };
        }
        return mockQueryBuilder;
      });

      const result = await getPostLoginRoute('operator-1');

      expect(result).toBe('/operator/company-1');
    });

    it('returns /operator/ for multi-company operator with valid last company', async () => {
      (mockSupabase.from as ReturnType<typeof vi.fn>).mockImplementation((table) => {
        if (table === 'user_company_access') {
          return {
            ...mockQueryBuilder,
            select: vi.fn().mockReturnValue({
              ...mockQueryBuilder,
              eq: vi.fn().mockReturnValue({
                data: [
                  {
                    company_id: 'company-1',
                    role: 'operator',
                    companies: { id: 'company-1', name: 'Acme Corp' },
                  },
                  {
                    company_id: 'company-2',
                    role: 'operator',
                    companies: { id: 'company-2', name: 'Widget Inc' },
                  },
                ],
                error: null,
              }),
            }),
          };
        }
        if (table === 'user_preferences') {
          return {
            ...mockQueryBuilder,
            select: vi.fn().mockReturnValue({
              ...mockQueryBuilder,
              eq: vi.fn().mockReturnValue({
                ...mockQueryBuilder,
                single: vi.fn().mockReturnValue({
                  data: { last_company_id: 'company-2' },
                  error: null,
                }),
              }),
            }),
          };
        }
        return mockQueryBuilder;
      });

      const result = await getPostLoginRoute('operator-1');

      expect(result).toBe('/operator/company-2');
    });
  });

  // ============== verifyCompanyAccess Tests ==============

  describe('verifyCompanyAccess', () => {
    it('returns true when user has access', async () => {
      mockQueryBuilder.data = { id: 'access-record-1' };
      mockQueryBuilder.error = null;

      const result = await verifyCompanyAccess('user-1', 'company-1');

      expect(mockSupabase.from).toHaveBeenCalledWith('user_company_access');
      expect(mockQueryBuilder.eq).toHaveBeenCalledWith('user_id', 'user-1');
      expect(mockQueryBuilder.eq).toHaveBeenCalledWith('company_id', 'company-1');
      expect(result).toBe(true);
    });

    it('returns false when user has no access (PGRST116)', async () => {
      mockQueryBuilder.data = null;
      mockQueryBuilder.error = { code: 'PGRST116', message: 'No rows found' };

      const result = await verifyCompanyAccess('user-1', 'company-1');

      expect(result).toBe(false);
    });

    it('returns false on database error (graceful fallback)', async () => {
      mockQueryBuilder.data = null;
      mockQueryBuilder.error = { code: '500', message: 'Server error' };

      const result = await verifyCompanyAccess('user-1', 'company-1');

      expect(result).toBe(false);
    });
  });

  // ============== getUserRole Tests ==============

  describe('getUserRole', () => {
    it('returns admin role', async () => {
      mockQueryBuilder.data = { role: 'admin' };
      mockQueryBuilder.error = null;

      const result = await getUserRole('user-1', 'company-1');

      expect(mockSupabase.from).toHaveBeenCalledWith('user_company_access');
      expect(mockQueryBuilder.eq).toHaveBeenCalledWith('user_id', 'user-1');
      expect(mockQueryBuilder.eq).toHaveBeenCalledWith('company_id', 'company-1');
      expect(result).toBe('admin');
    });

    it('returns member role', async () => {
      mockQueryBuilder.data = { role: 'member' };
      mockQueryBuilder.error = null;

      const result = await getUserRole('user-1', 'company-1');

      expect(result).toBe('member');
    });

    it('returns null when user has no access (PGRST116)', async () => {
      mockQueryBuilder.data = null;
      mockQueryBuilder.error = { code: 'PGRST116', message: 'No rows found' };

      const result = await getUserRole('user-1', 'company-1');

      expect(result).toBeNull();
    });

    it('returns null on database error (graceful fallback)', async () => {
      mockQueryBuilder.data = null;
      mockQueryBuilder.error = { code: '500', message: 'Server error' };

      const result = await getUserRole('user-1', 'company-1');

      expect(result).toBeNull();
    });

    it('returns null when role is not set', async () => {
      mockQueryBuilder.data = { role: null };
      mockQueryBuilder.error = null;

      const result = await getUserRole('user-1', 'company-1');

      expect(result).toBeNull();
    });
  });
});
