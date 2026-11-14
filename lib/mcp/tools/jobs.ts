import { z } from 'zod';

import { defineCompanyTool, registerCompanyTool, type CompanyToolEnv, type ToolTarget } from '@/lib/mcp/defineTool';
import {
  BAD_CURSOR_MESSAGE,
  addressOf,
  addressOutput,
  companyLink,
  pageInput,
  pageOutput,
  paginate,
  urlOutput,
} from '@/lib/mcp/tools/shared';
import { VENDOR_PO_LINE_STATUSES, VENDOR_PO_STATUSES } from '@/lib/purchasing/vendorPoStatus';
import { vendorPoPath } from '@/lib/purchasingRoutes';
import { getSupabase } from '@/lib/supabase';
import {
  getJobLifecycleStage,
  isJobOverdue,
  type JobLifecycleStage,
  type JobWithRelations,
} from '@/types/job';
import { getAllJobs, getJobWithRelations } from '@/utils/jobsAccess';
import { getJobPartMaterialCheck } from '@/utils/materialCheckAccess';
import { listVendorPoLinesForJob } from '@/utils/vendorPoAccess';

/** Today in UTC: Jigged's server clock judges "overdue" on a purchase order line. */
const todayUtc = (): string => new Date().toISOString().slice(0, 10);

const poLink = (env: CompanyToolEnv, poId: string): string | null => env.link(vendorPoPath(env.company.id, poId));

const STAGES = [
  'not_started',
  'in_progress',
  'ready_to_ship',
  'partially_shipped',
  'completed',
  'cancelled',
] as const satisfies readonly JobLifecycleStage[];

const OPEN_STAGES: readonly JobLifecycleStage[] = ['not_started', 'in_progress', 'ready_to_ship', 'partially_shipped'];

const STAGE_HELP =
  'not_started, in_progress (on the floor), ready_to_ship (made, nothing shipped), ' +
  'partially_shipped, completed (fully shipped), cancelled.';

const jobSummary = z.object({
  job_id: z.string(),
  job_number: z.string(),
  stage: z.enum(STAGES),
  overdue: z.boolean().describe('Past its due date and not fully shipped or cancelled.'),
  due_date: z.string().nullable(),
  customer_id: z.string().nullable(),
  customer_name: z.string().nullable(),
  customer_po_number: z.string().nullable(),
  quote_number: z.string().nullable(),
  parts: z.array(z.object({ part_name: z.string(), quantity: z.number() })),
  created_at: z.string(),
  url: urlOutput,
});

type JobSummary = z.infer<typeof jobSummary>;

function summarise(job: JobWithRelations, env: CompanyToolEnv): JobSummary {
  return {
    job_id: job.id,
    job_number: job.job_number,
    stage: getJobLifecycleStage(job),
    overdue: isJobOverdue(job),
    due_date: job.due_date,
    customer_id: job.customer_id,
    customer_name: job.customers?.name ?? job.customer_name,
    customer_po_number: job.customer_po_number,
    quote_number: job.quotes?.quote_number ?? null,
    parts: (job.job_parts ?? [])
      .slice()
      .sort((a, b) => a.sequence - b.sequence)
      .map((jp) => ({ part_name: jp.parts?.part_name ?? 'Unknown part', quantity: jp.quantity })),
    created_at: job.created_at,
    url: companyLink(env, `/jobs/${job.id}`),
  };
}

export const listJobs = defineCompanyTool({
  name: 'list_jobs',
  title: 'List jobs',
  description:
    'Lists jobs (work orders) in a Jigged company. Without `stages` it returns open jobs: not ' +
    'started, in progress, ready to ship or partially shipped. Filters: lifecycle stage, overdue, ' +
    'customer, a due-date window, and search text matching job number, customer PO, customer ' +
    'name, part number or packing slip. Each job has its stage, due date, customer and parts with ' +
    'quantities. Sorted by due date (soonest first, undated last) unless `sort` is `newest`.',
  access: 'read',
  input: {
    stages: z.array(z.enum(STAGES)).optional().describe(`Lifecycle stages to include: ${STAGE_HELP}`),
    overdue: z.boolean().optional().describe('Only jobs past their due date.'),
    customer_id: z.guid().optional().describe('Only this customer\'s jobs.'),
    due_from: z.iso.date().optional().describe('Only jobs due on or after this date (YYYY-MM-DD).'),
    due_to: z.iso.date().optional().describe('Only jobs due on or before this date (YYYY-MM-DD).'),
    search: z.string().optional().describe('Job number, customer PO, customer name, part number or packing slip.'),
    sort: z.enum(['due_soonest', 'newest']).optional(),
    ...pageInput,
  },
  output: { jobs: z.array(jobSummary), ...pageOutput },
  run: async (args, env) => {
    const stages = args.stages ?? OPEN_STAGES;
    const newest = args.sort === 'newest';
    const { jobs } = await getAllJobs(
      env.company.id,
      {
        search: args.search,
        customerId: args.customer_id,
        overdue: args.overdue,
        stages: [...stages],
        // Stage narrowing happens below, from the job's own statuses, on both paths.
        excludeClosed: false,
      },
      newest ? 'created_at' : 'due_date',
      newest ? 'desc' : 'asc',
    );
    const rows = jobs
      .filter((job) => stages.includes(getJobLifecycleStage(job)))
      .filter((job) => !args.due_from || (job.due_date !== null && job.due_date >= args.due_from))
      .filter((job) => !args.due_to || (job.due_date !== null && job.due_date <= args.due_to));
    // Postgres puts NULLs last ascending, which is what "soonest first" wants; the search path
    // doesn't keep the order, so sort again here either way.
    rows.sort((a, b) =>
      newest
        ? b.created_at.localeCompare(a.created_at)
        : (a.due_date ?? '9999-12-31').localeCompare(b.due_date ?? '9999-12-31'),
    );
    const page = paginate(rows, args);
    if (!page) return { ok: false, message: BAD_CURSOR_MESSAGE };
    return {
      ok: true,
      data: { jobs: page.items.map((j) => summarise(j, env)), total: page.total, next_cursor: page.next_cursor },
    };
  },
});

