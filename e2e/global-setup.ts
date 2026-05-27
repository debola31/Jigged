/**
 * Playwright global setup: idempotent E2E fixture seeding.
 *
 * Promised in `e2e/SEED_TODO.md` — the unify-parts-inventory PR (chunk 1) tore
 * down the legacy seed and intentionally left the E2E company empty. The
 * existing specs (parts-and-routing, quote-to-job, csv-import) need a baseline
 * of: ≥1 vendor, ≥1 internal + ≥1 external work_center, ≥1 customer, ≥1
 * manufacturable part with a routing op, ≥1 stockable raw, ≥1 BOM child.
 *
 * Idempotency strategy: every seeded row carries a per-row sentinel via the
 * `legacy_id` column shaped as `${E2E_SEED_MARKER}:${stable_name}` (e.g.
 * `E2E_SEED_v1:E2E-MFG-001`). The per-row suffix is required because
 * `parts_legacy_id_unique_per_company` (and the equivalent on vendors)
 * forbids two rows in one company sharing the same legacy_id. Lookups
 * happen by stable name (which also has UNIQUE-per-company constraints),
 * so the marker is purely for teardown — `legacy_id LIKE 'E2E_SEED_v1%'`
 * cleanly scopes deletes to seeded rows. Re-runs are safe.
 *
 * Why we sign in as the test user (and not service-role): every table we
 * write to (vendors, work_centers, customers, parts, routings,
 * routing_operations, parts_bom) has an RLS policy of the form
 *   company_id IN (SELECT company_id FROM user_company_access WHERE user_id = auth.uid())
 * So an authenticated user with access to E2E_TEST_COMPANY_ID can do every
 * insert legitimately, no RLS bypass required. Avoiding the service-role key
 * shrinks the CI secret surface — if a future seed step actually needs
 * admin powers (e.g. seeding auth.users or RLS-immune tables), reintroduce
 * the service-role client at that boundary only, not for the whole script.
 *
 * Env contract:
 *   SUPABASE_URL                       — Supabase project URL (e.g. staging)
 *   NEXT_PUBLIC_SUPABASE_ANON_KEY      — public key the browser already uses
 *   E2E_TEST_COMPANY_ID                — UUID of the company the E2E user belongs to
 *   E2E_TEST_EMAIL / E2E_TEST_PASSWORD — credentials for sign-in (also used by auth.setup.ts)
 *
 * The E2E user must have a `user_company_access` row for E2E_TEST_COMPANY_ID
 * (any role — operator/user/admin all satisfy the RLS predicate).
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

/** Sentinel prefix that tags every row seeded by this script. Each row's
 *  legacy_id is `${E2E_SEED_MARKER}:${stable_name}` so the per-company
 *  legacy_id UNIQUE constraint is satisfied. Bump version when the seed
 *  shape changes so old rows fall out of the prefix match cleanly. */
export const E2E_SEED_MARKER = 'E2E_SEED_v1';

/** Build the per-row legacy_id tag for a given stable name. */
const seedTag = (name: string) => `${E2E_SEED_MARKER}:${name}`;

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
  anonKey: string;
  companyId: string;
  email: string;
  password: string;
}

function readEnvOrExit(): SeedEnv {
  const missing: string[] = [];
  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  const anonKey =
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
    process.env.SUPABASE_ANON_KEY ??
    process.env.SUPABASE_PUBLISHABLE_KEY ??
    '';
  const companyId = process.env.E2E_TEST_COMPANY_ID ?? '';
  const email = process.env.E2E_TEST_EMAIL ?? '';
  const password = process.env.E2E_TEST_PASSWORD ?? '';

  if (!url) missing.push('SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL)');
  if (!anonKey) missing.push('NEXT_PUBLIC_SUPABASE_ANON_KEY (or SUPABASE_ANON_KEY)');
  if (!companyId) missing.push('E2E_TEST_COMPANY_ID');
  if (!email) missing.push('E2E_TEST_EMAIL');
  if (!password) missing.push('E2E_TEST_PASSWORD');

  if (missing.length > 0) {
    console.error(
      '\n[e2e/global-setup] Cannot seed E2E fixtures — missing env vars:\n  - ' +
        missing.join('\n  - ') +
        '\n\nSee e2e/README.md for the full env contract. Aborting.\n',
    );
    process.exit(1);
  }

  return { url, anonKey, companyId, email, password };
}

