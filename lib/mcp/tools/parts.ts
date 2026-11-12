import { z } from 'zod';

import { defineCompanyTool, registerCompanyTool, type CompanyToolEnv, type ToolTarget } from '@/lib/mcp/defineTool';
import { BAD_CURSOR_MESSAGE, companyLink, pageInput, pageOutput, paginate, urlOutput } from '@/lib/mcp/tools/shared';
import { VENDOR_PO_LINE_STATUSES } from '@/lib/purchasing/vendorPoStatus';
import { vendorPoPath } from '@/lib/purchasingRoutes';
import { getSupabase } from '@/lib/supabase';
import {
  getJobLifecycleStage,
  type FulfillmentStatus,
  type JobLifecycleStage,
  type ProductionStatus,
} from '@/types/job';
import type { Part, PartNoteType } from '@/types/part';
import { isQuoteExpired } from '@/types/quote';
import { getBomForPart } from '@/utils/bomAccess';
import { getReferencesForPart } from '@/utils/partCustomerReferencesAccess';
import { getTiersForPart, getTiersWithComputedPrices } from '@/utils/partPricingTiersAccess';
import {
  getAllParts,
  getBoughtParts,
  getMadeParts,
  getPart as loadPart,
  getPartCostExplain,
  getPartNotes,
} from '@/utils/partsAccess';
import { calculateRoutingCost, type LaborItem, type RoutingCostBreakdown } from '@/utils/routingCostCalculation';
import { getRoutingForPart } from '@/utils/routingsAccess';
import { escapeIlikePattern } from '@/utils/searchFilter';
import { getOnOrderForParts } from '@/utils/vendorPoAccess';
import { getVendor } from '@/utils/vendorsAccess';

/**
 * The part tools: the item master (made and bought parts), one part in full, and what a part
 * costs. Part cost and prices are shown to every office user in the app, so none of this is
 * admin-only. Inventory (on hand, stock value) belongs to the inventory tools, not here.
 *
 * get_part also says what is coming for the part on purchase orders TO A VENDOR — on order (sent,
 * open lines) and on draft, apart, in its stock unit, from `part_on_order` through
 * getOnOrderForParts (the figures the job page's Materials card and the To buy list use) — and the
 * Last PO price from each vendor, read from `part_vendor_last_purchase`, which IS that definition.
 */

export const SOURCES = ['made', 'bought'] as const satisfies readonly Part['source'][];
export const SOURCE_HELP = '`made` in the shop, or `bought` from a vendor.';

const STAGES = [
  'not_started',
  'in_progress',
  'ready_to_ship',
  'partially_shipped',
  'completed',
  'cancelled',
] as const satisfies readonly JobLifecycleStage[];

const PRODUCTION = ['not_started', 'in_progress', 'completed', 'cancelled'] as const satisfies readonly ProductionStatus[];
const FULFILLMENT = ['unshipped', 'partially_shipped', 'fully_shipped'] as const satisfies readonly FulfillmentStatus[];
const NOTE_TYPES = ['user', 'pricing'] as const satisfies readonly PartNoteType[];
const QUOTE_STATUSES = ['open', 'converted', 'expired'] as const;
const STEP_KINDS = ['in_house', 'outside'] as const;
const QUANTITY_FROM = ['requested', 'saved_batch_size', 'default'] as const;

const kindOf = (outside: boolean): (typeof STEP_KINDS)[number] => (outside ? 'outside' : 'in_house');

/** How many jobs, quotes and notes `get_part` carries; the totals say how many there are. */
const RECENT = 10;
const NOTES_SHOWN = 20;
/** How many lines of purchase orders to vendors `get_part` lists. */
const OPEN_PO_LINES_SHOWN = 10;

const round2 = (n: number): number => Math.round(n * 100) / 100;
const round4 = (n: number): number => Math.round(n * 10000) / 10000;

/**
 * A status column typed `string` in the database, narrowed to the values its CHECK constraint
 * allows. A value outside them is a broken invariant, not something to guess around.
 */
function known<T extends string>(values: readonly T[], value: string, what: string): T {
  const hit = values.find((v) => v === value);
  if (hit === undefined) throw new Error(`Unexpected ${what} "${value}"`);
  return hit;
}

export const partLink = (env: CompanyToolEnv, partId: string): string | null => companyLink(env, `/parts/${partId}`);

