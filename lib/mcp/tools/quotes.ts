import { z } from 'zod';

import { defineCompanyTool, registerCompanyTool, type CompanyToolEnv, type ToolTarget } from '@/lib/mcp/defineTool';
import {
  BAD_CURSOR_MESSAGE,
  addressOf,
  addressOutput,
  companyLink,
  matchesText,
  pageInput,
  pageOutput,
  paginate,
  urlOutput,
} from '@/lib/mcp/tools/shared';
import { getSupabase } from '@/lib/supabase';
import {
  isQuoteExpired,
  type Quote,
  type QuoteLineItem,
  type QuoteListStatus,
  type QuoteWithRelations,
} from '@/types/quote';
import { getAllQuotes, getQuoteConversionState, getQuoteWithRelations } from '@/utils/quotesAccess';

/**
 * What a quote reads as, which is not what `quotes.status` stores. The column holds only
 * `active | expired`; winning a quote stamps `converted_at` and leaves the status alone, so a
 * converted quote beats the column (resolveQuoteStatus in components/quotes/QuoteStatusChip.tsx).
 * `expired` also covers an unconverted quote past its date that the lazy sweep hasn't flipped yet.
 */
const STATUSES = ['open', 'converted', 'expired'] as const satisfies readonly QuoteListStatus[];

type QuoteDisplayStatus = (typeof STATUSES)[number];

const STATUS_HELP =
  'open (still live: not converted, not past its expiry date), converted (became one or more ' +
  'jobs), expired (lapsed without converting).';

function statusOf(quote: Pick<Quote, 'status' | 'converted_at' | 'expiration_date'>): QuoteDisplayStatus {
  if (quote.converted_at) return 'converted';
  return isQuoteExpired(quote) ? 'expired' : 'open';
}

const cents = (n: number): number => Math.round(n * 100) / 100;

/** The line's total as the quote page and PDF show it. */
function lineTotal(li: QuoteLineItem): number {
  return li.total_price ?? cents(li.unit_price * li.quantity);
}

/** Lines that quote one part at several quantities: alternatives, so they have no sum. */
function hasPriceOptions(lines: QuoteLineItem[]): boolean {
  const seen = new Set<string>();
  for (const li of lines) {
    if (seen.has(li.part_id)) return true;
    seen.add(li.part_id);
  }
  return false;
}

/** The grand total the app shows: firm quotes only (one quantity per part), and only with lines. */
function quoteTotal(lines: QuoteLineItem[]): number | null {
  if (lines.length === 0 || hasPriceOptions(lines)) return null;
  return cents(lines.reduce((sum, li) => sum + lineTotal(li), 0));
}

const sortedLines = (quote: QuoteWithRelations): QuoteLineItem[] =>
  [...(quote.line_items ?? [])].sort((a, b) => a.sequence - b.sequence);

const totalOutput = z
  .number()
  .nullable()
  .describe('Sum of the line totals. Null when the quote has no lines or offers a part at several quantities.');

const quoteSummary = z.object({
  quote_id: z.string(),
  quote_number: z.string(),
  status: z.enum(STATUSES),
  customer_id: z.string().nullable(),
  customer_name: z.string().nullable(),
  total: totalOutput,
  expiration_date: z.string().nullable(),
  parts: z.array(z.object({ part_name: z.string(), quantity: z.number() })),
  created_at: z.string(),
  url: urlOutput,
});

type QuoteSummary = z.infer<typeof quoteSummary>;

function summarise(quote: QuoteWithRelations, env: CompanyToolEnv): QuoteSummary {
  const lines = sortedLines(quote);
  return {
    quote_id: quote.id,
    quote_number: quote.quote_number,
    status: statusOf(quote),
    customer_id: quote.customer_id,
    customer_name: quote.customers?.name ?? quote.customer_name,
    total: quoteTotal(lines),
    expiration_date: quote.expiration_date,
    parts: lines.map((li) => ({ part_name: li.parts?.part_name ?? 'Unknown part', quantity: li.quantity })),
    created_at: quote.created_at,
    url: companyLink(env, `/quotes/${quote.id}`),
  };
}

