/**
 * scripts/seed-dev.ts — comprehensive development seed for Jigged.
 *
 * Populates a single, richly-interconnected manufacturing company so the whole
 * app (parts + multi-level BOMs, inventory history, customers/addresses/vendors,
 * quotes → jobs → operations → shipments, activity feed, dashboards) has
 * realistic data to browse. Built for LOCAL/STAGING exploration — never run it
 * against production.
 *
 * Mechanics mirror e2e/global-setup.ts: a Supabase SERVICE-ROLE admin client
 * (bypasses RLS), find-or-create for the user/company, and a full data wipe of
 * the seed company's rows on each run so re-running is deterministic. Derived
 * state is left to the DB where the app relies on it:
 *   - quote/job/shipment party snapshots  → trg_snapshot_*_party (BEFORE INSERT)
 *   - quote/job numbers                    → set_quote_number trigger / RPCs
 *   - job operations                       → create_job_part_operations_from_routing RPC
 *   - packing-slip numbers + fulfillment   → create_shipment_with_line_items RPC + triggers
 *   - job/part production_status rollups    → status triggers (we progress operations)
 *
 * Run (local):
 *   supabase start && eval "$(supabase status -o env)"
 *   export SUPABASE_URL=$API_URL SUPABASE_SERVICE_ROLE_KEY=$SERVICE_ROLE_KEY
 *   pnpm seed
 *
 * Requires Node >= 22.6 (native TypeScript execution; Node 23.6+ runs .ts with
 * no flag). Reads URL/key from several common env var names (see readEnv).
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// ── Config ──────────────────────────────────────────────────────────────────

const COMPANY_NAME = 'Vanguard Precision Works';
const USER_EMAIL = process.env.SEED_USER_EMAIL ?? 'dev@jigged.test';
const USER_PASSWORD = process.env.SEED_USER_PASSWORD ?? 'jigged-dev-1234';
const USER_DISPLAY_NAME = 'Dev Seed User';

function readEnv(): { url: string; key: string } {
  const url =
    process.env.SUPABASE_URL ||
    process.env.SEED_SUPABASE_URL ||
    process.env.NEXT_PUBLIC_SUPABASE_URL ||
    process.env.TEST_SUPABASE_URL ||
    process.env.API_URL ||
    '';
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SEED_SUPABASE_SECRET_KEY ||
    process.env.TEST_SUPABASE_SECRET_KEY ||
    process.env.SERVICE_ROLE_KEY ||
    '';
  if (!url || !key) {
    console.error(
      '\n[seed-dev] Missing Supabase URL or service-role key.\n\n' +
        'For a local stack:\n' +
        '  supabase start\n' +
        '  eval "$(supabase status -o env)"\n' +
        '  export SUPABASE_URL=$API_URL SUPABASE_SERVICE_ROLE_KEY=$SERVICE_ROLE_KEY\n' +
        '  pnpm seed\n',
    );
    process.exit(1);
  }
  return { url, key };
}

// ── Tiny helpers ─────────────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;
/** ISO timestamp `days` ago (optionally offset by `hours` within that day). */
function daysAgo(days: number, hours = 9): string {
  return new Date(Date.now() - days * DAY_MS + hours * 60 * 60 * 1000).toISOString();
}
/** Date-only (YYYY-MM-DD) `days` from now (negative = past). */
function dateFromNow(days: number): string {
  return new Date(Date.now() + days * DAY_MS).toISOString().slice(0, 10);
}
const round2 = (n: number): number => Math.round(n * 100) / 100;
const round4 = (n: number): number => Math.round(n * 10000) / 10000;

function die(msg: string, err?: unknown): never {
  console.error(`[seed-dev] ${msg}${err ? `: ${(err as Error).message ?? err}` : ''}`);
  process.exit(1);
}

// ── User / company / access ──────────────────────────────────────────────────

async function ensureUser(db: SupabaseClient): Promise<string> {
  const { data: list, error } = await db.auth.admin.listUsers({ perPage: 200 });
  if (error) die('listUsers failed', error);
  const existing = list.users.find((u) => u.email === USER_EMAIL);
  if (existing) return existing.id;
  const { data, error: createErr } = await db.auth.admin.createUser({
    email: USER_EMAIL,
    password: USER_PASSWORD,
    email_confirm: true,
  });
  if (createErr || !data.user) die(`createUser failed for ${USER_EMAIL}`, createErr);
  return data.user!.id;
}

async function ensureCompany(db: SupabaseClient): Promise<string> {
  const { data: existing } = await db
    .from('companies')
    .select('id')
    .eq('name', COMPANY_NAME)
    .maybeSingle();
  if (existing) return existing.id;
  const { data, error } = await db
    .from('companies')
    .insert({ name: COMPANY_NAME })
    .select('id')
    .single();
  if (error || !data) die('company insert failed', error);
  return data!.id;
}

async function ensureAccess(db: SupabaseClient, userId: string, companyId: string): Promise<string> {
  const { data: existing } = await db
    .from('user_company_access')
    .select('id')
    .eq('user_id', userId)
    .eq('company_id', companyId)
    .maybeSingle();
  if (existing) return existing.id;
  const { data, error } = await db
    .from('user_company_access')
    .insert({ user_id: userId, company_id: companyId, role: 'admin', name: USER_DISPLAY_NAME })
    .select('id')
    .single();
  if (error || !data) die('user_company_access insert failed', error);
  return data!.id;
}

/**
 * Delete all of the seed company's domain rows in FK-dependency order so a
 * re-run rebuilds a clean dataset. Keeps the company, the user, and the access
 * link. order_counters is reset so numbering restarts at Q-0001 / J-0001.
 */
async function resetCompanyData(db: SupabaseClient, companyId: string): Promise<void> {
  // Resolve scoping ids that some child tables key on (no company_id column).
  const { data: jobRows } = await db.from('jobs').select('id').eq('company_id', companyId);
  const jobIds = (jobRows ?? []).map((j) => j.id);
  const { data: partRows } = await db.from('parts').select('id').eq('company_id', companyId);
  const partIds = (partRows ?? []).map((p) => p.id);
  const { data: custRows } = await db.from('customers').select('id').eq('company_id', companyId);
  const custIds = (custRows ?? []).map((c) => c.id);
  const { data: routingRows } = await db.from('routings').select('id').eq('company_id', companyId);
  const routingIds = (routingRows ?? []).map((r) => r.id);
  const { data: shipRows } = await db.from('shipments').select('id').eq('company_id', companyId);
  const shipIds = (shipRows ?? []).map((s) => s.id);
  const { data: vendorRows } = await db.from('vendors').select('id').eq('company_id', companyId);
  const vendorIds = (vendorRows ?? []).map((v) => v.id);

  const delIn = async (table: string, col: string, ids: string[]) => {
    if (ids.length === 0) return;
    for (let i = 0; i < ids.length; i += 200) {
      const { error } = await db.from(table).delete().in(col, ids.slice(i, i + 200));
      if (error) die(`reset ${table} failed`, error);
    }
  };
  const delEq = async (table: string) => {
    const { error } = await db.from(table).delete().eq('company_id', companyId);
    if (error) die(`reset ${table} failed`, error);
  };

  // inventory_transactions first: jobs/operations FK to it with ON DELETE SET
  // NULL, but the notes-only-update trigger rejects that SET-NULL — so the
  // transactions must be gone before we delete any job rows.
  await delEq('inventory_transactions');
  await delIn('shipment_line_items', 'shipment_id', shipIds);
  await delEq('shipments');
  await delEq('job_note_media');
  await delEq('job_notes');
  await delIn('job_operations', 'job_id', jobIds);
  await delIn('job_materials', 'job_id', jobIds);
  await delIn('job_parts', 'job_id', jobIds);
  await delEq('quickbooks_invoice_links');
  await delEq('job_fulfillment_audit');
  await delEq('jobs');
  await delEq('quote_line_items');
  await delEq('quote_operations');
  await delEq('quote_materials');
  await delEq('quotes');
  await delIn('part_pricing_tiers', 'part_id', partIds);
  await delIn('part_procurement_tiers', 'part_id', partIds);
  await delIn('parts_bom', 'parent_part_id', partIds);
  await delIn('routing_operations', 'routing_id', routingIds);
  await delEq('routings');
  await delEq('parts');
  await delIn('customer_contacts', 'customer_id', custIds);
  await delIn('customer_addresses', 'customer_id', custIds);
  await delEq('customers');
  await delEq('work_centers');
  await delIn('vendor_contacts', 'vendor_id', vendorIds);
  await delEq('vendors');
  await db.from('company_order_counters').delete().eq('company_id', companyId);
}

