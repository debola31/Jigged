/**
 * Per-tenant feature flags stored in companies.settings (jsonb).
 *
 * A flag gates a not-yet-general feature to specific tenants by setting
 * `settings.features.<key> = true` on that company's row (UI + access-layer
 * gate; DB columns/triggers ship to everyone). Shipments + invoicing used to
 * be gated this way; they're now core (always on) and the flag was removed —
 * `inventory_locations` is the remaining opt-in example.
 *
 * Most flags are opt-IN (default off): a company must be explicitly enabled.
 * A flag can instead be opt-OUT (default on) via `defaultEnabled: true` on its
 * descriptor — for a GA feature that ships enabled everywhere but needs a
 * per-tenant kill-switch (e.g. `ai_insights`). An opt-out flag stays on until
 * a company's row explicitly stores the key as `false`.
 *
 * Toggle for a pilot tenant:
 *   UPDATE public.companies
 *      SET settings = jsonb_set(COALESCE(settings, '{}'::jsonb),
 *                               '{features,inventory_locations}', 'true')
 *    WHERE id = '<pilot-company-uuid>';
 *
 * Rollback:
 *   UPDATE public.companies
 *      SET settings = settings #- '{features,inventory_locations}'
 *    WHERE id = '<pilot-company-uuid>';
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

export const KNOWN_FEATURES: readonly FeatureFlagDescriptor[] = [
  {
    key: 'inventory_locations',
    label: 'Inventory Locations',
    description:
      'QR-addressable storage locations with per-location stock: the Locations manager + visual builder, per-part location tracking, and bin scanning. The base inventory list is unaffected.',
  },
  {
    key: 'ai_insights',
    label: 'AI Insights',
    description:
      'Dashboard ask-bar (natural-language questions about shop data) and the saved-charts section. On by default; turning it off hides the AI area and blocks the chat endpoint for this tenant.',
    // GA feature with a kill-switch: enabled unless explicitly turned off.
    defaultEnabled: true,
  },
  {
    key: 'data_import',
    label: 'Data import',
    description:
      'Guided data importer for onboarding: upload legacy ERP CSV exports, review what will come in and what to fix (record counts, duplicates, orphan references, gaps) plus a best-effort source-ERP guess, then import. Opt-in per tenant while onboarding.',
  },
] as const;

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
 * Generic flag check. Honors the registry's `defaultEnabled`, so opt-out flags
 * read correctly. Prefer the named helpers below at call sites — they encode
 * the contract that the feature key is known to the registry.
 */
export function isFeatureEnabled(
  company: SettingsLike | null | undefined,
  feature: string,
): boolean {
  const descriptor = KNOWN_FEATURES.find((f) => f.key === feature);
  return readFeatureFlag(company, feature, descriptor?.defaultEnabled ?? false);
}

export function isInventoryLocationsEnabled(
  company: Pick<Company, 'settings'> | null | undefined,
): boolean {
  return readFeatureFlag(company, 'inventory_locations');
}

/**
 * Data import is opt-IN: off unless the company row explicitly sets
 * settings.features.data_import = true (enabled per tenant while onboarding).
 */
export function isDataImportEnabled(
  company: Pick<Company, 'settings'> | null | undefined,
): boolean {
  return readFeatureFlag(company, 'data_import');
}

/**
 * AI Insights is opt-OUT: enabled for every tenant unless their company row
 * explicitly sets settings.features.ai_insights = false.
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
  for (const f of KNOWN_FEATURES) {
    out[f.key] = readFeatureFlag(company, f.key, f.defaultEnabled ?? false);
  }
  return out;
}