/** id → name for a handful of vendors or customers. A by-id read: archived ones still resolve. */
async function namesById(table: 'vendors' | 'customers', ids: Array<string | null>): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((id): id is string => id !== null))];
  if (wanted.length === 0) return new Map();
  const { data, error } = await getSupabase().from(table).select('id, name').in('id', wanted);
  if (error) throw error;
  return new Map((data ?? []).map((row) => [row.id, row.name]));
}

// ─── list_parts ───────────────────────────────────────────────────────────────────────────────

const partSummary = z.object({
  part_id: z.string(),
  part_name: z.string().describe('The part number the shop knows it by.'),
  description: z.string().nullable(),
  source: z.enum(SOURCES).describe(SOURCE_HELP),
  unit: z.string().nullable().describe('Primary unit of measure.'),
  preferred_vendor_id: z.string().nullable(),
  preferred_vendor_name: z.string().nullable(),
  url: urlOutput,
});

export const listParts = defineCompanyTool({
  name: 'list_parts',
  title: 'List parts',
  description:
    'Lists the parts in a Jigged company\'s item master, both made in the shop and bought from ' +
    'vendors. Search matches the part name (part number) or description; `source` narrows to ' +
    'made or bought. Each part has its description, made or bought, unit and preferred vendor. ' +
    'Sorted by part name unless `sort` is `recently_updated`. Archived parts are not listed.',
  access: 'read',
  input: {
    search: z.string().optional().describe('Part name (part number) or description.'),
    source: z.enum(SOURCES).optional().describe(`Only made or only bought parts: ${SOURCE_HELP}`),
    sort: z.enum(['part_name', 'recently_updated']).optional(),
    ...pageInput,
  },
  output: { parts: z.array(partSummary), ...pageOutput },
  run: async (args, env) => {
    const recent = args.sort === 'recently_updated';
    const load = args.source === 'made' ? getMadeParts : args.source === 'bought' ? getBoughtParts : getAllParts;
    // Each loader filters `deleted_at IS NULL` and searches part_name + description.
    const parts = await load(env.company.id, args.search ?? '', recent ? 'updated_at' : 'part_name', recent ? 'desc' : 'asc');
    const page = paginate(parts, args);
    if (!page) return { ok: false, message: BAD_CURSOR_MESSAGE };
    const vendors = await namesById('vendors', page.items.map((p) => p.preferred_vendor_id));
    return {
      ok: true,
      data: {
        parts: page.items.map((p) => ({
          part_id: p.id,
          part_name: p.part_name,
          description: p.description,
          source: p.source,
          unit: p.primary_unit,
          preferred_vendor_id: p.preferred_vendor_id,
          preferred_vendor_name: p.preferred_vendor_id ? (vendors.get(p.preferred_vendor_id) ?? null) : null,
          url: partLink(env, p.id),
        })),
        total: page.total,
        next_cursor: page.next_cursor,
      },
    };
  },
});

// ─── finding one part ─────────────────────────────────────────────────────────────────────────

const partRef = {
  part_id: z.guid().optional().describe('The part, by id.'),
  part_name: z.string().optional().describe('The part, by its exact part name (part number), when you have no id.'),
};

const NAME_THE_PART = 'Give a part_id or a part_name.';

interface NameMatch {
  id: string;
  part_name: string;
  deleted_at: string | null;
}

/**
 * The best of the parts whose name matches ignoring case. A live part beats an archived one:
 * when a new part takes an archived part's name, the archived one is renamed `<name> (archived)`,
 * but an archived part nobody collided with keeps its name, so both can answer to it. Exact case
 * beats a case-only match.
 */
function bestNameMatch(rows: NameMatch[], name: string): NameMatch | null {
  const rank = (r: NameMatch): number => (r.deleted_at === null ? 0 : 2) + (r.part_name === name ? 0 : 1);
  return rows.slice().sort((a, b) => rank(a) - rank(b))[0] ?? null;
}

