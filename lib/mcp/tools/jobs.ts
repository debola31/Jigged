import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import { defineCompanyTool, registerCompanyTool, type CompanyToolEnv } from '@/lib/mcp/defineTool';
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
import { getSupabase } from '@/lib/supabase';
import {
  getJobLifecycleStage,
  isJobOverdue,
  type JobLifecycleStage,
  type JobWithRelations,
} from '@/types/job';
import { getAllJobs, getJobWithRelations } from '@/utils/jobsAccess';
import { getJobPartMaterialCheck } from '@/utils/materialCheckAccess';

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

const jobDetail = {
  job_id: z.string(),
  job_number: z.string(),
  archived: z.boolean().describe('Archived in Jigged, so it no longer appears in lists.'),
  stage: z.enum(STAGES),
  overdue: z.boolean(),
  due_date: z.string().nullable(),
  customer_id: z.string().nullable(),
  customer_name: z.string().nullable(),
  customer_po_number: z.string().nullable(),
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
    'Returns one job in full: stage, due date, customer, PO, quote, terms, shipping details and ' +
    'addresses, and each part with its quantity, price and routing steps (status, work center or ' +
    'outside vendor, estimates, instructions). Find a job by id or by job number.',
  access: 'read',
  input: jobRef,
  output: jobDetail,
  run: async (args, env) => {
    const found = await findJob(args, env);
    if ('message' in found) return { ok: false, message: found.message };
    const { job, archived } = found;
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
  short_by: z.number().nullable(),
  heat_numbers: z.array(z.string()),
});

export const getJobMaterialCheck = defineCompanyTool({
  name: 'get_job_material_check',
  title: 'Check a job\'s material',
  description:
    'For each part on a job, lists the material its bill of materials needs for the order ' +
    'quantity, what is on hand, what was already issued to the job, and how much is short. Find ' +
    'the job by id or by job number.',
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

export function registerJobTools(server: McpServer): void {
  registerCompanyTool(server, listJobs);
  registerCompanyTool(server, getJob);
  registerCompanyTool(server, getJobMaterialCheck);
}

/** Exported for the catalogue test. */
export const JOB_TOOLS = [listJobs, getJob, getJobMaterialCheck];
