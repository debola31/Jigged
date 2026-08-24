/**
 * Per-tenant feature flags stored in companies.settings (jsonb).
 *
 * A flag gates a feature to specific tenants by setting `settings.features.<key>` on that
 * company's row (UI + access-layer gate; DB columns/triggers ship to everyone). Shipments and
 * invoicing used to be gated this way; they're now core (always on) and their flags were removed.
 *
 * A flag can be opt-IN (default off) for a pilot that must run at named shops only, or opt-OUT
 * (default on) via `defaultEnabled: true` — a GA feature that ships enabled everywhere but needs
 * a per-tenant kill-switch. An opt-out flag stays on until a company's row explicitly stores the
 * key as `false`.
 *
 * **Both flags in the registry are currently opt-OUT.** The opt-in form is still supported and
 * still tested; there is simply no live instance since the `machine_maintenance` and
 * `quickbooks_desktop` pilots were retired into core.
 *
 * Kill an opt-OUT flag for one tenant — note this stores an explicit `false`, it does not
 * delete the key:
 *   UPDATE public.companies
 *      SET settings = jsonb_set(COALESCE(settings, '{}'::jsonb),
 *                               '{features,dashboard_revenue}', 'false')
 *    WHERE id = '<company-uuid>';
 *
 * Restore it:
 *   UPDATE public.companies
 *      SET settings = settings #- '{features,dashboard_revenue}'
 *    WHERE id = '<company-uuid>';
 *
 * Mind the direction: on an opt-OUT flag DELETING the key restores the default, which means
 * turning the feature back ON. On an opt-IN flag the two statements swap meaning. Reach for the
 * registry, not memory, before writing either.
 */

import type { Company } from '@/utils/companyAccess';

interface SettingsLike {
  settings?: Record<string, unknown> | null | undefined;
}

/**
 * Registry of feature-flag keys recognized by the app.
 *
 * The /admin/companies feature-flag editor renders one toggle per entry.
 * Adding a new flag adds a row here once; the UI and the
 * `isFeatureEnabled` helper both read from this list.
 */
export interface FeatureFlagDescriptor {
  key: string;
  label: string;
  description: string;
  /**
   * State to assume when a company has no explicit value for this key.
   * Omit (or `false`) for opt-in pilot flags. Set `true` for a GA feature
   * that ships on for everyone but needs a per-tenant kill-switch — it then
   * reads enabled unless the company row explicitly stores `false`.
   */
  defaultEnabled?: boolean;
}

/**
 * `as const` — not a `readonly FeatureFlagDescriptor[]` annotation — so that `KnownFeatureKey`
 * below resolves to a UNION of the literal keys rather than to plain `string`.
 *
 * That distinction is the difference between a compiler error and a silent bug. Under the old
 * annotation, `useCompanyFeatures().features` was `Record<string, boolean>`, so a call site left
 * behind after a flag was retired — `features.machine_maintenance` — kept compiling, evaluated to
 * `undefined`, and PERMANENTLY HID the feature it was meant to release. Retiring three flags at
 * once (Aug 2026) meant eleven such reads; none of them was type-checked. Now every one is.
 */
export const KNOWN_FEATURES = [
  {
    key: 'ai_insights',
    label: 'AI Insights',
    description:
      'Dashboard ask-bar (natural-language questions about shop data) and the saved-charts section. On by default; turning it off hides the AI area and blocks the chat endpoint for this tenant.',
    // GA feature with a kill-switch: enabled unless explicitly turned off.
    defaultEnabled: true,
  },
  {
    key: 'dashboard_revenue',
    label: 'Dashboard Revenue',
    description:
      'The money lines on the dashboard scorecards — the amount under each count ("$18,006 not yet shipped", "$12,480 shipped this week") and the Completed card\'s period-over-period delta. Counts, the Open Jobs split and every drill-down stay visible whatever the flag says. On by default; turning it off leaves a shop with counts only, for an owner who does not want the whole book totalled on a screen other people walk past. Composes with the existing admin-only rule — a non-admin never sees the money either way.',
    // Opt-OUT rather than opt-in, deliberately: these figures exist for every admin today, so
    // shipping this opt-in would have silently removed a live feature from every tenant and
    // needed a backfill to undo. A kill-switch changes nothing until someone asks for it.
    defaultEnabled: true,
  },
] as const;

