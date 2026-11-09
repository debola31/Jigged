import { createHash } from 'node:crypto';

import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import { callBackend } from '@/lib/mcp/backend';
import { defineCompanyTool, registerCompanyTool, type CompanyToolEnv } from '@/lib/mcp/defineTool';
import { companyLink, urlOutput } from '@/lib/mcp/tools/shared';
import { getSupabase } from '@/lib/supabase';

/**
 * Creating a QuickBooks invoice for a job, the way the job page's Invoice dialog
 * (components/jobs/PushToQuickBooksDialog.tsx) does: a preflight, then ONE push of the chosen
 * per-part quantities. Both go through the FastAPI backend (api/routes/quickbooks_routes.py),
 * because the QuickBooks tokens live in a service-role-only table; `callBackend` carries the
 * caller's token and this server's gateway key. The browser's `utils/quickbooksAccess.ts`
 * helpers read a browser session and call a relative URL, so they cannot run here.
 *
 * WHO MAY PUSH. Any office role, as in the app: `preflight` and `push_invoice` call
 * `verify_company_access` without `require_admin`, and the Invoices menu's "Create invoice" has
 * no role check (operators never reach the dashboard, and the MCP wrapper refuses them).
 *
 * ONE INVOICE PER RETRY. The dialog mints one idempotency key per open and reuses it on retry.
 * An assistant has no "open", so the key is derived from what identifies the draft: the company,
 * the job, the sorted lines and today's date (UTC). Repeating the same call the same day finds
 * the invoice the first one created (`already_existed`) instead of creating a second.
 */

const CUSTOMER_STATUSES = ['mapped', 'exact_match', 'candidates', 'unmatched'] as const;

/** POST /api/quickbooks/{company_id}/jobs/{job_id}/preflight, as `preflight()` builds it. */
const preflightResponse = z.object({
  connected: z.boolean(),
  provider: z.enum(['qbo', 'qbd']).optional(),
  has_deep_links: z.boolean().optional(),
  blocked: z.object({ code: z.string(), link_id: z.string() }).nullable().optional(),
  customer: z
    .object({
      status: z.enum(CUSTOMER_STATUSES),
      qb_customer_id: z.string().nullable(),
      candidates: z.array(z.object({ qb_id: z.string(), display_name: z.string().nullable() })),
      jigged_customer_id: z.string(),
      jigged_name: z.string(),
    })
    .optional(),
  // services/quickbooks.py load_billable_parts
  parts: z
    .array(
      z.object({
        job_part_id: z.string(),
        part_name: z.string(),
        description: z.string().nullable(),
        unit_price: z.number().nullable(),
        qty_ordered: z.number(),
        qty_shipped: z.number(),
        qty_invoiced: z.number(),
        qty_invoiceable: z.number(),
        production_status: z.string().nullable(),
      }),
    )
    .optional(),
});

type Preflight = z.infer<typeof preflightResponse>;
type BillablePart = NonNullable<Preflight['parts']>[number];
type PreflightCustomer = NonNullable<Preflight['customer']>;

/** POST /api/quickbooks/{company_id}/jobs/{job_id}/invoice, every shape `push_invoice()` returns. */
const pushResponse = z.object({
  qb_invoice_id: z.string().nullable().optional(),
  doc_number: z.string().nullable().optional(),
  url: z.string().nullable().optional(),
  already_existed: z.boolean().optional(),
  in_progress: z.boolean().optional(),
});

const NOT_CONNECTED =
  "QuickBooks isn't connected, so no invoice can be created. An admin can connect it in Jigged under Settings.";
const BLOCKED =
  'An earlier invoice for this job could not be confirmed in QuickBooks. Check it there before creating another.';
const IN_PROGRESS = 'This invoice is already being created. Check the job\'s invoices in a moment.';

/** The invoice-date tolerance the backend enforces (`_resolve_transaction_date`). */
const DAY_MS = 24 * 60 * 60 * 1000;

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

function formatQty(n: number): string {
  return String(Math.round(n * 10_000) / 10_000);
}

const jobRef = {
  job_id: z.guid().optional().describe('The job, by id.'),
  job_number: z.string().optional().describe('The job, by its number, when you have no id.'),
};

/**
 * The job by id (a by-id read, so an archived job still resolves) or by number among live jobs,
 * as get_job_invoices finds it. Always within this company.
 */