const operationOutput = z.object({
  sequence: z.number(),
  name: z.string(),
  status: z.enum(['pending', 'in_progress', 'completed', 'sent']).describe('`sent` is out at an outside vendor.'),
  work_center: z.string().nullable(),
  outside_vendor: z.string().nullable(),
  outside_service: z.string().nullable(),
  // Nullable in the database (an outside step has no estimate), whatever types/job.ts says.
  estimated_setup_minutes: z.number().nullable(),
  estimated_run_minutes_per_unit: z.number().nullable(),
  completed_at: z.string().nullable(),
  sent_at: z.string().nullable(),
  instructions: z.string().nullable(),
  notes: z.string().nullable(),
});

const jobPartOutput = z.object({
  job_part_id: z.string(),
  part_id: z.string(),
  part_name: z.string(),
  description: z.string().nullable(),
  quantity: z.number(),
  unit_price: z.number().nullable(),
  total_price: z.number().nullable(),
  production_status: z.enum(['not_started', 'in_progress', 'completed', 'cancelled']),
  fulfillment_status: z.enum(['unshipped', 'partially_shipped', 'fully_shipped']),
  operations: z.array(operationOutput),
});

const jobVendorPoLineOutput = z.object({
  vendor_po_id: z.string(),
  po_number: z.string().describe("The purchase order to a vendor (PO-1042) — the shop's order, not the customer's."),
  po_status: z.enum(VENDOR_PO_STATUSES),
  vendor: z.object({ vendor_id: z.string(), name: z.string(), url: urlOutput }),
  line_number: z.number(),
  kind: z.enum(['part', 'outside_service', 'other']).describe('A bought part or material, an outside step this vendor does, or anything else.'),
  item: z.string().describe("The line's description."),
  job_part_id: z.string().nullable(),
  operation: z.string().nullable().describe('Outside lines: the routing step, e.g. "Op 30 Anodize".'),
  quantity: z.number(),
  unit: z.string(),
  received_quantity: z.number(),
  open_quantity: z.number().describe('Still to arrive; 0 once received or closed.'),
  status: z.enum(VENDOR_PO_LINE_STATUSES),
  expected_on: z.string().nullable(),
  overdue: z.boolean().describe("Past its expected date, judged on Jigged's server clock (UTC)."),
  url: urlOutput,
});

const jobDetail = {
  job_id: z.string(),
  job_number: z.string(),
  archived: z.boolean().describe('Archived in Jigged, so it no longer appears in lists.'),
  stage: z.enum(STAGES),
  overdue: z.boolean(),
  due_date: z.string().nullable(),
  customer_id: z.string().nullable(),
  customer_name: z.string().nullable(),
  customer_po_number: z
    .string()
    .nullable()
    .describe("The customer's PO number: the order the customer sent the shop. The shop's own POs to vendors are vendor_po_lines."),
  quote_id: z.string().nullable(),
  quote_number: z.string().nullable(),
  payment_terms: z.string().nullable(),
  freight_terms: z.string().nullable(),
  ship_via: z.string().nullable(),
  shipping_instructions: z.string().nullable(),
  bill_to: addressOutput.nullable(),
  ship_to: addressOutput.nullable(),
  contact: z.object({ name: z.string().nullable(), email: z.string().nullable(), phone: z.string().nullable() }).nullable(),
  started_at: z.string().nullable(),
  completed_at: z.string().nullable(),
  created_at: z.string(),
  parts: z.array(jobPartOutput),
  vendor_po_lines: z
    .array(jobVendorPoLineOutput)
    .describe("The job's lines on purchase orders to vendors (bought parts, material, outside steps), as its Vendor POs row shows them. Archived POs are left out."),
  url: urlOutput,
};

