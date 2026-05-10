/**
 * Playwright global teardown: remove rows tagged with E2E_SEED_MARKER.
 *
 * We deliberately tear down ONLY the marker-tagged rows we own — never a
 * blanket DELETE on the test company, since devs may have manually-created
 * data they'd rather keep between runs.
 *
 * Order matches the FK graph: BOM edges + routing_operations first (children
 * of parts/routings), then routings, then parts, then work_centers, then
 * vendors. Customers are left in place (CSV / quote-to-job specs may still
 * want them across runs; the seed step is no-op anyway thanks to the
 * find-or-insert pattern).
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'path';
import { E2E_SEED_MARKER } from './global-setup';

dotenv.config({ path: path.resolve(__dirname, '.env.test.local') });

interface TeardownEnv {
  url: string;
  serviceRoleKey: string;
  companyId: string;
}

function readEnvOrSkip(): TeardownEnv | null {
  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  const companyId = process.env.E2E_TEST_COMPANY_ID ?? '';
  if (!url || !serviceRoleKey || !companyId) {
    // If setup never ran (env missing), skip teardown silently — setup has
    // already shown the error.
    return null;
  }
  return { url, serviceRoleKey, companyId };
}

function makeAdminClient(env: TeardownEnv): SupabaseClient {
  return createClient(env.url, env.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * Skip teardown by default — most workflows want the seed to persist between
 * local runs (faster) and CI workers don't share databases. Set
 * E2E_TEARDOWN_SEEDED=1 to enable cleanup.
 */
export default async function globalTeardown(): Promise<void> {
  if (process.env.E2E_TEARDOWN_SEEDED !== '1') return;

  const env = readEnvOrSkip();
  if (!env) return;
  const supabase = makeAdminClient(env);

  // eslint-disable-next-line no-console
  console.log(`[e2e/global-teardown] Removing rows tagged ${E2E_SEED_MARKER}…`);

  // Find tagged parts first; we need their IDs to clean up routings + BOM
  // edges before deleting the parts themselves.
  // Prefix match because every seeded row's legacy_id is shaped
  // `${E2E_SEED_MARKER}:${stable_name}` (per-row to satisfy the
  // per-company legacy_id UNIQUE constraint). The trailing `%` also
  // catches any bare-marker rows from earlier seed-script versions.
  const { data: taggedParts } = await supabase
    .from('parts')
    .select('id')
    .eq('company_id', env.companyId)
    .like('legacy_id', `${E2E_SEED_MARKER}%`);
  const partIds = (taggedParts ?? []).map((p: { id: string }) => p.id);

  if (partIds.length > 0) {
    // BOM edges where either side is a tagged part
    await supabase.from('parts_bom').delete().in('parent_part_id', partIds);
    await supabase.from('parts_bom').delete().in('child_part_id', partIds);

    // routings on tagged parts (cascades to routing_operations)
    await supabase.from('routings').delete().in('part_id', partIds);

    // The parts themselves
    await supabase.from('parts').delete().in('id', partIds);
  }

  // work_centers — find by description prefix since they have no legacy_id
  // column. Safe because the prefix is namespaced ('E2E seed (...)').
  await supabase
    .from('work_centers')
    .delete()
    .eq('company_id', env.companyId)
    .like('description', 'E2E seed (%');

  // Tagged vendors (same prefix-match rationale as parts above).
  await supabase
    .from('vendors')
    .delete()
    .eq('company_id', env.companyId)
    .like('legacy_id', `${E2E_SEED_MARKER}%`);

  // eslint-disable-next-line no-console
  console.log('[e2e/global-teardown] Done.');
}
