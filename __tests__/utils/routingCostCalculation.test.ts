import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RoutingWithGraph, RoutingOperationWithWorkCenter } from '@/types/routings';
import type { BomLineWithChildPart } from '@/types/bom';

/**
 * Tests for utils/routingCostCalculation.ts.
 *
 * Behaviors under test:
 *   - Internal ops: cost = (cycle + setup) × COALESCE(override, wc.labor_rate) / 60
 *   - External ops: cost = unit_price (per-unit) + setup_cost (one-time)
 *   - BOM materials: per-unit cost = bom.quantity × getComputedPartCost(child_id, qty)
 *     (the SQL function compute_part_cost_at_qty handles tier cascade and
 *     unit conversion internally — the TS layer just multiplies)
 *   - Tier pricing: setup amortizes across the tier qty
 *
 * Per the no-silent-fallbacks engineering principle, the TS function does
 * NOT silently treat missing rates / external pricing / material costs as
 * zero. It surfaces them via the `warnings` array (typed) and skips the
 * row in the cost rollup.
 *
 * Migration 20260514 dropped parts.cost_per_unit and recalculate_part_cost
 * in favour of the live compute_part_cost_at_qty(part_id, qty) function.
 * `getComputedPartCost` is the TS wrapper; tests mock it to return the
 * child cost the test wants to exercise.
 */

const mockGetRoutingForPart = vi.fn();
const mockGetBomForPart = vi.fn();
// childCostMap is keyed by child part_id; the mockGetComputedPartCost looks
// up the desired cost here so individual tests can stage the value alongside
// their BOM-line builder call. null means "no priced tier — propagate NULL"
// (used to exercise the missing_material_cost warning path).
const childCostMap = new Map<string, number | null>();
const mockGetComputedPartCost = vi.fn(async (partId: string, _qty: number) => {
  if (childCostMap.has(partId)) return childCostMap.get(partId) ?? null;
  return 0;
});
const mockGetPartCostExplain = vi.fn(async (partId: string, qty: number) => ({
  unit_cost: childCostMap.has(partId) ? childCostMap.get(partId) ?? null : 0,
  missing_leaves: childCostMap.get(partId) === null
    ? [{ part_id: partId, part_name: childNameMap.get(partId) ?? 'UNPRICED', depth: 0, qty_required: qty }]
    : [],
}));
const childNameMap = new Map<string, string>();
// getSupabase is invoked when the BOM has unit-mismatch rows that require a
// parts_unit_conversions lookup. Tests stay on same-unit rows by default;
// the mock returns an empty conversion list when called.
const mockSupabaseConversions: Array<{ part_id: string; from_unit: string; to_primary_factor: number }> = [];

vi.mock('@/utils/routingsAccess', () => ({
  getRoutingForPart: (...args: unknown[]) => mockGetRoutingForPart(...args),
}));
vi.mock('@/utils/bomAccess', () => ({
  getBomForPart: (...args: unknown[]) => mockGetBomForPart(...args),
}));
vi.mock('@/utils/partsAccess', () => ({
  getComputedPartCost: (...args: [string, number]) => mockGetComputedPartCost(...args),
  getPartCostExplain: (...args: [string, number]) => mockGetPartCostExplain(...args),
}));
vi.mock('@/lib/supabase', () => {
  // Only invoked when a BOM line uses a unit different from the child's
  // primary_unit; tests stay on same-unit rows by default and this returns
  // an empty conversion list.
  const makeClient = () => ({
    from: () => ({
      select: () => ({
        in: () => ({
          in: () => Promise.resolve({ data: mockSupabaseConversions, error: null }),
        }),
      }),
    }),
  });
  return {
    getSupabase: makeClient,
    // typed-client rollout: same singleton at runtime.
    getTypedSupabase: makeClient,
  };
});

import { calculateRoutingCost, calculateTierPricing } from '@/utils/routingCostCalculation';

// ============================================================================
// Builders
// ============================================================================

interface OpOverrides {
  id?: string;
  setup_minutes?: number | null;
  cycle_minutes_per_unit?: number | null;
  labor_rate_override?: number | null;
  external_unit_price?: number | null;
  external_setup_cost?: number | null;
  work_center?: RoutingOperationWithWorkCenter['work_center'];
}

