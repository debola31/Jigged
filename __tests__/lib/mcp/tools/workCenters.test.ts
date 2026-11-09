import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { CompanyToolEnv } from '@/lib/mcp/defineTool';
import { listWorkCenters } from '@/lib/mcp/tools/workCenters';
import type { WorkCenter } from '@/types/workCenter';

/**
 * list_work_centers, run directly. What matters here: the search reaches the access function,
 * the routing-step count is joined on and sorted by, the page and links, and a failed count read
 * fails rather than reporting zero everywhere.
 */

const mockGetAll = vi.fn();
vi.mock('@/utils/workCentersAccess', () => ({
  getAllWorkCenters: (...a: unknown[]) => mockGetAll(...a),
}));

let usage: { data: Array<{ work_center_id: string; uses: number }> | null; error: { message: string } | null } = {
  data: [],
  error: null,
};
const mockRpc = vi.fn();
vi.mock('@/lib/supabase', () => ({
  getSupabase: () => ({
    rpc: async (...a: unknown[]) => {
      mockRpc(...a);
      return usage;
    },
  }),
  registerScopedClientResolver: () => {},
}));

const env: CompanyToolEnv = {
  caller: { token: 't', clientId: 'c', userId: 'u', email: null, expiresAt: 0 },
  company: { id: 'co-1', name: 'Acme Machining', role: 'user', isDemo: false, governingCompanyId: 'co-1' },
  link: (path) => `https://jigged.app${path}`,
};

function wc(overrides: Partial<WorkCenter>): WorkCenter {
  return {
    id: 'wc-1',
    company_id: 'co-1',
    name: 'Haas VF-2',
    labor_rate: 85,
    description: null,
    make: null,
    model: null,
    serial_number: null,
    year_built: null,
    purchased_on: null,
    metadata: {},
    created_at: '',
    updated_at: '',
    ...overrides,
  };
}

describe('list_work_centers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    usage = { data: [], error: null };
  });

  it('lists work centers by name with their rate, routing-step count and a link', async () => {
    mockGetAll.mockResolvedValue([
      wc({ id: 'a', name: 'Deburr bench', labor_rate: null }),
      wc({ id: 'b', name: 'Haas VF-2', make: 'Haas', model: 'VF-2', description: 'Main mill' }),
    ]);
    usage = { data: [{ work_center_id: 'b', uses: 12 }], error: null };
    const res = await listWorkCenters.run({ search: 'ha' }, env);
    if (!res.ok) throw new Error('expected a page');
    expect(mockGetAll).toHaveBeenCalledWith('co-1', 'ha');
    expect(mockRpc).toHaveBeenCalledWith('work_center_usage', { p_company_id: 'co-1' });
    expect(res.data.work_centers).toEqual([
      {
        work_center_id: 'a',
        name: 'Deburr bench',
        description: null,
        labor_rate_per_hour: null,
        make: null,
        model: null,
        routing_steps: 0,
        url: 'https://jigged.app/dashboard/co-1/work-centers/a',
      },
      {
        work_center_id: 'b',
        name: 'Haas VF-2',
        description: 'Main mill',
        labor_rate_per_hour: 85,
        make: 'Haas',
        model: 'VF-2',
        routing_steps: 12,
        url: 'https://jigged.app/dashboard/co-1/work-centers/b',
      },
    ]);
    expect(res.data.total).toBe(2);
  });

  it('sorts by most routing steps on request, then by name', async () => {
    mockGetAll.mockResolvedValue([wc({ id: 'a', name: 'A' }), wc({ id: 'b', name: 'B' }), wc({ id: 'c', name: 'C' })]);
    usage = { data: [{ work_center_id: 'c', uses: 9 }, { work_center_id: 'b', uses: 9 }, { work_center_id: 'a', uses: 1 }], error: null };
    const res = await listWorkCenters.run({ sort: 'most_routed' }, env);
    if (!res.ok) throw new Error('expected a page');
    expect(res.data.work_centers.map((w) => [w.name, w.routing_steps])).toEqual([
      ['B', 9],
      ['C', 9],
      ['A', 1],
    ]);
  });

  it('pages with a cursor and refuses one it did not issue', async () => {
    mockGetAll.mockResolvedValue(Array.from({ length: 3 }, (_, i) => wc({ id: `w${i}`, name: `W-${i}` })));
    const first = await listWorkCenters.run({ limit: 2 }, env);
    if (!first.ok) throw new Error('expected a page');
    expect(first.data.work_centers.map((w) => w.name)).toEqual(['W-0', 'W-1']);
    expect(first.data.next_cursor).toBe('2');
    expect(await listWorkCenters.run({ cursor: '-1' }, env)).toEqual({ ok: false, message: expect.stringMatching(/cursor/) });
  });

  it('fails when the routing-step count cannot be read, rather than reporting zero', async () => {
    mockGetAll.mockResolvedValue([wc({})]);
    usage = { data: null, error: { message: 'statement timeout' } };
    await expect(listWorkCenters.run({}, env)).rejects.toMatchObject({ message: 'statement timeout' });
  });
});