// ── Catalog: vendors, work centers ───────────────────────────────────────────

interface VendorSpec {
  key: string;
  name: string;
  city: string;
  state: string;
}
const VENDORS: VendorSpec[] = [
  { key: 'atlas', name: 'Atlas Metals Supply', city: 'Cleveland', state: 'OH' },
  { key: 'fasten', name: 'FastenRight Hardware', city: 'Rockford', state: 'IL' },
  { key: 'profinish', name: 'ProFinish Coatings', city: 'Detroit', state: 'MI' },
  { key: 'bearings', name: 'Precision Bearings Co', city: 'Charlotte', state: 'NC' },
  { key: 'voltedge', name: 'VoltEdge Electronics', city: 'Austin', state: 'TX' },
];

async function seedVendors(db: SupabaseClient, companyId: string): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  for (const v of VENDORS) {
    const { data, error } = await db
      .from('vendors')
      .insert({
        company_id: companyId,
        name: v.name,
        city: v.city,
        state: v.state,
        country: 'USA',
      })
      .select('id')
      .single();
    if (error || !data) die(`vendor insert (${v.name})`, error);
    ids.set(v.key, data!.id);
    // One contact per vendor.
    await db.from('vendor_contacts').insert({
      vendor_id: data!.id,
      name: `${v.name.split(' ')[0]} Sales`,
      email: `sales@${v.key}.example`,
      phone: '555-0100',
      is_primary: true,
    });
  }
  return ids;
}

interface WorkCenterSpec {
  key: string;
  name: string;
  kind: 'internal' | 'external';
  vendorKey?: string;
  laborRate: number | null;
}
const WORK_CENTERS: WorkCenterSpec[] = [
  { key: 'saw', name: 'Bandsaw', kind: 'internal', laborRate: 75 },
  { key: 'mill', name: 'CNC Mill (Haas VF-2)', kind: 'internal', laborRate: 120 },
  { key: 'lathe', name: 'CNC Lathe (Okuma)', kind: 'internal', laborRate: 110 },
  { key: 'deburr', name: 'Manual Deburr', kind: 'internal', laborRate: 65 },
  { key: 'assembly', name: 'Assembly Bench', kind: 'internal', laborRate: 70 },
  { key: 'inspect', name: 'Final Inspection', kind: 'internal', laborRate: 85 },
  { key: 'anodize', name: 'Anodizing (ProFinish)', kind: 'external', vendorKey: 'profinish', laborRate: null },
];

async function seedWorkCenters(
  db: SupabaseClient,
  companyId: string,
  vendorIds: Map<string, string>,
): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  for (const w of WORK_CENTERS) {
    const { data, error } = await db
      .from('work_centers')
      .insert({
        company_id: companyId,
        name: w.name,
        kind: w.kind,
        vendor_id: w.vendorKey ? vendorIds.get(w.vendorKey) : null,
        labor_rate: w.laborRate,
        description: w.kind === 'external' ? 'Outside process' : 'In-house work center',
      })
      .select('id')
      .single();
    if (error || !data) die(`work_center insert (${w.name})`, error);
    ids.set(w.key, data!.id);
  }
  return ids;
}

// ── Catalog: customers + addresses + contacts ────────────────────────────────

interface CustomerSpec {
  name: string;
  city: string;
  state: string;
  line1: string;
  shipCity?: string;
  shipState?: string;
  shipLine1?: string;
  contact: { name: string; role: string; email: string };
}
const CUSTOMERS: CustomerSpec[] = [
  { name: 'Northwind Hydraulics', city: 'Milwaukee', state: 'WI', line1: '1420 Industrial Pkwy', contact: { name: 'Dana Reyes', role: 'buyer', email: 'dana@northwind.example' } },
  { name: 'Cascade Robotics', city: 'Portland', state: 'OR', line1: '88 Maker Way', shipCity: 'Hillsboro', shipState: 'OR', shipLine1: 'Dock 7, 200 Fab Rd', contact: { name: 'Sam Okafor', role: 'engineering', email: 'sam@cascade.example' } },
  { name: 'Meridian Aerospace', city: 'Wichita', state: 'KS', line1: '5 Falcon Loop', contact: { name: 'Priya Menon', role: 'quality', email: 'priya@meridian.example' } },
  { name: 'Granite Equipment Co', city: 'Manchester', state: 'NH', line1: '310 Quarry St', contact: { name: 'Tom Beck', role: 'buyer', email: 'tom@granite.example' } },
  { name: 'BlueRidge Medical Devices', city: 'Asheville', state: 'NC', line1: '47 Sterile Dr', contact: { name: 'Lena Park', role: 'accounts_payable', email: 'ap@blueridge.example' } },
  { name: 'Sierra Pump & Valve', city: 'Reno', state: 'NV', line1: '900 Basin Ave', shipCity: 'Sparks', shipState: 'NV', shipLine1: 'Whse B, 12 Flow Ct', contact: { name: 'Marco Diaz', role: 'shipping_receiving', email: 'recv@sierrapump.example' } },
];

interface SeededCustomer {
  id: string;
  name: string;
  billingAddressId: string;
  shippingAddressId: string;
  contactId: string;
}