/** The part a tool names by id or name, in this company, or a sentence saying it isn't there. */
export async function findPart(
  args: { part_id?: string; part_name?: string },
  env: CompanyToolEnv,
): Promise<{ part: Part; archived: boolean } | { message: string }> {
  // By-id and by-name reads deliberately do not filter `deleted_at`: an archived part's page
  // still opens, and its old quotes and jobs still point at it.
  let match: { id: string; deleted_at: string | null } | null;
  if (args.part_id) {
    const { data, error } = await getSupabase()
      .from('parts')
      .select('id, deleted_at')
      .eq('company_id', env.company.id)
      .eq('id', args.part_id)
      .maybeSingle();
    if (error) throw error;
    if (!data) return { message: `There is no part with that id in ${env.company.name}.` };
    match = data;
  } else if (args.part_name?.trim()) {
    const name = args.part_name.trim();
    const { data, error } = await getSupabase()
      .from('parts')
      .select('id, part_name, deleted_at')
      .eq('company_id', env.company.id)
      .ilike('part_name', escapeIlikePattern(name))
      .limit(20);
    if (error) throw error;
    match = bestNameMatch(data ?? [], name);
    if (!match) return { message: `There is no part named ${name} in ${env.company.name}.` };
  } else {
    return { message: NAME_THE_PART };
  }
  const part = await loadPart(match.id);
  if (!part) return { message: `There is no part with that id in ${env.company.name}.` };
  return { part, archived: match.deleted_at !== null };
}

// ─── get_part ─────────────────────────────────────────────────────────────────────────────────

export const tierOutput = z.object({
  quantity: z.number().describe('The quantity break. Its price holds from this quantity up to the next break.'),
  unit_price: z
    .number()
    .nullable()
    .describe('Price per unit at this break; null while the part\'s cost cannot be worked out or no markup is set.'),
  markup_percent: z.number().nullable(),
  cost_per_unit: z
    .number()
    .nullable()
    .describe('What a bought part costs at this break; null for a made part, whose cost comes from its routing and BOM.'),
});

export const bomLineOutput = z.object({
  part_id: z.string(),
  part_name: z.string(),
  description: z.string().nullable(),
  source: z.enum(SOURCES),
  quantity: z.number().describe('How much goes into one of this part, in `unit`.'),
  unit: z.string(),
  charge_basis: z
    .enum(['cost', 'price'])
    .describe('What the material adds to this part\'s price base: its cost, or its own marked-up price.'),
  url: urlOutput,
});

export const stepOutput = z.object({
  sequence: z.number(),
  operation: z.string().describe('The work center or outside service the step runs at.'),
  kind: z.enum(STEP_KINDS),
  outside_vendor: z.string().nullable(),
  setup_minutes: z.number().nullable().describe('Null for an outside step, which is priced by the piece.'),
  run_minutes_per_unit: z.number().nullable().describe('Null for an outside step, which is priced by the piece.'),
  instructions: z.string().nullable(),
});

const referenceOutput = z.object({
  customer_id: z.string(),
  customer_name: z.string().nullable(),
  customer_part_number: z.string().describe('The number this customer uses for the part.'),
  customer_revision: z.string().nullable(),
  customer_drawing_number: z.string().nullable(),
});

const jobUseOutput = z.object({
  job_id: z.string(),
  job_number: z.string(),
  stage: z.enum(STAGES),
  quantity: z.number().describe('How many of this part the job is for.'),
  customer_name: z.string().nullable(),
  due_date: z.string().nullable(),
  created_at: z.string().nullable(),
  url: urlOutput,
});

const quoteUseOutput = z.object({
  quote_id: z.string(),
  quote_number: z.string(),
  status: z.enum(QUOTE_STATUSES).describe('open (still live), converted (became a job), expired.'),
  quantities: z.array(z.number()).describe('The quantities of this part the quote prices.'),
  customer_name: z.string().nullable(),
  expiration_date: z.string().nullable(),
  created_at: z.string().nullable(),
  url: urlOutput,
});

const noteOutput = z.object({
  body: z.string(),
  note_type: z
    .enum(NOTE_TYPES)
    .describe('`user` was typed by a person; `pricing` was logged by Jigged when the pricing was saved.'),
  created_at: z.string(),
  edited_at: z.string().nullable(),
});

type JobUse = z.infer<typeof jobUseOutput>;
type QuoteUse = z.infer<typeof quoteUseOutput>;

const onOrderOutput = z
  .object({
    quantity: z.number().describe("On sent purchase orders to vendors and still to arrive, in the part's unit."),
    on_draft_quantity: z.number().describe('On draft POs not sent yet: not on order.'),
    next_expected_on: z.string().nullable(),
    open_line_count: z.number(),
    draft_line_count: z.number(),
    unit_mismatch_line_count: z
      .number()
      .describe("Lines ordered in a unit the part no longer counts in, so they are in neither figure."),
  })
  .describe('What is coming from vendors. Only purchase orders in Jigged count.');

