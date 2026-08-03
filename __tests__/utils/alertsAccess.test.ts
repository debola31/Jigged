import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Narrow on purpose: this covers the BOUND added for the max_rows truncation, not the severity
 * rules, which were already working and are exercised through the badge.
 */
const { state, mockSupabase } = vi.hoisted(() => {
  const s: { data: unknown; error: unknown; calls: Record<string, unknown[]> } = {
    data: [],
    error: null,
    calls: {},
  };
  const builder: Record<string, unknown> = {};
  ['select', 'eq', 'is', 'not', 'order', 'limit'].forEach((m) => {
    builder[m] = vi.fn((...args: unknown[]) => {
      s.calls[m] = args;
      return builder;
    });
  });
  builder.then = (resolve: (v: unknown) => unknown) => resolve({ data: s.data, error: s.error });
  return { state: s, mockSupabase: { from: vi.fn(() => builder) } };
});

vi.mock('@/lib/supabase', () => ({
  getSupabase: () => mockSupabase,
  getTypedSupabase: () => mockSupabase,
}));

import { getLowStockPartsAlerts, LOW_STOCK_SCAN_LIMIT } from '@/utils/alertsAccess';

const part = (over: Record<string, unknown>) => ({
  id: 'p',
  part_name: 'PART',
  quantity: 0,
  reorder_point: 10,
  primary_unit: 'ea',
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  state.data = [];
  state.error = null;
  state.calls = {};
});

describe('getLowStockPartsAlerts — bounding the scan', () => {
  /**
   * It read every stocked part with a reorder point. On a 9,428-part catalogue PostgREST caps the
   * response at `max_rows` (1,000) and returns whichever rows came first, with no error — so a
   * genuinely-out part could be absent from the badge and nothing would say so.
   */
  it('caps the read instead of relying on PostgREST to truncate it', async () => {
    await getLowStockPartsAlerts('co1');
    expect(state.calls.limit).toEqual([LOW_STOCK_SCAN_LIMIT]);
  });

  /** Ordering is what makes the cap safe: it drops the least urgent rows, not an arbitrary set. */
  it('scans the emptiest shelves first', async () => {
    await getLowStockPartsAlerts('co1');
    expect(state.calls.order).toEqual(['quantity', { ascending: true }]);
  });

  it('still filters archived and non-stocked parts out at the server', async () => {
    await getLowStockPartsAlerts('co1');
    expect(state.calls.is).toEqual(['deleted_at', null]);
    expect(state.calls.eq).toBeDefined();
  });

  /**
   * The low test compares two COLUMNS, which PostgREST cannot express — so it stays in JS, and a
   * part that has a reorder point but is above it must not become an alert.
   */
  it('reports only parts at or under their reorder point', async () => {
    state.data = [
      part({ id: 'a', part_name: 'OUT', quantity: 0, reorder_point: 10 }),
      part({ id: 'b', part_name: 'FINE', quantity: 50, reorder_point: 10 }),
      part({ id: 'c', part_name: 'AT-THE-LINE', quantity: 10, reorder_point: 10 }),
    ];

    const alerts = await getLowStockPartsAlerts('co1');

    expect(alerts.map((a) => a.item_name)).toEqual(
      expect.arrayContaining(['OUT', 'AT-THE-LINE']),
    );
    expect(alerts.map((a) => a.item_name)).not.toContain('FINE');
  });

  it('calls nothing on hand critical, and half-way high', async () => {
    state.data = [
      part({ id: 'a', part_name: 'OUT', quantity: 0, reorder_point: 10 }),
      part({ id: 'b', part_name: 'HALF', quantity: 4, reorder_point: 10 }),
      part({ id: 'c', part_name: 'NEARLY', quantity: 9, reorder_point: 10 }),
    ];

    const bySeverity = Object.fromEntries(
      (await getLowStockPartsAlerts('co1')).map((a) => [a.item_name, a.severity]),
    );
    expect(bySeverity.OUT).toBe('critical');
    expect(bySeverity.HALF).toBe('high');
    expect(bySeverity.NEARLY).toBe('medium');
  });
});
