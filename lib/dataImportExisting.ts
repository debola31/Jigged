/**
 * Bounded, RLS-scoped read of the identity values already in Jigged for a company, so the
 * Import step can show new-vs-existing and offer create/update modes. Read-only and best-
 * effort: a failed read yields an empty set for that entity (its rows are treated as new).
 * Only the name-like-identity entities are fetched (parts/vendors/work_centers/customers).
 */

import type { ExistingIdentities } from '@/lib/dataImportReconcile';
import { getSupabase } from '@/lib/supabase';

/** Normalize a query result's identity column into a lookup set, or null on a failed/absent
 *  read (best-effort: those rows are then treated as new). The picker keeps this fully typed —
 *  each caller's row shape comes straight from the typed `.select()`. */
function toSet<R>(
  res: { data: R[] | null; error: unknown },
  pick: (row: R) => string | null | undefined,
): Set<string> | null {
  if (res.error || !res.data) return null;
  return new Set(res.data.map((r) => (pick(r) ?? '').trim().toLowerCase()).filter(Boolean));
}

export async function fetchExistingIdentities(companyId: string): Promise<ExistingIdentities> {
  const supabase = getSupabase();
  // Explicit per-table literals (not a dynamic `.from(string)`) so the typed client
  // schema-checks each table, its identity column, and the company_id filter.
  const [vendors, parts, workCenters, customers] = await Promise.all([
    supabase.from('vendors').select('name').eq('company_id', companyId),
    supabase.from('parts').select('part_name').eq('company_id', companyId),
    supabase.from('work_centers').select('name').eq('company_id', companyId),
    supabase.from('customers').select('name').eq('company_id', companyId),
  ]);

  const out: ExistingIdentities = {};
  const v = toSet(vendors, (r) => r.name);
  if (v) out.vendors = v;
  const p = toSet(parts, (r) => r.part_name);
  if (p) out.parts = p;
  const w = toSet(workCenters, (r) => r.name);
  if (w) out.work_centers = w;
  const c = toSet(customers, (r) => r.name);
  if (c) out.customers = c;
  return out;
}