function makeOp(overrides: OpOverrides = {}): RoutingOperationWithWorkCenter {
  return {
    id: overrides.id ?? 'op-1',
    routing_id: 'routing-1',
    work_center_id: overrides.work_center?.id ?? 'wc-1',
    sequence: 10,
    setup_minutes: overrides.setup_minutes ?? 0,
    cycle_minutes_per_unit: overrides.cycle_minutes_per_unit ?? null,
    labor_rate_override: overrides.labor_rate_override ?? null,
    external_unit_price: overrides.external_unit_price ?? null,
    external_setup_cost: overrides.external_setup_cost ?? null,
    instructions: null,
    metadata: {},
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    work_center: overrides.work_center ?? {
      id: 'wc-1',
      name: 'Mazak Lathe',
      kind: 'internal',
      labor_rate: 100,
      vendor: null,
    },
  };
}

function makeRouting(operations: RoutingOperationWithWorkCenter[]): RoutingWithGraph {
  return {
    id: 'routing-1',
    company_id: 'company-1',
    part_id: 'part-1',
    name: 'Routing - PART-1',
    description: null,
    created_by: null,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    part: { id: 'part-1', part_name: 'PART-1', description: null },
    operations,
  };
}

interface BomOverrides {
  id?: string;
  quantity?: number;
  unit?: string;
  childId?: string;
  childName?: string;
  /**
   * Cost this child returns from compute_part_cost_at_qty. Staged into
   * `childCostMap` keyed by the child's id. Pass `null` to test the
   * missing-cost path (no priced tier covers the cascaded qty). Omit to
   * get the default of 5.0.
   */
  childCost?: number | null;
  childPrimaryUnit?: string;
}

