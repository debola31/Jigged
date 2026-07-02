/**
 * Per-tenant feature flags stored in companies.settings (jsonb).
 *
 * A flag gates a not-yet-general feature to specific tenants by setting
 * `settings.features.<key> = true` on that company's row (UI + access-layer
 * gate; DB columns/triggers ship to everyone). Shipments + invoicing used to
 * be gated this way; they're now core (always on) and the flag was removed —
 * `inventory_locations` is the remaining example.
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
}

export const KNOWN_FEATURES: readonly FeatureFlagDescriptor[] = [
  {
    key: 'inventory_locations',
    label: 'Inventory Locations',
    description:
      'QR-addressable storage locations with per-location stock: the Locations manager + visual builder, per-part location tracking, and bin scanning. The base inventory list is unaffected.',
  },
] as const;

export type KnownFeatureKey = (typeof KNOWN_FEATURES)[number]['key'];

function readFeatureFlag(
  company: SettingsLike | null | undefined,
  feature: string,
): boolean {
  if (!company?.settings) return false;
  const settings = company.settings as Record<string, unknown>;
  const features = settings.features as Record<string, unknown> | undefined;
  if (!features) return false;
  const value = features[feature];
  return value === true || value === 'true';
}

/**
 * Generic flag check. Prefer the named helpers below at call sites — they
 * encode the contract that the feature key is known to the registry.
 */
export function isFeatureEnabled(
  company: SettingsLike | null | undefined,
  feature: string,
): boolean {
  return readFeatureFlag(company, feature);
}

export function isInventoryLocationsEnabled(
  company: Pick<Company, 'settings'> | null | undefined,
): boolean {
  return readFeatureFlag(company, 'inventory_locations');
}

/**
 * Read the full feature-flag state for a company. Returns a dense map
 * keyed by KNOWN_FEATURES entries — anything unknown to the registry is
 * dropped on read.
 */
export function readCompanyFeatures(
  company: SettingsLike | null | undefined,
): Record<KnownFeatureKey, boolean> {
  const out = {} as Record<KnownFeatureKey, boolean>;
  for (const f of KNOWN_FEATURES) {
    out[f.key] = readFeatureFlag(company, f.key);
  }
  return out;
}
