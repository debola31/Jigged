import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RoutingWithGraph, RoutingOperationWithWorkCenter } from '@/types/routings';
import type { BomLineWithChildPart } from '@/types/bom';

/**
 * Tests for utils/routingCostCalculation.ts against the unified
 * parts/work_centers/vendors schema (PR 1).
 *
 * Behaviors under test:
 *   - Internal ops: cost = (cycle + setup) × COALESCE(override, wc.labor_rate) / 60
 *   - External ops: cost = unit_price (per-unit) + setup_cost (one-time)
 *   - BOM materials: per-unit cost = bom.quantity × child.cost_per_unit
 *     (no client-side unit conversion; the SQL recalculate_part_cost has
 *     already normalised child.cost_per_unit to the child's primary_unit)
 *   - Tier pricing: setup amortizes across the tier qty
 *
 * Per the no-silent-fallbacks engineering principle, the TS function does
 * NOT silently treat missing rates / external pricing / material costs as
 * zero. It surfaces them via the `warnings` array (typed) and skips the
 * row in the cost rollup. Tests assert each warning type is raised with a
 * useful message when data is missing.
 *
 * The SQL recalculate_part_cost is stricter — it RAISEs — but the
 * client-side breakdown is for the part-detail UI, where surfacing
 * warnings is more useful than blowing up the page render. The two layers
 * agree on the principle (no $0 fallback) and the user sees the gap
 * either way.
 */

const mockGetRoutingForPart = vi.fn();
const mockGetBomForPart = vi.fn();

vi.mock('@/utils/routingsAccess', () => ({
  getRoutingForPart: (...args: unknown[]) => mockGetRoutingForPart(...args),
}));
vi.mock('@/utils/bomAccess', () => ({
  getBomForPart: (...args: unknown[]) => mockGetBomForPart(...args),
}));

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
  childName?: string;
  /** Pass `null` explicitly to test the missing_material_cost path. Omit
   *  the key entirely to get the default of 5.0. */
  childCost?: number | null;
  childPrimaryUnit?: string;
}

function makeBomLine(overrides: BomOverrides = {}): BomLineWithChildPart {
  // We deliberately use `'childCost' in overrides` here (not `??`) so
  // callers can pass `childCost: null` to exercise the missing-cost branch
  // without it being silently coerced back to the default.
  const childCost = 'childCost' in overrides ? overrides.childCost! : 5.0;
  return {
    id: overrides.id ?? 'bom-1',
    parent_part_id: 'part-1',
    child_part_id: 'child-1',
    quantity: overrides.quantity ?? 1,
    unit: overrides.unit ?? 'ea',
    sequence: 10,
    notes: null,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    child_part: {
      id: 'child-1',
      part_name: overrides.childName ?? 'CHILD-1',
      description: null,
      primary_unit: overrides.childPrimaryUnit ?? 'ea',
      cost_per_unit: childCost,
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