export const listQuotes = defineCompanyTool({
  name: 'list_quotes',
  title: 'List quotes',
  description:
    'Lists quotes in a Jigged company, newest first. Filters: status, customer, and search text ' +
    'matching the quote number, customer name or a part number on the quote. Each quote has its ' +
    'status, customer, total, expiry date and the parts quoted with their quantities.',
  access: 'read',
  input: {
    status: z.enum(STATUSES).optional().describe(`Only quotes with this status: ${STATUS_HELP} Every status when left out.`),
    customer_id: z.guid().optional().describe('Only this customer\'s quotes.'),
    search: z.string().optional().describe('Quote number, customer name or part number.'),
    ...pageInput,
  },
  output: { quotes: z.array(quoteSummary), ...pageOutput },
  run: async (args, env) => {
    // `open` and `converted` narrow in the database exactly as the status above reads them.
    // `expired` can't: the column misses a lapsed quote the sweep hasn't flipped yet, and holds
    // converted quotes the sweep did flip. So it is read whole and narrowed here, as are the rest.
    const serverStatus = args.status === 'open' || args.status === 'converted' ? args.status : undefined;
    const quotes = await getAllQuotes(
      env.company.id,
      { status: serverStatus, customerId: args.customer_id },
      'created_at',
      'desc',
    );
    const rows = quotes
      .filter((q) => !args.status || statusOf(q) === args.status)
      .filter((q) =>
        matchesText(
          args.search,
          q.quote_number,
          q.customers?.name ?? q.customer_name,
          ...(q.line_items ?? []).map((li) => li.parts?.part_name),
        ),
      );
    rows.sort((a, b) => b.created_at.localeCompare(a.created_at));
    const page = paginate(rows, args);
    if (!page) return { ok: false, message: BAD_CURSOR_MESSAGE };
    return {
      ok: true,
      data: { quotes: page.items.map((q) => summarise(q, env)), total: page.total, next_cursor: page.next_cursor },
    };
  },
});

const lineOutput = z.object({
  line_item_id: z.string(),
  part_id: z.string(),
  part_name: z.string(),
  description: z.string().nullable(),
  quantity: z.number(),
  unit: z.string().nullable().describe('The part\'s unit of measure.'),
  unit_price: z.number(),
  line_total: z.number(),
  lead_time: z.string().nullable().describe('This line\'s lead time, or the quote\'s when the line has none.'),
  price_overridden: z.boolean().describe('The price was typed on this quote rather than taken from the part\'s price tiers.'),
  job_number: z.string().nullable().describe('The job this line was converted into, if it was.'),
});

export const quoteDetail = {
  quote_id: z.string(),
  quote_number: z.string(),
  status: z.enum(STATUSES),
  archived: z.boolean().describe('Deleted in Jigged, so it no longer appears in lists.'),
  customer_id: z.string().nullable(),
  customer_name: z.string().nullable(),
  contact: z
    .object({ name: z.string().nullable(), email: z.string().nullable(), phone: z.string().nullable() })
    .nullable(),
  bill_to: addressOutput.nullable(),
  ship_to: addressOutput.nullable(),
  payment_terms: z.string().nullable(),
  lead_time: z.string().nullable(),
  customer_note: z.string().nullable().describe('The note to the customer printed on the quote.'),
  expiration_date: z.string().nullable(),
  converted_at: z.string().nullable(),
  created_at: z.string(),
  total: totalOutput,
  price_options: z.boolean().describe('Some part is offered at several quantities, each its own line.'),
  line_items: z.array(lineOutput),
  jobs: z
    .array(
      z.object({
        job_id: z.string(),
        job_number: z.string(),
        customer_po_number: z.string().nullable(),
        url: urlOutput,
      }),
    )
    .describe('The jobs this quote was converted into, cancelled ones left out.'),
  url: urlOutput,
};

const NAME_THE_QUOTE = 'Give a quote_id or a quote_number.';

/**
 * The quote a tool names by id or number, or a sentence saying it isn't there. A by-id read, so
 * an archived quote is found too and says so; `Quote` doesn't carry `deleted_at`, hence the
 * lookup reads it alongside the id.
 */
