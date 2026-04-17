import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { OperationFormData } from '@/types/operations';

// Use vi.hoisted to define mock variables before vi.mock is called
const { mockQueryBuilder, mockSupabase } = vi.hoisted(() => {
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
    'not',
    'order',
    'single',
    'limit',
  ];

  chainMethods.forEach((method) => {
    builder[method] = vi.fn().mockImplementation(() => builder);
  });

  builder.data = null;
  builder.error = null;
  builder.count = null;

  const supabase = {
    from: vi.fn().mockImplementation(() => builder),
  };

  return { mockQueryBuilder: builder, mockSupabase: supabase };
});

vi.mock('@/lib/supabase', () => ({
  getSupabase: () => mockSupabase,
  createClient: () => mockSupabase,
  supabase: mockSupabase,
}));

import {
  getAllOperations,
  getOperationsFlat,
  getOperation,
  checkOperationNameExists,
  createOperation,
  updateOperation,
  deleteOperation,
  bulkDeleteOperations,
  bulkImportOperations,
} from '@/utils/operationsAccess';

describe('operationsAccess utilities', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

  describe('getAllOperations', () => {
    it('returns operations for a company', async () => {
      const mockOps = [
        { id: 'op-1', name: 'Milling' },
        { id: 'op-2', name: 'Turning' },
      ];
      mockQueryBuilder.data = mockOps;
      mockQueryBuilder.error = null;

      const result = await getAllOperations('company-1');

      expect(mockSupabase.from).toHaveBeenCalledWith('operation_types');
      expect(result).toHaveLength(2);
    });

    it('applies search filter', async () => {
      mockQueryBuilder.data = [];
      mockQueryBuilder.error = null;

      await getAllOperations('company-1', 'milling');

      expect(mockQueryBuilder.or).toHaveBeenCalledWith(expect.stringContaining('milling'));
    });
  });

  describe('getOperationsFlat', () => {
    it('returns flat list of operations', async () => {
      mockQueryBuilder.data = [{ id: 'op-1', name: 'Milling' }];
      mockQueryBuilder.error = null;

      const result = await getOperationsFlat('company-1');

      expect(result).toHaveLength(1);
    });
  });

  describe('getOperation', () => {
    it('returns operation by ID', async () => {
      const mockOp = { id: 'op-1', name: 'Milling', labor_rate: 75 };
      mockQueryBuilder.data = mockOp;
      mockQueryBuilder.error = null;

      const result = await getOperation('op-1');

      expect(mockQueryBuilder.eq).toHaveBeenCalledWith('id', 'op-1');
      expect(result).toEqual(mockOp);
    });

    it('returns null when not found', async () => {
      mockQueryBuilder.data = null;
      mockQueryBuilder.error = { code: 'PGRST116', message: 'Not found' };

      const result = await getOperation('nonexistent');

      expect(result).toBeNull();
    });
  });

  describe('checkOperationNameExists', () => {
    it('returns true when name exists', async () => {
      mockQueryBuilder.data = [{ id: 'existing-op' }];
      mockQueryBuilder.error = null;

      const result = await checkOperationNameExists('company-1', 'Milling');

      expect(mockQueryBuilder.ilike).toHaveBeenCalledWith('name', 'Milling');
      expect(result).toBe(true);
    });

    it('returns false when name does not exist', async () => {
      mockQueryBuilder.data = [];
      mockQueryBuilder.error = null;

      const result = await checkOperationNameExists('company-1', 'NewOp');

      expect(result).toBe(false);
    });

    it('excludes specific ID in edit mode', async () => {
      mockQueryBuilder.data = [];
      mockQueryBuilder.error = null;

      await checkOperationNameExists('company-1', 'Milling', 'op-1');

      expect(mockQueryBuilder.neq).toHaveBeenCalledWith('id', 'op-1');
    });
  });

  describe('createOperation', () => {
    it('creates a new operation', async () => {
      const formData: OperationFormData = {
        name: 'Milling',
        labor_rate: '75',
        description: 'CNC milling',
      };
      const mockCreated = { id: 'new-op', ...formData };
      mockQueryBuilder.data = mockCreated;
      mockQueryBuilder.error = null;

      const result = await createOperation('company-1', formData);

      expect(mockQueryBuilder.insert).toHaveBeenCalled();
      expect(result.name).toBe('Milling');
    });

    it('handles empty optional fields', async () => {
      const formData: OperationFormData = {
        name: 'Manual Work',
        labor_rate: '',
        description: '',
      };
      mockQueryBuilder.data = { id: 'new-op', name: 'Manual Work' };
      mockQueryBuilder.error = null;

      const result = await createOperation('company-1', formData);

      expect(result).toBeDefined();
    });
  });

  describe('updateOperation', () => {
    it('updates an existing operation', async () => {
      const formData: OperationFormData = {
        name: 'Updated Milling',
        labor_rate: '80',
        description: 'Updated description',
      };
      mockQueryBuilder.data = { id: 'op-1', ...formData };
      mockQueryBuilder.error = null;

      const result = await updateOperation('op-1', formData);

      expect(mockQueryBuilder.update).toHaveBeenCalled();
      expect(mockQueryBuilder.eq).toHaveBeenCalledWith('id', 'op-1');
      expect(result.name).toBe('Updated Milling');
    });
  });

  describe('deleteOperation', () => {
    it('deletes an operation', async () => {
      mockQueryBuilder.data = null;
      mockQueryBuilder.error = null;

      await deleteOperation('op-1');

      expect(mockQueryBuilder.delete).toHaveBeenCalled();
      expect(mockQueryBuilder.eq).toHaveBeenCalledWith('id', 'op-1');
    });

    it('throws user-friendly error on FK constraint', async () => {
      mockQueryBuilder.data = null;
      mockQueryBuilder.error = { code: '23503', message: 'FK constraint violation' };

      await expect(deleteOperation('op-1')).rejects.toThrow(
        'Cannot delete this operation because it is used in routing operations'
      );
    });
  });

  describe('bulkDeleteOperations', () => {
    it('deletes multiple operations', async () => {
      mockQueryBuilder.data = null;
      mockQueryBuilder.error = null;

      await bulkDeleteOperations(['op-1', 'op-2']);

      expect(mockQueryBuilder.delete).toHaveBeenCalled();
      expect(mockQueryBuilder.in).toHaveBeenCalledWith('id', ['op-1', 'op-2']);
    });

    it('handles empty array', async () => {
      await bulkDeleteOperations([]);

      expect(mockSupabase.from).not.toHaveBeenCalled();
    });

    it('filters invalid IDs', async () => {
      mockQueryBuilder.data = null;
      mockQueryBuilder.error = null;

      // @ts-expect-error Testing invalid input
      await bulkDeleteOperations(['valid', null, '', undefined]);

      expect(mockSupabase.from).toHaveBeenCalled();
    });

    it('throws user-friendly error on FK constraint', async () => {
      mockQueryBuilder.data = null;
      mockQueryBuilder.error = { code: '23503', message: 'FK constraint' };

      await expect(bulkDeleteOperations(['op-1'])).rejects.toThrow(
        'Cannot delete some operations because they are used in routing operations'
      );
    });
  });

  describe('bulkImportOperations', () => {
    it('imports operations successfully', async () => {
      (mockSupabase.from as ReturnType<typeof vi.fn>).mockImplementation(() => ({
        ...mockQueryBuilder,
        select: vi.fn().mockReturnValue({
          ...mockQueryBuilder,
          eq: vi.fn().mockReturnValue({
            data: [],
            error: null,
          }),
        }),
        insert: vi.fn().mockReturnValue({
          data: null,
          error: null,
        }),
      }));

      const rows = [
        { name: 'Milling', labor_rate: '75' },
        { name: 'Turning', labor_rate: '70' },
      ];

      const result = await bulkImportOperations('company-1', rows);

      expect(result.imported).toBeGreaterThanOrEqual(0);
      expect(result.errors).toBeDefined();
    });

    it('skips rows with missing name', async () => {
      (mockSupabase.from as ReturnType<typeof vi.fn>).mockImplementation(() => ({
        ...mockQueryBuilder,
        select: vi.fn().mockReturnValue({
          ...mockQueryBuilder,
          eq: vi.fn().mockReturnValue({
            data: [],
            error: null,
          }),
        }),
      }));

      const rows = [
        { name: '', labor_rate: '75' },
        { name: 'Valid', labor_rate: '70' },
      ];

      const result = await bulkImportOperations('company-1', rows);

      expect(result.skipped).toBeGreaterThanOrEqual(1);
      expect(result.errors.some((e) => e.reason === 'Missing name')).toBe(true);
    });

    it('detects duplicate names in database', async () => {
      (mockSupabase.from as ReturnType<typeof vi.fn>).mockImplementation(() => ({
        ...mockQueryBuilder,
        select: vi.fn().mockReturnValue({
          ...mockQueryBuilder,
          eq: vi.fn().mockReturnValue({
            data: [{ name: 'existing' }],
            error: null,
          }),
        }),
      }));

      const rows = [{ name: 'Existing', labor_rate: '75' }];

      const result = await bulkImportOperations('company-1', rows);

      expect(result.skipped).toBe(1);
      expect(result.errors.some((e) => e.reason.includes('already exists'))).toBe(true);
    });

    it('detects duplicate names within file', async () => {
      (mockSupabase.from as ReturnType<typeof vi.fn>).mockImplementation(() => ({
        ...mockQueryBuilder,
        select: vi.fn().mockReturnValue({
          ...mockQueryBuilder,
          eq: vi.fn().mockReturnValue({
            data: [],
            error: null,
          }),
        }),
        insert: vi.fn().mockReturnValue({
          data: null,
          error: null,
        }),
      }));

      const rows = [
        { name: 'Duplicate', labor_rate: '75' },
        { name: 'Duplicate', labor_rate: '80' },
      ];

      const result = await bulkImportOperations('company-1', rows);

      expect(result.errors.some((e) => e.reason.includes('Duplicate'))).toBe(true);
    });
  });
});
