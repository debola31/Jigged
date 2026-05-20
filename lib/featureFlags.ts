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

export function isShipmentsEnabled(
  company: Pick<Company, 'settings'> | null | undefined,
): boolean {
  return readFeatureFlag(company, 'shipments');
}
