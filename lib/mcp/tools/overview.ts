import { z } from 'zod';

import { defineCompanyTool, registerCompanyTool, type CompanyToolEnv, type ToolTarget } from '@/lib/mcp/defineTool';
import { companyLink, isAdmin, urlOutput } from '@/lib/mcp/tools/shared';
import { getJobLifecycleStage, type JobWithRelations } from '@/types/job';
import { isQuoteOpen, type QuoteWithRelations } from '@/types/quote';
import type { CustomerWithRelations } from '@/types/customer';
import type { Vendor } from '@/types/vendor';
import { getAllCustomers } from '@/utils/customerAccess';
import {
  getCompletedPeriod,
  getDashboardMetrics,
  type MetricTimePeriod,
  type MetricValue,
} from '@/utils/dashboardAccess';
import { getAllJobs } from '@/utils/jobsAccess';
import { searchPartsForSelect, type PartSelectOption } from '@/utils/partsAccess';
import { getAllQuotes } from '@/utils/quotesAccess';
import { filterQuotesBySearch } from '@/utils/quoteSearch';
import { getAllVendors } from '@/utils/vendorsAccess';

// ---------------------------------------------------------------------------
// get_shop_overview
// ---------------------------------------------------------------------------

const PERIODS = ['today', 'this_week'] as const satisfies readonly MetricTimePeriod[];

const ADMIN_ONLY = 'Only for company admins; null otherwise.';

const money = (what: string) => z.number().nullable().describe(`${what} ${ADMIN_ONLY}`);

const bucket = z.object({ count: z.number(), value: money('What is still owed on these jobs.') });

export const getShopOverview = defineCompanyTool({
  name: 'get_shop_overview',
  title: 'Get the shop overview',
  description:
    'Returns the figures on the Jigged dashboard: overdue jobs, open jobs split into not ' +
    'started, in progress and finished but not shipped, jobs shipped from in a period, and open ' +
    'quotes. Counts for everyone; the dollar values behind them only for company admins. A ' +
    'figure that could not be loaded is null rather than 0.',
  access: 'read',
  input: {
    period: z
      .enum(PERIODS)
      .optional()
      .describe(
        'The window for completed_jobs: today, or this week starting Sunday. Defaults to the ' +
          'one this person last chose on their dashboard. Days are counted on Jigged\'s server ' +
          'clock, which can differ from the shop\'s local day near midnight.',
      ),
  },
  output: {
    period: z.enum(PERIODS),
    overdue_jobs: z
      .object({
        count: z.number(),
        value: money('The order value of these jobs.'),
      })
      .nullable()
      .describe(
        'Open jobs past their due date, judged on Jigged\'s server clock. Every overdue job is also an open job.',
      ),
    open_jobs: z
      .object({
        count: z.number(),
        value: money('What is still owed: ordered minus already shipped, at the job\'s prices.'),
        not_started: bucket,
        in_progress: bucket,
        finished_not_shipped: bucket,
      })
      .nullable()
      .describe('Jobs not fully shipped and not cancelled. The three buckets add up to the total.'),
    completed_jobs: z
      .object({
        count: z.number().describe('Jobs with a shipment dated in the period.'),
        shipped_value: money('Shipped quantities at the job\'s prices.'),
        previous_period_shipped_value: money('The same figure for the period before.'),
      })
      .nullable()
      .describe('What went out in the period, by ship date. Voided shipments do not count.'),
    open_quotes: z
      .object({ count: z.number() })
      .nullable()
      .describe(
        'Quotes still open: active, not converted to a job, not expired. No dollar value: a ' +
          'quote can hold alternative prices for the customer to choose from, so a total is undefined.',
      ),
    url: urlOutput.describe('The dashboard in Jigged.'),
  },
  run: async (args, env) => {
    // The saved choice is a database row (user_preferences), read as this person. The tool never
    // writes it: asking for another period here does not change their dashboard.
    const period = args.period ?? (await getCompletedPeriod());
    const metrics = await getDashboardMetrics(env.company.id, period);
    const admin = isAdmin(env);
    // To the cent: the dashboard sums line totals in floating point (3301.0199999999995).
    const show = (n: number | null | undefined): number | null =>
      admin && typeof n === 'number' ? Math.round(n * 100) / 100 : null;
    const split = (b: { count: number; money: number }) => ({ count: b.count, value: show(b.money) });
    const open: MetricValue | undefined = metrics.open_jobs;

    return {
      ok: true,
      data: {
        period,
        overdue_jobs: metrics.overdue_jobs
          ? { count: metrics.overdue_jobs.count, value: show(metrics.overdue_jobs.money) }
          : null,
        open_jobs:
          open && open.split
            ? {
                count: open.count,
                value: show(open.money),
                not_started: split(open.split.notStarted),
                in_progress: split(open.split.inProgress),
                finished_not_shipped: split(open.split.completed),
              }
            : null,
        completed_jobs: metrics.completed_jobs
          ? {
              count: metrics.completed_jobs.count,
              shipped_value: show(metrics.completed_jobs.money),
              previous_period_shipped_value: show(metrics.completed_jobs.previousMoney),
            }
          : null,
        open_quotes: metrics.open_quotes ? { count: metrics.open_quotes.count } : null,
        url: companyLink(env),
      },
    };
  },
});

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------

