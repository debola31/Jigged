import { getSupabase } from '@/lib/supabase';
import type { PartCategory, PartCategoryFormData } from '@/types/partCategory';

/**
 * Get all part categories for a company.
 */
export async function getPartCategories(
  companyId: string,
  sortField: string = 'name',
  sortDirection: 'asc' | 'desc' = 'asc'
): Promise<PartCategory[]> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('part_categories')
    .select('*')
    .eq('company_id', companyId)
    .order(sortField, { ascending: sortDirection === 'asc' });

  if (error) {
    console.error('Error fetching part categories:', error);
    throw error;
  }

  return data || [];
}

/**
 * Get all part categories with parts count.
 */
export async function getPartCategoriesWithCounts(
  companyId: string
): Promise<PartCategory[]> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('part_categories')
    .select('*, parts(count)')
    .eq('company_id', companyId)
    .order('name', { ascending: true });

  if (error) {
    console.error('Error fetching part categories with counts:', error);
    throw error;
  }

  return (data || []).map((cat: Record<string, unknown>) => {
    const partsAgg = cat.parts as Array<{ count: number }> | undefined;
    const partsCount = partsAgg?.[0]?.count ?? 0;
    return {
      id: cat.id as string,
      company_id: cat.company_id as string,
      name: cat.name as string,
      default_markup_percent: cat.default_markup_percent as number | null,
      description: cat.description as string | null,
      created_at: cat.created_at as string,
      updated_at: cat.updated_at as string,
      parts_count: partsCount,
    };
  });
}

/**
 * Lightweight categories query for dropdowns.
 */
export async function getPartCategoriesForSelect(
  companyId: string
): Promise<Array<{ id: string; name: string; default_markup_percent: number | null }>> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('part_categories')
    .select('id, name, default_markup_percent')
    .eq('company_id', companyId)
    .order('name', { ascending: true });

  if (error) {
    console.error('Error fetching part categories for select:', error);
    throw error;
  }

  return data || [];
}

/**
 * Create a new part category.
 */
export async function createPartCategory(
  companyId: string,
  formData: PartCategoryFormData
): Promise<PartCategory> {
  const supabase = getSupabase();

  const markupPercent = formData.default_markup_percent.trim()
    ? parseFloat(formData.default_markup_percent)
    : null;

  const { data, error } = await supabase
    .from('part_categories')
    .insert({
      company_id: companyId,
      name: formData.name.trim(),
      default_markup_percent: markupPercent,
      description: formData.description.trim() || null,
    })
    .select()
    .single();

  if (error) {
    console.error('Error creating part category:', error);
    throw error;
  }

  return data;
}

/**
 * Update an existing part category.
 */
export async function updatePartCategory(
  categoryId: string,
  formData: PartCategoryFormData
): Promise<PartCategory> {
  const supabase = getSupabase();

  const markupPercent = formData.default_markup_percent.trim()
    ? parseFloat(formData.default_markup_percent)
    : null;

  const { data, error } = await supabase
    .from('part_categories')
    .update({
      name: formData.name.trim(),
      default_markup_percent: markupPercent,
      description: formData.description.trim() || null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', categoryId)
    .select()
    .single();

  if (error) {
    console.error('Error updating part category:', error);
    throw error;
  }

  return data;
}

/**
 * Delete a part category.
 * Parts with this category will have category_id set to NULL (ON DELETE SET NULL).
 */
export async function deletePartCategory(categoryId: string): Promise<void> {
  const supabase = getSupabase();

  const { error } = await supabase
    .from('part_categories')
    .delete()
    .eq('id', categoryId);

  if (error) {
    console.error('Error deleting part category:', error);
    throw error;
  }
}
