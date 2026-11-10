/**
 * Every page under `/dashboard/{companyId}/purchasing/…`, by route pattern, with its title.
 *
 * The slot after `orders` or `rfqs` is either a named page (`new`) or a record ID, and the code
 * that reads it cannot tell the difference by looking. So a page added without a line here does not
 * fail — it silently takes the hub's title, which is how `/parts/drawings` shipped calling itself
 * "Part Details" (see lib/partsSubroutes.ts, the precedent).
 *
 * Both title readers — `components/layout/Header.tsx` and `components/feedback/FeedbackDialog.tsx`
 * — import THIS, and `__tests__/lib/purchasingRoutes.test.ts` reads the routes off disk so a new
 * page without a title fails there. The path builders below are what every surface and every MCP
 * record `url` uses, so a link can only point at a pattern that has a page.
 */

/** Route pattern (relative to `/purchasing`, dynamic segments as named on disk) → page title. */
export const PURCHASING_PAGE_TITLES: Record<string, string> = {
  '': 'Purchasing',
  'orders/new': 'New Purchase Order',
  'orders/[poId]': 'Purchase Order',
  'rfqs/new': 'New RFQ',
  'rfqs/[rfqId]': 'RFQ',
};

/** The hub's tabs (`?view=`); an unknown value falls back to `orders`. */
export const PURCHASING_VIEWS = ['orders', 'receipts', 'to-buy', 'rfqs'] as const;
export type PurchasingView = (typeof PURCHASING_VIEWS)[number];

const HUB_TITLE = PURCHASING_PAGE_TITLES[''];

function isDynamic(segment: string): boolean {
  return segment.startsWith('[') && segment.endsWith(']');
}

/**
 * The title for a pathname under `/dashboard/{companyId}/purchasing`, or `null` when the path is
 * not a purchasing page (so the caller's other rules still apply). A named page always beats the
 * record slot beside it; anything else under /purchasing reads as the hub.
 */
export function purchasingPageTitle(pathname: string): string | null {
  const segments = pathname.split('?')[0].split('/').filter(Boolean);
  // /dashboard/{companyId}/purchasing/…
  if (segments[0] !== 'dashboard' || segments[2] !== 'purchasing') return null;
  const rest = segments.slice(3);
  const exact = PURCHASING_PAGE_TITLES[rest.join('/')];
  if (exact !== undefined) return exact;

  const patterns = Object.keys(PURCHASING_PAGE_TITLES).map((p) => (p === '' ? [] : p.split('/')));
  const staticSiblings = (depth: number, parent: string[]) =>
    new Set(
      patterns
        .filter((p) => p.length === depth + 1 && p.slice(0, depth).join('/') === parent.join('/') && !isDynamic(p[depth]))
        .map((p) => p[depth]),
    );
  for (const pattern of patterns) {
    if (pattern.length !== rest.length) continue;
    const matches = pattern.every((part, i) => {
      if (!isDynamic(part)) return part === rest[i];
      // A record slot never captures a sibling that is a named page.
      return !staticSiblings(i, rest.slice(0, i)).has(rest[i]);
    });
    if (matches) return PURCHASING_PAGE_TITLES[pattern.join('/')];
  }
  return HUB_TITLE;
}

/** `/dashboard/{companyId}/purchasing`, optionally on a tab. */
export function purchasingHubPath(companyId: string, view?: PurchasingView): string {
  const base = `/dashboard/${companyId}/purchasing`;
  return view ? `${base}?view=${view}` : base;
}

/** A vendor PO's page — or `new` for the create form. */
export function vendorPoPath(companyId: string, poId: string | 'new'): string {
  return `/dashboard/${companyId}/purchasing/orders/${poId}`;
}

/** An RFQ's page — or `new` for the create form. */
export function vendorRfqPath(companyId: string, rfqId: string | 'new'): string {
  return `/dashboard/${companyId}/purchasing/rfqs/${rfqId}`;
}