/**
 * Widened view of the registry, for the code that reads `defaultEnabled`.
 *
 * `as const` narrows each entry to its own literal shape, and a literal that OMITS the optional
 * `defaultEnabled` has no such property to read — so `f.defaultEnabled` is an error on an opt-in
 * entry. Assigning to the interface type (a checked widening, not a cast) restores the optional
 * property without giving up the key union above.
 */
const DESCRIPTORS: readonly FeatureFlagDescriptor[] = KNOWN_FEATURES;

export type KnownFeatureKey = (typeof KNOWN_FEATURES)[number]['key'];

/**
 * Read one flag. `defaultEnabled` is returned when the company has no explicit
 * value (missing settings, missing features block, or missing key) — an
 * explicit stored `false` always wins over an opt-out default.
 */
function readFeatureFlag(
  company: SettingsLike | null | undefined,
  feature: string,
  defaultEnabled = false,
): boolean {
  if (!company?.settings) return defaultEnabled;
  const settings = company.settings as Record<string, unknown>;
  const features = settings.features as Record<string, unknown> | undefined;
  if (!features) return defaultEnabled;
  const value = features[feature];
  if (value === undefined || value === null) return defaultEnabled;
  return value === true || value === 'true';
}

/**
 * Generic flag check for a single key, honoring the registry's `defaultEnabled`.
 *
 * Server-side / one-off use. The live client path is `readCompanyFeatures` via
 * `useCompanyFeatures()`, which resolves the whole map in one pass — a component asking about one
 * flag through this function would still have had to fetch the company row itself.
 *
 * NOTE there is deliberately no named `isDashboardRevenueEnabled` beside `isAiInsightsEnabled`.
 * A named helper hardcodes its own default (see the warning on that one), which is a divergence
 * only a test can catch; the registry-driven path cannot diverge from the registry. The two
 * helpers retired with their flags in Aug 2026 had no production caller at all.
 */
export function isFeatureEnabled(
  company: SettingsLike | null | undefined,
  feature: string,
): boolean {
  const descriptor = DESCRIPTORS.find((f) => f.key === feature);
  return readFeatureFlag(company, feature, descriptor?.defaultEnabled ?? false);
}

/**
 * AI Insights is opt-OUT: enabled for every tenant unless their company row
 * explicitly sets settings.features.ai_insights = false.
 *
 * The `true` here is not decoration — this helper carries its OWN default rather than reading the
 * descriptor, so flipping `defaultEnabled` in the registry without changing this line would leave
 * `isFeatureEnabled()` and this function disagreeing about the same flag. The parity test in
 * `__tests__/lib/featureFlags.test.ts` is what catches that. It is also why no second helper was
 * written for `dashboard_revenue`.
 */
export function isAiInsightsEnabled(
  company: Pick<Company, 'settings'> | null | undefined,
): boolean {
  return readFeatureFlag(company, 'ai_insights', true);
}

/**
 * Read the full feature-flag state for a company. Returns a dense map
 * keyed by KNOWN_FEATURES entries — anything unknown to the registry is
 * dropped on read. Each key resolves against its descriptor's default, so
 * opt-out flags (ai_insights) report `true` unless explicitly disabled.
 */
export function readCompanyFeatures(
  company: SettingsLike | null | undefined,
): Record<KnownFeatureKey, boolean> {
  const out = {} as Record<KnownFeatureKey, boolean>;
  for (const f of DESCRIPTORS) {
    out[f.key as KnownFeatureKey] = readFeatureFlag(company, f.key, f.defaultEnabled ?? false);
  }
  return out;
}
