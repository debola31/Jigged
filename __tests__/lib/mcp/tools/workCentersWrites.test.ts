import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { CompanyToolEnv } from '@/lib/mcp/defineTool';
import { createWorkCenter, updateWorkCenter } from '@/lib/mcp/tools/workCentersWrites';
import type { WorkCenter } from '@/types/workCenter';

/**
 * create_work_center and update_work_center, run directly. What matters here: the work center
 * form's own access functions get the form's values, its name check refuses first, an edit writes
 * the whole form back seeded from the saved row, and nothing names a person.
 */

const wcAccess = {
  checkWorkCenterNameExists: vi.fn(),
  createWorkCenter: vi.fn(),
  updateWorkCenter: vi.fn(),
  getWorkCenter: vi.fn(),
};
vi.mock('@/utils/workCentersAccess', () => ({
  checkWorkCenterNameExists: (...a: unknown[]) => wcAccess.checkWorkCenterNameExists(...a),
  createWorkCenter: (...a: unknown[]) => wcAccess.createWorkCenter(...a),
  updateWorkCenter: (...a: unknown[]) => wcAccess.updateWorkCenter(...a),
  getWorkCenter: (...a: unknown[]) => wcAccess.getWorkCenter(...a),
}));

type Row = Record<string, unknown>;
let db: Record<string, Row[]> = {};

vi.mock('@/lib/supabase', () => {
  const from = (table: string) => {
    const filters: Array<(r: Row) => boolean> = [];
    let cap = Number.POSITIVE_INFINITY;
    const rows = () => (db[table] ?? []).filter((r) => filters.every((f) => f(r))).slice(0, cap);
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: (col: string, val: unknown) => {
        filters.push((r) => r[col] === val);
        return chain;
      },
      ilike: (col: string, pattern: string) => {
        const wanted = pattern.replace(/\\([%_\\])/g, '$1').toLowerCase();
        filters.push((r) => String(r[col]).toLowerCase() === wanted);
        return chain;
      },
      limit: (n: number) => {
        cap = n;
        return chain;
      },
      maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
      then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
        Promise.resolve({ data: rows(), error: null }).then(resolve, reject),
    };
    return chain;
  };
  return { getSupabase: () => ({ from }), registerScopedClientResolver: () => {} };
});

const env: CompanyToolEnv = {
  caller: { token: 't', clientId: 'c', userId: 'u-1', email: null, expiresAt: 0 },
  company: { id: 'co-1', name: 'Acme Machining', role: 'user', isDemo: false, governingCompanyId: 'co-1' },
  origin: 'https://jigged.app',
  link: (path) => `https://jigged.app${path}`,
};