async function seedCustomers(db: SupabaseClient, companyId: string): Promise<SeededCustomer[]> {
  const out: SeededCustomer[] = [];
  for (const c of CUSTOMERS) {
    const { data: cust, error } = await db
      .from('customers')
      .insert({ company_id: companyId, name: c.name })
      .select('id')
      .single();
    if (error || !cust) die(`customer insert (${c.name})`, error);

    const { data: billing, error: bErr } = await db
      .from('customer_addresses')
      .insert({
        customer_id: cust!.id,
        address_line1: c.line1,
        city: c.city,
        state: c.state,
        postal_code: '00000',
        country: 'USA',
        default_billing: true,
        default_shipping: !c.shipLine1,
        attention_to: 'Accounts Payable',
      })
      .select('id')
      .single();
    if (bErr || !billing) die(`billing address insert (${c.name})`, bErr);

    let shippingId = billing!.id;
    if (c.shipLine1) {
      const { data: ship, error: sErr } = await db
        .from('customer_addresses')
        .insert({
          customer_id: cust!.id,
          address_line1: c.shipLine1,
          city: c.shipCity,
          state: c.shipState,
          postal_code: '00000',
          country: 'USA',
          default_billing: false,
          default_shipping: true,
          attention_to: 'Receiving',
        })
        .select('id')
        .single();
      if (sErr || !ship) die(`shipping address insert (${c.name})`, sErr);
      shippingId = ship!.id;
    }

    const { data: contact, error: ctErr } = await db
      .from('customer_contacts')
      .insert({
        customer_id: cust!.id,
        name: c.contact.name,
        role: c.contact.role,
        email: c.contact.email,
        phone: '555-0123',
        is_primary: true,
      })
      .select('id')
      .single();
    if (ctErr || !contact) die(`contact insert (${c.name})`, ctErr);

    out.push({
      id: cust!.id,
      name: c.name,
      billingAddressId: billing!.id,
      shippingAddressId: shippingId,
      contactId: contact!.id,
    });
  }
  return out;
}

// ── Catalog: parts, BOM, routings, tiers ─────────────────────────────────────

type Source = 'made' | 'bought';
interface PartSpec {
  key: string;
  name: string;
  description: string;
  source: Source;
  stocked: boolean;
  unit: string;
  // bought:
  vendorKey?: string;
  cost?: number;
  // made: routing op work-center keys (in sequence) + BOM children {key, qty}
  ops?: string[];
  bom?: { key: string; qty: number }[];
  // sellable made parts get pricing tiers: [{qty, markupPct}]
  tiers?: { qty: number; markup: number }[];
  // starting on-hand for stocked parts (set via receipts history)
  onHand?: number;
}

// Raw blanks & bought components (leaves of the BOM tree).
const PARTS: PartSpec[] = [
  { key: 'al', name: 'RAW-AL6061-BLANK', description: 'Aluminum 6061 machining blank', source: 'bought', stocked: true, unit: 'ea', vendorKey: 'atlas', cost: 6.4, onHand: 240 },
  { key: 'steel', name: 'RAW-STEEL-BLANK', description: 'Steel A36 plate blank', source: 'bought', stocked: true, unit: 'ea', vendorKey: 'atlas', cost: 4.1, onHand: 180 },
  { key: 'ss', name: 'RAW-SS304-BLANK', description: 'Stainless 304 rod blank', source: 'bought', stocked: true, unit: 'ea', vendorKey: 'atlas', cost: 7.85, onHand: 120 },
  { key: 'bearing', name: 'BUY-BEARING-608ZZ', description: 'Ball bearing 608ZZ', source: 'bought', stocked: true, unit: 'ea', vendorKey: 'bearings', cost: 1.25, onHand: 600 },
  { key: 'oring', name: 'BUY-ORING-214', description: 'O-ring #214 Buna-N', source: 'bought', stocked: true, unit: 'ea', vendorKey: 'fasten', cost: 0.18, onHand: 1500 },
  { key: 'shcs', name: 'BUY-SHCS-M5x16', description: 'M5x16 socket head cap screw', source: 'bought', stocked: true, unit: 'ea', vendorKey: 'fasten', cost: 0.07, onHand: 5000 },
  { key: 'dowel', name: 'BUY-DOWEL-3MM', description: 'Dowel pin 3mm x 16', source: 'bought', stocked: true, unit: 'ea', vendorKey: 'fasten', cost: 0.09, onHand: 2200 },
  { key: 'motor', name: 'BUY-MOTOR-12V', description: '12V DC gearmotor', source: 'bought', stocked: true, unit: 'ea', vendorKey: 'voltedge', cost: 14.5, onHand: 60 },

  // Machined sub-components (level 1 made parts).
  { key: 'housing', name: 'SUB-HOUSING', description: 'Pump housing, machined', source: 'made', stocked: true, unit: 'ea', ops: ['saw', 'mill', 'deburr'], bom: [{ key: 'al', qty: 1 }], onHand: 25 },
  { key: 'shaft', name: 'SUB-SHAFT', description: 'Drive shaft, turned', source: 'made', stocked: true, unit: 'ea', ops: ['saw', 'lathe', 'deburr'], bom: [{ key: 'ss', qty: 1 }], onHand: 40 },
  { key: 'cover', name: 'SUB-COVER', description: 'End cover, anodized', source: 'made', stocked: true, unit: 'ea', ops: ['mill', 'deburr', 'anodize'], bom: [{ key: 'steel', qty: 1 }], onHand: 30 },
  { key: 'bracket', name: 'SUB-BRACKET', description: 'Mounting bracket', source: 'made', stocked: true, unit: 'ea', ops: ['mill', 'deburr'], bom: [{ key: 'steel', qty: 1 }], onHand: 35 },

  // Sub-assemblies (level 2 made parts).
  { key: 'pumpcore', name: 'ASM-PUMPCORE', description: 'Pump core assembly', source: 'made', stocked: true, unit: 'ea', ops: ['assembly', 'inspect'], bom: [{ key: 'housing', qty: 1 }, { key: 'shaft', qty: 1 }, { key: 'bearing', qty: 2 }, { key: 'oring', qty: 2 }], onHand: 12 },
  { key: 'gearbox', name: 'ASM-GEARBOX', description: 'Gearbox subassembly', source: 'made', stocked: true, unit: 'ea', ops: ['assembly', 'inspect'], bom: [{ key: 'bracket', qty: 1 }, { key: 'motor', qty: 1 }, { key: 'shcs', qty: 4 }], onHand: 8 },

  // Top-level sellable products (level 3+ made parts) with pricing tiers.
  { key: 'pump', name: 'PROD-PUMP-100', description: 'Hydraulic Pump P-100', source: 'made', stocked: false, unit: 'ea', ops: ['assembly', 'inspect'], bom: [{ key: 'pumpcore', qty: 1 }, { key: 'cover', qty: 2 }, { key: 'shcs', qty: 8 }, { key: 'dowel', qty: 4 }], tiers: [{ qty: 1, markup: 60 }, { qty: 10, markup: 50 }, { qty: 25, markup: 42 }] },
  { key: 'actuator', name: 'PROD-ACTUATOR-200', description: 'Linear Actuator A-200', source: 'made', stocked: false, unit: 'ea', ops: ['assembly', 'inspect'], bom: [{ key: 'gearbox', qty: 1 }, { key: 'shaft', qty: 1 }, { key: 'bearing', qty: 1 }], tiers: [{ qty: 1, markup: 65 }, { qty: 5, markup: 55 }, { qty: 20, markup: 48 }] },
  { key: 'manifold', name: 'PROD-MANIFOLD-300', description: 'Valve Manifold M-300', source: 'made', stocked: false, unit: 'ea', ops: ['mill', 'assembly', 'inspect'], bom: [{ key: 'housing', qty: 1 }, { key: 'cover', qty: 1 }, { key: 'oring', qty: 4 }, { key: 'shcs', qty: 6 }], tiers: [{ qty: 1, markup: 58 }, { qty: 10, markup: 47 }] },
  // Sold-by-length part (fractional units) — standalone sellable, no BOM.
  { key: 'rail', name: 'PROD-RAIL-CUT', description: 'Cut-to-length guide rail (per inch)', source: 'made', stocked: false, unit: 'in', ops: ['saw', 'deburr'], tiers: [{ qty: 1, markup: 70 }, { qty: 36, markup: 55 }] },
];

