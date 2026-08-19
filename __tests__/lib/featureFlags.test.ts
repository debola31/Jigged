import { describe, it, expect } from 'vitest';
import {
  isAiInsightsEnabled,
  isFeatureEnabled,
  isInventoryLocationsEnabled,
  isMachineMaintenanceEnabled,
  readCompanyFeatures,
  KNOWN_FEATURES,
} from '@/lib/featureFlags';

describe('featureFlags: inventory_locations (opt-out / default-on)', () => {
  it('is registered in KNOWN_FEATURES (so /admin/companies renders a toggle)', () => {
    expect(KNOWN_FEATURES.map((f) => f.key)).toContain('inventory_locations');
  });

  it('is registered with defaultEnabled true', () => {
    const descriptor = KNOWN_FEATURES.find((f) => f.key === 'inventory_locations');
    expect(descriptor?.defaultEnabled).toBe(true);
  });

  /**
   * Storage went GA when `is_stocked` was dropped: Parts gave up its On hand / Status columns
   * and the Count Inventory button in the same change, so leaving this opt-in would have moved
   * counting somewhere most tenants could not reach.
   */
  it('defaults ON when the company has no explicit value', () => {
    expect(isInventoryLocationsEnabled({ settings: { features: {} } })).toBe(true);
    expect(isInventoryLocationsEnabled({ settings: {} })).toBe(true);
    expect(isInventoryLocationsEnabled(null)).toBe(true);
    expect(isInventoryLocationsEnabled(undefined)).toBe(true);
  });

  it('stays ON for an explicit true (boolean or "true")', () => {
    expect(isInventoryLocationsEnabled({ settings: { features: { inventory_locations: true } } })).toBe(true);
    expect(isInventoryLocationsEnabled({ settings: { features: { inventory_locations: 'true' } } })).toBe(true);
  });

  it('turns OFF only when explicitly disabled', () => {
    expect(isInventoryLocationsEnabled({ settings: { features: { inventory_locations: false } } })).toBe(false);
  });

  it('is independent of other flags', () => {
    const otherOnly = { settings: { features: { some_other_flag: true } } };
    expect(isInventoryLocationsEnabled(otherOnly)).toBe(true);
  });

  /**
   * The descriptor and the named helper are two places that each carry the default. This asserts
   * they agree — `isInventoryLocationsEnabled` hardcodes its own rather than reading the
   * registry, so flipping only one of them is a silent, one-line divergence.
   */
  it('agrees with the generic registry-driven check', () => {
    const noneSet = { settings: { features: {} } };
    expect(isFeatureEnabled(noneSet, 'inventory_locations')).toBe(
      isInventoryLocationsEnabled(noneSet),
    );
    const off = { settings: { features: { inventory_locations: false } } };
    expect(isFeatureEnabled(off, 'inventory_locations')).toBe(isInventoryLocationsEnabled(off));
  });

  it('readCompanyFeatures includes the new key', () => {
    const features = readCompanyFeatures({ settings: { features: { inventory_locations: true } } });
    expect(features.inventory_locations).toBe(true);
  });

  it('shipments is no longer a feature flag (now core / always-on)', () => {
    expect(KNOWN_FEATURES.map((f) => f.key)).not.toContain('shipments');
  });
});

describe('featureFlags: ai_insights (opt-out / default-on)', () => {
  it('is registered with defaultEnabled true (renders a toggle, defaults on)', () => {
    const descriptor = KNOWN_FEATURES.find((f) => f.key === 'ai_insights');
    expect(descriptor).toBeDefined();
    expect(descriptor?.defaultEnabled).toBe(true);
  });

  it('defaults ON when the company has no explicit value', () => {
    // Missing key, missing features block, missing settings, and null/undefined
    // company all read as enabled — this is a GA feature with a kill-switch.
    expect(isAiInsightsEnabled({ settings: { features: {} } })).toBe(true);
    expect(isAiInsightsEnabled({ settings: {} })).toBe(true);
    expect(isAiInsightsEnabled(null)).toBe(true);
    expect(isAiInsightsEnabled(undefined)).toBe(true);
  });

  it('stays ON for an explicit true (boolean or "true")', () => {
    expect(isAiInsightsEnabled({ settings: { features: { ai_insights: true } } })).toBe(true);
    expect(isAiInsightsEnabled({ settings: { features: { ai_insights: 'true' } } })).toBe(true);
  });

  it('turns OFF only when explicitly disabled', () => {
    expect(isAiInsightsEnabled({ settings: { features: { ai_insights: false } } })).toBe(false);
  });

  it('readCompanyFeatures reflects the opt-out default without leaking to opt-in flags', () => {
    const noneSet = readCompanyFeatures({ settings: { features: {} } });
    expect(noneSet.ai_insights).toBe(true); // opt-out default on
    expect(noneSet.machine_maintenance).toBe(false); // opt-in default off, unaffected

    const disabled = readCompanyFeatures({ settings: { features: { ai_insights: false } } });
    expect(disabled.ai_insights).toBe(false);
  });
});

describe('featureFlags: machine_maintenance (opt-in pilot flag)', () => {
  it('is registered in KNOWN_FEATURES with no defaultEnabled', () => {
    // The module is an experiment with a written kill criterion, so it must be
    // on at exactly the shops whose behaviour is being measured. An opt-out
    // default would silently widen the sample and make the result unreadable.
    const descriptor = KNOWN_FEATURES.find((f) => f.key === 'machine_maintenance');
    expect(descriptor).toBeDefined();
    expect(descriptor?.defaultEnabled).toBeUndefined();
  });

  it('reads settings.features.machine_maintenance (boolean or "true"), defaulting off', () => {
    expect(isMachineMaintenanceEnabled({ settings: { features: { machine_maintenance: true } } })).toBe(true);
    expect(isMachineMaintenanceEnabled({ settings: { features: { machine_maintenance: 'true' } } })).toBe(true);
    expect(isMachineMaintenanceEnabled({ settings: { features: {} } })).toBe(false);
    expect(isMachineMaintenanceEnabled(null)).toBe(false);
    expect(isMachineMaintenanceEnabled(undefined)).toBe(false);
  });

  it('readCompanyFeatures includes the key', () => {
    expect(
      readCompanyFeatures({ settings: { features: { machine_maintenance: true } } }).machine_maintenance,
    ).toBe(true);
  });
});