function wc(overrides: Partial<WorkCenter>): WorkCenter {
  return {
    id: 'wc-1',
    company_id: 'co-1',
    name: 'Haas VF-2',
    labor_rate: 85,
    description: null,
    make: 'Haas',
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

const PERSON = /(_by|_by_name|author.*|operator.*|^user_id|^user_name)$/;

beforeEach(() => {
  vi.clearAllMocks();
  db = {
    work_centers: [
      { id: 'wc-1', company_id: 'co-1', name: 'Haas VF-2', deleted_at: null },
      { id: 'wc-2', company_id: 'co-1', name: 'Old Lathe', deleted_at: '2026-01-01T00:00:00Z' },
      { id: 'wc-x', company_id: 'co-other', name: 'Elsewhere', deleted_at: null },
    ],
  };
  wcAccess.checkWorkCenterNameExists.mockResolvedValue(false);
  wcAccess.getWorkCenter.mockImplementation(async (id: string) =>
    id === 'wc-1' ? wc({}) : id === 'wc-2' ? wc({ id: 'wc-2', name: 'Old Lathe', make: null }) : null,
  );
});

describe('create_work_center', () => {
  it('creates through createWorkCenter with what the form passes', async () => {
    wcAccess.createWorkCenter.mockResolvedValue(
      wc({ id: 'wc-9', name: 'Okuma LB3000', labor_rate: 95, make: 'Okuma', year_built: 2019, purchased_on: '2020-03-01' }),
    );
    const res = await createWorkCenter.run(
      { name: ' Okuma LB3000 ', labor_rate_per_hour: 95, make: 'Okuma', year_built: 2019, purchased_on: '2020-03-01' },
      env,
    );
    if (!res.ok) throw new Error(res.message);
    expect(wcAccess.checkWorkCenterNameExists).toHaveBeenCalledWith('co-1', 'Okuma LB3000');
    expect(wcAccess.createWorkCenter).toHaveBeenCalledWith('co-1', {
      name: 'Okuma LB3000',
      labor_rate: '95',
      description: '',
      make: 'Okuma',
      model: '',
      serial_number: '',
      year_built: '2019',
      purchased_on: '2020-03-01',
    });
    expect(res.data).toEqual({
      work_center_id: 'wc-9',
      name: 'Okuma LB3000',
      description: null,
      labor_rate_per_hour: 95,
      make: 'Okuma',
      model: null,
      serial_number: null,
      year_built: 2019,
      purchased_on: '2020-03-01',
      url: 'https://jigged.app/dashboard/co-1/work-centers/wc-9',
    });
    expect(Object.keys(res.data).filter((k) => PERSON.test(k))).toEqual([]);
  });

  it('refuses a name a live work center has, and a blank one', async () => {
    wcAccess.checkWorkCenterNameExists.mockResolvedValue(true);
    expect(await createWorkCenter.run({ name: 'Haas VF-2', labor_rate_per_hour: 85 }, env)).toEqual({
      ok: false,
      message: 'Acme Machining already has a work center named Haas VF-2. Work center names are unique.',
    });
    expect(await createWorkCenter.run({ name: '  ', labor_rate_per_hour: 85 }, env)).toEqual({
      ok: false,
      message: 'A work center needs a name.',
    });
    expect(wcAccess.createWorkCenter).not.toHaveBeenCalled();
  });

  it('holds the database\'s year range in its input', () => {
    const year = createWorkCenter.input.year_built;
    expect(year.safeParse(1899).success).toBe(false);
    expect(year.safeParse(2019).success).toBe(true);
    expect(createWorkCenter.input.labor_rate_per_hour.safeParse(-1).success).toBe(false);
  });
});

describe('update_work_center', () => {
  it('writes the whole form back through updateWorkCenter, seeded from the saved row', async () => {
    wcAccess.updateWorkCenter.mockImplementation(async (id: string) => wc({ id, labor_rate: 90, model: 'VF-2SS', make: null }));
    const res = await updateWorkCenter.run(
      { work_center_name: 'haas vf-2', labor_rate_per_hour: 90, model: 'VF-2SS', make: null },
      env,
    );
    if (!res.ok) throw new Error(res.message);
    expect(wcAccess.getWorkCenter).toHaveBeenCalledWith('wc-1');
    expect(wcAccess.updateWorkCenter).toHaveBeenCalledWith('wc-1', {
      name: 'Haas VF-2',
      labor_rate: '90',
      description: '',
      make: '',
      model: 'VF-2SS',
      serial_number: '',
      year_built: '',
      purchased_on: '',
    });
    expect(res.data).toMatchObject({
      work_center_id: 'wc-1',
      labor_rate_per_hour: 90,
      archived: false,
      changed: ['labor_rate_per_hour', 'make', 'model'],
      url: 'https://jigged.app/dashboard/co-1/work-centers/wc-1',
    });
    expect(Object.keys(res.data).filter((k) => PERSON.test(k))).toEqual([]);
  });

  it('renames after checking the name against the others, by id', async () => {
    wcAccess.updateWorkCenter.mockImplementation(async (id: string, form: { name: string }) => wc({ id, name: form.name }));
    const res = await updateWorkCenter.run({ work_center_id: 'wc-1', name: 'Mill 1' }, env);
    if (!res.ok) throw new Error(res.message);
    expect(wcAccess.checkWorkCenterNameExists).toHaveBeenCalledWith('co-1', 'Mill 1', 'wc-1');
    expect(res.data.changed).toEqual(['name']);

    wcAccess.checkWorkCenterNameExists.mockResolvedValue(true);
    expect(await updateWorkCenter.run({ work_center_id: 'wc-1', name: 'Mill 2' }, env)).toEqual({
      ok: false,
      message: 'Acme Machining already has a work center named Mill 2. Work center names are unique.',
    });
  });

  it('finds an archived work center by name and says so', async () => {
    wcAccess.updateWorkCenter.mockImplementation(async (id: string) => wc({ id, name: 'Old Lathe', description: 'Spare' }));
    const res = await updateWorkCenter.run({ work_center_name: 'Old Lathe', description: 'Spare' }, env);
    if (!res.ok) throw new Error(res.message);
    expect(res.data.archived).toBe(true);
  });

  it('refuses a call with nothing to change, one not in the company, and writes nothing when already so', async () => {
    expect(await updateWorkCenter.run({ work_center_id: 'wc-1' }, env)).toEqual({
      ok: false,
      message: expect.stringMatching(/^Give at least one field to change/),
    });
    expect(await updateWorkCenter.run({ work_center_name: 'Elsewhere', make: 'x' }, env)).toEqual({
      ok: false,
      message: 'There is no work center named Elsewhere in Acme Machining.',
    });
    const same = await updateWorkCenter.run({ work_center_id: 'wc-1', labor_rate_per_hour: 85, make: 'Haas' }, env);
    if (!same.ok) throw new Error(same.message);
    expect(same.data.changed).toEqual([]);
    expect(wcAccess.updateWorkCenter).not.toHaveBeenCalled();
  });
});

// Nothing here is admin-only: the work center pages and form have no admin guard, and every run
// above is as a `user`.