interface SeededPart {
  id: string;
  spec: PartSpec;
}

async function seedParts(
  db: SupabaseClient,
  companyId: string,
  vendorIds: Map<string, string>,
  wcIds: Map<string, string>,
): Promise<Map<string, SeededPart>> {
  const parts = new Map<string, SeededPart>();

  // 1. Insert parts (set preferred_vendor for bought parts).
  for (const p of PARTS) {
    const { data, error } = await db
      .from('parts')
      .insert({
        company_id: companyId,
        part_name: p.name,
        description: p.description,
        source: p.source,
        is_stocked: p.stocked,
        primary_unit: p.unit,
        quantity: 0, // set later via inventory receipts
        reorder_point: p.stocked ? 10 : null,
        preferred_vendor_id: p.source === 'bought' ? vendorIds.get(p.vendorKey!) : null,
      })
      .select('id')
      .single();
    if (error || !data) die(`part insert (${p.name})`, error);
    parts.set(p.key, { id: data!.id, spec: p });
  }

  // 2. Procurement tiers for bought parts (under the preferred vendor so
  //    compute_part_cost_at_qty resolves a cost).
  for (const p of PARTS) {
    if (p.source !== 'bought' || p.cost == null) continue;
    const part = parts.get(p.key)!;
    const { error } = await db.from('part_procurement_tiers').insert({
      part_id: part.id,
      vendor_id: vendorIds.get(p.vendorKey!),
      min_quantity: 1,
      cost_per_unit: p.cost,
    });
    if (error) die(`procurement tier insert (${p.name})`, error);
  }

  // 3. BOM edges.
  for (const p of PARTS) {
    if (!p.bom) continue;
    const parent = parts.get(p.key)!;
    let seq = 10;
    for (const child of p.bom) {
      const childPart = parts.get(child.key);
      if (!childPart) die(`BOM child '${child.key}' for ${p.name} not found`);
      const { error } = await db.from('parts_bom').insert({
        parent_part_id: parent.id,
        child_part_id: childPart!.id,
        quantity: child.qty,
        unit: childPart!.spec.unit,
        sequence: seq,
      });
      if (error) die(`bom insert (${p.name} -> ${child.key})`, error);
      seq += 10;
    }
  }

  // 4. Routings + operations for made parts.
  for (const p of PARTS) {
    if (p.source !== 'made' || !p.ops) continue;
    const part = parts.get(p.key)!;
    const { data: routing, error: rErr } = await db
      .from('routings')
      .insert({ company_id: companyId, part_id: part.id, name: `${p.name} routing`, description: 'Standard routing' })
      .select('id')
      .single();
    if (rErr || !routing) die(`routing insert (${p.name})`, rErr);
    let seq = 10;
    for (const wcKey of p.ops) {
      const wc = WORK_CENTERS.find((w) => w.key === wcKey)!;
      const isExternal = wc.kind === 'external';
      const { error: opErr } = await db.from('routing_operations').insert({
        routing_id: routing!.id,
        work_center_id: wcIds.get(wcKey),
        sequence: seq,
        setup_minutes: isExternal ? 0 : 15,
        cycle_minutes_per_unit: isExternal ? 0 : 3,
        labor_rate_override: null,
        external_unit_price: isExternal ? 4.5 : null,
        instructions: `${wc.name} operation`,
      });
      if (opErr) die(`routing op insert (${p.name}/${wcKey})`, opErr);
      seq += 10;
    }
  }

  // 5. Pricing tiers for sellable parts.
  for (const p of PARTS) {
    if (!p.tiers) continue;
    const part = parts.get(p.key)!;
    let seq = 1;
    for (const t of p.tiers) {
      const { error } = await db.from('part_pricing_tiers').insert({
        part_id: part.id,
        company_id: companyId,
        sequence: seq,
        quantity: t.qty,
        markup_percent: t.markup,
      });
      if (error) die(`pricing tier insert (${p.name}@${t.qty})`, error);
      seq += 1;
    }
  }

  return parts;
}

// ── Inventory receipts (stock history) ───────────────────────────────────────

async function seedInventoryReceipts(
  db: SupabaseClient,
  companyId: string,
  userId: string,
  parts: Map<string, SeededPart>,
): Promise<void> {
  for (const { id, spec } of parts.values()) {
    if (!spec.stocked || !spec.onHand) continue;
    // Split the on-hand into 2-3 dated receipts to build a little history.
    const total = spec.onHand;
    const lots = [Math.round(total * 0.5), Math.round(total * 0.3), total - Math.round(total * 0.5) - Math.round(total * 0.3)];
    const ages = [150, 75, 20];
    for (let i = 0; i < lots.length; i++) {
      if (lots[i] <= 0) continue;
      const { error } = await db.from('inventory_transactions').insert({
        company_id: companyId,
        part_id: id,
        item_name: spec.name,
        type: 'addition',
        quantity: lots[i],
        unit: spec.unit,
        converted_quantity: lots[i],
        notes: `PO receipt lot ${i + 1}`,
        created_by: userId,
        created_at: daysAgo(ages[i]),
      });
      if (error) die(`inventory receipt insert (${spec.name})`, error);
    }
    // Set the live on-hand to the receipts total.
    const { error: upErr } = await db.from('parts').update({ quantity: total }).eq('id', id);
    if (upErr) die(`part quantity update (${spec.name})`, upErr);
  }
}

// ── Cost-resolution sanity check ─────────────────────────────────────────────

async function checkCosts(db: SupabaseClient, parts: Map<string, SeededPart>): Promise<void> {
  const sellable = [...parts.values()].filter((p) => p.spec.tiers);
  console.log('[seed-dev] cost resolution check (compute_part_cost_at_qty):');
  for (const p of sellable) {
    const { data, error } = await db.rpc('compute_part_cost_at_qty', { p_part_id: p.id, p_qty: 1 });
    if (error) {
      console.log(`   ✗ ${p.spec.name}: ${error.message}`);
    } else {
      console.log(`   ✓ ${p.spec.name}: base unit cost @1 = ${data}`);
    }
  }
}

// ── Pass 2: quotes → jobs → operations → shipments + history ─────────────────

interface Ctx {
  db: SupabaseClient;
  companyId: string;
  userId: string;
  accessId: string;
  partsById: Map<string, SeededPart>;
}

interface ComputedTier {
  id: string;
  quantity: number;
  unit_price: number | null;
  markup_percent: number | null;
}