const openPoLineOutput = z.object({
  vendor_po_id: z.string(),
  po_number: z.string().describe('A purchase order to a vendor, not a customer PO.'),
  line_number: z.number(),
  quantity: z.number().describe("Still to arrive, in the part's unit; for a draft, the whole line."),
  expected_on: z.string().nullable(),
  draft: z.boolean(),
  status: z.enum(VENDOR_PO_LINE_STATUSES),
  url: urlOutput,
});

const lastPoPriceOutput = z.object({
  vendor: z.object({ vendor_id: z.string(), name: z.string(), url: urlOutput }),
  vendor_po_id: z.string(),
  po_number: z.string(),
  ordered_on: z.string().nullable(),
  quantity: z.number(),
  unit: z.string(),
  unit_price: z.number().describe('Per `unit`.'),
  unit_price_per_stock_unit: z.number().nullable(),
  url: urlOutput,
});

type OpenPoLine = z.infer<typeof openPoLineOutput>;
type LastPoPrice = z.infer<typeof lastPoPriceOutput>;

const poLink = (env: CompanyToolEnv, poId: string): string | null => env.link(vendorPoPath(env.company.id, poId));

/** What is coming for one part on purchase orders to vendors: the totals and the lines behind them. */
async function onOrderFor(
  partId: string,
  env: CompanyToolEnv,
): Promise<{ onOrder: z.infer<typeof onOrderOutput>; lines: OpenPoLine[] }> {
  const entry = (await getOnOrderForParts(env.company.id, [partId])).get(partId);
  const lines = (entry?.refs ?? [])
    .slice()
    .sort((a, b) => {
      if (a.isDraft !== b.isDraft) return a.isDraft ? 1 : -1;
      return (a.expectedOn ?? '9999-12-31').localeCompare(b.expectedOn ?? '9999-12-31');
    })
    .slice(0, OPEN_PO_LINES_SHOWN)
    .map((ref) => ({
      vendor_po_id: ref.vendorPurchaseOrderId,
      po_number: ref.poNumber,
      line_number: ref.lineNumber,
      quantity: ref.stockQuantity,
      expected_on: ref.expectedOn,
      draft: ref.isDraft,
      status: ref.status,
      url: poLink(env, ref.vendorPurchaseOrderId),
    }));
  return {
    onOrder: {
      // Loaded, so a part with nothing coming is a true 0, never unknown.
      quantity: entry?.onOrder ?? 0,
      on_draft_quantity: entry?.onDraft ?? 0,
      next_expected_on: entry?.nextExpectedOn ?? null,
      open_line_count: entry?.openLineCount ?? 0,
      draft_line_count: entry?.draftLineCount ?? 0,
      unit_mismatch_line_count: entry?.unitMismatchLineCount ?? 0,
    },
    lines,
  };
}

/**
 * "Last PO price" from each vendor: the newest priced line for this part on a sent, unarchived
 * purchase order to that vendor (`part_vendor_last_purchase`). Newest first.
 */
async function lastPoPrices(partId: string, env: CompanyToolEnv): Promise<LastPoPrice[]> {
  const { data, error } = await getSupabase()
    .from('part_vendor_last_purchase')
    .select('vendor_id, vendor_purchase_order_id, po_number, ordered_on, quantity, unit, unit_price, unit_price_per_stock_unit')
    .eq('company_id', env.company.id)
    .eq('part_id', partId)
    .order('ordered_on', { ascending: false });
  if (error) throw error;
  const rows = (data ?? []).flatMap((r) =>
    r.vendor_id && r.vendor_purchase_order_id && r.po_number && r.unit && r.unit_price !== null && r.quantity !== null
      ? [{ ...r, vendor_id: r.vendor_id, vendor_purchase_order_id: r.vendor_purchase_order_id, po_number: r.po_number, unit: r.unit, unit_price: Number(r.unit_price), quantity: Number(r.quantity) }]
      : [],
  );
  if (rows.length === 0) return [];
  const names = await namesById('vendors', rows.map((r) => r.vendor_id));
  return rows
    .sort((a, b) => (b.ordered_on ?? '').localeCompare(a.ordered_on ?? ''))
    .map((r) => ({
      vendor: { vendor_id: r.vendor_id, name: names.get(r.vendor_id) ?? 'Unknown vendor', url: companyLink(env, `/vendors/${r.vendor_id}`) },
      vendor_po_id: r.vendor_purchase_order_id,
      po_number: r.po_number,
      ordered_on: r.ordered_on,
      quantity: r.quantity,
      unit: r.unit,
      unit_price: r.unit_price,
      unit_price_per_stock_unit: r.unit_price_per_stock_unit === null ? null : Number(r.unit_price_per_stock_unit),
      url: poLink(env, r.vendor_purchase_order_id),
    }));
}

