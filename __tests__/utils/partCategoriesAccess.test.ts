import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PartCategoryFormData } from '@/types/partCategory';

// Mock Supabase
const { mockQueryBuilder, mockSupabase } = vi.hoisted(() => {
  const builder: Record<string, ReturnType<typeof vi.fn> | unknown> = {};

  const chainMethods = [
    'from',
    'select',
    'insert',
    'update',
    'delete',
    'eq',
    'order',
    'single',
  ];

  chainMethods.forEach((method) => {
    builder[method] = vi.fn().mockImplementation(() => builder);
  });

  builder['data'] = null;
  builder['error'] = null;

  const supabase = { from: vi.fn().mockImplementation(() => builder) };
  return { mockQueryBuilder: builder, mockSupabase: supabase };
});

vi.mock('@/lib/supabase', () => ({
  getSupabase: () => mockSupabase,
}));

import {
  getPartCategories,
  getPartCategoriesWithCounts,
  getPartCategoriesForSelect,
  createPartCategory,
  updatePartCategory,
  deletePartCategory,
} from '@/utils/partCategoriesAccess';

describe('partCategoriesAccess', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockQueryBuilder.data = null;
    mockQueryBuilder.error = null;
  });

  describe('getPartCategories', () => {
    it('returns categories for a company', async () => {
      const mockCategories = [
        { id: 'cat-1', company_id: 'co-1', name: 'Machined', default_markup_percent: 35 },
        { id: 'cat-2', company_id: 'co-1', name: 'Tooling', default_markup_percent: 40 },
      ];
      mockQueryBuilder.data = mockCategories;

      const result = await getPartCategories('co-1');

      expect(mockSupabase.from).toHaveBeenCalledWith('part_categories');
      expect(result).toEqual(mockCategories);
    });

    it('throws on error', async () => {
      mockQueryBuilder.error = { message: 'DB error', code: '500' };

      await expect(getPartCategories('co-1')).rejects.toEqual(
        expect.objectContaining({ message: 'DB error' })
      );
    });

    it('returns empty array when no categories exist', async () => {
      mockQueryBuilder.data = [];

      const result = await getPartCategories('co-1');
      expect(result).toEqual([]);
    });
  });

  describe('getPartCategoriesWithCounts', () => {
    it('returns categories with parts_count', async () => {
      mockQueryBuilder.data = [
        {
          id: 'cat-1',
          company_id: 'co-1',
          name: 'Machined',
          default_markup_percent: 35,
          description: null,
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-01T00:00:00Z',
          parts: [{ count: 5 }],
        },
      ];

      const result = await getPartCategoriesWithCounts('co-1');

      expect(result).toHaveLength(1);
      expect(result[0].parts_count).toBe(5);
      expect(result[0].name).toBe('Machined');
    });

    it('defaults parts_count to 0 when no parts', async () => {
      mockQueryBuilder.data = [
        {
          id: 'cat-1',
          company_id: 'co-1',
          name: 'Empty',
          default_markup_percent: null,
          description: null,
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-01T00:00:00Z',
          parts: [],
        },
      ];

      const result = await getPartCategoriesWithCounts('co-1');
      expect(result[0].parts_count).toBe(0);
    });
  });

  describe('getPartCategoriesForSelect', () => {
    it('returns lightweight category data', async () => {
      mockQueryBuilder.data = [
        { id: 'cat-1', name: 'Machined', default_markup_percent: 35 },
      ];

      const result = await getPartCategoriesForSelect('co-1');

      expect(result).toEqual([{ id: 'cat-1', name: 'Machined', default_markup_percent: 35 }]);
    });
  });

  describe('createPartCategory', () => {
    it('creates category with valid data', async () => {
      const formData: PartCategoryFormData = {
        name: 'Precision Machined',
        default_markup_percent: '35',
        description: 'CNC parts',
      };

      const mockCreated = {
        id: 'new-cat-id',
        company_id: 'co-1',
        name: 'Precision Machined',
        default_markup_percent: 35,
        description: 'CNC parts',
      };
      mockQueryBuilder.data = mockCreated;

      const result = await createPartCategory('co-1', formData);

      expect(mockSupabase.from).toHaveBeenCalledWith('part_categories');
      expect(result).toEqual(mockCreated);
    });

    it('handles empty markup_percent as null', async () => {
      const formData: PartCategoryFormData = {
        name: 'No Markup',
        default_markup_percent: '',
        description: '',
      };

      mockQueryBuilder.data = {
        id: 'new-cat-id',
        company_id: 'co-1',
        name: 'No Markup',
        default_markup_percent: null,
        description: null,
      };

      const result = await createPartCategory('co-1', formData);
      expect(result.default_markup_percent).toBeNull();
    });

    it('throws on error', async () => {
      mockQueryBuilder.error = { message: 'Duplicate name', code: '23505' };

      await expect(
        createPartCategory('co-1', { name: 'Dup', default_markup_percent: '', description: '' })
      ).rejects.toEqual(expect.objectContaining({ message: 'Duplicate name' }));
    });
  });

  describe('updatePartCategory', () => {
    it('updates category successfully', async () => {
      const formData: PartCategoryFormData = {
        name: 'Updated Name',
        default_markup_percent: '40',
        description: 'Updated desc',
      };

      mockQueryBuilder.data = {
        id: 'cat-1',
        company_id: 'co-1',
        name: 'Updated Name',
        default_markup_percent: 40,
        description: 'Updated desc',
      };

      const result = await updatePartCategory('cat-1', formData);

      expect(mockSupabase.from).toHaveBeenCalledWith('part_categories');
      expect(result.name).toBe('Updated Name');
      expect(result.default_markup_percent).toBe(40);
    });
  });

  describe('deletePartCategory', () => {
    it('deletes category successfully', async () => {
      mockQueryBuilder.error = null;

      await expect(deletePartCategory('cat-1')).resolves.toBeUndefined();
      expect(mockSupabase.from).toHaveBeenCalledWith('part_categories');
    });

    it('throws on error', async () => {
      mockQueryBuilder.error = { message: 'Not found', code: 'PGRST116' };

      await expect(deletePartCategory('cat-1')).rejects.toEqual(
        expect.objectContaining({ message: 'Not found' })
      );
    });
  });
});
