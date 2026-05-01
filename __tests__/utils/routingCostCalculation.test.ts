import { describe, it, expect, vi, beforeEach } from 'vitest';
import { calculateRoutingCost, calculateTierPricing, type RoutingCostBreakdown } from '@/utils/routingCostCalculation';
import type { RoutingWithGraph, RoutingMaterialWithItem } from '@/types/routings';

// Mock getRoutingForPart
const mockGetRoutingForPart = vi.fn();
vi.mock('@/utils/routingsAccess', () => ({
  getRoutingForPart: (...args: unknown[]) => mockGetRoutingForPart(...args),
}));

function makeMaterial(
  overrides: Partial<RoutingMaterialWithItem> & {
    inventoryItemName?: string;
    inventoryItemCost?: number | null;
    inventoryItemPrimaryUnit?: string;
  } = {}
): RoutingMaterialWithItem {
  const {
    inventoryItemName = 'Steel Rod',
    inventoryItemCost = 25,
    inventoryItemPrimaryUnit = 'kg',
    ...rest
  } = overrides;
  return {
    id: 'mat-1',
    routing_id: 'routing-1',
    inventory_item_id: 'inv-1',
    quantity: 1,
    unit: 'kg',
    sequence: 10,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    inventory_item: {
      id: rest.inventory_item_id || 'inv-1',
      name: inventoryItemName,
      cost_per_unit: inventoryItemCost,
      primary_unit: inventoryItemPrimaryUnit,
    },
    ...rest,
  };
}

function makeRouting(
  nodes: RoutingWithGraph['nodes'],
  materials: RoutingMaterialWithItem[] = []
): RoutingWithGraph {
  return {
    id: 'routing-1',
    company_id: 'company-1',
    part_id: 'part-1',
    name: 'Routing - P001',
    description: null,
    created_by: null,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    part: { id: 'part-1', part_name: 'P001', description: null },
    nodes,
    materials,
  };
}

function makeNode(overrides: Partial<RoutingWithGraph['nodes'][0]> = {}): RoutingWithGraph['nodes'][0] {
  return {
    id: 'node-1',
    routing_id: 'routing-1',
    operation_type_id: 'op-1',
    run_time_per_unit: 30,
    setup_time: 0,
    metadata: {},
    sequence: 10,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    operation_type: {
      id: 'op-1',
      name: 'CNC Milling',
      labor_rate: 80,
    },
    ...overrides,
  };
}