/**
 * The newest live jobs this part is on, and how many there are. Queried here rather than through
 * `getJobsForPart`, which returns archived jobs too; this is a list, so they stay out.
 */
async function recentJobs(partId: string, env: CompanyToolEnv): Promise<{ total: number; recent: JobUse[] }> {
  const { data, error, count } = await getSupabase()
    .from('jobs')
    .select(
      'id, job_number, production_status, fulfillment_status, due_date, created_at, customer_name, customers(name), job_parts!inner(quantity)',
      { count: 'exact' },
    )
    .eq('company_id', env.company.id)
    .eq('job_parts.part_id', partId)
    .is('deleted_at', null)
    .order('created_at', { ascending: false, nullsFirst: false })
    .limit(RECENT);
  if (error) throw error;
  const rows = data ?? [];
  return {
    total: count ?? rows.length,
    recent: rows.map((job) => ({
      job_id: job.id,
      job_number: job.job_number,
      stage: getJobLifecycleStage({
        production_status: known(PRODUCTION, job.production_status, 'job production status'),
        fulfillment_status: known(FULFILLMENT, job.fulfillment_status, 'job fulfillment status'),
      }),
      quantity: job.job_parts.reduce((sum, jp) => sum + Number(jp.quantity), 0),
      customer_name: job.customers?.name ?? job.customer_name,
      due_date: job.due_date,
      created_at: job.created_at,
      url: companyLink(env, `/jobs/${job.id}`),
    })),
  };
}

/**
 * The newest live quotes this part is on, and how many there are. Queried here rather than
 * through `getQuotesForPart`, which returns archived quotes too.
 */
async function recentQuotes(partId: string, env: CompanyToolEnv): Promise<{ total: number; recent: QuoteUse[] }> {
  const { data, error, count } = await getSupabase()
    .from('quotes')
    .select(
      'id, quote_number, status, converted_at, expiration_date, created_at, customer_name, customers(name), quote_line_items!inner(quantity)',
      { count: 'exact' },
    )
    .eq('company_id', env.company.id)
    .eq('quote_line_items.part_id', partId)
    .is('deleted_at', null)
    .order('created_at', { ascending: false, nullsFirst: false })
    .limit(RECENT);
  if (error) throw error;
  const rows = data ?? [];
  return {
    total: count ?? rows.length,
    recent: rows.map((quote) => {
      const expired = isQuoteExpired({
        status: known(['active', 'expired'], quote.status, 'quote status'),
        expiration_date: quote.expiration_date,
      });
      return {
        quote_id: quote.id,
        quote_number: quote.quote_number,
        status: quote.converted_at ? 'converted' : expired ? 'expired' : 'open',
        quantities: quote.quote_line_items.map((li) => Number(li.quantity)).sort((a, b) => a - b),
        customer_name: quote.customers?.name ?? quote.customer_name,
        expiration_date: quote.expiration_date,
        created_at: quote.created_at,
        url: companyLink(env, `/quotes/${quote.id}`),
      };
    }),
  };
}

