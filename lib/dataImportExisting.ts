/**
 * Bounded, RLS-scoped read of the identity values already in Jigged for a company, so the
 * Import step can show new-vs-existing and offer create/update modes. Read-only and best-
 * effort: a failed read yields an empty set for that entity (its rows are treated as new).
 * Only the name-like-identity entities are fetched (parts/vendors/work_centers/customers).
 */

import type { EntityType } from '@/types/data-import';
import type { ExistingIdentities } from '@/lib/dataImportReconcile';
import { getSupabase } from '@/lib/supabase';

const IDENTITY_SOURCES: { entity: EntityType; table: string; column: string }[] = [
  { entity: 'vendors', table: 'vendors', column: 'name' },
  { entity: 'parts', table: 'parts', column: 'part_name' },
  { entity: 'work_centers', table: 'work_centers', column: 'name' },
  { entity: 'customers', table: 'customers', column: 'name' },
];

export async function fetchExistingIdentities(companyId: string): Promise<ExistingIdentities> {
  const supabase = getSupabase();
  const out: ExistingIdentities = {};
  await Promise.all(
    IDENTITY_SOURCES.map(async ({ entity, table, column }) => {
      const { data, error } = await supabase.from(table).select(column).eq('company_id', companyId);
      if (error || !data) return;
      out[entity] = new Set(
        (data as Record<string, string>[])
          .map((r) => (r[column] ?? '').trim().toLowerCase())
          .filter(Boolean),
      );
    }),
  );
  return out;
}