const RESULT_TYPES = ['job', 'quote', 'part', 'customer', 'vendor'] as const;
type ResultType = (typeof RESULT_TYPES)[number];

const PER_TYPE = 5;

const resultOutput = z.object({
  type: z.enum(RESULT_TYPES),
  id: z
    .string()
    .describe('The record\'s id: a job_id, quote_id, part_id, customer_id or vendor_id, by `type`.'),
  title: z.string().describe('The job or quote number, or the part, customer or vendor name.'),
  detail: z.string().nullable(),
  url: urlOutput,
});

type SearchResult = z.infer<typeof resultOutput>;

/** Exact title matches first, then the access function's own order. */
function exactFirst<T>(rows: T[], titleOf: (row: T) => string, query: string): T[] {
  const needle = query.toLowerCase();
  const exact = rows.filter((r) => titleOf(r).toLowerCase() === needle);
  return [...exact, ...rows.filter((r) => titleOf(r).toLowerCase() !== needle)];
}

const words = (s: string) => s.replace(/_/g, ' ');

const joined = (...parts: Array<string | null | undefined>): string | null =>
  parts.filter((p): p is string => Boolean(p?.trim())).join(' · ') || null;

function jobResult(job: JobWithRelations, env: CompanyToolEnv): SearchResult {
  return {
    type: 'job',
    id: job.id,
    title: job.job_number,
    detail: joined(
      job.customers?.name ?? job.customer_name,
      words(getJobLifecycleStage(job)),
      job.due_date ? `due ${job.due_date}` : null,
    ),
    url: companyLink(env, `/jobs/${job.id}`),
  };
}

function quoteStatus(quote: QuoteWithRelations): string {
  if (quote.converted_at) return 'converted to a job';
  return isQuoteOpen(quote) ? 'open' : 'expired';
}

function quoteResult(quote: QuoteWithRelations, env: CompanyToolEnv): SearchResult {
  return {
    type: 'quote',
    id: quote.id,
    title: quote.quote_number,
    detail: joined(quote.customers?.name ?? quote.customer_name, quoteStatus(quote)),
    url: companyLink(env, `/quotes/${quote.id}`),
  };
}

function partResult(part: PartSelectOption, env: CompanyToolEnv): SearchResult {
  return {
    type: 'part',
    id: part.id,
    title: part.part_name,
    detail: joined(part.source === 'made' ? 'made part' : 'bought part', part.description),
    url: companyLink(env, `/parts/${part.id}`),
  };
}