export async function findQuote(
  args: { quote_id?: string; quote_number?: string },
  env: CompanyToolEnv,
): Promise<{ quote: QuoteWithRelations; archived: boolean } | { message: string }> {
  const number = args.quote_number?.trim();
  if (!args.quote_id && !number) return { message: NAME_THE_QUOTE };
  const lookup = getSupabase().from('quotes').select('id, deleted_at').eq('company_id', env.company.id);
  const { data, error } = await (args.quote_id ? lookup.eq('id', args.quote_id) : lookup.eq('quote_number', number ?? ''))
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  const missing = args.quote_id
    ? `There is no quote with that id in ${env.company.name}.`
    : `There is no quote ${number} in ${env.company.name}.`;
  if (!data) return { message: missing };
  const quote = await getQuoteWithRelations(data.id, env.company.id);
  if (!quote) return { message: missing };
  return { quote, archived: data.deleted_at !== null };
}

export const getQuote = defineCompanyTool({
  name: 'get_quote',
  title: 'Get a quote',
  description:
    'Returns one quote in full: status, customer, contact, addresses, payment terms, lead time, ' +
    'expiry date, the note to the customer, each line with its part, quantity, unit price, line ' +
    'total and lead time, the total, and the jobs it was converted into. Find a quote by id or ' +
    'by quote number.',
  access: 'read',
  input: {
    quote_id: z.guid().optional().describe('The quote, by id.'),
    quote_number: z.string().optional().describe('The quote, by its number, when you have no id.'),
  },
  output: quoteDetail,
  run: async (args, env) => {
    const found = await findQuote(args, env);
    if ('message' in found) return { ok: false, message: found.message };
    const { quote, archived } = found;
    const conversions = await getQuoteConversionState(quote.id);
    const jobByLine = new Map(conversions.map((c) => [c.line_item_id, c.job_number]));
    const jobs = [...new Map(conversions.map((c) => [c.job_id, c])).values()].map((c) => ({
      job_id: c.job_id,
      job_number: c.job_number,
      customer_po_number: c.customer_po_number,
      url: companyLink(env, `/jobs/${c.job_id}`),
    }));
    const lines = sortedLines(quote);
    // Who prepared the quote is left out, like every other "who" on these tools; cost and markup
    // are left out because the quote page doesn't show them.
    return {
      ok: true,
      data: {
        quote_id: quote.id,
        quote_number: quote.quote_number,
        status: statusOf(quote),
        archived,
        customer_id: quote.customer_id,
        customer_name: quote.customers?.name ?? quote.customer_name,
        contact: quote.contact_snapshot
          ? {
              name: quote.contact_snapshot.name,
              email: quote.contact_snapshot.email,
              phone: quote.contact_snapshot.phone,
            }
          : null,
        bill_to: addressOf(quote.bill_to_address),
        ship_to: addressOf(quote.ship_to_address),
        payment_terms: quote.payment_terms,
        lead_time: quote.lead_time_text,
        customer_note: quote.customer_note,
        expiration_date: quote.expiration_date,
        converted_at: quote.converted_at,
        created_at: quote.created_at,
        total: quoteTotal(lines),
        price_options: hasPriceOptions(lines),
        line_items: lines.map((li) => ({
          line_item_id: li.id,
          part_id: li.part_id,
          part_name: li.parts?.part_name ?? 'Unknown part',
          description: li.parts?.description ?? null,
          quantity: li.quantity,
          unit: li.parts?.primary_unit ?? null,
          unit_price: li.unit_price,
          line_total: lineTotal(li),
          lead_time: li.lead_time_text ?? quote.lead_time_text,
          price_overridden: li.is_quote_override,
          job_number: jobByLine.get(li.id) ?? null,
        })),
        jobs,
        url: companyLink(env, `/quotes/${quote.id}`),
      },
    };
  },
});

export function registerQuoteTools(server: ToolTarget): void {
  registerCompanyTool(server, listQuotes);
  registerCompanyTool(server, getQuote);
}

/** Exported for the catalogue test. */
export const QUOTE_TOOLS = [listQuotes, getQuote];