async function makeAuthenticatedClient(env: SeedEnv): Promise<SupabaseClient> {
  const supabase = createClient(env.url, env.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error } = await supabase.auth.signInWithPassword({
    email: env.email,
    password: env.password,
  });
  if (error) {
    throw new Error(
      `[e2e/global-setup] Failed to sign in as ${env.email}: ${error.message}. ` +
        `The E2E test user must exist on this Supabase project and have a ` +
        `user_company_access row for E2E_TEST_COMPANY_ID.`,
    );
  }
  return supabase;
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

  // The vendors table dropped contact_name/email/phone/notes in
  // 20260504_vendor_contacts_and_drop_notes — contacts now live on a
  // separate vendor_contacts row. None of the current specs touch vendor
  // contact info, so we don't seed a vendor_contacts row here; if a spec
  // needs one later, add an ensureVendorContact helper alongside this.
  const { data, error } = await supabase
    .from('vendors')
    .insert({
      company_id: companyId,
      name: VENDOR_NAME,
      legacy_id: seedTag(VENDOR_NAME),
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
  source: 'made' | 'bought';
  is_stocked: boolean;
  primary_unit: string | null;
  quantity: number;
  /**
   * Procurement cost to seed for bought parts. Persisted as a NULL-vendor
   * procurement tier at min_quantity=1 (parts.cost_per_unit was dropped in
   * migration 20260514). Ignored for made parts — their cost is computed
   * live by compute_part_cost_at_qty.
   */
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

  let partId: string;
  if (existing) {
    partId = existing.id;
  } else {
    const { data, error } = await supabase
      .from('parts')
      .insert({
        company_id: companyId,
        part_name: spec.part_name,
        description: spec.description,
        source: spec.source,
        is_stocked: spec.is_stocked,
        primary_unit: spec.primary_unit,
        quantity: spec.quantity,
        legacy_id: seedTag(spec.part_name),
      })
      .select('id')
      .single();
    if (error || !data) throw new Error(`part insert failed (${spec.part_name}): ${error?.message}`);
    partId = data.id;
  }

  // Idempotent NULL-vendor procurement tier for bought parts with a cost.
  if (spec.source === 'bought' && spec.cost_per_unit !== null && spec.cost_per_unit > 0) {
    const { data: existingTier, error: tierLookupErr } = await supabase
      .from('part_procurement_tiers')
      .select('id')
      .eq('part_id', partId)
      .is('vendor_id', null)
      .eq('min_quantity', 1)
      .maybeSingle();
    if (tierLookupErr) {
      throw new Error(`tier lookup failed (${spec.part_name}): ${tierLookupErr.message}`);
    }
    if (!existingTier) {
      const { error: tierErr } = await supabase
        .from('part_procurement_tiers')
        .insert({
          part_id: partId,
          vendor_id: null,
          min_quantity: 1,
          cost_per_unit: spec.cost_per_unit,
        });
      if (tierErr) {
        throw new Error(`tier insert failed (${spec.part_name}): ${tierErr.message}`);
      }
    }
  }

  return partId;
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
 * Find-or-insert one pricing tier for a part at the given sequence. The spec
 * exercises the tier-resolution path inside QuoteForm, which requires
 * `part_pricing_tiers` rows on the manufacturable test part — without them
 * the form shows "no pricing tiers yet" and the quote-to-job spec is forced
 * to runtime-skip. UNIQUE(part_id, sequence) keeps this idempotent.
 *
 * Tier rows only carry metadata (qty break + markup %); the unit price is
 * derived live from the routing + BOM at read time.
 */
async function ensurePricingTier(
  supabase: SupabaseClient,
  companyId: string,
  partId: string,
  sequence: number,
  quantity: number,
  markupPercent: number,
): Promise<void> {
  const { data: existing, error: lookupErr } = await supabase
    .from('part_pricing_tiers')
    .select('id')
    .eq('part_id', partId)
    .eq('sequence', sequence)
    .maybeSingle();
  if (lookupErr) throw new Error(`pricing tier lookup failed: ${lookupErr.message}`);
  if (existing) return;

  const { error } = await supabase
    .from('part_pricing_tiers')
    .insert({
      part_id: partId,
      company_id: companyId,
      sequence,
      quantity,
      markup_percent: markupPercent,
    });
  if (error) throw new Error(`pricing tier insert failed: ${error.message}`);
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
  const supabase = await makeAuthenticatedClient(env);

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
    description: 'E2E made part with routing',
    source: 'made',
    is_stocked: false,
    primary_unit: null,
    quantity: 0,
    cost_per_unit: null,
  });
  await ensurePart(supabase, env.companyId, {
    part_name: PART_RAW_NAME,
    description: 'E2E stocked raw material',
    source: 'bought',
    is_stocked: true,
    primary_unit: 'lbs',
    quantity: 100,
    cost_per_unit: 5.5,
  });
  const subPartId = await ensurePart(supabase, env.companyId, {
    part_name: PART_SUB_NAME,
    description: 'E2E sub-assembly (BOM child of MFG-001)',
    source: 'made',
    is_stocked: true,
    primary_unit: 'ea',
    quantity: 10,
    cost_per_unit: 12.0,
  });

  await ensureRouting(supabase, env.companyId, mfgPartId, wcInternalId);
  await ensureBomEdge(supabase, mfgPartId, subPartId);
  // Two pricing tiers so the QuoteForm has a real tier to resolve against
  // when the spec types an order quantity. sequence is the UI ordering; the
  // tier-resolver matches by quantity, picking the highest tier with
  // tier_qty <= order_qty.
  await ensurePricingTier(supabase, env.companyId, mfgPartId, 1, 1, 50);
  await ensurePricingTier(supabase, env.companyId, mfgPartId, 2, 10, 40);

  // eslint-disable-next-line no-console
  console.log('[e2e/global-setup] Done.');
}