/** Compute each pricing tier's sell price (base cost @ tier qty × markup),
 *  mirroring getTiersWithComputedPrices so seeded snapshots match live. */
async function computeTiers(ctx: Ctx, part: SeededPart): Promise<ComputedTier[]> {
  const { data: rows, error } = await ctx.db
    .from('part_pricing_tiers')
    .select('id, quantity, markup_percent')
    .eq('part_id', part.id)
    .order('quantity', { ascending: true });
  if (error) die(`tier read (${part.spec.name})`, error);
  const tiers: ComputedTier[] = [];
  for (const t of rows ?? []) {
    const { data: base, error: cErr } = await ctx.db.rpc('compute_part_cost_at_qty', {
      p_part_id: part.id,
      p_qty: t.quantity,
    });
    if (cErr) die(`compute_part_cost (${part.spec.name}@${t.quantity})`, cErr);
    const baseCost = round2(Number(base));
    const markup = t.markup_percent == null ? null : Number(t.markup_percent);
    const unit_price = markup == null ? null : round2(baseCost * (1 + markup / 100));
    tiers.push({ id: t.id, quantity: Number(t.quantity), unit_price, markup_percent: markup });
  }
  return tiers;
}

function resolveTier(
  tiers: ComputedTier[],
  orderQty: number,
): { unit_price: number; source_tier_id: string } | null {
  const priced = tiers
    .filter((t): t is ComputedTier & { unit_price: number } => t.unit_price != null)
    .sort((a, b) => a.quantity - b.quantity);
  if (!priced.length) return null;
  if (orderQty < priced[0].quantity) {
    return { unit_price: priced[0].unit_price, source_tier_id: priced[0].id };
  }
  let match = priced[0];
  for (const t of priced) {
    if (t.quantity <= orderQty) match = t;
    else break;
  }
  return { unit_price: match.unit_price, source_tier_id: match.id };
}

function buildSnapshot(tiers: ComputedTier[], orderQty: number, resolvedTierId: string | null) {
  const priced = tiers
    .filter((t) => t.unit_price != null)
    .map((t) => ({
      id: t.id,
      quantity: t.quantity,
      unit_price: t.unit_price,
      markup_percent: t.markup_percent,
    }))
    .sort((a, b) => a.quantity - b.quantity);
  return {
    tiers: priced,
    resolved_tier_id: resolvedTierId,
    resolved_quantity: orderQty,
    captured_at: new Date().toISOString(),
  };
}

interface QuoteLineInput {
  part: SeededPart;
  qty: number;
  /** When set, line is a custom-price override (never tier-priced / drift-checked). */
  override?: number;
}
interface SeededLine {
  id: string;
  partId: string;
  quantity: number;
  unitPrice: number;
}
interface SeededQuote {
  quoteId: string;
  quoteNumber: string;
  lines: SeededLine[];
}

async function createQuote(
  ctx: Ctx,
  args: {
    customer: SeededCustomer;
    lines: QuoteLineInput[];
    status?: 'active' | 'expired';
    createdDaysAgo: number;
    expirationDays?: number;
    leadDays?: number;
    paymentTerms?: string;
  },
): Promise<SeededQuote> {
  const { db, companyId, userId } = ctx;
  const created = daysAgo(args.createdDaysAgo);
  const { data: quote, error } = await db
    .from('quotes')
    .insert({
      company_id: companyId,
      quote_number: '', // set_quote_number trigger fills this
      customer_id: args.customer.id,
      billing_address_id: args.customer.billingAddressId,
      shipping_address_id: args.customer.shippingAddressId,
      contact_id: args.customer.contactId,
      status: args.status ?? 'active',
      lead_time_days: args.leadDays ?? 14,
      lead_time_value: args.leadDays ?? 14,
      lead_time_unit: 'calendar_days',
      payment_terms: args.paymentTerms ?? 'Net 30',
      expiration_date: dateFromNow(args.expirationDays ?? 30),
      created_by: userId,
      created_at: created,
      status_changed_at: created,
    })
    .select('id, quote_number')
    .single();
  if (error || !quote) die('quote insert', error);

  const lines: SeededLine[] = [];
  let seq = 10;
  for (const li of args.lines) {
    const tiers = await computeTiers(ctx, li.part);
    let unitPrice: number;
    let sourceTierId: string | null = null;
    let isOverride = false;
    if (li.override != null) {
      unitPrice = li.override;
      isOverride = true;
      sourceTierId = resolveTier(tiers, li.qty)?.source_tier_id ?? null;
    } else {
      const resolved = resolveTier(tiers, li.qty);
      if (!resolved) die(`no priced tier for ${li.part.spec.name} @ ${li.qty}`);
      unitPrice = resolved!.unit_price;
      sourceTierId = resolved!.source_tier_id;
    }
    const baseRpc = await db.rpc('compute_part_cost_at_qty', { p_part_id: li.part.id, p_qty: li.qty });
    const baseCost = baseRpc.data != null ? round2(Number(baseRpc.data)) : null;
    const { data: lineRow, error: lErr } = await db
      .from('quote_line_items')
      .insert({
        quote_id: quote!.id,
        company_id: companyId,
        part_id: li.part.id,
        source_tier_id: sourceTierId,
        sequence: seq,
        quantity: li.qty,
        unit_price: unitPrice,
        total_price: round2(unitPrice * li.qty),
        markup_percent: null,
        base_cost_per_unit: baseCost,
        is_quote_override: isOverride,
        pricing_basis_snapshot: buildSnapshot(tiers, li.qty, sourceTierId),
        basis_unknown: false,
        created_at: created,
      })
      .select('id')
      .single();
    if (lErr || !lineRow) die(`quote line insert (${li.part.spec.name})`, lErr);
    lines.push({ id: lineRow!.id, partId: li.part.id, quantity: li.qty, unitPrice });
    seq += 10;
  }
  return { quoteId: quote!.id, quoteNumber: quote!.quote_number, lines };
}

async function routingIdFor(ctx: Ctx, partId: string): Promise<string | null> {
  const { data } = await ctx.db.from('routings').select('id').eq('part_id', partId).maybeSingle();
  return data?.id ?? null;
}

interface SeededJob {
  jobId: string;
  jobNumber: string;
  parts: { id: string; partId: string; quantity: number }[];
}

async function insertJobParts(
  ctx: Ctx,
  jobId: string,
  lines: { partId: string; quantity: number; unitPrice: number; sourceLineId?: string | null }[],
  createdAt: string,
): Promise<SeededJob['parts']> {
  const out: SeededJob['parts'] = [];
  let seq = 10;
  for (const l of lines) {
    const { data: jp, error } = await ctx.db
      .from('job_parts')
      .insert({
        job_id: jobId,
        company_id: ctx.companyId,
        part_id: l.partId,
        source_quote_line_item_id: l.sourceLineId ?? null,
        sequence: seq,
        quantity: l.quantity,
        unit_price: l.unitPrice,
        total_price: round4(l.unitPrice * l.quantity),
        production_status: 'not_started',
        fulfillment_status: 'unshipped',
        created_at: createdAt,
      })
      .select('id')
      .single();
    if (error || !jp) die('job_part insert', error);
    const routingId = await routingIdFor(ctx, l.partId);
    if (routingId) {
      const { error: rpcErr } = await ctx.db.rpc('create_job_part_operations_from_routing', {
        p_job_part_id: jp!.id,
        p_routing_id: routingId,
      });
      if (rpcErr) die('create_job_part_operations_from_routing', rpcErr);
    }
    out.push({ id: jp!.id, partId: l.partId, quantity: l.quantity });
    seq += 10;
  }
  return out;
}

