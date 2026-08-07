/**
 * Access layer for `company_custom_units`. Each company can extend the
 * standard unit-of-measurement list (see `lib/standardUnits.ts`) with shop-
 * specific units. Used by the UOM combobox to populate the "Custom" group.
 */

import { getSupabase } from '@/lib/supabase';
import { toFriendlyError } from '@/lib/supabaseErrors';
import type { CompanyCustomUnit } from '@/types/units';

/**
 * Fetch every custom unit defined for a company, ordered alphabetically by
 * `unit_name` so the picker shows a stable, predictable list.
 */
export async function getCompanyCustomUnits(
  companyId: string,
): Promise<CompanyCustomUnit[]> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('company_custom_units')
    .select('*')
    .eq('company_id', companyId)
    .order('unit_name', { ascending: true });

  if (error) {
    console.error('Error fetching company custom units:', error);
    throw error;
  }
  return (data || []) as CompanyCustomUnit[];
}

/**
 * Insert a new custom unit for a company. Trims the input, rejects empty
 * names, and surfaces the unique-constraint violation as a friendly error
 * (`unit_name` is unique per company at the DB level).
 */
export async function addCompanyCustomUnit(
  companyId: string,
  unitName: string,
): Promise<CompanyCustomUnit> {
  const trimmed = unitName.trim();
  if (!trimmed) {
    throw new Error('Unit name is required');
  }

  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('company_custom_units')
    .insert({ company_id: companyId, unit_name: trimmed })
    .select()
    .single();

  if (error) {
    // Postgres unique_violation. Surface a clean message rather than the raw
    // "duplicate key value violates unique constraint" wall of text.
    if (error.code === '23505') {
      throw new Error(`Unit "${trimmed}" already exists for this company`);
    }
    console.error('Error adding company custom unit:', error);
    throw toFriendlyError(error, { entity: 'unit' });
  }

  return data as CompanyCustomUnit;
}