async function findJob(
  args: { job_id?: string; job_number?: string },
  env: CompanyToolEnv,
): Promise<{ job: { id: string; job_number: string; deleted_at: string | null } } | { message: string }> {
  const number = args.job_number?.trim();
  if (!args.job_id && !number) return { message: 'Give a job_id or a job_number.' };
  let query = getSupabase().from('jobs').select('id, job_number, deleted_at').eq('company_id', env.company.id);
  query = args.job_id ? query.eq('id', args.job_id) : query.eq('job_number', number ?? '').is('deleted_at', null);
  const { data, error } = await query.limit(1).maybeSingle();
  if (error) throw error;
  if (!data) {
    return {
      message: args.job_id
        ? `There is no job with that id in ${env.company.name}.`
        : `There is no job ${number} in ${env.company.name}.`,
    };
  }
  return { job: data };
}

function preflightPath(env: CompanyToolEnv, jobId: string): string {
  return `/api/quickbooks/${env.company.id}/jobs/${jobId}/preflight`;
}

function runPreflight(env: CompanyToolEnv, jobId: string): Promise<Preflight> {
  return callBackend(env, preflightPath(env, jobId), preflightResponse, { body: {} });
}

function providerLabel(provider: Preflight['provider']): 'online' | 'desktop' | null {
  if (provider === 'qbd') return 'desktop';
  if (provider === 'qbo') return 'online';
  return null;
}

/** The dialog lists a part only when it has a price and something left to invoice. */
function isBillable(p: BillablePart): boolean {
  return p.unit_price !== null && p.qty_invoiceable > 0;
}

/** The dialog's default for a line: shipped but not yet invoiced, within what may still be billed. */
function proposedQuantity(p: BillablePart): number {
  if (!isBillable(p)) return 0;
  return Math.min(Math.max(0, p.qty_shipped - p.qty_invoiced), p.qty_invoiceable);
}

/**
 * The idempotency key for one push: a UUID (the column is `uuid`) from SHA-256 over the company,
 * the job, the lines sorted by job part, and the day. RFC 9562 version 8, the custom layout.
 */