async function convertToJob(
  ctx: Ctx,
  args: { quote: SeededQuote; customer: SeededCustomer; poNumber: string; dueDays: number; createdDaysAgo: number },
): Promise<SeededJob> {
  const { db, companyId, userId } = ctx;
  const created = daysAgo(args.createdDaysAgo);
  const jobNumber = args.quote.quoteNumber.replace(/^Q-/, 'J-');
  const { data: job, error } = await db
    .from('jobs')
    .insert({
      company_id: companyId,
      quote_id: args.quote.quoteId,
      customer_id: args.customer.id,
      job_number: jobNumber,
      production_status: 'not_started',
      fulfillment_status: 'unshipped',
      due_date: dateFromNow(args.dueDays),
      lead_time_days: 14,
      customer_po_number: args.poNumber,
      billing_address_id: args.customer.billingAddressId,
      shipping_address_id: args.customer.shippingAddressId,
      contact_id: args.customer.contactId,
      created_by: userId,
      created_at: created,
    })
    .select('id, job_number')
    .single();
  if (error || !job) die('job insert (convert)', error);

  const parts = await insertJobParts(
    ctx,
    job!.id,
    args.quote.lines.map((l) => ({
      partId: l.partId,
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      sourceLineId: l.id,
    })),
    created,
  );
  await db
    .from('quotes')
    .update({ converted_at: created, status_changed_at: created })
    .eq('id', args.quote.quoteId);
  return { jobId: job!.id, jobNumber: job!.job_number, parts };
}

async function createDirectJob(
  ctx: Ctx,
  args: {
    customer: SeededCustomer;
    lines: { part: SeededPart; qty: number; unitPrice: number }[];
    poNumber: string;
    dueDays: number;
    createdDaysAgo: number;
  },
): Promise<SeededJob> {
  const { db, companyId, userId } = ctx;
  const created = daysAgo(args.createdDaysAgo);
  const { data: jobNumber, error: numErr } = await db.rpc('generate_direct_job_number', {
    company_uuid: companyId,
  });
  if (numErr) die('generate_direct_job_number', numErr);
  const { data: job, error } = await db
    .from('jobs')
    .insert({
      company_id: companyId,
      quote_id: null,
      customer_id: args.customer.id,
      job_number: jobNumber as string,
      production_status: 'not_started',
      fulfillment_status: 'unshipped',
      due_date: dateFromNow(args.dueDays),
      customer_po_number: args.poNumber,
      billing_address_id: args.customer.billingAddressId,
      shipping_address_id: args.customer.shippingAddressId,
      contact_id: args.customer.contactId,
      created_by: userId,
      created_at: created,
    })
    .select('id, job_number')
    .single();
  if (error || !job) die('job insert (direct)', error);
  const parts = await insertJobParts(
    ctx,
    job!.id,
    args.lines.map((l) => ({ partId: l.part.id, quantity: l.qty, unitPrice: l.unitPrice })),
    created,
  );
  return { jobId: job!.id, jobNumber: job!.job_number, parts };
}

/** Progress a job by setting operation + job_part statuses (the job-status
 *  trigger rolls up from parts). 'completed'/'in_progress'/'cancelled'. */
async function progressJob(
  ctx: Ctx,
  job: SeededJob,
  status: 'completed' | 'in_progress' | 'cancelled',
  anchorDaysAgo: number,
): Promise<void> {
  const { db } = ctx;
  if (status === 'cancelled') {
    for (const jp of job.parts) {
      await db
        .from('job_parts')
        .update({ production_status: 'cancelled', status_changed_at: daysAgo(anchorDaysAgo) })
        .eq('id', jp.id);
    }
    return;
  }
  for (const jp of job.parts) {
    const { data: ops } = await db
      .from('job_operations')
      .select('id, sequence')
      .eq('job_part_id', jp.id)
      .order('sequence', { ascending: true });
    const list = ops ?? [];
    if (status === 'completed') {
      for (let i = 0; i < list.length; i++) {
        await db
          .from('job_operations')
          .update({
            status: 'completed',
            started_at: daysAgo(anchorDaysAgo + (list.length - i) * 2),
            completed_at: daysAgo(anchorDaysAgo + (list.length - i) * 2 - 1),
            completed_by: ctx.userId,
          })
          .eq('id', list[i].id);
      }
      await db
        .from('job_parts')
        .update({
          production_status: 'completed',
          started_at: daysAgo(anchorDaysAgo + list.length * 2),
          completed_at: daysAgo(anchorDaysAgo),
          status_changed_at: daysAgo(anchorDaysAgo),
        })
        .eq('id', jp.id);
    } else {
      // in_progress: complete the first op, start the second (if any).
      if (list[0]) {
        await db
          .from('job_operations')
          .update({
            status: 'completed',
            started_at: daysAgo(anchorDaysAgo + 3),
            completed_at: daysAgo(anchorDaysAgo + 2),
            completed_by: ctx.userId,
          })
          .eq('id', list[0].id);
      }
      if (list[1]) {
        await db
          .from('job_operations')
          .update({ status: 'in_progress', started_at: daysAgo(anchorDaysAgo + 1) })
          .eq('id', list[1].id);
      }
      await db
        .from('job_parts')
        .update({
          production_status: 'in_progress',
          started_at: daysAgo(anchorDaysAgo + 3),
          status_changed_at: daysAgo(anchorDaysAgo + 1),
        })
        .eq('id', jp.id);
    }
  }
}

/** Deplete the immediate stocked BOM children of each job part (issued to job). */
async function depleteForJob(ctx: Ctx, job: SeededJob, whenDaysAgo: number): Promise<void> {
  const { db, companyId, userId } = ctx;
  for (const jp of job.parts) {
    const { data: edges } = await db
      .from('parts_bom')
      .select('child_part_id, quantity, unit')
      .eq('parent_part_id', jp.partId);
    for (const e of edges ?? []) {
      const child = ctx.partsById.get(e.child_part_id);
      if (!child || !child.spec.stocked) continue;
      const used = Number(e.quantity) * jp.quantity;
      await db.from('inventory_transactions').insert({
        company_id: companyId,
        part_id: e.child_part_id,
        item_name: child.spec.name,
        type: 'depletion',
        quantity: used,
        unit: e.unit,
        converted_quantity: used,
        job_id: job.jobId,
        notes: `Issued to ${job.jobNumber}`,
        created_by: userId,
        created_at: daysAgo(whenDaysAgo),
      });
      // Decrement live on-hand (clamp at 0).
      const { data: cur } = await db.from('parts').select('quantity').eq('id', e.child_part_id).single();
      const next = Math.max(0, Number(cur?.quantity ?? 0) - used);
      await db.from('parts').update({ quantity: next }).eq('id', e.child_part_id);
    }
  }
}

