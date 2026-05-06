/**
 * Playwright global setup: idempotent E2E fixture seeding.
 *
 * Promised in `e2e/SEED_TODO.md` — the unify-parts-inventory PR (chunk 1) tore
 * down the legacy seed and intentionally left the E2E company empty. The
 * existing specs (parts-and-routing, quote-to-job, csv-import) need a baseline
 * of: ≥1 vendor, ≥1 internal + ≥1 external work_center, ≥1 customer, ≥1
 * manufacturable part with a routing op, ≥1 stockable raw, ≥1 BOM child.
 *
 * Idempotency strategy: every seeded row carries a sentinel marker via the
 * `legacy_id` column (e.g. legacy_id='E2E_SEED_v1'). On each run we look up by
 * marker and skip the insert if it exists. Re-runs are safe.
 *
 * Why service role: this script bypasses RLS so it can write into the test
 * company without going through the auth flow. The service role key MUST
 * never be loaded into a browser bundle — it's only ever used here, in the
 * Node-side global setup.
 *
 * Env contract:
 *   SUPABASE_URL                — Supabase project URL (e.g. staging)
 *   SUPABASE_SERVICE_ROLE_KEY   — service role JWT (bypasses RLS)
 *   E2E_TEST_COMPANY_ID         — UUID of the company the E2E user belongs to
 *   E2E_TEST_USER_ID            — UUID of the E2E test user
 *
 * If any are missing we exit 1 — silent skipping would leave specs failing
 * with confusing "Autocomplete is empty" timeouts.
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'path';

// Load the same env file Playwright already reads, so devs only configure
// E2E credentials once.
dotenv.config({ path: path.resolve(__dirname, '.env.test.local') });

/** Sentinel that tags every row seeded by this script. Bump version when
 *  the seed shape changes so old rows can be migrated cleanly. */
export const E2E_SEED_MARKER = 'E2E_SEED_v1';

/** Customer name we look up to detect prior seeds (customers has no
 *  legacy_id column on its schema, so we scope by name + company). */
export const E2E_CUSTOMER_NAME = 'E2E Test Customer';

/** Stable names — the E2E specs match against these strings via Autocomplete. */
const VENDOR_NAME = 'E2E Test Vendor';
const WC_INTERNAL_NAME = 'E2E Internal WC';
const WC_EXTERNAL_NAME = 'E2E External WC';
const PART_MFG_NAME = 'E2E-MFG-001';
const PART_RAW_NAME = 'E2E-RAW-001';
const PART_SUB_NAME = 'E2E-SUB-001';

interface SeedEnv {
  url: string;
  serviceRoleKey: string;
  companyId: string;
  userId: string;
}

function readEnvOrExit(): SeedEnv {
  const missing: string[] = [];
  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  const companyId = process.env.E2E_TEST_COMPANY_ID ?? '';
  const userId = process.env.E2E_TEST_USER_ID ?? '';

  if (!url) missing.push('SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL)');
  if (!serviceRoleKey) missing.push('SUPABASE_SERVICE_ROLE_KEY');
  if (!companyId) missing.push('E2E_TEST_COMPANY_ID');
  if (!userId) missing.push('E2E_TEST_USER_ID');

  if (missing.length > 0) {
    console.error(
      '\n[e2e/global-setup] Cannot seed E2E fixtures — missing env vars:\n  - ' +
        missing.join('\n  - ') +
        '\n\nSee e2e/README.md for the full env contract. Aborting.\n',
    );
    process.exit(1);
  }

  return { url, serviceRoleKey, companyId, userId };
}