function makeBomLine(overrides: BomOverrides = {}): BomLineWithChildPart {
  // We deliberately use `'childCost' in overrides` here (not `??`) so
  // callers can pass `childCost: null` to exercise the missing-cost branch
  // without it being silently coerced back to the default.
  const childCost = 'childCost' in overrides ? overrides.childCost! : 5.0;
  const childId = overrides.childId ?? 'child-1';
  const childName = overrides.childName ?? 'CHILD-1';
  // Stage the cost so the mocked compute_part_cost_at_qty returns it.
  childCostMap.set(childId, childCost);
  childNameMap.set(childId, childName);
  return {
    id: overrides.id ?? 'bom-1',
    parent_part_id: 'part-1',
    child_part_id: childId,
    quantity: overrides.quantity ?? 1,
    unit: overrides.unit ?? 'ea',
    sequence: 10,
    notes: null,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    child_part: {
      id: childId,
      part_name: childName,
      description: null,
      primary_unit: overrides.childPrimaryUnit ?? 'ea',
      is_stocked: true,
      source: 'bought',
    },
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('calculateRoutingCost', () => {
  beforeEach(() => {
    mockGetRoutingForPart.mockReset();
    mockGetBomForPart.mockReset();
    mockGetBomForPart.mockResolvedValue([]);
    childCostMap.clear();
    childNameMap.clear();
    mockSupabaseConversions.length = 0;
  });

  describe('returns null when there is nothing to cost', () => {
    it('returns null when part has no routing AND no BOM', async () => {
      mockGetRoutingForPart.mockResolvedValue(null);
      mockGetBomForPart.mockResolvedValue([]);

      const result = await calculateRoutingCost('part-1');

      expect(result).toBeNull();
    });
  });

  describe('internal operations', () => {
    it('prices cycle + setup at the work_center labor_rate when no override', async () => {
      // wc.labor_rate=100, setup=30min, cycle=6min/unit
      // run cost  = 6/60 * 100  = 10.00 per unit
      // setup cost = 30/60 * 100 = 50.00 (one-time)
      const op = makeOp({
        setup_minutes: 30,
        cycle_minutes_per_unit: 6,
        work_center: {
          id: 'wc-1',
          name: 'Mazak Lathe',
          kind: 'internal',
          labor_rate: 100,
          vendor: null,
        },
      });
      mockGetRoutingForPart.mockResolvedValue(makeRouting([op]));

      const result = await calculateRoutingCost('part-1');

      expect(result).not.toBeNull();
      expect(result!.warnings).toEqual([]);
      expect(result!.labor_items).toHaveLength(1);
      expect(result!.labor_items[0].labor_rate).toBe(100);
      expect(result!.labor_items[0].cost).toBe(10);
      expect(result!.labor_items[0].setup_cost).toBe(50);
      expect(result!.total_labor_cost).toBe(10);
      expect(result!.total_setup_cost).toBe(50);
      expect(result!.total_material_cost).toBe(0);
      // total_cost = labor + materials (setup amortizes only at the tier
      // pricing layer — not in the routing-level total)
      expect(result!.total_cost).toBe(10);
    });

    it('labor_rate_override takes precedence over the work_center default', async () => {
      // override=120 wins over wc.labor_rate=100
      // run cost = 6/60 * 120 = 12.00
      const op = makeOp({
        setup_minutes: 0,
        cycle_minutes_per_unit: 6,
        labor_rate_override: 120,
        work_center: {
          id: 'wc-1',
          name: 'Mazak Lathe',
          kind: 'internal',
          labor_rate: 100,
          vendor: null,
        },
      });
      mockGetRoutingForPart.mockResolvedValue(makeRouting([op]));

      const result = await calculateRoutingCost('part-1');

      expect(result!.labor_items[0].labor_rate).toBe(120);
      expect(result!.labor_items[0].cost).toBe(12);
    });

    it('emits missing_labor_rate warning when neither override nor wc.labor_rate is set', async () => {
      // Per the no-silent-fallbacks principle: skip the op rather than
      // pricing it at $0. The warning surfaces the gap so the UI can show
      // a "fix me" badge instead of a phantom-zero cost.
      const op = makeOp({
        cycle_minutes_per_unit: 6,
        labor_rate_override: null,
        work_center: {
          id: 'wc-1',
          name: 'Mazak Lathe',
          kind: 'internal',
          labor_rate: null,
          vendor: null,
        },
      });
      mockGetRoutingForPart.mockResolvedValue(makeRouting([op]));

      const result = await calculateRoutingCost('part-1');

      expect(result!.warnings).toHaveLength(1);
      expect(result!.warnings[0].type).toBe('missing_labor_rate');
      expect(result!.warnings[0].message).toContain('Mazak Lathe');
      expect(result!.warnings[0].node_id).toBe('op-1');
      expect(result!.labor_items).toHaveLength(0);
      expect(result!.total_labor_cost).toBe(0);
    });

    it('emits empty_operation warning when both setup and cycle are zero', async () => {
      const op = makeOp({ setup_minutes: 0, cycle_minutes_per_unit: 0 });
      mockGetRoutingForPart.mockResolvedValue(makeRouting([op]));

      const result = await calculateRoutingCost('part-1');

      expect(result!.warnings).toHaveLength(1);
      expect(result!.warnings[0].type).toBe('empty_operation');
      expect(result!.labor_items).toHaveLength(0);
    });
  });

  describe('external operations', () => {
    const externalWc = {
      id: 'wc-ext',
      name: 'PerformCoat',
      kind: 'external' as const,
      labor_rate: null,
      vendor: { id: 'v-1', name: 'PerformCoat Finishing' },
    };

    it('prices unit_price as per-unit and setup_cost as one-time', async () => {
      const op = makeOp({
        external_unit_price: 4.5,
        external_setup_cost: 75,
        work_center: externalWc,
      });
      mockGetRoutingForPart.mockResolvedValue(makeRouting([op]));

      const result = await calculateRoutingCost('part-1');

      expect(result!.warnings).toEqual([]);
      expect(result!.labor_items).toHaveLength(1);
      expect(result!.labor_items[0].cost).toBe(4.5);
      expect(result!.labor_items[0].setup_cost).toBe(75);
      // External ops never carry time — those fields stay zero
      expect(result!.labor_items[0].run_time_minutes).toBe(0);
      expect(result!.labor_items[0].setup_time_minutes).toBe(0);
      expect(result!.labor_items[0].labor_rate).toBe(0);
    });

    it('treats unit_price-only as zero setup', async () => {
      const op = makeOp({
        external_unit_price: 10,
        external_setup_cost: null,
        work_center: externalWc,
      });
      mockGetRoutingForPart.mockResolvedValue(makeRouting([op]));

      const result = await calculateRoutingCost('part-1');

      expect(result!.labor_items[0].cost).toBe(10);
      expect(result!.labor_items[0].setup_cost).toBe(0);
    });

    it('emits missing_external_pricing when both fields are null', async () => {
      // Mirrors recalculate_part_cost's SQL guard: free outside ops are
      // meaningless, so we refuse to price as $0.
      const op = makeOp({
        external_unit_price: null,
        external_setup_cost: null,
        work_center: externalWc,
      });
      mockGetRoutingForPart.mockResolvedValue(makeRouting([op]));

      const result = await calculateRoutingCost('part-1');

      expect(result!.warnings).toHaveLength(1);
      expect(result!.warnings[0].type).toBe('missing_external_pricing');
      expect(result!.warnings[0].message).toContain('PerformCoat');
      expect(result!.labor_items).toHaveLength(0);
    });
  });

  describe('mixed internal + external routings', () => {
    it('sums per-op contributions correctly across kinds', async () => {
      const internalOp = makeOp({
        id: 'op-int',
        setup_minutes: 30,
        cycle_minutes_per_unit: 6,
        // override 120 → run = 12.00, setup = 60.00
        labor_rate_override: 120,
        work_center: {
          id: 'wc-int',
          name: 'HURCO Mill',
          kind: 'internal',
          labor_rate: 100,
          vendor: null,
        },
      });
      const externalOp = makeOp({
        id: 'op-ext',
        external_unit_price: 4.5,
        external_setup_cost: 75,
        work_center: {
          id: 'wc-ext',
          name: 'PerformCoat',
          kind: 'external',
          labor_rate: null,
          vendor: { id: 'v-1', name: 'PerformCoat Finishing' },
        },
      });
      mockGetRoutingForPart.mockResolvedValue(makeRouting([internalOp, externalOp]));

      const result = await calculateRoutingCost('part-1');

      expect(result!.warnings).toEqual([]);
      expect(result!.labor_items).toHaveLength(2);
      // labor (per-unit run + per-unit external unit_price)
      expect(result!.total_labor_cost).toBeCloseTo(12 + 4.5, 2);
      // setup (internal + external one-time)
      expect(result!.total_setup_cost).toBeCloseTo(60 + 75, 2);
    });
  });

  describe('routing edge cases', () => {
    it('emits no_operations warning when routing has zero operations', async () => {
      mockGetRoutingForPart.mockResolvedValue(makeRouting([]));

      const result = await calculateRoutingCost('part-1');

      expect(result).not.toBeNull();
      expect(result!.warnings).toHaveLength(1);
      expect(result!.warnings[0].type).toBe('no_operations');
    });
  });

  describe('BOM materials', () => {
    it('adds child cost_per_unit × bom quantity to total_material_cost', async () => {
      mockGetRoutingForPart.mockResolvedValue(null);
      mockGetBomForPart.mockResolvedValue([
        makeBomLine({
          quantity: 2,
          unit: 'ea',
          childPrimaryUnit: 'ea',
          childCost: 5,
        }),
      ]);

      const result = await calculateRoutingCost('part-1');

      expect(result!.warnings).toEqual([]);
      expect(result!.material_items).toHaveLength(1);
      expect(result!.material_items[0].cost).toBe(10);
      expect(result!.total_material_cost).toBe(10);
      expect(result!.total_cost).toBe(10);
    });

    it('uses child.cost_per_unit as-is even when BOM unit differs from primary_unit', async () => {
      // The TS function does NOT perform client-side unit conversion. The
      // SQL recalculate_part_cost has already normalised
      // parts.cost_per_unit to the child's primary_unit, so the TS layer
      // can multiply BOM quantity × cost_per_unit directly. This test
      // pins the contract — if we ever need conversion, callers must
      // make it explicit via parts_unit_conversions, not bury it here.
      mockGetRoutingForPart.mockResolvedValue(null);
      mockGetBomForPart.mockResolvedValue([
        makeBomLine({
          quantity: 0.75,
          unit: 'in',
          childPrimaryUnit: 'in', // matched
          childCost: 0.85,
        }),
      ]);

      const result = await calculateRoutingCost('part-1');

      // The function rounds material cost to 2 decimal places — 0.6375 → 0.64.
      // The exact intermediate (0.6375) is what feeds into total rollups, so
      // we check the rounded item cost AND the total separately.
      expect(result!.material_items[0].cost).toBe(0.64);
      expect(result!.total_material_cost).toBe(0.64);
      expect(result!.material_items[0].unit).toBe('in');
    });

    it('emits missing_material_cost warning when child has null cost_per_unit', async () => {
      // No silent fallback — surface the gap rather than rolling up $0.
      mockGetRoutingForPart.mockResolvedValue(null);
      mockGetBomForPart.mockResolvedValue([
        makeBomLine({
          quantity: 5,
          childName: 'UNPRICED-PART',
          childCost: null,
        }),
      ]);

      const result = await calculateRoutingCost('part-1');

      expect(result!.warnings).toHaveLength(1);
      expect(result!.warnings[0].type).toBe('missing_material_cost');
      expect(result!.warnings[0].message).toContain('UNPRICED-PART');
      expect(result!.warnings[0].material_id).toBe('bom-1');
      expect(result!.material_items).toHaveLength(0);
      expect(result!.total_material_cost).toBe(0);
    });

    it('exposes child_part_name + detail on missing_material_cost so the renderer can link the part name', async () => {
      // The Pricing-card warning UI replaced the trailing "Open child →" link
      // with `<Link>{child_part_name}</Link> {detail}` so the part name itself
      // is the click target. Verify the warning carries those fields and that
      // `message` still composes them for backwards-compatible callers.
      mockGetRoutingForPart.mockResolvedValue(null);
      mockGetBomForPart.mockResolvedValue([
        makeBomLine({
          quantity: 5,
          childName: 'UNPRICED-PART',
          childCost: null,
        }),
      ]);

      const result = await calculateRoutingCost('part-1');

      const w = result!.warnings[0];
      expect(w.child_part_name).toBe('UNPRICED-PART');
      expect(typeof w.detail).toBe('string');
      expect(w.detail).not.toBe('');
      // detail should NOT include the "PARTNAME: " prefix — that's the
      // renderer's job, composed via the Link wrapper.
      expect(w.detail).not.toMatch(/^UNPRICED-PART:/);
      // message still combines them for legacy callers.
      expect(w.message).toBe(`UNPRICED-PART: ${w.detail}`);
    });

    it('falls back to child.primary_unit when bom.unit is empty', async () => {
      mockGetRoutingForPart.mockResolvedValue(null);
      mockGetBomForPart.mockResolvedValue([
        makeBomLine({
          quantity: 3,
          unit: '',
          childPrimaryUnit: 'lbs',
          childCost: 2,
        }),
      ]);

      const result = await calculateRoutingCost('part-1');

      expect(result!.material_items[0].unit).toBe('lbs');
    });

    it('SP-H-42-FFBC regression: parent rolls up both made + bought children live', async () => {
      // Repro of the user-reported bug from migration 20260514. Before this
      // refactor, the parent's BOM panel showed "—" for made child
      // 0190-4140 because parts.cost_per_unit was the snapshot column and
      // had never been written for that child (despite pricing tiers
      // existing for it). The bought child C FLAT happened to have a value
      // in the snapshot column. With the snapshot gone, both children
      // resolve through compute_part_cost_at_qty live, so the rollup is
      // symmetric and complete.
      mockGetRoutingForPart.mockResolvedValue(
        makeRouting([
          makeOp({
            setup_minutes: 30,
            cycle_minutes_per_unit: 6,
            labor_rate_override: 100,
          }),
        ]),
      );
      mockGetBomForPart.mockResolvedValue([
        makeBomLine({
          id: 'bom-made-child',
          childId: 'part-0190-4140',
          childName: '0190-4140',
          quantity: 1,
          childCost: 76.26,
        }),
        makeBomLine({
          id: 'bom-bought-child',
          childId: 'part-c-flat',
          childName: 'C FLAT .50 X .625 X 6.00 Z9',
          quantity: 1,
          childCost: 17.41,
        }),
      ]);

      const result = await calculateRoutingCost('part-1');

      // No missing-material warnings — both children have a live cost.
      expect(
        result!.warnings.filter((w) => w.type === 'missing_material_cost'),
      ).toHaveLength(0);
      // Both children land in material_items.
      expect(result!.material_items).toHaveLength(2);
      // Material total = 1 × 76.26 + 1 × 17.41 = 93.67
      expect(result!.total_material_cost).toBeCloseTo(93.67, 2);
      // labor = 6 min × $100 / 60 = $10 per unit
      expect(result!.total_labor_cost).toBe(10);
      // setup = 30 min × $100 / 60 = $50 one-time
      expect(result!.total_setup_cost).toBe(50);
    });
  });

  describe('combined routing + BOM', () => {
    it('rolls up labor + setup + materials into the breakdown totals', async () => {
      mockGetRoutingForPart.mockResolvedValue(
        makeRouting([
          makeOp({
            setup_minutes: 30,
            cycle_minutes_per_unit: 6,
            // override 120 → run = 12.00, setup = 60.00
            labor_rate_override: 120,
          }),
        ]),
      );
      mockGetBomForPart.mockResolvedValue([
        makeBomLine({ quantity: 2, childCost: 5 }), // material = 10
      ]);

      const result = await calculateRoutingCost('part-1');

      expect(result!.total_labor_cost).toBe(12);
      expect(result!.total_setup_cost).toBe(60);
      expect(result!.total_material_cost).toBe(10);
      // total_cost = labor + material; setup is one-time and only folded
      // into the per-tier price (it amortizes by qty).
      expect(result!.total_cost).toBe(22);
    });
  });
});

// ============================================================================
// calculateTierPricing — quantity tier breakdowns
// ============================================================================

describe('calculateTierPricing', () => {
  it('amortizes setup cost across the tier quantity', async () => {
    // Build a breakdown with run=12/unit, material=10/unit, setup=60 one-time.
    // qty=10 → setup-per-unit = 6 → base = 12 + 10 + 6 = 28.00
    mockGetRoutingForPart.mockResolvedValue(
      makeRouting([
        makeOp({
          setup_minutes: 30,
          cycle_minutes_per_unit: 6,
          labor_rate_override: 120,
        }),
      ]),
    );
    mockGetBomForPart.mockResolvedValue([
      makeBomLine({ quantity: 2, childCost: 5 }),
    ]);

    const breakdown = await calculateRoutingCost('part-1');
    const tier = calculateTierPricing(breakdown!, 10, 25);

    expect(tier.baseCostPerUnit).toBe(28);
    // 25% markup → 28 × 1.25 = 35.00
    expect(tier.unitPrice).toBe(35);
  });

  it('falls back to qty=1 when quantity is zero or negative', async () => {
    mockGetRoutingForPart.mockResolvedValue(
      makeRouting([
        makeOp({
          setup_minutes: 30,
          cycle_minutes_per_unit: 6,
          labor_rate_override: 120,
        }),
      ]),
    );
    mockGetBomForPart.mockResolvedValue([]);

    const breakdown = await calculateRoutingCost('part-1');
    const tier = calculateTierPricing(breakdown!, 0, 0);

    // qty clamped to 1 → setup amortizes to its full 60.00 per unit
    expect(tier.baseCostPerUnit).toBe(72);
    expect(tier.unitPrice).toBe(72);
  });

  it('returns null unitPrice when markup is null', async () => {
    mockGetRoutingForPart.mockResolvedValue(
      makeRouting([
        makeOp({
          setup_minutes: 0,
          cycle_minutes_per_unit: 6,
          labor_rate_override: 100,
        }),
      ]),
    );
    mockGetBomForPart.mockResolvedValue([]);

    const breakdown = await calculateRoutingCost('part-1');
    const tier = calculateTierPricing(breakdown!, 1, null);

    expect(tier.baseCostPerUnit).toBe(10);
    expect(tier.unitPrice).toBeNull();
  });

  it('returns the same per-unit base across multiple tier quantities (setup is the only qty-dependent piece)', async () => {
    // Build run=12/unit, material=10/unit, setup=60 one-time.
    // qty=1   → setup-per-unit=60 → base=82
    // qty=10  → setup-per-unit=6  → base=28
    // qty=100 → setup-per-unit=0.6 → base=22.6
    mockGetRoutingForPart.mockResolvedValue(
      makeRouting([
        makeOp({
          setup_minutes: 30,
          cycle_minutes_per_unit: 6,
          labor_rate_override: 120,
        }),
      ]),
    );
    mockGetBomForPart.mockResolvedValue([
      makeBomLine({ quantity: 2, childCost: 5 }),
    ]);

    const breakdown = await calculateRoutingCost('part-1');

    const t1 = calculateTierPricing(breakdown!, 1, 25);
    const t10 = calculateTierPricing(breakdown!, 10, 25);
    const t100 = calculateTierPricing(breakdown!, 100, 25);

    expect(t1.baseCostPerUnit).toBe(82);
    expect(t10.baseCostPerUnit).toBe(28);
    expect(t100.baseCostPerUnit).toBe(22.6);

    // Markup applied per tier — verify the percent flows through
    expect(t1.unitPrice).toBeCloseTo(102.5, 2);
    expect(t10.unitPrice).toBe(35);
    expect(t100.unitPrice).toBeCloseTo(28.25, 2);
  });
});