describe('calculateRoutingCost', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null when no routing exists', async () => {
    mockGetRoutingForPart.mockResolvedValue(null);
    const result = await calculateRoutingCost('part-1');
    expect(result).toBeNull();
  });

  it('returns warning when routing has no nodes', async () => {
    mockGetRoutingForPart.mockResolvedValue(makeRouting([]));
    const result = await calculateRoutingCost('part-1');

    expect(result).not.toBeNull();
    expect(result!.total_cost).toBe(0);
    expect(result!.warnings).toHaveLength(1);
    expect(result!.warnings[0].type).toBe('no_operations');
  });

  it('calculates labor cost correctly for 2 nodes', async () => {
    const nodes = [
      makeNode({
        id: 'node-1',
        run_time_per_unit: 30,
        operation_type: { id: 'op-1', name: 'CNC Milling', labor_rate: 80 },
      }),
      makeNode({
        id: 'node-2',
        run_time_per_unit: 15,
        operation_type: { id: 'op-2', name: 'Grinding', labor_rate: 60 },
      }),
    ];

    mockGetRoutingForPart.mockResolvedValue(makeRouting(nodes));

    const result = await calculateRoutingCost('part-1');

    expect(result).not.toBeNull();
    expect(result!.labor_items).toHaveLength(2);
    expect(result!.labor_items[0].cost).toBe(40);
    expect(result!.labor_items[1].cost).toBe(15);
    expect(result!.total_labor_cost).toBe(55);
    expect(result!.total_material_cost).toBe(0);
    expect(result!.total_cost).toBe(55);
    expect(result!.warnings).toHaveLength(0);
  });

  it('calculates labor + material costs correctly (materials are routing-level)', async () => {
    const nodes = [
      makeNode({
        id: 'node-1',
        run_time_per_unit: 60,
        operation_type: { id: 'op-1', name: 'CNC Milling', labor_rate: 100 },
      }),
    ];

    const materials = [
      makeMaterial({
        id: 'mat-1',
        inventory_item_id: 'inv-1',
        quantity: 2,
        unit: 'kg',
        inventoryItemName: 'Steel Rod',
        inventoryItemCost: 25,
        inventoryItemPrimaryUnit: 'kg',
      }),
      makeMaterial({
        id: 'mat-2',
        inventory_item_id: 'inv-2',
        quantity: 5,
        unit: 'ea',
        inventoryItemName: 'Bolt M6',
        inventoryItemCost: 0.5,
        inventoryItemPrimaryUnit: 'ea',
      }),
    ];

    mockGetRoutingForPart.mockResolvedValue(makeRouting(nodes, materials));

    const result = await calculateRoutingCost('part-1');

    expect(result).not.toBeNull();
    expect(result!.total_labor_cost).toBe(100);
    expect(result!.material_items).toHaveLength(2);
    expect(result!.material_items[0].cost).toBe(50);
    expect(result!.material_items[1].cost).toBe(2.5);
    expect(result!.total_material_cost).toBe(52.5);
    expect(result!.total_cost).toBe(152.5);
    expect(result!.warnings).toHaveLength(0);
  });

  it('warns on missing labor_rate', async () => {
    const nodes = [
      makeNode({
        operation_type: { id: 'op-1', name: 'Manual', labor_rate: null },
      }),
    ];

    mockGetRoutingForPart.mockResolvedValue(makeRouting(nodes));
    const result = await calculateRoutingCost('part-1');

    expect(result!.labor_items).toHaveLength(0);
    expect(result!.warnings).toHaveLength(1);
    expect(result!.warnings[0].type).toBe('missing_labor_rate');
  });

  it('warns empty_operation when run and setup are both zero/null', async () => {
    const nodes = [makeNode({ run_time_per_unit: null, setup_time: 0 })];

    mockGetRoutingForPart.mockResolvedValue(makeRouting(nodes));
    const result = await calculateRoutingCost('part-1');

    expect(result!.labor_items).toHaveLength(0);
    expect(result!.warnings).toHaveLength(1);
    expect(result!.warnings[0].type).toBe('empty_operation');
  });

  it('includes setup-only operation (null run time, non-zero setup) with run_cost = 0', async () => {
    const nodes = [
      makeNode({
        id: 'node-eng',
        run_time_per_unit: null,
        setup_time: 30,
        operation_type: { id: 'op-eng', name: 'Engineering', labor_rate: 125 },
      }),
    ];

    mockGetRoutingForPart.mockResolvedValue(makeRouting(nodes));
    const result = await calculateRoutingCost('part-1');

    expect(result!.warnings).toHaveLength(0);
    expect(result!.labor_items).toHaveLength(1);
    expect(result!.labor_items[0].cost).toBe(0);
    expect(result!.labor_items[0].setup_cost).toBe(62.5);
    expect(result!.total_setup_cost).toBe(62.5);
  });

  it('includes setup-only operation (explicit 0 run time) with run_cost = 0', async () => {
    const nodes = [
      makeNode({
        id: 'node-prog',
        run_time_per_unit: 0,
        setup_time: 45,
        operation_type: { id: 'op-prog', name: 'Programming', labor_rate: 100 },
      }),
    ];

    mockGetRoutingForPart.mockResolvedValue(makeRouting(nodes));
    const result = await calculateRoutingCost('part-1');

    expect(result!.warnings).toHaveLength(0);
    expect(result!.labor_items[0].cost).toBe(0);
    expect(result!.labor_items[0].setup_cost).toBe(75);
  });

  it('warns missing_labor_rate on a setup-only op when labor_rate is null', async () => {
    const nodes = [
      makeNode({
        run_time_per_unit: null,
        setup_time: 20,
        operation_type: { id: 'op-1', name: 'Engineering', labor_rate: null },
      }),
    ];

    mockGetRoutingForPart.mockResolvedValue(makeRouting(nodes));
    const result = await calculateRoutingCost('part-1');

    expect(result!.labor_items).toHaveLength(0);
    expect(result!.warnings).toHaveLength(1);
    expect(result!.warnings[0].type).toBe('missing_labor_rate');
  });

  it('warns on missing inventory item cost', async () => {
    const nodes = [makeNode()];
    const materials = [
      makeMaterial({
        id: 'mat-missing-cost',
        inventory_item_id: 'inv-missing',
        quantity: 1,
        unit: 'ea',
        inventoryItemName: 'Unknown Part',
        inventoryItemCost: null,
        inventoryItemPrimaryUnit: 'ea',
      }),
    ];

    mockGetRoutingForPart.mockResolvedValue(makeRouting(nodes, materials));
    const result = await calculateRoutingCost('part-1');

    expect(result!.material_items).toHaveLength(0);
    expect(result!.warnings.some((w) => w.type === 'missing_material_cost')).toBe(true);
  });

  it('warns when inventory item join is null', async () => {
    const nodes = [makeNode()];
    const materials: RoutingMaterialWithItem[] = [
      {
        id: 'mat-orphan',
        routing_id: 'routing-1',
        inventory_item_id: 'inv-deleted',
        quantity: 1,
        unit: 'ea',
        sequence: 10,
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
        inventory_item: null,
      },
    ];

    mockGetRoutingForPart.mockResolvedValue(makeRouting(nodes, materials));
    const result = await calculateRoutingCost('part-1');

    expect(result!.material_items).toHaveLength(0);
    expect(result!.warnings.some((w) => w.type === 'missing_material_cost')).toBe(true);
  });

  it('calculates setup cost separately from run cost', async () => {
    const nodes = [
      makeNode({
        run_time_per_unit: 30,
        setup_time: 60,
        operation_type: { id: 'op-1', name: 'CNC Milling', labor_rate: 80 },
      }),
    ];

    mockGetRoutingForPart.mockResolvedValue(makeRouting(nodes));
    const result = await calculateRoutingCost('part-1');

    expect(result).not.toBeNull();
    expect(result!.labor_items[0].cost).toBe(40);
    expect(result!.labor_items[0].setup_cost).toBe(80);
    expect(result!.labor_items[0].setup_time_minutes).toBe(60);
    expect(result!.total_labor_cost).toBe(40);
    expect(result!.total_setup_cost).toBe(80);
    expect(result!.total_cost).toBe(40);
  });

  it('returns zero setup cost when setup_time is 0', async () => {
    const nodes = [
      makeNode({
        run_time_per_unit: 30,
        setup_time: 0,
        operation_type: { id: 'op-1', name: 'Manual Deburring', labor_rate: 50 },
      }),
    ];

    mockGetRoutingForPart.mockResolvedValue(makeRouting(nodes));
    const result = await calculateRoutingCost('part-1');

    expect(result!.labor_items[0].setup_cost).toBe(0);
    expect(result!.labor_items[0].setup_time_minutes).toBe(0);
    expect(result!.total_setup_cost).toBe(0);
  });
});

