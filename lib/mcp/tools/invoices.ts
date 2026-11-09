import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import { defineCompanyTool, registerCompanyTool, type CompanyToolEnv } from '@/lib/mcp/defineTool';
import { companyLink, urlOutput } from '@/lib/mcp/tools/shared';
import { getSupabase } from '@/lib/supabase';
import { QB_INVOICE_STATUSES } from '@/utils/invoicePaymentStatus';
import { getQuickBooksInvoiceLinksForJob } from '@/utils/quickbooksAccess';

/**
 * A job's QuickBooks invoices, from what Jigged stores in Supabase and nothing else.
 *
 * `getQuickBooksInvoiceLinksForJob` is a plain member read of `quickbooks_invoice_links` and its
 * lines. Every other QuickBooks function goes through the FastAPI backend with a relative
 * `fetch`, which cannot run here, so this tool never asks QuickBooks anything: the payment
 * status is the mirror as it was last refreshed, which happens when someone opens the job's
 * Invoices menu in Jigged, and `payment_status_checked_at` says when.
 *
 * Amounts are not admin-gated. The job page's Invoices menu shows every invoice and its total to
 * any office role (it has no role check; operators never reach the dashboard), so a salesperson
 * sees here what they see there. Only the dashboard's whole-book totals are admin-only.
 */

const lineOutput = z.object({
  job_part_id: z.string(),
  part_name: z.string(),
  quantity: z.number(),
  unit_price: z.number(),
  total_price: z.number(),
});

const invoiceOutput = z.object({
  invoice_id: z.string().describe('Jigged\'s record of the invoice.'),
  invoice_number: z.string().nullable().describe('The QuickBooks invoice number.'),
  quickbooks: z.enum(['online', 'desktop']),
  issued_at: z.string().describe('When Jigged created the invoice in QuickBooks.'),
  invoice_date: z.string().nullable().describe('The invoice date QuickBooks holds (YYYY-MM-DD).'),
  due_date: z.string().nullable().describe('As QuickBooks computed it from the terms (YYYY-MM-DD).'),
  lines: z.array(lineOutput).describe('The job parts and quantities this invoice billed, at Jigged\'s prices.'),
  total: z.number().describe('The sum of the lines: Jigged\'s figure, before any tax QuickBooks adds.'),
  quickbooks_total: z
    .number()
    .nullable()
    .describe('The invoice total in QuickBooks, tax included, so it can exceed `total`. QuickBooks Online only.'),
  quickbooks_balance: z.number().nullable().describe('What QuickBooks says is still owed. QuickBooks Online only.'),
  payment_status: z
    .enum(QB_INVOICE_STATUSES)
    .nullable()
    .describe(
      'What QuickBooks Online last said: paid, partial, open, voided, or missing (deleted in ' +
        'QuickBooks). Null when it has never been checked, and for QuickBooks Desktop, which ' +
        'reports no payments back.',
    ),
  payment_status_checked_at: z
    .string()
    .nullable()
    .describe('When QuickBooks was last asked. The status and balance are as of this moment.'),
  voided: z.boolean().describe('Voided invoices no longer count toward what is invoiced.'),
  voided_at: z.string().nullable(),
  quantities_corrected_at: z
    .string()
    .nullable()
    .describe('Set when someone corrected the quantities Jigged recorded against this invoice after it was issued.'),
  quickbooks_url: z.string().nullable().describe('The invoice in QuickBooks Online. Null for QuickBooks Desktop.'),
  url: urlOutput.describe('The job\'s page in Jigged, where its invoices are.'),
});

const NAME_THE_JOB = 'Give a job_id or a job_number.';

/**
 * The job by id (a by-id read, so an archived job still resolves) or by number (non-archived,
 * as get_job finds it), always within this company.
 */
async function findJob(
  args: { job_id?: string; job_number?: string },
  env: CompanyToolEnv,
): Promise<{ job: { id: string; job_number: string } } | { message: string }> {
  const number = args.job_number?.trim();
  if (!args.job_id && !number) return { message: NAME_THE_JOB };
  let query = getSupabase().from('jobs').select('id, job_number').eq('company_id', env.company.id);
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

export const getJobInvoices = defineCompanyTool({
  name: 'get_job_invoices',
  title: 'Get a job\'s invoices',
  description:
    'Returns the QuickBooks invoices Jigged created for one job, newest first, voided ones ' +
    'included and marked: invoice number, dates, the job parts and quantities each billed with ' +
    'Jigged\'s prices and total, and, for QuickBooks Online, the total, balance and payment ' +
    'status as QuickBooks last reported them with when that was. Reads what Jigged has stored; ' +
    'it does not contact QuickBooks. Find the job by id or by job number.',
  access: 'read',
  input: {
    job_id: z.guid().optional().describe('The job, by id.'),
    job_number: z.string().optional().describe('The job, by its number, when you have no id.'),
  },
  output: {
    job_id: z.string(),
    job_number: z.string(),
    invoices: z.array(invoiceOutput),
    url: urlOutput,
  },
  run: async (args, env) => {
    const found = await findJob(args, env);
    if ('message' in found) return { ok: false, message: found.message };
    const { job } = found;
    const jobUrl = companyLink(env, `/jobs/${job.id}`);
    const views = await getQuickBooksInvoiceLinksForJob(env.company.id, job.id);
    return {
      ok: true,
      data: {
        job_id: job.id,
        job_number: job.job_number,
        invoices: views.map((inv) => ({
          invoice_id: inv.id,
          invoice_number: inv.docNumber,
          quickbooks: inv.provider === 'qbd' ? ('desktop' as const) : ('online' as const),
          issued_at: inv.createdAt,
          invoice_date: inv.qbTxnDate,
          due_date: inv.qbDueDate,
          lines: inv.lines.map((l) => ({
            job_part_id: l.jobPartId,
            part_name: l.partName,
            quantity: l.quantity,
            unit_price: l.unitPrice,
            total_price: l.totalPrice,
          })),
          total: inv.total,
          quickbooks_total: inv.qbTotalAmt,
          quickbooks_balance: inv.qbBalance,
          payment_status: inv.qbStatus,
          payment_status_checked_at: inv.qbStatusCheckedAt,
          voided: inv.voidedAt !== null,
          voided_at: inv.voidedAt,
          quantities_corrected_at: inv.correctedAt,
          quickbooks_url: inv.url,
          url: jobUrl,
        })),
        url: jobUrl,
      },
      ...(views.length === 0 ? { text: `Job ${job.job_number} has no QuickBooks invoices in Jigged.` } : {}),
    };
  },
});

export function registerInvoiceTools(server: McpServer): void {
  registerCompanyTool(server, getJobInvoices);
}

/** Exported for the catalogue test. */
export const INVOICE_TOOLS = [getJobInvoices];
