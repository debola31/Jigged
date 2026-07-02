import { describe, it, expect } from 'vitest';
import {
  isInventoryLocationsEnabled,
  readCompanyFeatures,
  KNOWN_FEATURES,
} from '@/lib/featureFlags';

describe('featureFlags: inventory_locations', () => {
  it('is registered in KNOWN_FEATURES (so /admin/companies renders a toggle)', () => {
    expect(KNOWN_FEATURES.map((f) => f.key)).toContain('inventory_locations');
  });

  it('reads settings.features.inventory_locations (boolean or "true")', () => {
    expect(isInventoryLocationsEnabled({ settings: { features: { inventory_locations: true } } })).toBe(true);
    expect(isInventoryLocationsEnabled({ settings: { features: { inventory_locations: 'true' } } })).toBe(true);
    expect(isInventoryLocationsEnabled({ settings: { features: {} } })).toBe(false);
    expect(isInventoryLocationsEnabled({ settings: {} })).toBe(false);
    expect(isInventoryLocationsEnabled(null)).toBe(false);
    expect(isInventoryLocationsEnabled(undefined)).toBe(false);
  });

  it('defaults OFF and is independent of other flags', () => {
    const otherOnly = { settings: { features: { some_other_flag: true } } };
    expect(isInventoryLocationsEnabled(otherOnly)).toBe(false);
  });

  it('readCompanyFeatures includes the new key', () => {
    const features = readCompanyFeatures({ settings: { features: { inventory_locations: true } } });
    expect(features.inventory_locations).toBe(true);
  });

  it('shipments is no longer a feature flag (now core / always-on)', () => {
    expect(KNOWN_FEATURES.map((f) => f.key)).not.toContain('shipments');
  });
});
