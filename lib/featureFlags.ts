/**
 * Per-tenant feature flags stored in companies.settings (jsonb).
 *
 * A flag gates a not-yet-general feature to specific tenants by setting
 * `settings.features.<key> = true` on that company's row (UI + access-layer
 * gate; DB columns/triggers ship to everyone). Shipments + invoicing used to
 * be gated this way; they're now core (always on) and the flag was removed.
 *
 * Most flags are opt-IN (default off): a company must be explicitly enabled.
 * A flag can instead be opt-OUT (default on) via `defaultEnabled: true` on its
 * descriptor — for a GA feature that ships enabled everywhere but needs a
 * per-tenant kill-switch (e.g. `ai_insights`). An opt-out flag stays on until
 * a company's row explicitly stores the key as `false`.
 *
 * Toggle for a pilot tenant (an opt-IN flag — `machine_maintenance` here):
 *   UPDATE public.companies
 *      SET settings = jsonb_set(COALESCE(settings, '{}'::jsonb),
 *                               '{features,machine_maintenance}', 'true')
 *    WHERE id = '<pilot-company-uuid>';
 *
 * Rollback:
 *   UPDATE public.companies
 *      SET settings = settings #- '{features,machine_maintenance}'
 *    WHERE id = '<pilot-company-uuid>';
 *
 * Mind the direction on an opt-OUT flag: DELETING the key restores the default, which for
 * `inventory_locations` or `ai_insights` means turning the feature back ON. Killing one of those
 * for a tenant means storing an explicit `'false'`, not removing the key.
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
      'Storage: QR-addressable locations with per-location stock — the Locations manager + visual builder, the operator Inventory tab, and bin scanning. On by default; turning it off hides Storage for this tenant but does not change where stock lives (every part has a place regardless).',
    // GA with a kill-switch, as of the is_stocked removal. Two reasons it stopped being opt-in:
    // the pilot gate had already lost its meaning (20260802015837 removed the flag check from
    // the seeding trigger, so every company has an Unassigned bucket and balance rows whether
    // or not this is on — the flag governs only whether a shop MANAGES places), and Parts gave
    // up its On hand / Status columns and Count Inventory button in the same change. Leaving
    // this off by default would have moved those workflows somewhere most tenants cannot reach.
    defaultEnabled: true,
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
  {
    key: 'machine_maintenance',
    label: 'Machine Maintenance',
    description:
      'A maintenance logbook per machine, written by whoever is standing at it: a Maintenance tab on the operator view once a station is selected, with optional machine details and manuals, plus a read-only log on the work-center page. One pilot shop at a time — see docs/modules/machine-maintenance.md.',
  },
  {
    key: 'quickbooks_desktop',
    label: 'QuickBooks Desktop',
    description:
      'Connect a locally installed QuickBooks Desktop (via Conductor) instead of QuickBooks Online, and push invoices to it. A company connects one or the other, never both. Opt-in per tenant: Conductor bills per connected company file, so this flag gates the backend connect endpoint and not just the UI — see docs/modules/quickbooks-desktop.md.',
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

/**
 * Storage is opt-OUT: enabled for every tenant unless their company row explicitly sets
 * settings.features.inventory_locations = false.
 *
 * The `true` here is not decoration — this helper takes its own default rather than reading
 * the descriptor, so adding `defaultEnabled: true` to KNOWN_FEATURES without changing this line
 * would leave `isFeatureEnabled()` and this function disagreeing about the same flag.
 */
export function isInventoryLocationsEnabled(
  company: Pick<Company, 'settings'> | null | undefined,
): boolean {
  return readFeatureFlag(company, 'inventory_locations', true);
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
 * Machine Maintenance is opt-IN, and stays that way through the pilot: the
 * module is an experiment with a written kill criterion, so it must be on at
 * exactly the shops whose behaviour is being measured and nowhere else.
 */
export function isMachineMaintenanceEnabled(
  company: Pick<Company, 'settings'> | null | undefined,
): boolean {
  return readFeatureFlag(company, 'machine_maintenance');
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