export const getPart = defineCompanyTool({
  name: 'get_part',
  title: 'Get a part',
  description:
    'Returns one part in full: description, made or bought, unit, preferred vendor, pricing ' +
    'tiers (quantity breaks with unit price and markup), bill of materials, routing steps (work ' +
    'center or outside service, setup and run estimates, instructions), the part numbers ' +
    'customers use for it, the 10 newest jobs and quotes it is on with their totals, and its ' +
    'notes. Also what is coming for it on purchase orders to vendors (on order, and on draft apart, ' +
    'in its own unit, with the open lines) and the Last PO price from each vendor. Find a part by ' +
    'id or by exact part name (part number).',
  access: 'read',
  input: partRef,
  output: {
    part_id: z.string(),
    part_name: z.string(),
    description: z.string().nullable(),
    source: z.enum(SOURCES).describe(SOURCE_HELP),
    unit: z.string().nullable(),
    archived: z.boolean(),
    preferred_vendor: z.object({ vendor_id: z.string(), name: z.string(), url: urlOutput }).nullable(),
    pricing_tiers: z.array(tierOutput),
    bill_of_materials: z.array(bomLineOutput),
    routing: z.array(stepOutput),
    customer_part_numbers: z.array(referenceOutput),
    jobs_total: z.number().describe('Live jobs this part is on.'),
    recent_jobs: z.array(jobUseOutput).describe(`The ${RECENT} newest of them.`),
    quotes_total: z.number().describe('Live quotes this part is on.'),
    recent_quotes: z.array(quoteUseOutput).describe(`The ${RECENT} newest of them.`),
    notes_total: z.number(),
    notes: z.array(noteOutput).describe(`The ${NOTES_SHOWN} newest notes, newest first.`),
    on_order: onOrderOutput,
    open_vendor_po_lines: z
      .array(openPoLineOutput)
      .describe(`Up to ${OPEN_PO_LINES_SHOWN} lines for this part on purchase orders to vendors still to arrive: sent ones first by expected date, then drafts.`),
    last_po_prices: z
      .array(lastPoPriceOutput)
      .describe('Last PO price from each vendor: the newest priced line on a sent purchase order to that vendor. Newest first.'),
    url: urlOutput,
  },
  run: async (args, env) => {
    const found = await findPart(args, env);
    if ('message' in found) return { ok: false, message: found.message };
    const { part, archived } = found;
    const [tiers, bom, routing, references, jobs, quotes, notes, vendor, coming, lastPrices] = await Promise.all([
      getTiersWithComputedPrices(part.id),
      getBomForPart(part.id),
      getRoutingForPart(part.id),
      getReferencesForPart(part.id),
      recentJobs(part.id, env),
      recentQuotes(part.id, env),
      getPartNotes(part.id, env.company.id),
      part.preferred_vendor_id ? getVendor(part.preferred_vendor_id) : Promise.resolve(null),
      onOrderFor(part.id, env),
      lastPoPrices(part.id, env),
    ]);
    const customers = await namesById('customers', references.map((r) => r.customer_id));
    return {
      ok: true,
      data: {
        part_id: part.id,
        part_name: part.part_name,
        description: part.description,
        source: part.source,
        unit: part.primary_unit,
        archived,
        preferred_vendor: vendor
          ? { vendor_id: vendor.id, name: vendor.name, url: companyLink(env, `/vendors/${vendor.id}`) }
          : null,
        pricing_tiers: tiers.map((t) => ({
          quantity: Number(t.quantity),
          unit_price: t.unit_price,
          markup_percent: t.markup_percent === null ? null : Number(t.markup_percent),
          cost_per_unit: t.cost_per_unit === null ? null : Number(t.cost_per_unit),
        })),
        bill_of_materials: bom.map((line) => ({
          part_id: line.child_part.id,
          part_name: line.child_part.part_name,
          description: line.child_part.description,
          source: line.child_part.source,
          quantity: line.quantity,
          unit: line.unit,
          charge_basis: line.charge_basis,
          url: partLink(env, line.child_part.id),
        })),
        routing: (routing?.operations ?? []).map((op) => {
          const outside = op.vendor_service !== null;
          return {
            sequence: op.sequence,
            operation: op.vendor_service?.name ?? op.work_center?.name ?? 'Unknown step',
            kind: kindOf(outside),
            outside_vendor: op.vendor_service?.vendor?.name ?? null,
            setup_minutes: outside || op.setup_minutes === null ? null : Number(op.setup_minutes),
            run_minutes_per_unit:
              outside || op.cycle_minutes_per_unit === null ? null : Number(op.cycle_minutes_per_unit),
            instructions: op.instructions,
          };
        }),
        customer_part_numbers: references.map((r) => ({
          customer_id: r.customer_id,
          customer_name: customers.get(r.customer_id) ?? null,
          customer_part_number: r.customer_part_number,
          customer_revision: r.customer_revision,
          customer_drawing_number: r.customer_drawing_number,
        })),
        jobs_total: jobs.total,
        recent_jobs: jobs.recent,
        quotes_total: quotes.total,
        recent_quotes: quotes.recent,
        notes_total: notes.length,
        // Who wrote a note is deliberately absent: the body and the date are the record.
        notes: notes.slice(0, NOTES_SHOWN).map((n) => ({
          body: n.body,
          note_type: n.note_type,
          created_at: n.created_at,
          edited_at: n.edited_at,
        })),
        on_order: coming.onOrder,
        open_vendor_po_lines: coming.lines,
        last_po_prices: lastPrices,
        url: partLink(env, part.id),
      },
    };
  },
});

