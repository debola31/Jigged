/**
 * Playwright global setup: seed an ephemeral local Supabase for E2E.
 *
 * The full setup runs against a fresh local Supabase stack (`supabase start`):
 * fresh DB, no pre-existing users, no pre-existing companies. We use the
 * local service-role key to:
 *   1. Create or find the test auth user (deterministic email/password from
 *      `e2e/fixtures/test-data.ts`).
 *   2. Create or find the test company.
 *   3. Link the user to the company via `user_company_access` (role=admin).
 *   4. Seed the per-spec data graph: vendor, work centers, customer, parts,
 *      routing, BOM, pricing tiers.
 *
 * Idempotency: every helper is find-or-insert so re-running locally without
 * `supabase db reset` is safe. CI runs always start from a fresh DB so the
 * "find" branches are no-ops there.
 *
 * Env contract (set by `.github/workflows/e2e-tests.yml` after
 * `supabase status -o env`, or by the developer's shell after
 * `eval "$(supabase status -o env)"`):
 *
 *   TEST_SUPABASE_URL              — `API_URL` from `supabase status`
 *   TEST_SUPABASE_SECRET_KEY       — `SERVICE_ROLE_KEY` from `supabase status`
 *
 * Both are required. Exits 1 if missing, with a copy-pasteable command in
 * the error message — silent skipping would leave specs failing with
 * confusing "Autocomplete is empty" timeouts.
 *
 * Why service-role here: we need `auth.admin.createUser` to provision the
 * test user, and we want every entity insert to bypass RLS so the seed
 * doesn't double as an RLS test. The service-role key is the local-stack
 * key (publicly-known default) — there is no production secret in this
 * file or in CI.
 */

import { createClient, SupabaseClient, User } from '@supabase/supabase-js';
import { TEST_EMAIL, TEST_PASSWORD } from './fixtures/test-data';

/** Stable identifiers the specs match against. Changing these is a breaking
 *  change to every spec. */
const COMPANY_NAME = 'E2E Test Company';
const VENDOR_NAME = 'E2E Test Vendor';
const WC_INTERNAL_NAME = 'E2E Internal WC';
const WC_EXTERNAL_NAME = 'E2E External WC';
const CUSTOMER_NAME = 'E2E Test Customer';
const PART_MFG_NAME = 'E2E-MFG-001';
const PART_RAW_NAME = 'E2E-RAW-001';
const PART_SUB_NAME = 'E2E-SUB-001';
// Made part measured in a non-count unit (inches), with a fractional pricing
// tier — exercises fractional order quantities end-to-end (quote -> job).
const PART_LENGTH_NAME = 'E2E-LENGTH-001';

interface SetupEnv {
  url: string;
  secretKey: string;
}

function readEnvOrExit(): SetupEnv {
  const url = process.env.TEST_SUPABASE_URL ?? '';
  const secretKey = process.env.TEST_SUPABASE_SECRET_KEY ?? '';
  const missing: string[] = [];
  if (!url) missing.push('TEST_SUPABASE_URL');
  if (!secretKey) missing.push('TEST_SUPABASE_SECRET_KEY');
  if (missing.length > 0) {
    console.error(
      '\n[e2e/global-setup] Missing env vars:\n  - ' +
        missing.join('\n  - ') +
        '\n\nRun `supabase start` and then\n' +
        '  eval "$(supabase status -o env)"\n' +
        '  export TEST_SUPABASE_URL=$API_URL\n' +
        '  export TEST_SUPABASE_SECRET_KEY=$SERVICE_ROLE_KEY\n' +
        '\nAborting.\n',
    );
    process.exit(1);
  }
  return { url, secretKey };
}

