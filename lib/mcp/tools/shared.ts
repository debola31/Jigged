import { z } from 'zod';

import type { CompanyToolEnv } from '@/lib/mcp/defineTool';

/**
 * What every read tool shares: one page shape, one way to link back into the app, and the rules
 * for what may leave Jigged.
 *
 * OUTPUT RULES (docs/modules/ai-assistants.md once written; the plan until then):
 *   - Lists return at most MAX_PAGE rows per call, with `total` and a `next_cursor`.
 *   - Every record carries `url`, a link to its page in Jigged (null when the request had no
 *     origin to build one from).
 *   - Nothing names a person against shop-floor work: no `completed_by`, no `sent_by`, no who-moved-
 *     the-stock. The surveillance guardrail (docs/modules/operator-view.md) covers assistants too.
 *   - Money the app shows admins only (the dashboard's totals, inventory cost) is returned to
 *     admins only. Prices on a quote or job are not: a salesperson sees those in the app.
 *     Neither are PURCHASING prices — a purchase order to a vendor's prices, totals and open
 *     value, price sheets, the Last PO price, the Shortages list's prices and what "Use as part cost"
 *     would set — which every office user sees (purchasing decision 3, plan §3.12). Inventory cost
 *     and stock value stay admin-only.
 *   - Text a person typed (notes, instructions, descriptions) is data, returned as written.
 *   - Archived records never appear in a list; the access functions filter `deleted_at`.
 */

export const DEFAULT_PAGE = 25;
export const MAX_PAGE = 50;

export const pageInput = {
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_PAGE)
    .optional()
    .describe(`How many to return, 1 to ${MAX_PAGE}. Defaults to ${DEFAULT_PAGE}.`),
  cursor: z.string().optional().describe('next_cursor from the previous page, to continue the list.'),
};

export const pageOutput = {
  total: z.number().describe('How many match, across every page.'),
  next_cursor: z.string().nullable().describe('Pass as `cursor` for the next page; null on the last page.'),
};

export interface Page<T> {
  items: T[];
  total: number;
  next_cursor: string | null;
}

export const BAD_CURSOR_MESSAGE = 'That cursor is not one this list returned. Start again without a cursor.';

/**
 * Cut one page from rows already filtered and sorted. The cursor is the offset of the next row,
 * so it is only meaningful against the same filters; a stale one returns a shifted page, never
 * another company's rows (RLS answered the query).
 */
export function paginate<T>(rows: T[], args: { limit?: number; cursor?: string }): Page<T> | null {
  const limit = Math.min(args.limit ?? DEFAULT_PAGE, MAX_PAGE);
  let offset = 0;
  if (args.cursor !== undefined) {
    if (!/^\d+$/.test(args.cursor)) return null;
    offset = Number(args.cursor);
  }
  const items = rows.slice(offset, offset + limit);
  const next = offset + items.length;
  return { items, total: rows.length, next_cursor: next < rows.length ? String(next) : null };
}

/** An absolute link to a page of this company in Jigged, or null without an origin. */
export function companyLink(env: CompanyToolEnv, path = ''): string | null {
  return env.link(`/dashboard/${env.company.id}${path}`);
}

export const urlOutput = z.string().nullable().describe('The page in Jigged.');

export const isAdmin = (env: CompanyToolEnv): boolean => env.company.role === 'admin';

/** Case-insensitive "contains" for the lists filtered in memory. */
export function matchesText(query: string | undefined, ...fields: Array<string | null | undefined>): boolean {
  const needle = query?.trim().toLowerCase();
  if (!needle) return true;
  return fields.some((f) => f?.toLowerCase().includes(needle));
}

export const addressOutput = z.object({
  address_line1: z.string().nullable(),
  address_line2: z.string().nullable(),
  city: z.string().nullable(),
  state: z.string().nullable(),
  postal_code: z.string().nullable(),
  country: z.string().nullable(),
  attention_to: z.string().nullable(),
});

export type AddressOut = z.infer<typeof addressOutput>;

export function addressOf(a: Partial<AddressOut> | null | undefined): AddressOut | null {
  if (!a) return null;
  return {
    address_line1: a.address_line1 ?? null,
    address_line2: a.address_line2 ?? null,
    city: a.city ?? null,
    state: a.state ?? null,
    postal_code: a.postal_code ?? null,
    country: a.country ?? null,
    attention_to: a.attention_to ?? null,
  };
}
