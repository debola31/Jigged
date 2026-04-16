import { describe, it, expect, vi, beforeEach } from 'vitest';
import { calculateRoutingCost } from '@/utils/routingCostCalculation';
import type { RoutingWithGraph } from '@/types/routings';

// Mock getRoutingForPart
const mockGetRoutingForPart = vi.fn();
vi.mock('@/utils/routingsAccess', () => ({
  getRoutingForPart: (...args: unknown[]) => mockGetRoutingForPart(...args),
}));

// Mock Supabase for inventory_items lookup
const { mockQueryBuilder, mockSupabase } = vi.hoisted(() => {
  const builder: Record<string, ReturnType<typeof vi.fn> | unknown> = {};
  const chainMethods = ['from', 'select', 'in', 'eq'];
  chainMethods.forEach((method) => {
    builder[method] = vi.fn().mockImplementation(() => builder);
  });
  builder['data'] = null;
  builder['error'] = null;

  const supabase = { from: vi.fn().mockImplementation(() => builder) };
  return { mockQueryBuilder: builder, mockSupabase: supabase };
});

vi.mock('@/lib/supabase', () => ({
  getSupabase: () => mockSupabase,
}));

function makeRouting(nodes: RoutingWithGraph['nodes']): RoutingWithGraph {
  return {
    id: 'routing-1',
    company_id: 'company-1',
    part_id: 'part-1',
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    part: { id: 'part-1', part_name: 'P001', description: null },
    nodes,
    edges: [],
  };
}

function makeNode(overrides: Partial<RoutingWithGraph['nodes'][0]> = {}): RoutingWithGraph['nodes'][0] {
  return {
    id: 'node-1',
    routing_id: 'routing-1',
    operation_type_id: 'op-1',
    run_time_per_unit: 30,
    setup_time: 0,
    instructions: null,
    metadata: {},
    materials: [],
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    operation_type: {
      id: 'op-1',
      name: 'CNC Milling',
      labor_rate: 80,
      resource_group_id: null,
    },
    ...overrides,
  };
}