// ─── get_part_cost ────────────────────────────────────────────────────────────────────────────

const costOperation = z.object({
  operation: z.string().describe('The work center or outside service.'),
  kind: z.enum(STEP_KINDS),
  setup_minutes: z.number(),
  run_minutes_per_unit: z.number(),
  labour_rate_per_hour: z.number().nullable().describe('Null for an outside step, which is priced by the piece.'),
  run_cost_per_unit: z.number().describe('Run labour per unit; for an outside step, its price per piece.'),
  setup_cost: z.number().describe('One-time, for the whole batch.'),
});

const costMaterial = z.object({
  part_name: z.string(),
  quantity: z.number().describe('How much goes into one of this part, in `unit`.'),
  unit: z.string(),
  cost_per_part: z.number().describe('What this material adds to one of this part, at cost.'),
  charged_per_part: z
    .number()
    .describe('What it adds to the price base: its cost, unless the BOM line charges it at its marked-up price.'),
});

const breakdownOutput = z.object({
  run_labour_per_unit: z.number().describe('In-house run time at each step\'s labour rate.'),
  outside_processing_per_unit: z.number().describe('Outside services, priced by the piece.'),
  setup_total: z.number().describe('One-time in-house setup labour for the batch.'),
  setup_per_unit: z.number().describe('setup_total spread over the batch quantity.'),
  materials_per_unit: z
    .number()
    .nullable()
    .describe('Bill of materials at cost; null when a material has no cost at this quantity (see warnings).'),
  price_base_per_unit: z
    .number()
    .nullable()
    .describe('What a pricing tier\'s markup applies to at this quantity: above the cost only when a material is charged at its marked-up price.'),
  operations: z.array(costOperation).describe('Steps that could be costed; the others are named in warnings.'),
  materials: z.array(costMaterial).describe('Materials that could be costed; the others are named in warnings.'),
});

const gapPart = z.object({ part_id: z.string(), part_name: z.string(), url: urlOutput });

type CostBreakdown = z.infer<typeof breakdownOutput>;

const isOutside = (item: LaborItem): boolean => item.outside;

/** The Cost card's figures (components/parts/PartPricing.tsx), with outside work split out. */
function breakdownOf(b: RoutingCostBreakdown, quantity: number): CostBreakdown {
  const sum = (items: LaborItem[]): number => round2(items.reduce((total, item) => total + item.cost, 0));
  const setupPerUnit = round2(b.total_setup_cost / quantity);
  return {
    run_labour_per_unit: sum(b.labor_items.filter((i) => !isOutside(i))),
    outside_processing_per_unit: sum(b.labor_items.filter(isOutside)),
    setup_total: b.total_setup_cost,
    setup_per_unit: setupPerUnit,
    materials_per_unit: b.total_material_true_cost,
    price_base_per_unit:
      b.total_material_cost === null ? null : round2(b.total_labor_cost + setupPerUnit + b.total_material_cost),
    operations: b.labor_items.map((item) => {
      const outside = isOutside(item);
      return {
        operation: item.operation_name,
        kind: kindOf(outside),
        setup_minutes: item.setup_time_minutes,
        run_minutes_per_unit: item.run_time_minutes,
        labour_rate_per_hour: outside ? null : item.labor_rate,
        run_cost_per_unit: item.cost,
        setup_cost: item.setup_cost,
      };
    }),
    materials: b.material_items.map((m) => ({
      part_name: m.item_name,
      quantity: m.quantity,
      unit: m.unit,
      cost_per_part: round4(m.true_cost),
      charged_per_part: round4(m.cost),
    })),
  };
}

