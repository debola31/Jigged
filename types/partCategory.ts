/**
 * Part category record from database
 */
export interface PartCategory {
  id: string;
  company_id: string;
  name: string;
  default_markup_percent: number | null;
  description: string | null;
  created_at: string;
  updated_at: string;
  // Optional relation counts (populated by getPartCategoriesWithCounts)
  parts_count?: number;
}

/**
 * Form data for creating/editing part categories
 */
export interface PartCategoryFormData {
  name: string;
  default_markup_percent: string;
  description: string;
}

/**
 * Empty form defaults for NEW part categories only
 */
export const EMPTY_CATEGORY_FORM: PartCategoryFormData = {
  name: '',
  default_markup_percent: '',
  description: '',
};

/**
 * Convert PartCategory to PartCategoryFormData for edit forms.
 */
export function partCategoryToFormData(category: PartCategory): PartCategoryFormData {
  return {
    name: category.name,
    default_markup_percent: category.default_markup_percent?.toString() ?? '',
    description: category.description || '',
  };
}
