/**
 * Attaches the current company to every PostHog event.
 *
 * WHY NOT `posthog.register()`, WHICH IS THE OBVIOUS API FOR THIS.
 * Super properties are written to localStorage and, in PostHog's own words,
 * "persisted across sessions so you have to explicitly remove them if they are
 * no longer relevant". One Jigged user can hold access to several companies and
 * switch between them without signing out — which already happens in production
 * data. A registered company would keep labelling events with whichever company
 * was registered last, silently, until something re-registered it. The URL
 * cannot go stale that way, so the URL is the source of truth here.
 *
 * WHY NOT GROUP ANALYTICS, WHICH IS THE CANONICAL B2B ANSWER. It is a paid
 * add-on, unavailable on the free plan we are on, and subscribing changes the
 * billing basis for *all* identified events in the project, not just grouped
 * ones. Revisit when we want company-level funnels and retention rather than
 * readable breakdowns — roughly when there are enough accounts for a percentage
 * to mean something. Until then this costs nothing and answers the same
 * segmentation question.
 *
 * THE NAME IS ENRICHMENT, THE ID IS THE CONTRACT. `company_id` is derived from
 * the path on every event and is always correct. `company_name` comes from a
 * module-level value the app sets as it resolves, so it can briefly lag a
 * navigation — which is why it is only attached when its id matches the id in
 * the URL. A mismatch drops the name rather than shipping a wrong one.
 */

/** What the app last told us about the company it is displaying. */
let known: { id: string; name: string } | null = null;

/**
 * Called by the app when it knows which company is on screen. Pass `null` on
 * sign-out or when leaving a company-scoped area.
 */
export function setAnalyticsCompany(company: { id: string; name: string } | null): void {
  known = company;
}

/** Test seam — resets the module-level value between cases. */
export function __resetAnalyticsCompany(): void {
  known = null;
}

/**
 * Every app route is company-scoped (`/dashboard/{id}/…`, `/operator/{id}/…`),
 * which is what makes the path trustworthy. Signed-out and pre-selection routes
 * (`/login`, `/select-company`, `/accept-invite/…`) have no company and get
 * nothing rather than a placeholder — an absent property is honest, a
 * placeholder becomes a fake row in every breakdown.
 */
const COMPANY_PATH = /^\/(?:dashboard|operator)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/|$)/i;

export function companyIdFromPath(pathname: string): string | null {
  return COMPANY_PATH.exec(pathname)?.[1]?.toLowerCase() ?? null;
}

export interface CompanyProperties {
  company_id?: string;
  company_name?: string;
}

/**
 * Pure core, exported for tests. `pathname` is passed in rather than read from
 * `window` so this stays testable and usable outside the browser.
 */
export function companyProperties(pathname: string): CompanyProperties {
  const id = companyIdFromPath(pathname);
  if (!id) return {};
  // Only trust the cached name when it belongs to the company we are actually
  // looking at. Mid-navigation the two disagree, and a wrong name is worse
  // than none: it silently attributes one customer's behaviour to another.
  return known?.id === id ? { company_id: id, company_name: known.name } : { company_id: id };
}

/**
 * posthog-js `before_send`. Runs on EVERY event including `$autocapture` and
 * `$pageview`, which is the point — a per-call-site property would miss exactly
 * the high-volume events we most want to segment. Returning the event unchanged
 * (never null) so this can never drop one.
 */
export function withCompany<T extends { properties?: Record<string, unknown> } | null>(
  event: T,
): T {
  if (!event || typeof window === 'undefined') return event;
  const props = companyProperties(window.location.pathname);
  if (props.company_id) {
    event.properties = { ...event.properties, ...props };
  }
  return event;
}