const jobRef = {
  job_id: z.guid().optional().describe('The job, by id.'),
  job_number: z.string().optional().describe('The job, by its number, when you have no id.'),
};

const NAME_THE_JOB = 'Give a job_id or a job_number.';

/**
 * The job a tool names by id or number, or a sentence saying it isn't there. A by-id read, so an
 * archived job is found too and says so; `JobWithRelations` doesn't carry `deleted_at`, hence the
 * lookup reads it alongside the id. By number, a live job wins over an archived namesake.
 */
export async function findJob(
  args: { job_id?: string; job_number?: string },
  env: CompanyToolEnv,
): Promise<{ job: JobWithRelations; archived: boolean } | { message: string }> {
  const number = args.job_number?.trim();
  if (!args.job_id && !number) return { message: NAME_THE_JOB };
  const lookup = getSupabase().from('jobs').select('id, deleted_at').eq('company_id', env.company.id);
  const { data, error } = await (args.job_id ? lookup.eq('id', args.job_id) : lookup.eq('job_number', number ?? ''))
    .order('deleted_at', { ascending: false, nullsFirst: true })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  const missing = args.job_id
    ? `There is no job with that id in ${env.company.name}.`
    : `There is no job ${number} in ${env.company.name}.`;
  if (!data) return { message: missing };
  const job = await getJobWithRelations(data.id, env.company.id);
  if (!job) return { message: missing };
  return { job, archived: data.deleted_at !== null };
}

export const getJob = defineCompanyTool({
  name: 'get_job',
  title: 'Get a job',
  description:
    "Returns one job in full: stage, due date, customer, the customer's PO number, quote, terms, " +
    'shipping details and addresses, and each part with its quantity, price and routing steps ' +
    '(status, work center or outside vendor, estimates, instructions); and the lines for it on ' +
    "purchase orders to vendors with what has arrived. Find a job by id or by job number.",
  access: 'read',
  input: jobRef,
  output: jobDetail,
  run: async (args, env) => {
    const found = await findJob(args, env);
    if ('message' in found) return { ok: false, message: found.message };
    const { job, archived } = found;
    const poLines = await listVendorPoLinesForJob(job.id, { today: todayUtc() });
    return {
      ok: true,
      data: {
        job_id: job.id,
        job_number: job.job_number,
        archived,
        stage: getJobLifecycleStage(job),
        overdue: isJobOverdue(job),
        due_date: job.due_date,
        customer_id: job.customer_id,
        customer_name: job.customers?.name ?? job.customer_name,
        customer_po_number: job.customer_po_number,
        quote_id: job.quote_id,
        quote_number: job.quotes?.quote_number ?? null,
        payment_terms: job.payment_terms,
        freight_terms: job.freight_terms,
        ship_via: job.ship_via,
        shipping_instructions: job.shipping_instructions,
        bill_to: addressOf(job.bill_to_address),
        ship_to: addressOf(job.ship_to_address),
        contact: job.contact_snapshot
          ? { name: job.contact_snapshot.name, email: job.contact_snapshot.email, phone: job.contact_snapshot.phone }
          : null,
        started_at: job.started_at,
        completed_at: job.completed_at,
        created_at: job.created_at,
        parts: (job.job_parts ?? []).map((jp) => ({
          job_part_id: jp.id,
          part_id: jp.part_id,
          part_name: jp.parts?.part_name ?? 'Unknown part',
          description: jp.parts?.description ?? null,
          quantity: jp.quantity,
          unit_price: jp.unit_price,
          total_price: jp.total_price,
          production_status: jp.production_status,
          fulfillment_status: jp.fulfillment_status,
          // Who completed or sent a step is deliberately absent: the surveillance guardrail.
          operations: (jp.job_operations ?? []).map((op) => ({
            sequence: op.sequence,
            name: op.operation_name,
            status: op.status,
            work_center: op.work_center?.name ?? null,
            outside_vendor: op.vendor_service?.vendor?.name ?? null,
            outside_service: op.vendor_service?.name ?? null,
            estimated_setup_minutes: op.estimated_setup_minutes,
            estimated_run_minutes_per_unit: op.estimated_run_minutes_per_unit,
            completed_at: op.completed_at,
            sent_at: op.sent_at,
            instructions: op.instructions ?? null,
            notes: op.notes,
          })),
        })),
        vendor_po_lines: poLines.map((l) => ({
          vendor_po_id: l.vendorPurchaseOrderId,
          po_number: l.poNumber,
          po_status: l.poStatus,
          vendor: { vendor_id: l.vendorId, name: l.vendorName, url: companyLink(env, `/vendors/${l.vendorId}`) },
          line_number: l.lineNumber,
          kind: l.lineKind,
          item: l.description,
          job_part_id: l.jobPartId,
          operation: l.operationLabel,
          quantity: l.quantity,
          unit: l.unit,
          received_quantity: l.receivedQuantity,
          open_quantity: l.openQuantity,
          status: l.status,
          expected_on: l.expectedOn,
          overdue: l.isLate,
          url: poLink(env, l.vendorPurchaseOrderId),
        })),
        url: companyLink(env, `/jobs/${job.id}`),
      },
    };
  },
});