describe('calculateTierPricing', () => {
  const breakdown: RoutingCostBreakdown = {
    labor_items: [],
    material_items: [],
    total_labor_cost: 20,
    total_setup_cost: 60,
    total_material_cost: 10,
    total_cost: 30,
    warnings: [],
  };

  it('amortizes setup across quantity', () => {
    const qty1 = calculateTierPricing(breakdown, 1, 0);
    const qty4 = calculateTierPricing(breakdown, 4, 0);
    const qty10 = calculateTierPricing(breakdown, 10, 0);
    expect(qty1.baseCostPerUnit).toBe(90);
    expect(qty4.baseCostPerUnit).toBe(45);
    expect(qty10.baseCostPerUnit).toBe(36);
  });

  it('applies markup to base cost', () => {
    const { baseCostPerUnit, unitPrice } = calculateTierPricing(breakdown, 4, 25);
    expect(baseCostPerUnit).toBe(45);
    expect(unitPrice).toBe(56.25);
  });

  it('returns null unit price when markup is null', () => {
    const { unitPrice } = calculateTierPricing(breakdown, 4, null);
    expect(unitPrice).toBeNull();
  });

  it('treats qty < 1 as qty = 1 (no division by zero)', () => {
    const zero = calculateTierPricing(breakdown, 0, 10);
    expect(zero.baseCostPerUnit).toBe(90);
    expect(zero.unitPrice).toBe(99);
  });

  it('Miscellaneous $60/hr hack (70 min run) does not amortize across tiers', () => {
    // 70 min × $60/hr = $70 per unit of run labor — should stay flat across tiers.
    const miscBreakdown: RoutingCostBreakdown = {
      labor_items: [],
      material_items: [],
      total_labor_cost: 70,
      total_setup_cost: 0,
      total_material_cost: 0,
      total_cost: 70,
      warnings: [],
    };
    expect(calculateTierPricing(miscBreakdown, 1, 0).baseCostPerUnit).toBe(70);
    expect(calculateTierPricing(miscBreakdown, 4, 0).baseCostPerUnit).toBe(70);
    expect(calculateTierPricing(miscBreakdown, 10, 0).baseCostPerUnit).toBe(70);
  });
});