export const getPartCost = defineCompanyTool({
  name: 'get_part_cost',
  title: 'Get a part\'s cost',
  description:
    'Returns what one of a part costs at a batch size: for a made part, in-house run labour, ' +
    'setup spread over the batch, outside processing and materials, with each routing step and ' +
    'BOM material; for a bought part, its purchase cost at each quantity break. Also names what ' +
    'is missing when a cost cannot be worked out. Costs at the batch size saved on the part ' +
    'unless `quantity` is given. Find a part by id or by exact part name (part number).',
  access: 'read',
  input: {
    ...partRef,
    quantity: z
      .number()
      .positive()
      .optional()
      .describe('The batch size to cost at. Defaults to the part\'s saved batch size, or 1.'),
  },
  output: {
    part_id: z.string(),
    part_name: z.string(),
    source: z.enum(SOURCES).describe(SOURCE_HELP),
    unit: z.string().nullable(),
    quantity: z
      .number()
      .describe('The batch size costed: setup is spread over this many, and bought material is costed at what this many consume.'),
    quantity_from: z
      .enum(QUANTITY_FROM)
      .describe('Where `quantity` came from: the request, the batch size saved on the part, or 1.'),
    unit_cost: z
      .number()
      .nullable()
      .describe('What one costs at this quantity, from Jigged\'s costing engine; null when something in its tree has no cost or rate (see gaps).'),
    can_be_quoted: z.boolean().describe('Everything in its tree has a cost and the part has a markup.'),
    breakdown: breakdownOutput.nullable().describe('For a made part with a routing or BOM; null otherwise.'),
    purchase_costs: z
      .array(z.object({ quantity: z.number(), cost_per_unit: z.number().nullable() }))
      .describe('A bought part\'s cost at each quantity break; empty for a made part.'),
    gaps: z.object({
      missing_costs: z
        .array(gapPart.extend({ quantity_needed: z.number() }))
        .describe('Bought parts in the tree with no cost covering the quantity needed.'),
      missing_rates: z
        .array(gapPart)
        .describe('Made parts in the tree with a routing step that has no labour rate or outside price.'),
      missing_markups: z
        .array(gapPart.extend({ source: z.enum(SOURCES) }))
        .describe('Parts with no pricing tier markup, so no price.'),
    }),
    warnings: z.array(z.string()).describe('Steps and materials left out of the breakdown, and why.'),
    url: urlOutput,
  },
  run: async (args, env) => {
    const found = await findPart(args, env);
    if ('message' in found) return { ok: false, message: found.message };
    const { part } = found;
    const made = part.source === 'made';
    // A batch size is a made-part setting; a bought part's is ignored by the costing engine.
    const saved = made ? part.costing_batch_quantity : null;
    const quantity = args.quantity ?? saved ?? 1;
    const quantityFrom: (typeof QUANTITY_FROM)[number] =
      args.quantity !== undefined ? 'requested' : saved !== null ? 'saved_batch_size' : 'default';

    const [explain, breakdown, tiers] = await Promise.all([
      getPartCostExplain(part.id, quantity),
      made ? calculateRoutingCost(part.id, quantity) : Promise.resolve(null),
      made ? Promise.resolve([]) : getTiersForPart(part.id),
    ]);

    return {
      ok: true,
      data: {
        part_id: part.id,
        part_name: part.part_name,
        source: part.source,
        unit: part.primary_unit,
        quantity,
        quantity_from: quantityFrom,
        unit_cost: explain.unit_cost === null ? null : round2(explain.unit_cost),
        can_be_quoted: explain.is_priceable,
        breakdown: breakdown ? breakdownOf(breakdown, quantity) : null,
        purchase_costs: tiers.map((t) => ({
          quantity: Number(t.quantity),
          cost_per_unit: t.cost_per_unit === null ? null : Number(t.cost_per_unit),
        })),
        gaps: {
          missing_costs: explain.missing_leaves.map((g) => ({
            part_id: g.part_id,
            part_name: g.part_name,
            quantity_needed: g.qty_required,
            url: partLink(env, g.part_id),
          })),
          missing_rates: explain.missing_op_rates.map((g) => ({
            part_id: g.part_id,
            part_name: g.part_name,
            url: partLink(env, g.part_id),
          })),
          missing_markups: explain.missing_markups.map((g) => ({
            part_id: g.part_id,
            part_name: g.part_name,
            source: g.source,
            url: partLink(env, g.part_id),
          })),
        },
        warnings: (breakdown?.warnings ?? []).map((w) => w.message),
        url: partLink(env, part.id),
      },
    };
  },
});

export function registerPartTools(server: ToolTarget): void {
  registerCompanyTool(server, listParts);
  registerCompanyTool(server, getPart);
  registerCompanyTool(server, getPartCost);
}

/** Exported for the catalogue test. */
export const PART_TOOLS = [listParts, getPart, getPartCost];
