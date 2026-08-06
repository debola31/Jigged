import { describe, it, expect, vi, beforeEach } from 'vitest';

// Focused coverage for the pinned-metric read path + the one-time "Overdue is
// now selectable" migration. Overdue Jobs used to be force-pinned outside the
// stored list; getPinnedMetricKeys now folds it into pre-existing prefs once
// (gated by a flag) so it stays visible but becomes removable.

const STATE: {
  user: { id: string } | null;
  storedPreferences: Record<string, unknown> | null;
  upserts: Array<{ preferences: Record<string, unknown> }>;
} = { user: { id: 'u1' }, storedPreferences: null, upserts: [] };

const mockSupabase = {
  auth: { getUser: vi.fn(async () => ({ data: { user: STATE.user } })) },
  from: vi.fn((table: string) => {
    if (table !== 'user_preferences') throw new Error(`unexpected table ${table}`);
    const builder: Record<string, unknown> = {};
    builder.select = vi.fn(() => builder);
    builder.eq = vi.fn(() => builder);
    builder.maybeSingle = vi.fn(async () => ({
      data: STATE.storedPreferences ? { preferences: STATE.storedPreferences } : null,
      error: null,
    }));
    builder.upsert = vi.fn(async (row: { preferences: Record<string, unknown> }) => {
      STATE.upserts.push(row);
      return { data: null, error: null };
    });
    return builder;
  }),
};

vi.mock('@/lib/supabase', () => ({
  getSupabase: () => mockSupabase,
}));

import {
  getPinnedMetricKeys,
  DEFAULT_PINNED_METRICS,
  PINNED_METRIC_SLOTS,
} from '@/utils/dashboardAccess';

// The read path fires setPinnedMetricKeys as fire-and-forget when it migrates;
// let those microtasks settle so we can assert on the persisted row.
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  vi.clearAllMocks();
  STATE.user = { id: 'u1' };
  STATE.storedPreferences = null;
  STATE.upserts = [];
});

describe('getPinnedMetricKeys — Overdue-selectable migration', () => {
  it('folds Overdue into the front of a pre-existing list (flag absent)', async () => {
    STATE.storedPreferences = {
      dashboard_pinned_metrics: ['open_quotes', 'not_started_jobs', 'in_progress_jobs'],
    };

    const keys = await getPinnedMetricKeys();

    expect(keys).toEqual([
      'overdue_jobs',
      'open_quotes',
      'not_started_jobs',
      'in_progress_jobs',
    ]);
    expect(keys.length).toBeLessThanOrEqual(PINNED_METRIC_SLOTS);
  });

  it('caps the folded list at the slot count', async () => {
    STATE.storedPreferences = {
      // Already 4 stored → folding Overdue in front must drop the last one.
      dashboard_pinned_metrics: ['open_quotes', 'not_started_jobs', 'in_progress_jobs', 'revenue'],
    };

    const keys = await getPinnedMetricKeys();

    expect(keys).toEqual(['overdue_jobs', 'open_quotes', 'not_started_jobs', 'in_progress_jobs']);
    expect(keys).toHaveLength(PINNED_METRIC_SLOTS);
  });

  it('does NOT re-add Overdue once the migration flag is set (deliberate removal sticks)', async () => {
    STATE.storedPreferences = {
      dashboard_pinned_metrics: ['open_quotes', 'not_started_jobs'],
      dashboard_overdue_selectable_migrated: true,
    };

    const keys = await getPinnedMetricKeys();

    expect(keys).toEqual(['open_quotes', 'not_started_jobs']);
    expect(keys).not.toContain('overdue_jobs');
  });

  it('leaves a list that already contains Overdue untouched (no duplicate)', async () => {
    STATE.storedPreferences = {
      dashboard_pinned_metrics: ['overdue_jobs', 'open_quotes'],
    };

    const keys = await getPinnedMetricKeys();

    expect(keys).toEqual(['overdue_jobs', 'open_quotes']);
  });

  it('persists the folded list AND stamps the migration flag', async () => {
    STATE.storedPreferences = {
      dashboard_pinned_metrics: ['open_quotes', 'not_started_jobs', 'in_progress_jobs'],
    };

    await getPinnedMetricKeys();
    await flush();

    expect(STATE.upserts).toHaveLength(1);
    const saved = STATE.upserts[0].preferences;
    expect(saved.dashboard_pinned_metrics).toEqual([
      'overdue_jobs',
      'open_quotes',
      'not_started_jobs',
      'in_progress_jobs',
    ]);
    expect(saved.dashboard_overdue_selectable_migrated).toBe(true);
  });

  it('returns defaults (which include Overdue) when no prefs are stored', async () => {
    STATE.storedPreferences = null;

    const keys = await getPinnedMetricKeys();

    expect(keys).toEqual(DEFAULT_PINNED_METRICS);
    expect(keys).toContain('overdue_jobs');
  });

  it('still migrates legacy keys while folding Overdue in', async () => {
    STATE.storedPreferences = {
      // weekly_revenue → revenue (legacy rename), overdue folded in front.
      dashboard_pinned_metrics: ['weekly_revenue', 'open_quotes'],
    };

    const keys = await getPinnedMetricKeys();

    expect(keys).toEqual(['overdue_jobs', 'revenue', 'open_quotes']);
  });
});
