import { describe, it, expect } from 'vitest';
import {
  isAiInsightsEnabled,
  isFeatureEnabled,
  readCompanyFeatures,
  KNOWN_FEATURES,
} from '@/lib/featureFlags';

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

  /**
   * The descriptor and the named helper are two places that each carry the default. This asserts
   * they agree — `isAiInsightsEnabled` hardcodes its own rather than reading the registry, so
   * flipping only one of them is a silent, one-line divergence.
   *
   * It is also the whole reason no second named helper was written for `dashboard_revenue`: the
   * registry-driven path cannot diverge from the registry, so it needs no test to keep it honest.
   */
  it('agrees with the generic registry-driven check', () => {
    const noneSet = { settings: { features: {} } };
    expect(isFeatureEnabled(noneSet, 'ai_insights')).toBe(isAiInsightsEnabled(noneSet));
    const off = { settings: { features: { ai_insights: false } } };
    expect(isFeatureEnabled(off, 'ai_insights')).toBe(isAiInsightsEnabled(off));
  });
});

describe('featureFlags: dashboard_revenue (opt-out / default-on)', () => {
  it('is registered in KNOWN_FEATURES (so /admin/companies renders a toggle)', () => {
    expect(KNOWN_FEATURES.map((f) => f.key)).toContain('dashboard_revenue');
  });

  /**
   * Opt-OUT, not opt-in, and the direction is the whole decision. The scorecard money lines
   * already existed for every admin, so shipping this opt-in would have removed a live feature
   * from every tenant on deploy and needed a backfill to put it back. A kill-switch changes
   * nothing until a shop asks.
   */
  it('is registered with defaultEnabled true', () => {
    const descriptor = KNOWN_FEATURES.find((f) => f.key === 'dashboard_revenue');
    expect(descriptor?.defaultEnabled).toBe(true);
  });

  it('defaults ON when the company has no explicit value', () => {
    expect(isFeatureEnabled({ settings: { features: {} } }, 'dashboard_revenue')).toBe(true);
    expect(isFeatureEnabled({ settings: {} }, 'dashboard_revenue')).toBe(true);
    expect(isFeatureEnabled(null, 'dashboard_revenue')).toBe(true);
    expect(isFeatureEnabled(undefined, 'dashboard_revenue')).toBe(true);
  });

  it('stays ON for an explicit true (boolean or "true")', () => {
    expect(
      isFeatureEnabled({ settings: { features: { dashboard_revenue: true } } }, 'dashboard_revenue'),
    ).toBe(true);
    expect(
      isFeatureEnabled(
        { settings: { features: { dashboard_revenue: 'true' } } },
        'dashboard_revenue',
      ),
    ).toBe(true);
  });

  it('turns OFF only when explicitly disabled', () => {
    expect(
      isFeatureEnabled(
        { settings: { features: { dashboard_revenue: false } } },
        'dashboard_revenue',
      ),
    ).toBe(false);
  });

  it('is independent of the other flag', () => {
    const aiOff = { settings: { features: { ai_insights: false } } };
    expect(isFeatureEnabled(aiOff, 'dashboard_revenue')).toBe(true);
    const revenueOff = { settings: { features: { dashboard_revenue: false } } };
    expect(isAiInsightsEnabled(revenueOff)).toBe(true);
  });
});

describe('featureFlags: the registry itself', () => {
  it('readCompanyFeatures returns a dense map resolved against each default', () => {
    const noneSet = readCompanyFeatures({ settings: { features: {} } });
    expect(noneSet).toEqual({ ai_insights: true, dashboard_revenue: true });

    const bothOff = readCompanyFeatures({
      settings: { features: { ai_insights: false, dashboard_revenue: false } },
    });
    expect(bothOff).toEqual({ ai_insights: false, dashboard_revenue: false });
  });

  it('readCompanyFeatures drops keys the registry does not know', () => {
    // This is the only thing that makes a retired key inert in a company row that still carries
    // it — there is no server-side allowlist on the /admin save path.
    const withStale = readCompanyFeatures({
      settings: { features: { machine_maintenance: true, some_other_flag: true } },
    });
    expect(withStale).not.toHaveProperty('machine_maintenance');
    expect(withStale).not.toHaveProperty('some_other_flag');
  });

  /**
   * An unregistered key defaults OFF through the generic check — the opt-in default is still the
   * code path a future pilot flag will take, even though no registered flag uses it today.
   */
  it('an unregistered key reads false (the opt-in default path is still live)', () => {
    expect(isFeatureEnabled({ settings: { features: {} } }, 'not_a_real_flag')).toBe(false);
    expect(isFeatureEnabled({ settings: { features: { not_a_real_flag: true } } }, 'not_a_real_flag')).toBe(true);
  });

  /**
   * Retired flags must not come back by accident.
   *
   * Every one of these was a real registry entry whose feature is now core and unconditional.
   * Re-adding a key here would silently re-gate a shipped feature — and because the removal was
   * type-silent before `KNOWN_FEATURES` became `as const`, a resurrected key is exactly the shape
   * of bug that took eleven hand-checked call sites to avoid the first time.
   */
  it('retired flags are not registered (their features are core / always-on now)', () => {
    const keys = KNOWN_FEATURES.map((f) => f.key);
    for (const retired of [
      'shipments',
      'data_import',
      'inventory_locations',
      'machine_maintenance',
      'quickbooks_desktop',
    ]) {
      expect(keys).not.toContain(retired);
    }
  });

  /**
   * `KnownFeatureKey` must stay a literal union, not `string`.
   *
   * This is a TYPE guarantee asserted at runtime as the closest available proxy: the union only
   * holds if `KNOWN_FEATURES` keeps its `as const` and gains no widening annotation. Under the old
   * `: readonly FeatureFlagDescriptor[]` annotation the key type collapsed to `string`, so a call
   * site left behind after a flag was retired compiled fine, read `undefined`, and permanently hid
   * the feature it was meant to release.
   */
  it('every registry key is a non-empty snake_case string', () => {
    expect(KNOWN_FEATURES.length).toBeGreaterThan(0);
    for (const f of KNOWN_FEATURES) {
      expect(f.key).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(f.label.length).toBeGreaterThan(0);
      expect(f.description.length).toBeGreaterThan(0);
    }
  });
});
