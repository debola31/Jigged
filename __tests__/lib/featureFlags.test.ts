import { describe, it, expect } from 'vitest';
import {
  isAiInsightsEnabled,
  isInventoryLocationsEnabled,
  isMachineMaintenanceEnabled,
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
    expect(noneSet.inventory_locations).toBe(false); // opt-in default off, unaffected

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