/**
 * Create a shipment by direct insert (the create_shipment_with_line_items RPC
 * gates on auth.uid(), which is null for the service-role client). We mint the
 * PS-{jobBase}-{n} number ourselves; inserting shipment_line_items fires the
 * fulfillment-cascade triggers, so job_part/job fulfillment_status update on
 * their own. fraction >= 1 ships the full ordered quantity (fractional-safe).
 */
async function shipJob(
  ctx: Ctx,
  args: {
    job: SeededJob;
    customer: SeededCustomer;
    fraction: number;
    daysAgo: number;
    voided?: boolean;
  },
): Promise<void> {
  const { db, companyId } = ctx;
  const jobBase = args.job.jobNumber.replace(/^[A-Za-z]+-/, '');
  const { count } = await db
    .from('shipments')
    .select('id', { count: 'exact', head: true })
    .eq('job_id', args.job.jobId);
  const packingSlip = `PS-${jobBase}-${(count ?? 0) + 1}`;
  const { data: ship, error } = await db
    .from('shipments')
    .insert({
      company_id: companyId,
      customer_id: args.customer.id,
      shipping_address_id: args.customer.shippingAddressId,
      one_time_address: null,
      packing_slip_number: packingSlip,
      ship_date: dateFromNow(-args.daysAgo),
      carrier: 'UPS Ground',
      shipping_method: 'shipment',
      job_id: args.job.jobId,
      created_by: ctx.userId,
      created_at: daysAgo(args.daysAgo),
    })
    .select('id')
    .single();
  if (error || !ship) die(`shipment insert (${args.job.jobNumber})`, error);

  for (const jp of args.job.parts) {
    const qty = args.fraction >= 1 ? jp.quantity : Math.max(round2(jp.quantity * args.fraction), 1);
    const { error: liErr } = await db
      .from('shipment_line_items')
      .insert({ shipment_id: ship!.id, job_part_id: jp.id, quantity: qty });
    if (liErr) die(`shipment line insert (${args.job.jobNumber})`, liErr);
  }
  if (args.voided) {
    await db
      .from('shipments')
      .update({ voided_at: daysAgo(args.daysAgo - 1), voided_by: ctx.userId })
      .eq('id', ship!.id);
  }
}

async function addNote(
  ctx: Ctx,
  args: { jobId: string; body: string; type?: 'user' | 'event'; daysAgo: number; jobPartId?: string },
): Promise<void> {
  const { error } = await ctx.db.from('job_notes').insert({
    company_id: ctx.companyId,
    job_id: args.jobId,
    author_id: ctx.accessId,
    body: args.body,
    note_type: args.type ?? 'user',
    job_part_id: args.jobPartId ?? null,
    created_at: daysAgo(args.daysAgo),
  });
  if (error) die('job_note insert', error);
}

async function addInvoiceLink(
  ctx: Ctx,
  args: { jobId: string; quoteId: string | null; docNumber: string; daysAgo: number },
): Promise<void> {
  const { error } = await ctx.db.from('quickbooks_invoice_links').insert({
    company_id: ctx.companyId,
    job_id: args.jobId,
    quote_id: args.quoteId,
    realm_id: '9130350000000000',
    qb_request_id: crypto.randomUUID(),
    qb_invoice_id: `INV-${args.docNumber}`,
    qb_invoice_doc_number: args.docNumber,
    qb_invoice_url: `https://app.qbo.intuit.com/app/invoice?txnId=${args.docNumber}`,
    status: 'created',
    created_at: daysAgo(args.daysAgo),
  });
  if (error) die('quickbooks_invoice_link insert', error);
}