const requirementOutput = z.object({
  part_id: z.string(),
  part_name: z.string(),
  status: z.enum(['ok', 'short', 'incomparable', 'archived']).describe(
    '`incomparable`: the BOM unit cannot be converted to the stock unit, so no shortage can be computed.',
  ),
  required: z.number().describe('Needed for the job, in the BOM line\'s unit.'),
  bom_unit: z.string(),
  required_in_stock_unit: z.number().nullable(),
  stock_unit: z.string().nullable(),
  on_hand: z.number(),
  issued: z.number().describe('Already taken from stock for this job.'),
  remaining_to_issue: z.number().nullable(),
  short_by: z.number().nullable().describe('Against what is on hand: stock still on a purchase order is not on the shelf.'),
  heat_numbers: z.array(z.string()),
  on_order: z.number().nullable().describe('On sent purchase orders to vendors and still to arrive, in the stock unit.'),
  on_draft: z.number().nullable().describe('On draft purchase orders not sent yet, in the stock unit.'),
  on_order_pos: z
    .array(
      z.object({
        vendor_po_id: z.string(),
        po_number: z.string(),
        quantity: z.number().describe('Still to arrive on it, in the stock unit.'),
        expected_on: z.string().nullable(),
        draft: z.boolean(),
        url: urlOutput,
      }),
    )
    .describe('The purchase orders to vendors behind those figures: sent ones first, then drafts.'),
});

export const getJobMaterialCheck = defineCompanyTool({
  name: 'get_job_material_check',
  title: 'Check a job\'s material',
  description:
    'For each part on a job, lists the material its bill of materials needs for the order ' +
    'quantity, what is on hand, what was already issued to the job, how much is short, and what is ' +
    'on order for it on purchase orders to vendors (drafts apart). Find the job by id or by job number.',
  access: 'read',
  input: jobRef,
  output: {
    job_id: z.string(),
    job_number: z.string(),
    parts: z.array(
      z.object({
        job_part_id: z.string(),
        part_name: z.string(),
        quantity: z.number(),
        materials: z.array(requirementOutput),
      }),
    ),
    url: urlOutput,
  },
  run: async (args, env) => {
    const found = await findJob(args, env);
    if ('message' in found) return { ok: false, message: found.message };
    const { job } = found;
    const parts = await Promise.all(
      (job.job_parts ?? []).map(async (jp) => {
        const requirements = await getJobPartMaterialCheck({
          companyId: env.company.id,
          jobId: job.id,
          jobPartId: jp.id,
          madePartId: jp.part_id,
          orderQuantity: jp.quantity,
        });
        return {
          job_part_id: jp.id,
          part_name: jp.parts?.part_name ?? 'Unknown part',
          quantity: jp.quantity,
          materials: requirements.map((r) => ({
            part_id: r.partId,
            part_name: r.partName,
            status: r.status,
            required: r.requiredInBomUnit,
            bom_unit: r.bomUnit,
            required_in_stock_unit: r.requiredInStockUnit,
            stock_unit: r.stockUnit,
            on_hand: r.onHand,
            issued: r.issued,
            remaining_to_issue: r.remainingToIssue,
            short_by: r.shortBy,
            heat_numbers: r.heatNumbers,
            on_order: r.onOrder ?? null,
            on_draft: r.onDraft ?? null,
            on_order_pos: (r.onOrderRefs ?? []).map((ref) => ({
              vendor_po_id: ref.vendorPurchaseOrderId,
              po_number: ref.poNumber,
              quantity: ref.stockQuantity,
              expected_on: ref.expectedOn,
              draft: ref.isDraft,
              url: poLink(env, ref.vendorPurchaseOrderId),
            })),
          })),
        };
      }),
    );
    return {
      ok: true,
      data: { job_id: job.id, job_number: job.job_number, parts, url: companyLink(env, `/jobs/${job.id}`) },
    };
  },
});

export function registerJobTools(server: ToolTarget): void {
  registerCompanyTool(server, listJobs);
  registerCompanyTool(server, getJob);
  registerCompanyTool(server, getJobMaterialCheck);
}

/** Exported for the catalogue test. */
export const JOB_TOOLS = [listJobs, getJob, getJobMaterialCheck];