export function invoiceRequestId(
  companyId: string,
  jobId: string,
  lines: ReadonlyArray<{ job_part_id: string; quantity: number }>,
  day: string,
): string {
  const sorted = lines
    .map((l) => [l.job_part_id, l.quantity] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const digest = createHash('sha256')
    .update(JSON.stringify(['jigged-mcp-invoice', 1, companyId, jobId, day, sorted]))
    .digest();
  const bytes = Uint8Array.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Buffer.from(bytes).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const MATCH_HELP =
  '`linked`: Jigged already bills this QuickBooks customer. `exact_match`: QuickBooks has a ' +
  'customer with exactly this name. `candidates`: QuickBooks has customers with similar names. ' +
  '`unmatched`: none.';

const ON_PUSH_HELP =
  'What push_invoice_to_quickbooks does for the customer without being told: `use_linked`, ' +
  '`use_exact_match` (and link it), `choose` (it needs quickbooks_customer_id or ' +
  'create_quickbooks_customer), or `create_in_quickbooks`.';

const customerOutput = z.object({
  customer_id: z.string(),
  name: z.string(),
  match: z.enum(['linked', 'exact_match', 'candidates', 'unmatched']).describe(MATCH_HELP),
  quickbooks_customer_id: z.string().nullable().describe('The linked or exactly matching QuickBooks customer.'),
  candidates: z.array(z.object({ quickbooks_customer_id: z.string(), name: z.string().nullable() })),
  on_push: z.enum(['use_linked', 'use_exact_match', 'choose', 'create_in_quickbooks']).describe(ON_PUSH_HELP),
});

function customerView(c: PreflightCustomer): z.infer<typeof customerOutput> {
  const onPush = {
    mapped: 'use_linked',
    exact_match: 'use_exact_match',
    candidates: 'choose',
    unmatched: 'create_in_quickbooks',
  } as const;
  return {
    customer_id: c.jigged_customer_id,
    name: c.jigged_name,
    match: c.status === 'mapped' ? 'linked' : c.status,
    quickbooks_customer_id: c.qb_customer_id,
    candidates: c.candidates.map((cand) => ({ quickbooks_customer_id: cand.qb_id, name: cand.display_name })),
    on_push: onPush[c.status],
  };
}

const partOutput = z.object({
  job_part_id: z.string(),
  part_name: z.string(),
  description: z.string().nullable(),
  unit_price: z.number().nullable().describe('The price the invoice bills at. Null: the part cannot be invoiced yet.'),
  quantity_ordered: z.number(),
  quantity_shipped: z.number(),
  quantity_invoiced: z.number().describe('Already on invoices QuickBooks confirmed.'),
  quantity_invoiceable: z.number().describe('Ordered and not yet invoiced: the most one invoice may bill.'),
  proposed_quantity: z.number().describe('What the app\'s Invoice dialog proposes: shipped but not yet invoiced.'),
});

export const previewInvoicePush = defineCompanyTool({
  name: 'preview_invoice_push',
  title: 'Preview a QuickBooks invoice',
  description:
    'Shows what creating a QuickBooks invoice for one job would involve, without creating ' +
    'one: whether QuickBooks (Online or Desktop) is connected, whether an earlier unconfirmed ' +
    'invoice blocks a new one, how the job\'s customer matches a QuickBooks customer (linked, ' +
    'an exact match, similar names, or none), and for each part its price and the quantities ' +
    'ordered, shipped, already invoiced and still invoiceable, with the quantity the app ' +
    'proposes and that total. `missing` lists what stops an invoice now. Asks QuickBooks for ' +
    'matching customers when the customer is not yet linked. Find the job by id or number.',
  access: 'read',
  openWorld: true,
  input: jobRef,
  output: {
    job_id: z.string(),
    job_number: z.string(),
    quickbooks_connected: z.boolean(),
    quickbooks: z.enum(['online', 'desktop']).nullable(),
    blocked_by_unconfirmed_invoice: z.boolean(),
    customer: customerOutput.nullable(),
    parts: z.array(partOutput),
    proposed_total: z.number().describe('The proposed quantities at their prices, before any tax QuickBooks adds.'),
    missing: z.array(z.string()).describe('What stops an invoice being created now. Empty when nothing does.'),
    url: urlOutput,
  },
  run: async (args, env) => {
    const found = await findJob(args, env);
    if ('message' in found) return { ok: false, message: found.message };
    const { job } = found;
    const pre = await runPreflight(env, job.id);
    const parts = pre.parts ?? [];

    const missing: string[] = [];
    if (!pre.connected) {
      missing.push(NOT_CONNECTED);
    } else {
      if (pre.blocked) missing.push(BLOCKED);
      // The dialog's three reasons for an empty picker.
      if (!parts.some(isBillable)) {
        if (parts.length === 0) missing.push('This job has no parts on it to invoice.');
        else if (!parts.some((p) => p.unit_price !== null)) {
          missing.push('No part on this job has a price yet. Set one on the job, then invoice it.');
        } else {
          missing.push('Everything on this job is already recorded as invoiced.');
        }
      }
      if (pre.customer?.status === 'candidates') {
        missing.push(
          `QuickBooks has several customers that could be ${pre.customer.jigged_name}; the invoice ` +
            'needs one chosen (quickbooks_customer_id) or a new one created (create_quickbooks_customer).',
        );
      }
    }

    return {
      ok: true,
      data: {
        job_id: job.id,
        job_number: job.job_number,
        quickbooks_connected: pre.connected,
        quickbooks: providerLabel(pre.provider),
        blocked_by_unconfirmed_invoice: Boolean(pre.blocked),
        customer: pre.customer ? customerView(pre.customer) : null,
        parts: parts.map((p) => ({
          job_part_id: p.job_part_id,
          part_name: p.part_name,
          description: p.description,
          unit_price: p.unit_price,
          quantity_ordered: p.qty_ordered,
          quantity_shipped: p.qty_shipped,
          quantity_invoiced: p.qty_invoiced,
          quantity_invoiceable: p.qty_invoiceable,
          proposed_quantity: proposedQuantity(p),
        })),
        proposed_total: round4(parts.reduce((sum, p) => sum + proposedQuantity(p) * (p.unit_price ?? 0), 0)),
        missing,
        url: companyLink(env, `/jobs/${job.id}`),
      },
    };
  },
});

type CustomerDecision = { action: 'use_existing'; qb_customer_id: string } | { action: 'create' };

/**
 * The customer step of the dialog. A linked customer is billed as linked; an exact name match is
 * the dialog's preselection; "create" is the only choice when QuickBooks has no match. Similar
 * names are the one case the dialog guesses (the first) and a person confirms, so here it needs
 * an explicit choice.
 */
function decideCustomer(
  c: PreflightCustomer,
  args: { quickbooks_customer_id?: string; create_quickbooks_customer?: boolean },
): CustomerDecision | { message: string } {
  const chosenId = args.quickbooks_customer_id?.trim();
  const create = args.create_quickbooks_customer === true;
  if (chosenId && create) {
    return { message: 'Give quickbooks_customer_id or create_quickbooks_customer, not both.' };
  }
  const list = c.candidates.map((cand) => `${cand.display_name ?? cand.qb_id} (quickbooks_customer_id ${cand.qb_id})`).join('; ');

  if (c.status === 'mapped') {
    if (create || (chosenId && chosenId !== c.qb_customer_id)) {
      return {
        message: `${c.jigged_name} is already linked to a QuickBooks customer, and Jigged invoices that one. Nothing was created.`,
      };
    }
    return c.qb_customer_id ? { action: 'use_existing', qb_customer_id: c.qb_customer_id } : { action: 'create' };
  }
  if (create) return { action: 'create' };
  if (chosenId) {
    if (!c.candidates.some((cand) => cand.qb_id === chosenId)) {
      return {
        message: c.candidates.length
          ? `That QuickBooks customer isn't one of the matches for ${c.jigged_name}: ${list}.`
          : `QuickBooks has no customer matching ${c.jigged_name}, so the invoice can only create one (create_quickbooks_customer).`,
      };
    }
    return { action: 'use_existing', qb_customer_id: chosenId };
  }
  if (c.status === 'exact_match' && c.qb_customer_id) return { action: 'use_existing', qb_customer_id: c.qb_customer_id };
  if (c.status === 'unmatched') return { action: 'create' };
  return {
    message:
      `QuickBooks has several customers that could be ${c.jigged_name}, so no invoice was created. ` +
      `Choose one with quickbooks_customer_id (${list}), or create_quickbooks_customer to create a new one.`,
  };
}

const lineInput = z.object({
  job_part_id: z.guid().describe('A job_part_id from preview_invoice_push or get_job.'),
  quantity: z.number().positive().describe('How many of that part this invoice bills.'),
});

export const pushInvoiceToQuickBooks = defineCompanyTool({
  name: 'push_invoice_to_quickbooks',
  title: 'Create a QuickBooks invoice',
  description:
    'Creates ONE invoice in QuickBooks for a job, billing the chosen quantity of each part at ' +
    'the job\'s prices (the price of each part invoiced is then locked in Jigged). A job may have ' +
    'many invoices; each part may be billed up to what was ordered and not yet invoiced, shipped ' +
    'or not. The job\'s customer is billed as linked; an exact name match is linked; when ' +
    'QuickBooks has no match the customer is created there; similar names need ' +
    'quickbooks_customer_id or create_quickbooks_customer. Repeating the same call on the same ' +
    'day returns the invoice it already created. Returns the invoice number, its lines and total, ' +
    'and its QuickBooks link.',
  access: 'write',
  destructive: true,
  openWorld: true,
  input: {
    ...jobRef,
    lines: z.array(lineInput).min(1).max(100).describe('Each part to bill, once, with its quantity.'),
    invoice_date: z
      .iso.date()
      .optional()
      .describe(
        'The invoice date (YYYY-MM-DD) in the shop\'s time zone. Jigged accepts only a date within ' +
          'a day of today. Defaults to today in UTC.',
      ),
    quickbooks_customer_id: z
      .string()
      .max(100)
      .optional()
      .describe('Bill this existing QuickBooks customer: one of the candidates preview_invoice_push lists.'),
    create_quickbooks_customer: z
      .boolean()
      .optional()
      .describe('Create the job\'s customer in QuickBooks rather than link an existing one.'),
  },
  output: {
    job_id: z.string(),
    job_number: z.string(),
    invoice_number: z.string().nullable().describe('The QuickBooks invoice number.'),
    quickbooks_invoice_id: z.string().nullable(),
    already_existed: z
      .boolean()
      .describe('This call repeated an earlier one, and the invoice it created was returned rather than a second one.'),
    invoice_date: z.string().describe('The invoice date sent to QuickBooks (YYYY-MM-DD).'),
    lines: z.array(
      z.object({
        job_part_id: z.string(),
        part_name: z.string(),
        quantity: z.number(),
        unit_price: z.number(),
        total_price: z.number(),
      }),
    ),
    total: z.number().describe('The sum of the lines: Jigged\'s figure, before any tax QuickBooks adds.'),
    quickbooks_url: z.string().nullable().describe('The invoice in QuickBooks Online. Null for QuickBooks Desktop.'),
    warnings: z.array(z.string()).describe('What the app would have pointed out. None of it stopped the invoice.'),
    url: urlOutput.describe('The job\'s page in Jigged, where its invoices are.'),
  },
  run: async (args, env) => {
    const found = await findJob(args, env);
    if ('message' in found) return { ok: false, message: found.message };
    const { job } = found;
    if (job.deleted_at) {
      return { ok: false, message: `Job ${job.job_number} is archived in Jigged, so no invoice was created.` };
    }

    const today = todayUtc();
    const invoiceDate = args.invoice_date ?? today;
    if (Math.abs(Date.parse(invoiceDate) - Date.parse(today)) > DAY_MS) {
      return { ok: false, message: 'Invoice date must be within a day of today.' };
    }

    const pre = await runPreflight(env, job.id);
    if (!pre.connected) return { ok: false, message: NOT_CONNECTED };
    if (pre.blocked) return { ok: false, message: BLOCKED };
    if (!pre.customer) return { ok: false, message: `Job ${job.job_number} has no customer to invoice.` };

    // ---- the lines, checked as the dialog and load_firm_invoice_lines check them ----
    const parts = pre.parts ?? [];
    const seen = new Set<string>();
    const warnings: string[] = [];
    for (const line of args.lines) {
      const part = parts.find((p) => p.job_part_id === line.job_part_id);
      if (!part) {
        const choices = parts.map((p) => `${p.part_name} (job_part_id ${p.job_part_id})`).join('; ');
        return {
          ok: false,
          message: parts.length
            ? `That part isn't on job ${job.job_number}. Its parts: ${choices}.`
            : `Job ${job.job_number} has no parts on it to invoice.`,
        };
      }
      if (seen.has(part.job_part_id)) {
        return { ok: false, message: `List each part once: ${part.part_name} appears twice.` };
      }
      seen.add(part.job_part_id);
      if (part.unit_price === null) {
        return { ok: false, message: `${part.part_name} has no unit price and can't be invoiced. Set one on the job first.` };
      }
      if (line.quantity > part.qty_invoiceable + 1e-9) {
        return {
          ok: false,
          message:
            part.qty_invoiceable > 0
              ? `Can't invoice ${formatQty(line.quantity)} of ${part.part_name}: only ${formatQty(part.qty_invoiceable)} left to invoice.`
              : `${part.part_name} is already fully invoiced.`,
        };
      }
      const shippedUnbilled = Math.max(0, part.qty_shipped - part.qty_invoiced);
      if (line.quantity > shippedUnbilled + 1e-9) {
        warnings.push(`${part.part_name}: billing ${formatQty(line.quantity)}, only ${formatQty(shippedUnbilled)} shipped so far.`);
      }
    }

    const customer = decideCustomer(pre.customer, args);
    if ('message' in customer) return { ok: false, message: customer.message };

    // The dialog sends the lines in the job's part order.
    const order = new Map(parts.map((p, i) => [p.job_part_id, i]));
    const lines = args.lines
      .slice()
      .sort((a, b) => (order.get(a.job_part_id) ?? 0) - (order.get(b.job_part_id) ?? 0))
      .map((l) => ({ job_part_id: l.job_part_id, quantity: l.quantity }));
    const requestId = invoiceRequestId(env.company.id, job.id, lines, today);

    const result = await callBackend(env, `/api/quickbooks/${env.company.id}/jobs/${job.id}/invoice`, pushResponse, {
      body: { customer, request_id: requestId, lines, transaction_date: invoiceDate },
    });
    if (result.in_progress) return { ok: false, message: IN_PROGRESS };

    const priced = lines.map((l) => {
      const part = parts.find((p) => p.job_part_id === l.job_part_id);
      const unitPrice = part?.unit_price ?? 0;
      return {
        job_part_id: l.job_part_id,
        part_name: part?.part_name ?? 'Part',
        quantity: l.quantity,
        unit_price: unitPrice,
        total_price: round4(l.quantity * unitPrice),
      };
    });
    return {
      ok: true,
      data: {
        job_id: job.id,
        job_number: job.job_number,
        invoice_number: result.doc_number ?? null,
        quickbooks_invoice_id: result.qb_invoice_id ?? null,
        already_existed: Boolean(result.already_existed),
        invoice_date: invoiceDate,
        lines: priced,
        total: round4(priced.reduce((sum, l) => sum + l.total_price, 0)),
        quickbooks_url: result.url ?? null,
        warnings,
        url: companyLink(env, `/jobs/${job.id}`),
      },
    };
  },
});

export function registerInvoiceWriteTools(server: McpServer): void {
  registerCompanyTool(server, previewInvoicePush);
  registerCompanyTool(server, pushInvoiceToQuickBooks);
}

/** Exported for the catalogue test. */
export const INVOICE_WRITE_TOOLS = [previewInvoicePush, pushInvoiceToQuickBooks];