function makeAdminClient(env: SetupEnv): SupabaseClient {
  return createClient(env.url, env.secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * Find-or-create the test auth user. Local Supabase's `admin.listUsers`
 * isn't filterable by email, so we paginate the first page and match by
 * email — for an ephemeral local DB the user list is tiny.
 *
 * When the user already exists we RESET its password to `TEST_PASSWORD`
 * rather than returning it as-is. Local Supabase persists its DB volume
 * across `supabase start`, so a user seeded by an earlier stack can carry a
 * stale password (or its hash can be invalidated by a JWT-secret change) —
 * a plain find-or-create then leaves every spec failing at login with
 * "Invalid login credentials" until someone runs `supabase db reset`. The
 * reset makes re-runs deterministic without a full DB reset. (On CI the DB
 * is always fresh, so this is a no-op there.)
 */
/** Body of the seeded durable note; the read-back spec asserts on this string. */
export const DURABLE_NOTE_BODY =
  'E2E durable note: indicate the fixture to 0.001 before the first bore.';

async function ensureAuthUser(supabase: SupabaseClient): Promise<User> {
  const { data: existingList, error: listErr } = await supabase.auth.admin.listUsers({
    perPage: 100,
  });
  if (listErr) throw new Error(`listUsers failed: ${listErr.message}`);
  const existing = existingList.users.find((u) => u.email === TEST_EMAIL);
  if (existing) {
    const { data, error } = await supabase.auth.admin.updateUserById(existing.id, {
      password: TEST_PASSWORD,
      email_confirm: true,
    });
    if (error || !data.user) {
      throw new Error(`updateUser (password reset) failed for ${TEST_EMAIL}: ${error?.message}`);
    }
    return data.user;
  }

  const { data, error } = await supabase.auth.admin.createUser({
    email: TEST_EMAIL,
    password: TEST_PASSWORD,
    email_confirm: true,
  });
  if (error || !data.user) {
    throw new Error(`createUser failed for ${TEST_EMAIL}: ${error?.message}`);
  }
  return data.user;
}

async function ensureCompany(supabase: SupabaseClient): Promise<string> {
  const { data: existing, error: lookupErr } = await supabase
    .from('companies')
    .select('id')
    .eq('name', COMPANY_NAME)
    .maybeSingle();
  if (lookupErr) throw new Error(`company lookup failed: ${lookupErr.message}`);
  if (existing) return existing.id;

  const { data, error } = await supabase
    .from('companies')
    .insert({ name: COMPANY_NAME })
    .select('id')
    .single();
  if (error || !data) throw new Error(`company insert failed: ${error?.message}`);
  return data.id;
}

// Billing enforcement (company_can_write RLS gate) blocks writes for companies
// with no billing row. The grandfather backfill runs on an empty DB before any
// test company exists, so grandfather the test company here — otherwise every
// app-driven write in the specs would be rejected by RLS.
async function ensureCompanyBilling(
  supabase: SupabaseClient,
  companyId: string,
): Promise<void> {
  const { error } = await supabase
    .from('company_billing')
    .upsert({ company_id: companyId, billing_exempt: true }, { onConflict: 'company_id' });
  if (error) throw new Error(`company_billing upsert failed: ${error.message}`);
}

/**
 * Turn on the pilot flags the specs exercise.
 *
 * Merges rather than replaces, and runs on every setup rather than only on
 * company creation: this seeder is find-or-insert, so a company created before a
 * flag existed would otherwise never get it, and a local stack keeps whatever
 * the first run made until someone does a db reset. CI always starts clean;
 * a developer's machine does not.
 */
async function ensureFeatureFlags(
  supabase: SupabaseClient,
  companyId: string,
  flags: Record<string, boolean>,
): Promise<void> {
  const { data, error: readErr } = await supabase
    .from('companies')
    .select('settings')
    .eq('id', companyId)
    .single();
  if (readErr) throw new Error(`settings read failed: ${readErr.message}`);

  const settings = (data?.settings ?? {}) as Record<string, unknown>;
  const features = (settings.features ?? {}) as Record<string, unknown>;

  const { error } = await supabase
    .from('companies')
    .update({ settings: { ...settings, features: { ...features, ...flags } } })
    .eq('id', companyId);
  if (error) throw new Error(`feature flag update failed: ${error.message}`);
}

async function ensureUserCompanyAccess(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
): Promise<void> {
  const { data: existing, error: lookupErr } = await supabase
    .from('user_company_access')
    .select('id')
    .eq('user_id', userId)
    .eq('company_id', companyId)
    .maybeSingle();
  if (lookupErr) throw new Error(`user_company_access lookup failed: ${lookupErr.message}`);
  if (existing) return;

  const { error } = await supabase.from('user_company_access').insert({
    user_id: userId,
    company_id: companyId,
    role: 'admin',
    name: 'E2E Test User',
  });
  if (error) throw new Error(`user_company_access insert failed: ${error.message}`);
}

async function ensureVendor(supabase: SupabaseClient, companyId: string): Promise<string> {
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
    .insert({ company_id: companyId, name: VENDOR_NAME })
    .select('id')
    .single();
  if (error || !data) throw new Error(`vendor insert failed: ${error?.message}`);
  return data.id;
}

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

async function ensureCustomer(supabase: SupabaseClient, companyId: string): Promise<string> {
  const { data: existing, error: lookupErr } = await supabase
    .from('customers')
    .select('id')
    .eq('company_id', companyId)
    .eq('name', CUSTOMER_NAME)
    .maybeSingle();
  if (lookupErr) throw new Error(`customer lookup failed: ${lookupErr.message}`);
  if (existing) return existing.id;

  const { data, error } = await supabase
    .from('customers')
    .insert({
      company_id: companyId,
      name: CUSTOMER_NAME,
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
  /** Persisted as a NULL-vendor procurement tier at min_quantity=1 for
   *  bought parts. Ignored for made parts. */
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
      })
      .select('id')
      .single();
    if (error || !data) throw new Error(`part insert failed (${spec.part_name}): ${error?.message}`);
    partId = data.id;
  }

  if (spec.source === 'bought' && spec.cost_per_unit !== null && spec.cost_per_unit > 0) {
    const { data: existingTier, error: tierLookupErr } = await supabase
      .from('part_procurement_tiers')
      .select('id')
      .eq('part_id', partId)
      .eq('min_quantity', 1)
      .maybeSingle();
    if (tierLookupErr) {
      throw new Error(`tier lookup failed (${spec.part_name}): ${tierLookupErr.message}`);
    }
    if (!existingTier) {
      // Part-level tier sheet — vendor is a label on the part, not a tier column.
      const { error: tierErr } = await supabase.from('part_procurement_tiers').insert({
        part_id: partId,
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
): Promise<string> {
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

  const { data: existingOp, error: opLookupErr } = await supabase
    .from('routing_operations')
    .select('id')
    .eq('routing_id', routingId)
    .eq('sequence', 10)
    .maybeSingle();
  if (opLookupErr) throw new Error(`routing op lookup failed: ${opLookupErr.message}`);
  if (existingOp) return routingId;

  const { error: opErr } = await supabase.from('routing_operations').insert({
    routing_id: routingId,
    work_center_id: workCenterId,
    sequence: 10,
    setup_minutes: 15,
    cycle_minutes_per_unit: 2.5,
    labor_rate_override: 100,
  });
  if (opErr) throw new Error(`routing op insert failed: ${opErr.message}`);
  return routingId;
}

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

  const { error } = await supabase.from('part_pricing_tiers').insert({
    part_id: partId,
    company_id: companyId,
    sequence,
    quantity,
    markup_percent: markupPercent,
  });
  if (error) throw new Error(`pricing tier insert failed: ${error.message}`);
}

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

  const { error } = await supabase.from('parts_bom').insert({
    parent_part_id: parentId,
    child_part_id: childId,
    quantity: 1,
    unit: 'ea',
    sequence: 10,
  });
  if (error) throw new Error(`bom insert failed: ${error.message}`);
}

interface JobStageSpec {
  jobNumber: string;
  productionStatus: 'not_started' | 'in_progress' | 'completed' | 'cancelled';
  fulfillmentStatus: 'unshipped' | 'partially_shipped' | 'fully_shipped';
  /**
   * Order quantity on the job_part. Defaults to 1.
   *
   * operator-completion.spec.ts needs > 1 on the job it drives: recording the
   * whole remaining balance is a FULL completion, so with a quantity of 1 a
   * PARTIAL is not expressible at all and that half of the flow cannot be
   * covered.
   */
  quantity?: number;
}

/**
 * Find-or-create a job at a specific lifecycle stage for the jobs-list
 * combined-Status spec. The list filters on the STORED production_status /
 * fulfillment_status columns, so we set them directly on a single job_part
 * (which the sync triggers roll up to the job) rather than going through the
 * operation/shipment write paths. Verified that explicit statuses survive the
 * triggers with no shipment/operation rows. Find key is (company, job_number)
 * so re-runs are idempotent.
 */
/**
 * A DURABLE part-subject note on a prior run, so the read-back loop has something
 * to read.
 *
 * Anchored to (part_id, routing_operation_id) — the routing TEMPLATE step — which
 * is what makes it job-independent: the operator on a later job for this part sees
 * it without any traversal of the job it was written on. `captured_job_id` records
 * where it came from (provenance, never subject), so the sheet can show its source
 * job number.
 *
 * Seeded rather than runtime-skipped, per CLAUDE.md: a skip would hide exactly the
 * regression this spec exists to catch — the jobs.status incident shipped that way.
 */
async function ensureDurableNote(
  supabase: SupabaseClient,
  companyId: string,
  partId: string,
  capturedJobNumber: string,
): Promise<void> {
  const { data: existing, error: lookupErr } = await supabase
    .from('notes')
    .select('id')
    .eq('company_id', companyId)
    .eq('part_id', partId)
    .eq('body', DURABLE_NOTE_BODY)
    .maybeSingle();
  if (lookupErr) throw new Error(`note lookup failed: ${lookupErr.message}`);
  if (existing) return;

  // The routing step for this part. routing_operations has no company_id — it
  // resolves through routings — and notes_validate_subject enforces that the step
  // actually belongs to part_id, so this must be looked up rather than guessed.
  const { data: routing, error: rErr } = await supabase
    .from('routings')
    .select('id')
    .eq('company_id', companyId)
    .eq('part_id', partId)
    .maybeSingle();
  if (rErr || !routing) throw new Error(`routing lookup failed: ${rErr?.message ?? 'missing'}`);

  const { data: routingOp, error: roErr } = await supabase
    .from('routing_operations')
    .select('id')
    .eq('routing_id', routing.id)
    .order('sequence')
    .limit(1)
    .maybeSingle();
  if (roErr || !routingOp) {
    throw new Error(`routing_operation lookup failed: ${roErr?.message ?? 'missing'}`);
  }

  const { data: access, error: aErr } = await supabase
    .from('user_company_access')
    .select('id')
    .eq('company_id', companyId)
    .limit(1)
    .maybeSingle();
  if (aErr || !access) throw new Error(`access lookup failed: ${aErr?.message ?? 'missing'}`);

  const { data: capturedJob } = await supabase
    .from('jobs')
    .select('id')
    .eq('company_id', companyId)
    .eq('job_number', capturedJobNumber)
    .maybeSingle();

  const { error } = await supabase.from('notes').insert({
    company_id: companyId,
    subject_kind: 'part',
    part_id: partId,
    routing_operation_id: routingOp.id,
    captured_job_id: capturedJob?.id ?? null,
    author_id: access.id,
    body: DURABLE_NOTE_BODY,
  });
  if (error) throw new Error(`durable note insert failed: ${error.message}`);
}

async function ensureJobAtStage(
  supabase: SupabaseClient,
  companyId: string,
  customerId: string,
  partId: string,
  routingId: string,
  spec: JobStageSpec,
): Promise<void> {
  const { data: existing, error: lookupErr } = await supabase
    .from('jobs')
    .select('id')
    .eq('company_id', companyId)
    .eq('job_number', spec.jobNumber)
    .maybeSingle();
  if (lookupErr) throw new Error(`job lookup failed (${spec.jobNumber}): ${lookupErr.message}`);

  if (existing) {
    // The job is already here, but a run seeded before this function created
    // job_operations would have left it with no steps — and a job_part with no
    // steps renders "This part has no operations", so there is nothing to open
    // and nothing to complete. Ensure the step separately rather than returning:
    // every other seeder in this file is find-or-insert, and this one was not.
    await ensureJobOperation(supabase, existing.id, routingId, spec);
    return;
  }

  const { data: job, error: jobErr } = await supabase
    .from('jobs')
    .insert({
      company_id: companyId,
      customer_id: customerId,
      job_number: spec.jobNumber,
      production_status: spec.productionStatus,
      fulfillment_status: spec.fulfillmentStatus,
    })
    .select('id')
    .single();
  if (jobErr || !job) throw new Error(`job insert failed (${spec.jobNumber}): ${jobErr?.message}`);

  const { error: partErr } = await supabase.from('job_parts').insert({
    job_id: job.id,
    company_id: companyId,
    part_id: partId,
    sequence: 1,
    quantity: spec.quantity ?? 1,
    unit_price: 10,
    total_price: 10 * (spec.quantity ?? 1),
    production_status: spec.productionStatus,
    fulfillment_status: spec.fulfillmentStatus,
  });
  if (partErr) throw new Error(`job_part insert failed (${spec.jobNumber}): ${partErr.message}`);

  await ensureJobOperation(supabase, job.id, routingId, spec);
}

/**
 * The step an operator actually opens and completes.
 *
 * These jobs are inserted directly rather than converted from a quote, and it is
 * conversion that normally snapshots routing_operations into job_operations — so
 * without this a job_part has no steps, the traveler renders "This part has no
 * operations", and there is nothing to complete.
 *
 * Carries routing_operation_id so a note captured on this step gets the DURABLE
 * (part, routing step) subject rather than falling back to a job subject.
 */
async function ensureJobOperation(
  supabase: SupabaseClient,
  jobId: string,
  routingId: string,
  spec: JobStageSpec,
): Promise<void> {
  const { data: existingOp, error: opLookupErr } = await supabase
    .from('job_operations')
    .select('id')
    .eq('job_id', jobId)
    .maybeSingle();
  if (opLookupErr) {
    throw new Error(`job_operation lookup failed (${spec.jobNumber}): ${opLookupErr.message}`);
  }
  if (existingOp) return;

  const { data: jobPart, error: jpErr } = await supabase
    .from('job_parts')
    .select('id')
    .eq('job_id', jobId)
    .single();
  if (jpErr || !jobPart) {
    throw new Error(`job_part lookup failed (${spec.jobNumber}): ${jpErr?.message}`);
  }

  const { data: routingOp } = await supabase
    .from('routing_operations')
    .select('id, work_center_id')
    .eq('routing_id', routingId)
    .eq('sequence', 10)
    .maybeSingle();

  const { error: opErr } = await supabase.from('job_operations').insert({
    job_id: jobId,
    job_part_id: jobPart.id,
    // No company_id here: job_operations has none, tenancy resolves through the job.
    sequence: 10,
    operation_name: WC_INTERNAL_NAME,
    work_center_id: routingOp?.work_center_id ?? null,
    routing_operation_id: routingOp?.id ?? null,
    estimated_setup_minutes: 15,
    estimated_run_minutes_per_unit: 2.5,
    // Mirrors the job: a completed job's step must not read as outstanding.
    status: spec.productionStatus === 'completed' ? 'completed' : 'pending',
  });
  if (opErr) throw new Error(`job_operation insert failed (${spec.jobNumber}): ${opErr.message}`);
}

export default async function globalSetup(): Promise<void> {
  const env = readEnvOrExit();
  const supabase = makeAdminClient(env);

  console.log('[e2e/global-setup] Seeding ephemeral local Supabase…');

  const user = await ensureAuthUser(supabase);
  const companyId = await ensureCompany(supabase);
  await ensureUserCompanyAccess(supabase, user.id, companyId);
  await ensureCompanyBilling(supabase, companyId);

  const vendorId = await ensureVendor(supabase, companyId);
  const wcInternalId = await ensureWorkCenter(
    supabase,
    companyId,
    WC_INTERNAL_NAME,
    'internal',
    null,
    100,
  );
  await ensureWorkCenter(supabase, companyId, WC_EXTERNAL_NAME, 'external', vendorId, null);
  const customerId = await ensureCustomer(supabase, companyId);

  const mfgPartId = await ensurePart(supabase, companyId, {
    part_name: PART_MFG_NAME,
    description: 'E2E made part with routing',
    source: 'made',
    is_stocked: false,
    // parts_requires_unit CHECK constraint (20260602…) makes primary_unit
    // NOT NULL for every part. 'ea' is the canonical unit for discrete parts.
    primary_unit: 'ea',
    quantity: 0,
    cost_per_unit: null,
  });
  await ensurePart(supabase, companyId, {
    part_name: PART_RAW_NAME,
    description: 'E2E stocked raw material',
    source: 'bought',
    is_stocked: true,
    primary_unit: 'lbs',
    quantity: 100,
    cost_per_unit: 5.5,
  });
  const subPartId = await ensurePart(supabase, companyId, {
    part_name: PART_SUB_NAME,
    description: 'E2E sub-assembly (BOM child of MFG-001)',
    source: 'made',
    is_stocked: true,
    primary_unit: 'ea',
    quantity: 10,
    cost_per_unit: 12.0,
  });

  const lengthPartId = await ensurePart(supabase, companyId, {
    part_name: PART_LENGTH_NAME,
    description: 'E2E made part sold by length (inches)',
    source: 'made',
    is_stocked: false,
    primary_unit: 'inches',
    quantity: 0,
    cost_per_unit: null,
  });

  const mfgRoutingId = await ensureRouting(supabase, companyId, mfgPartId, wcInternalId);
  await ensureRouting(supabase, companyId, lengthPartId, wcInternalId);
  await ensureBomEdge(supabase, mfgPartId, subPartId);
  // Two pricing tiers so QuoteForm can resolve a tier on the seeded MFG part.
  await ensurePricingTier(supabase, companyId, mfgPartId, 1, 1, 50);
  await ensurePricingTier(supabase, companyId, mfgPartId, 2, 10, 40);
  // Fractional minimum-quantity tier on the length part (0.5 in) — only valid
  // once part_pricing_tiers.quantity is numeric. Seeds the fractional path.
  await ensurePricingTier(supabase, companyId, lengthPartId, 1, 0.5, 30);

  // Jobs at distinct lifecycle stages for jobs-list-status.spec.ts. Shared
  // "E2E-JS-" job-number prefix so the spec can isolate them by search from
  // whatever jobs other specs create in the same shared company.
  await ensureJobAtStage(supabase, companyId, customerId, mfgPartId, mfgRoutingId, {
    jobNumber: 'E2E-JS-NOTSTARTED',
    productionStatus: 'not_started',
    fulfillmentStatus: 'unshipped',
    // > 1 so operator-completion.spec.ts can record a PARTIAL. Safe to change:
    // no spec asserts this quantity — the status specs assert statuses, and the
    // notes spec asserts note bodies.
    quantity: 5,
  });
  await ensureJobAtStage(supabase, companyId, customerId, mfgPartId, mfgRoutingId, {
    jobNumber: 'E2E-JS-READY',
    productionStatus: 'completed',
    fulfillmentStatus: 'unshipped',
  });
  await ensureJobAtStage(supabase, companyId, customerId, mfgPartId, mfgRoutingId, {
    jobNumber: 'E2E-JS-DONE',
    productionStatus: 'completed',
    fulfillmentStatus: 'fully_shipped',
  });
  await ensureJobAtStage(supabase, companyId, customerId, mfgPartId, mfgRoutingId, {
    jobNumber: 'E2E-JS-CANCELLED',
    productionStatus: 'cancelled',
    fulfillmentStatus: 'unshipped',
  });

  // After the jobs, so the note's provenance job resolves.
  await ensureDurableNote(supabase, companyId, mfgPartId, 'E2E-JS-DONE');

  // The Maintenance tab is flag-gated. No maintenance ENTRIES are seeded: the
  // spec writes its own through the UI, which is the only way to exercise the
  // capture path the module is actually a bet on.
  await ensureFeatureFlags(supabase, companyId, {
    machine_maintenance: true,
    // The count sheet and the Storage board are both behind this. Without it
    // `inventory-count.spec.ts` lands on a redirect.
    inventory_locations: true,
  });

  // A part in TWO places — the shape the count sheet exists to handle, and the one
  // no other fixture produces.
  await ensureSplitStock(supabase, companyId);

  console.log(`[e2e/global-setup] Done. user=${TEST_EMAIL} company=${companyId}`);
}

/** The two shelves `inventory-count.spec.ts` splits a part across. */
export const E2E_SHELF_A = 'E2E Shelf A';
export const E2E_SHELF_B = 'E2E Shelf B';
/** The part it splits. Distinct from every other seeded part so the spec owns it. */
export const E2E_SPLIT_PART = 'E2E-COUNT-SPLIT';

async function ensureLocation(
  supabase: SupabaseClient,
  companyId: string,
  name: string,
): Promise<string> {
  const { data: existing, error: lookupErr } = await supabase
    .from('inventory_locations')
    .select('id')
    .eq('company_id', companyId)
    .eq('name', name)
    .maybeSingle();
  if (lookupErr) throw new Error(`location lookup failed: ${lookupErr.message}`);
  if (existing) return existing.id;

  const { data, error } = await supabase
    .from('inventory_locations')
    .insert({ company_id: companyId, name, kind: 'shelf' })
    .select('id')
    .single();
  if (error) throw new Error(`location insert failed: ${error.message}`);
  return data.id;
}

/**
 * One part, stock at two shelves — the fixture for `inventory-count.spec.ts`.
 *
 * **Every write here is an absolute UPSERT, not a find-or-skip.** This seeder is find-or-insert
 * throughout, and CI always starts clean while a dev machine does not: a helper that early-returns
 * on "the part exists" leaves whatever the first run created, so extending it later silently does
 * nothing until someone runs `supabase db reset`. Setting the balance to an exact quantity every
 * time means a partial or drifted fixture repairs itself on the next run.
 *
 * `parts.quantity` is never written. It is a trigger-maintained roll-up of `part_location_stock`
 * since 20260802015837, and a direct write raises.
 */
async function ensureSplitStock(supabase: SupabaseClient, companyId: string): Promise<void> {
  const partId = await ensurePart(supabase, companyId, {
    part_name: E2E_SPLIT_PART,
    description: 'Split across two shelves, for the count sheet',
    source: 'bought',
    is_stocked: true,
    primary_unit: 'each',
    // The auto-track trigger seeds an Unassigned row from this on INSERT; the upserts below then
    // put the real stock on the shelves. Zero keeps the Unassigned row off the sheet (the row
    // rule emits places holding > 0), so the spec sees exactly two rows.
    quantity: 0,
    cost_per_unit: null,
  });

  const shelfA = await ensureLocation(supabase, companyId, E2E_SHELF_A);
  const shelfB = await ensureLocation(supabase, companyId, E2E_SHELF_B);

  const { error } = await supabase.from('part_location_stock').upsert(
    [
      { company_id: companyId, part_id: partId, location_id: shelfA, quantity: 40 },
      { company_id: companyId, part_id: partId, location_id: shelfB, quantity: 12 },
    ],
    { onConflict: 'part_id,location_id' },
  );
  if (error) throw new Error(`split stock upsert failed: ${error.message}`);
}