function makeAdminClient({ url, serviceRoleKey }: SeedEnv): SupabaseClient {
  return createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * Find-or-insert a vendor by name. Tags with E2E_SEED_MARKER so cleanup can
 * find it later without depending on the name string.
 */
async function ensureVendor(
  supabase: SupabaseClient,
  companyId: string,
): Promise<string> {
  const { data: existing, error: lookupErr } = await supabase
    .from('vendors')
    .select('id')
    .eq('company_id', companyId)
    .eq('name', VENDOR_NAME)
    .maybeSingle();
  if (lookupErr) throw new Error(`vendor lookup failed: ${lookupErr.message}`);
  if (existing) return existing.id;

  const { data, error } = await supabase
    .from('vendors')
    .insert({
      company_id: companyId,
      name: VENDOR_NAME,
      contact_email: 'e2e-vendor@example.com',
      legacy_id: E2E_SEED_MARKER,
    })
    .select('id')
    .single();
  if (error || !data) throw new Error(`vendor insert failed: ${error?.message}`);
  return data.id;
}

/**
 * Find-or-insert work_center. The (company_id, name) unique constraint
 * makes the find-then-insert race-safe under serial Playwright setup.
 */
async function ensureWorkCenter(
  supabase: SupabaseClient,
  companyId: string,
  name: string,
  kind: 'internal' | 'external',
  vendorId: string | null,
  laborRate: number | null,
): Promise<string> {
  const { data: existing, error: lookupErr } = await supabase
    .from('work_centers')
    .select('id')
    .eq('company_id', companyId)
    .eq('name', name)
    .maybeSingle();
  if (lookupErr) throw new Error(`work_center lookup failed: ${lookupErr.message}`);
  if (existing) return existing.id;

  const { data, error } = await supabase
    .from('work_centers')
    .insert({
      company_id: companyId,
      name,
      kind,
      vendor_id: vendorId,
      labor_rate: laborRate,
      description: `E2E seed (${kind})`,
    })
    .select('id')
    .single();
  if (error || !data) throw new Error(`work_center insert failed: ${error?.message}`);
  return data.id;
}

/** customers has no metadata or legacy_id column — match on (company_id, name). */
async function ensureCustomer(
  supabase: SupabaseClient,
  companyId: string,
): Promise<string> {
  const { data: existing, error: lookupErr } = await supabase
    .from('customers')
    .select('id')
    .eq('company_id', companyId)
    .eq('name', E2E_CUSTOMER_NAME)
    .maybeSingle();
  if (lookupErr) throw new Error(`customer lookup failed: ${lookupErr.message}`);
  if (existing) return existing.id;

  const { data, error } = await supabase
    .from('customers')
    .insert({
      company_id: companyId,
      name: E2E_CUSTOMER_NAME,
      contact_email: 'e2e-customer@example.com',
    })
    .select('id')
    .single();
  if (error || !data) throw new Error(`customer insert failed: ${error?.message}`);
  return data.id;
}

interface PartSpec {
  part_name: string;
  description: string;
  is_manufacturable: boolean;
  is_stockable: boolean;
  primary_unit: string | null;
  quantity: number;
  cost_per_unit: number | null;
}

async function ensurePart(
  supabase: SupabaseClient,
  companyId: string,
  spec: PartSpec,
): Promise<string> {
  const { data: existing, error: lookupErr } = await supabase
    .from('parts')
    .select('id')
    .eq('company_id', companyId)
    .eq('part_name', spec.part_name)
    .maybeSingle();
  if (lookupErr) throw new Error(`part lookup failed: ${lookupErr.message}`);
  if (existing) return existing.id;

  const { data, error } = await supabase
    .from('parts')
    .insert({
      company_id: companyId,
      part_name: spec.part_name,
      description: spec.description,
      is_manufacturable: spec.is_manufacturable,
      is_stockable: spec.is_stockable,
      primary_unit: spec.primary_unit,
      quantity: spec.quantity,
      cost_per_unit: spec.cost_per_unit,
      legacy_id: E2E_SEED_MARKER,
    })
    .select('id')
    .single();
  if (error || !data) throw new Error(`part insert failed (${spec.part_name}): ${error?.message}`);
  return data.id;
}

async function ensureRouting(
  supabase: SupabaseClient,
  companyId: string,
  partId: string,
  workCenterId: string,
): Promise<void> {
  // routings has UNIQUE(part_id) — one routing per part. Find by part_id.
  const { data: existing, error: lookupErr } = await supabase
    .from('routings')
    .select('id')
    .eq('part_id', partId)
    .maybeSingle();
  if (lookupErr) throw new Error(`routing lookup failed: ${lookupErr.message}`);

  let routingId: string;
  if (existing) {
    routingId = existing.id;
  } else {
    const { data, error } = await supabase
      .from('routings')
      .insert({
        company_id: companyId,
        part_id: partId,
        name: `${PART_MFG_NAME} routing`,
        description: 'E2E seed routing',
      })
      .select('id')
      .single();
    if (error || !data) throw new Error(`routing insert failed: ${error?.message}`);
    routingId = data.id;
  }

  // Ensure at least one operation. UNIQUE(routing_id, sequence) → match on seq.
  const { data: existingOp, error: opLookupErr } = await supabase
    .from('routing_operations')
    .select('id')
    .eq('routing_id', routingId)
    .eq('sequence', 10)
    .maybeSingle();
  if (opLookupErr) throw new Error(`routing op lookup failed: ${opLookupErr.message}`);
  if (existingOp) return;

  const { error: opErr } = await supabase
    .from('routing_operations')
    .insert({
      routing_id: routingId,
      work_center_id: workCenterId,
      sequence: 10,
      setup_minutes: 15,
      cycle_minutes_per_unit: 2.5,
      labor_rate_override: 100,
    });
  if (opErr) throw new Error(`routing op insert failed: ${opErr.message}`);
}

/**
 * Ensure a single BOM edge between two parts. UNIQUE(parent, child) keeps
 * this idempotent.
 */
async function ensureBomEdge(
  supabase: SupabaseClient,
  parentId: string,
  childId: string,
): Promise<void> {
  const { data: existing, error: lookupErr } = await supabase
    .from('parts_bom')
    .select('id')
    .eq('parent_part_id', parentId)
    .eq('child_part_id', childId)
    .maybeSingle();
  if (lookupErr) throw new Error(`bom lookup failed: ${lookupErr.message}`);
  if (existing) return;

  const { error } = await supabase
    .from('parts_bom')
    .insert({
      parent_part_id: parentId,
      child_part_id: childId,
      quantity: 1,
      unit: 'ea',
      sequence: 10,
    });
  if (error) throw new Error(`bom insert failed: ${error.message}`);
}

export default async function globalSetup(): Promise<void> {
  const env = readEnvOrExit();
  const supabase = makeAdminClient(env);

  // eslint-disable-next-line no-console
  console.log(`[e2e/global-setup] Seeding fixtures into company ${env.companyId}…`);

  const vendorId = await ensureVendor(supabase, env.companyId);
  const wcInternalId = await ensureWorkCenter(
    supabase,
    env.companyId,
    WC_INTERNAL_NAME,
    'internal',
    null,
    100,
  );
  await ensureWorkCenter(
    supabase,
    env.companyId,
    WC_EXTERNAL_NAME,
    'external',
    vendorId,
    null,
  );
  await ensureCustomer(supabase, env.companyId);

  const mfgPartId = await ensurePart(supabase, env.companyId, {
    part_name: PART_MFG_NAME,
    description: 'E2E manufacturable part with routing',
    is_manufacturable: true,
    is_stockable: false,
    primary_unit: null,
    quantity: 0,
    cost_per_unit: null,
  });
  await ensurePart(supabase, env.companyId, {
    part_name: PART_RAW_NAME,
    description: 'E2E stockable raw material',
    is_manufacturable: false,
    is_stockable: true,
    primary_unit: 'lbs',
    quantity: 100,
    cost_per_unit: 5.5,
  });
  const subPartId = await ensurePart(supabase, env.companyId, {
    part_name: PART_SUB_NAME,
    description: 'E2E sub-assembly (BOM child of MFG-001)',
    is_manufacturable: true,
    is_stockable: true,
    primary_unit: 'ea',
    quantity: 10,
    cost_per_unit: 12.0,
  });

  await ensureRouting(supabase, env.companyId, mfgPartId, wcInternalId);
  await ensureBomEdge(supabase, mfgPartId, subPartId);

  // eslint-disable-next-line no-console
  console.log('[e2e/global-setup] Done.');
}
