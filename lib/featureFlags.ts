/**
 * Per-tenant feature flags stored in companies.settings (jsonb).
 *
 * Phase-1 shipments is rolled out to Contour only by setting
 * `settings.features.shipments = true` on that company's row. The DB
 * columns + triggers ship to every tenant (they're harmless when no
 * shipments exist), so the gate is UI + access-layer only.
 *
 * Toggle for Contour:
 *   UPDATE public.companies
 *      SET settings = jsonb_set(COALESCE(settings, '{}'::jsonb),
 *                               '{features,shipments}', 'true')
 *    WHERE id = '<contour-uuid>';
 *
 * Rollback:
 *   UPDATE public.companies
 *      SET settings = settings #- '{features,shipments}'
 *    WHERE id = '<contour-uuid>';
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
    key: 'shipments',
    label: 'Shipments',
    description:
      'Packing-slip generation, shipment history, and dual production / fulfillment status on jobs.',
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

export function isShipmentsEnabled(
  company: Pick<Company, 'settings'> | null | undefined,
): boolean {
  return readFeatureFlag(company, 'shipments');
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