async function seedTransactions(
  ctx: Ctx,
  customers: SeededCustomer[],
  parts: Map<string, SeededPart>,
): Promise<{ quotes: number; jobs: number; shipments: number; notes: number }> {
  const pump = parts.get('pump')!;
  const actuator = parts.get('actuator')!;
  const manifold = parts.get('manifold')!;
  const rail = parts.get('rail')!;
  let quotes = 0;
  let jobs = 0;
  let shipments = 0;
  let notes = 0;

  // 1. Converted → completed → shipped + invoiced (Northwind, pump x10).
  const q1 = await createQuote(ctx, { customer: customers[0], lines: [{ part: pump, qty: 10 }], status: 'active', createdDaysAgo: 178, leadDays: 21 });
  quotes++;
  const j1 = await convertToJob(ctx, { quote: q1, customer: customers[0], poNumber: 'PO-NW-44120', dueDays: -130, createdDaysAgo: 172 });
  jobs++;
  await progressJob(ctx, j1, 'completed', 150);
  await depleteForJob(ctx, j1, 158);
  await shipJob(ctx, { job: j1, customer: customers[0], fraction: 1, daysAgo: 148 });
  shipments++;
  await addInvoiceLink(ctx, { jobId: j1.jobId, quoteId: q1.quoteId, docNumber: '1001', daysAgo: 147 });
  await addNote(ctx, { jobId: j1.jobId, body: 'First article approved by customer QA. Released full lot.', daysAgo: 165 });
  await addNote(ctx, { jobId: j1.jobId, body: 'Lot complete, packed and shipped via UPS.', daysAgo: 148 });
  notes += 2;

  // 2. Converted → completed → shipped + invoiced (Meridian, manifold x25).
  const q2 = await createQuote(ctx, { customer: customers[2], lines: [{ part: manifold, qty: 25 }], status: 'active', createdDaysAgo: 140, leadDays: 28 });
  quotes++;
  const j2 = await convertToJob(ctx, { quote: q2, customer: customers[2], poNumber: 'PO-MER-7781', dueDays: -60, createdDaysAgo: 134 });
  jobs++;
  await progressJob(ctx, j2, 'completed', 90);
  await depleteForJob(ctx, j2, 100);
  await shipJob(ctx, { job: j2, customer: customers[2], fraction: 1, daysAgo: 88 });
  shipments++;
  await addInvoiceLink(ctx, { jobId: j2.jobId, quoteId: q2.quoteId, docNumber: '1002', daysAgo: 86 });
  await addNote(ctx, { jobId: j2.jobId, body: 'Anodize batch returned from ProFinish, within spec.', daysAgo: 96 });
  notes++;

  // 3. Converted → in_progress, partially shipped (Cascade, actuator x20).
  const q3 = await createQuote(ctx, { customer: customers[1], lines: [{ part: actuator, qty: 20 }], status: 'active', createdDaysAgo: 60, leadDays: 21 });
  quotes++;
  const j3 = await convertToJob(ctx, { quote: q3, customer: customers[1], poNumber: 'PO-CAS-2207', dueDays: 12, createdDaysAgo: 52 });
  jobs++;
  await progressJob(ctx, j3, 'in_progress', 20);
  await depleteForJob(ctx, j3, 18);
  await shipJob(ctx, { job: j3, customer: customers[1], fraction: 0.5, daysAgo: 8 });
  shipments++;
  await addNote(ctx, { jobId: j3.jobId, body: 'Customer requested 10 ship early; partial slip cut.', daysAgo: 8 });
  notes++;

  // 4. Converted → in_progress (Sierra, pump x10 + manifold x5).
  const q4 = await createQuote(ctx, { customer: customers[5], lines: [{ part: pump, qty: 10 }, { part: manifold, qty: 5 }], status: 'active', createdDaysAgo: 40, leadDays: 30 });
  quotes++;
  const j4 = await convertToJob(ctx, { quote: q4, customer: customers[5], poNumber: 'PO-SPV-9912', dueDays: 25, createdDaysAgo: 33 });
  jobs++;
  await progressJob(ctx, j4, 'in_progress', 10);
  await depleteForJob(ctx, j4, 9);
  await addNote(ctx, { jobId: j4.jobId, body: 'Housing op running on the Haas, on schedule.', daysAgo: 6 });
  notes++;

  // 5. Converted → not_started (Granite, actuator x5).
  const q5 = await createQuote(ctx, { customer: customers[3], lines: [{ part: actuator, qty: 5 }], status: 'active', createdDaysAgo: 18, leadDays: 21 });
  quotes++;
  const j5 = await convertToJob(ctx, { quote: q5, customer: customers[3], poNumber: 'PO-GRA-330', dueDays: 30, createdDaysAgo: 12 });
  jobs++;
  await addNote(ctx, { jobId: j5.jobId, body: 'Released to the floor; awaiting saw availability.', type: 'event', daysAgo: 12 });
  notes++;

  // 6. Converted → cancelled (BlueRidge, pump x2).
  const q6 = await createQuote(ctx, { customer: customers[4], lines: [{ part: pump, qty: 2 }], status: 'active', createdDaysAgo: 70, leadDays: 14 });
  quotes++;
  const j6 = await convertToJob(ctx, { quote: q6, customer: customers[4], poNumber: 'PO-BR-5521', dueDays: -10, createdDaysAgo: 64 });
  jobs++;
  await progressJob(ctx, j6, 'cancelled', 50);
  await addNote(ctx, { jobId: j6.jobId, body: 'Customer cancelled order; design change on their end.', daysAgo: 50 });
  notes++;

  // 7. Direct PO job → completed + shipped (Granite, rail @ 48.5 in).
  const j7 = await createDirectJob(ctx, {
    customer: customers[3],
    lines: [{ part: rail, qty: 48.5, unitPrice: 71.4 }],
    poNumber: 'PO-GRA-401',
    dueDays: -40,
    createdDaysAgo: 95,
  });
  jobs++;
  await progressJob(ctx, j7, 'completed', 70);
  await shipJob(ctx, { job: j7, customer: customers[3], fraction: 1, daysAgo: 66 });
  shipments++;
  await addNote(ctx, { jobId: j7.jobId, body: 'Cut to 48.5 in per print, deburred and shipped.', daysAgo: 66 });
  notes++;

  // 8. Direct PO job → in_progress, one shipment voided then nothing (Cascade, pump x4).
  const j8 = await createDirectJob(ctx, {
    customer: customers[1],
    lines: [{ part: pump, qty: 4, unitPrice: 540 }],
    poNumber: 'PO-CAS-2250',
    dueDays: 20,
    createdDaysAgo: 25,
  });
  jobs++;
  await progressJob(ctx, j8, 'in_progress', 8);
  await depleteForJob(ctx, j8, 7);
  await shipJob(ctx, { job: j8, customer: customers[1], fraction: 0.5, daysAgo: 4, voided: true });
  shipments++;
  await addNote(ctx, { jobId: j8.jobId, body: 'Slip voided — wrong carrier selected, re-cutting.', type: 'event', daysAgo: 3 });
  notes++;

  // 9. Standalone ACTIVE quotes (open opportunities).
  await createQuote(ctx, { customer: customers[4], lines: [{ part: manifold, qty: 10 }], status: 'active', createdDaysAgo: 9, leadDays: 21 });
  quotes++;
  await createQuote(ctx, { customer: customers[5], lines: [{ part: actuator, qty: 12 }, { part: pump, qty: 6 }], status: 'active', createdDaysAgo: 5, leadDays: 28 });
  quotes++;
  // A quote with a custom-price override line.
  await createQuote(ctx, { customer: customers[0], lines: [{ part: pump, qty: 3, override: 525 }], status: 'active', createdDaysAgo: 14, leadDays: 14 });
  quotes++;

  // 10. EXPIRED quotes.
  await createQuote(ctx, { customer: customers[2], lines: [{ part: pump, qty: 50 }], status: 'expired', createdDaysAgo: 120, expirationDays: -30, leadDays: 35 });
  quotes++;
  await createQuote(ctx, { customer: customers[3], lines: [{ part: manifold, qty: 8 }], status: 'expired', createdDaysAgo: 100, expirationDays: -20, leadDays: 21 });
  quotes++;

  // 11. A quote that will show PRICE DRIFT on the detail page: quote it at the
  //     current tier, then bump the part's tier markup so live > snapshot.
  const qDrift = await createQuote(ctx, { customer: customers[1], lines: [{ part: actuator, qty: 8 }], status: 'active', createdDaysAgo: 7, leadDays: 21 });
  quotes++;
  await ctx.db
    .from('part_pricing_tiers')
    .update({ markup_percent: 72 })
    .eq('part_id', actuator.id)
    .gte('quantity', 5);
  await addNote(ctx, { jobId: j3.jobId, body: `See quote ${qDrift.quoteNumber}: actuator pricing was just revised upward.`, type: 'event', daysAgo: 1 });
  notes++;

  return { quotes, jobs, shipments, notes };
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { url, key } = readEnv();
  const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

  console.log(`[seed-dev] Target: ${url}`);
  const userId = await ensureUser(db);
  const companyId = await ensureCompany(db);
  await ensureAccess(db, userId, companyId);
  console.log(`[seed-dev] company=${companyId} user=${USER_EMAIL}`);

  console.log('[seed-dev] wiping existing seed-company data…');
  await resetCompanyData(db, companyId);

  console.log('[seed-dev] seeding catalog…');
  const vendorIds = await seedVendors(db, companyId);
  const wcIds = await seedWorkCenters(db, companyId, vendorIds);
  const customers = await seedCustomers(db, companyId);
  const parts = await seedParts(db, companyId, vendorIds, wcIds);
  await seedInventoryReceipts(db, companyId, userId, parts);
  await checkCosts(db, parts);

  console.log('[seed-dev] seeding quotes, jobs, shipments, activity…');
  const accessId = await ensureAccess(db, userId, companyId); // returns existing id
  const partsById = new Map<string, SeededPart>();
  for (const p of parts.values()) partsById.set(p.id, p);
  const ctx: Ctx = { db, companyId, userId, accessId, partsById };
  const tx = await seedTransactions(ctx, customers, parts);

  console.log(
    `[seed-dev] Done. vendors=${vendorIds.size} work_centers=${wcIds.size} ` +
      `customers=${customers.length} parts=${parts.size} quotes=${tx.quotes} ` +
      `jobs=${tx.jobs} shipments=${tx.shipments} notes=${tx.notes}`,
  );
  console.log(`[seed-dev] Company: ${COMPANY_NAME}`);
  console.log(`[seed-dev] Login: ${USER_EMAIL} / ${USER_PASSWORD}`);
}

main().catch((e) => die('unhandled error', e));