function customerResult(customer: CustomerWithRelations, env: CompanyToolEnv): SearchResult {
  const place =
    customer.addresses.find((a) => a.default_billing && a.city) ?? customer.addresses.find((a) => a.city);
  return {
    type: 'customer',
    id: customer.id,
    title: customer.name,
    detail: joined(
      place ? [place.city, place.state].filter(Boolean).join(', ') : null,
      customer.primary_contact?.name,
    ),
    url: companyLink(env, `/customers/${customer.id}`),
  };
}

function vendorResult(vendor: Vendor, env: CompanyToolEnv): SearchResult {
  return {
    type: 'vendor',
    id: vendor.id,
    title: vendor.name,
    detail: null,
    url: companyLink(env, `/vendors/${vendor.id}`),
  };
}

export const search = defineCompanyTool({
  name: 'search',
  title: 'Search Jigged',
  description:
    'Searches one company\'s jobs, quotes, parts, customers and vendors for a piece of text and ' +
    'returns up to 5 matches of each type, each with its type, id, number or name, a short ' +
    'detail line and a link. Jobs match on job number, customer PO, customer name, part number ' +
    'or packing slip; quotes on quote number, customer or a line\'s part; parts on name or ' +
    'description; customers on name; vendors on name or city. Archived records are left out. ' +
    'The ids are the ones get_job, get_quote, get_part, get_customer and get_vendor take.',
  access: 'read',
  input: {
    query: z.string().min(1).max(200).describe('The text to look for: a number, a name or part of one.'),
  },
  output: {
    results: z.array(resultOutput),
    more: z.array(z.enum(RESULT_TYPES)).describe('Types with more matches than the 5 shown.'),
  },
  run: async (args, env) => {
    const query = args.query.trim();
    if (!query) return { ok: false, message: 'Give some text to search for.' };
    const companyId = env.company.id;

    const [jobs, quotes, parts, customers, vendors] = await Promise.all([
      // Newest first; the search RPC behind this already leaves archived jobs out.
      getAllJobs(companyId, { search: query, excludeClosed: false }, 'created_at', 'desc'),
      getAllQuotes(companyId).then((all) => filterQuotesBySearch(all, query)),
      // One more than shown, to know whether there are more.
      searchPartsForSelect(companyId, query, 'all', PER_TYPE + 1),
      getAllCustomers(companyId, query),
      getAllVendors(companyId, query),
    ]);

    const matched: Record<ResultType, SearchResult[]> = {
      job: exactFirst(jobs.jobs, (j) => j.job_number, query).map((j) => jobResult(j, env)),
      quote: exactFirst(quotes, (q) => q.quote_number, query).map((q) => quoteResult(q, env)),
      part: exactFirst(parts, (p) => p.part_name, query).map((p) => partResult(p, env)),
      customer: exactFirst(customers, (c) => c.name, query).map((c) => customerResult(c, env)),
      vendor: exactFirst(vendors, (v) => v.name, query).map((v) => vendorResult(v, env)),
    };
    const totals: Record<ResultType, number> = {
      job: Math.max(jobs.total, jobs.jobs.length),
      quote: quotes.length,
      part: parts.length,
      customer: customers.length,
      vendor: vendors.length,
    };

    const results = RESULT_TYPES.flatMap((t) => matched[t].slice(0, PER_TYPE));
    return {
      ok: true,
      data: { results, more: RESULT_TYPES.filter((t) => totals[t] > PER_TYPE) },
      ...(results.length === 0 ? { text: `Nothing in ${env.company.name} matches "${query}".` } : {}),
    };
  },
});

export function registerOverviewTools(server: ToolTarget): void {
  registerCompanyTool(server, getShopOverview);
  registerCompanyTool(server, search);
}

/** Exported for the catalogue test. */
export const OVERVIEW_TOOLS = [getShopOverview, search];