describe('calculateRoutingCost', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockQueryBuilder.data = null;
    mockQueryBuilder.error = null;
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
        run_time_per_unit: 30, // 30 min
        operation_type: { id: 'op-1', name: 'CNC Milling', labor_rate: 80, resource_group_id: null },
      }),
      makeNode({
        id: 'node-2',
        run_time_per_unit: 15, // 15 min
        operation_type: { id: 'op-2', name: 'Grinding', labor_rate: 60, resource_group_id: null },
      }),
    ];

    mockGetRoutingForPart.mockResolvedValue(makeRouting(nodes));

    const result = await calculateRoutingCost('part-1');

    expect(result).not.toBeNull();
    // Node 1: (30/60) * 80 = 40
    // Node 2: (15/60) * 60 = 15
    expect(result!.labor_items).toHaveLength(2);
    expect(result!.labor_items[0].cost).toBe(40);
    expect(result!.labor_items[1].cost).toBe(15);
    expect(result!.total_labor_cost).toBe(55);
    expect(result!.total_material_cost).toBe(0);
    expect(result!.total_cost).toBe(55);
    expect(result!.warnings).toHaveLength(0);
  });

  it('calculates labor + material costs correctly', async () => {
    const nodes = [
      makeNode({
        id: 'node-1',
        run_time_per_unit: 60,
        operation_type: { id: 'op-1', name: 'CNC Milling', labor_rate: 100, resource_group_id: null },
        materials: [
          { inventory_item_id: 'inv-1', quantity: 2, unit: 'kg' },
          { inventory_item_id: 'inv-2', quantity: 5, unit: 'ea' },
        ],
      }),
    ];

    mockGetRoutingForPart.mockResolvedValue(makeRouting(nodes));

    // Mock inventory items lookup
    mockQueryBuilder.data = [
      { id: 'inv-1', name: 'Steel Rod', cost_per_unit: 25, primary_unit: 'kg' },
      { id: 'inv-2', name: 'Bolt M6', cost_per_unit: 0.5, primary_unit: 'ea' },
    ];
    mockQueryBuilder.error = null;

    const result = await calculateRoutingCost('part-1');

    expect(result).not.toBeNull();
    // Labor: (60/60) * 100 = 100
    expect(result!.total_labor_cost).toBe(100);
    // Materials: (2 * 25) + (5 * 0.5) = 50 + 2.5 = 52.5
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
        operation_type: { id: 'op-1', name: 'Manual', labor_rate: null, resource_group_id: null },
      }),
    ];

    mockGetRoutingForPart.mockResolvedValue(makeRouting(nodes));
    const result = await calculateRoutingCost('part-1');

    expect(result!.labor_items).toHaveLength(0);
    expect(result!.warnings).toHaveLength(1);
    expect(result!.warnings[0].type).toBe('missing_labor_rate');
  });

  it('warns on missing run_time_per_unit', async () => {
    const nodes = [
      makeNode({ run_time_per_unit: null }),
    ];

    mockGetRoutingForPart.mockResolvedValue(makeRouting(nodes));
    const result = await calculateRoutingCost('part-1');

    expect(result!.labor_items).toHaveLength(0);
    expect(result!.warnings).toHaveLength(1);
    expect(result!.warnings[0].type).toBe('missing_run_time');
  });

  it('warns on missing inventory item cost', async () => {
    const nodes = [
      makeNode({
        materials: [{ inventory_item_id: 'inv-missing', quantity: 1, unit: 'ea' }],
      }),
    ];

    mockGetRoutingForPart.mockResolvedValue(makeRouting(nodes));
    mockQueryBuilder.data = [
      { id: 'inv-missing', name: 'Unknown Part', cost_per_unit: null, primary_unit: 'ea' },
    ];

    const result = await calculateRoutingCost('part-1');

    expect(result!.material_items).toHaveLength(0);
    expect(result!.warnings.some(w => w.type === 'missing_material_cost')).toBe(true);
  });

  it('warns when inventory item not found', async () => {
    const nodes = [
      makeNode({
        materials: [{ inventory_item_id: 'inv-nonexistent', quantity: 1, unit: 'ea' }],
      }),
    ];

    mockGetRoutingForPart.mockResolvedValue(makeRouting(nodes));
    mockQueryBuilder.data = []; // No items found

    const result = await calculateRoutingCost('part-1');

    expect(result!.material_items).toHaveLength(0);
    expect(result!.warnings.some(w => w.type === 'missing_material_cost')).toBe(true);
  });

  it('calculates setup cost separately from run cost', async () => {
    const nodes = [
      makeNode({
        run_time_per_unit: 30, // 30 min run
        setup_time: 60, // 60 min setup
        operation_type: { id: 'op-1', name: 'CNC Milling', labor_rate: 80, resource_group_id: null },
      }),
    ];

    mockGetRoutingForPart.mockResolvedValue(makeRouting(nodes));

    const result = await calculateRoutingCost('part-1');

    expect(result).not.toBeNull();
    // Run cost: (30/60) * 80 = 40
    expect(result!.labor_items[0].cost).toBe(40);
    // Setup cost: (60/60) * 80 = 80
    expect(result!.labor_items[0].setup_cost).toBe(80);
    expect(result!.labor_items[0].setup_time_minutes).toBe(60);
    expect(result!.total_labor_cost).toBe(40);
    expect(result!.total_setup_cost).toBe(80);
    // total_cost is per-unit only (excludes setup)
    expect(result!.total_cost).toBe(40);
  });

  it('returns zero setup cost when setup_time is 0', async () => {
    const nodes = [
      makeNode({
        run_time_per_unit: 30,
        setup_time: 0,
        operation_type: { id: 'op-1', name: 'Manual Deburring', labor_rate: 50, resource_group_id: null },
      }),
    ];

    mockGetRoutingForPart.mockResolvedValue(makeRouting(nodes));

    const result = await calculateRoutingCost('part-1');

    expect(result!.labor_items[0].setup_cost).toBe(0);
    expect(result!.labor_items[0].setup_time_minutes).toBe(0);
    expect(result!.total_setup_cost).toBe(0);
  });
});
