import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { CompanyToolEnv } from '@/lib/mcp/defineTool';
import { archiveRecord } from '@/lib/mcp/tools/archive';

/**
 * archive_record, run directly (the wrapper's guards are covered in defineTool.test.ts). What
 * matters here: each entity goes through the archive function its own page's Delete calls, with
 * the arguments it passes; the lookup is company-scoped and by id; an archived record is left
 * alone; and nothing is admin-only, as in the app.
 */

const archived = {
  softDeleteCustomer: vi.fn(),
  deleteVendor: vi.fn(),
  deletePart: vi.fn(),
  deleteQuote: vi.fn(),
  deleteJob: vi.fn(),
  deleteWorkCenter: vi.fn(),
};
vi.mock('@/utils/customerAccess', () => ({ softDeleteCustomer: (...a: unknown[]) => archived.softDeleteCustomer(...a) }));
vi.mock('@/utils/vendorsAccess', () => ({ deleteVendor: (...a: unknown[]) => archived.deleteVendor(...a) }));
vi.mock('@/utils/partsAccess', () => ({ deletePart: (...a: unknown[]) => archived.deletePart(...a) }));
vi.mock('@/utils/quotesAccess', () => ({ deleteQuote: (...a: unknown[]) => archived.deleteQuote(...a) }));
vi.mock('@/utils/jobsAccess', () => ({ deleteJob: (...a: unknown[]) => archived.deleteJob(...a) }));
vi.mock('@/utils/workCentersAccess', () => ({ deleteWorkCenter: (...a: unknown[]) => archived.deleteWorkCenter(...a) }));

let rows: Record<string, unknown> = {};
const queryCalls: Array<[string, string, unknown[]]> = [];
vi.mock('@/lib/supabase', () => {
  const chainFor = (table: string) => {
    const chain: Record<string, unknown> = {};
    for (const method of ['select', 'eq', 'is', 'limit']) {
      chain[method] = (...a: unknown[]) => (queryCalls.push([table, method, a]), chain);
    }
    chain.maybeSingle = async () => ({ data: rows[table] ?? null, error: null });
    return chain;
  };
  return { getSupabase: () => ({ from: (table: string) => chainFor(table) }), registerScopedClientResolver: () => {} };
});

const ID = '11111111-1111-1111-1111-111111111111';

function envAs(role: 'admin' | 'user'): CompanyToolEnv {
  return {
    caller: { token: 't', clientId: 'c', userId: 'u', email: null, expiresAt: 0 },
    company: { id: 'co-1', name: 'Acme Machining', role, isDemo: false, governingCompanyId: 'co-1' },
    origin: 'https://jigged.app',
    link: (path) => `https://jigged.app${path}`,
  };
}

const PERSON_FIELD = /(_by$|_by_|^author|^operator|^user_id$|^user_name$)/;

const CASES = [
  { entity: 'customer', table: 'customers', row: { name: 'Boeing' }, label: 'Boeing', fn: 'softDeleteCustomer', args: [ID], path: 'customers' },
  { entity: 'vendor', table: 'vendors', row: { name: 'Anodize Co' }, label: 'Anodize Co', fn: 'deleteVendor', args: [ID], path: 'vendors' },
  { entity: 'part', table: 'parts', row: { part_name: 'BRKT-100' }, label: 'BRKT-100', fn: 'deletePart', args: [ID], path: 'parts' },
  { entity: 'quote', table: 'quotes', row: { quote_number: 'Q-1042' }, label: 'Q-1042', fn: 'deleteQuote', args: [ID, 'co-1'], path: 'quotes' },
  { entity: 'job', table: 'jobs', row: { job_number: 'J-2207' }, label: 'J-2207', fn: 'deleteJob', args: [ID, 'co-1'], path: 'jobs' },
  { entity: 'work_center', table: 'work_centers', row: { name: 'Haas VF-2' }, label: 'Haas VF-2', fn: 'deleteWorkCenter', args: [ID], path: 'work-centers' },
] as const;

describe('archive_record', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rows = {};
    queryCalls.length = 0;
    for (const fn of Object.values(archived)) fn.mockResolvedValue(undefined);
  });

  it.each(CASES)('archives a $entity through $fn, the function its page calls', async (c) => {
    rows[c.table] = { ...c.row, deleted_at: null };
    // A user, not an admin: no Delete button in the app is admin-only.
    const res = await archiveRecord.run({ entity: c.entity, id: ID }, envAs('user'));
    if (!res.ok) throw new Error(res.message);
    expect(archived[c.fn]).toHaveBeenCalledWith(...c.args);
    for (const [name, fn] of Object.entries(archived)) {
      if (name !== c.fn) expect(fn).not.toHaveBeenCalled();
    }
    expect(res.data).toEqual({
      entity: c.entity,
      id: ID,
      name_or_number: c.label,
      archived: true,
      url: `https://jigged.app/dashboard/co-1/${c.path}/${ID}`,
    });
    expect(Object.keys(res.data).filter((k) => PERSON_FIELD.test(k))).toEqual([]);
    // Found by id within this company, archived or not (no deleted_at filter on a by-id read).
    expect(queryCalls).toContainEqual([c.table, 'eq', ['company_id', 'co-1']]);
    expect(queryCalls).toContainEqual([c.table, 'eq', ['id', ID]]);
    expect(queryCalls.some(([, m]) => m === 'is')).toBe(false);
  });

  it('leaves an archived record alone, so its archive time stands', async () => {
    rows.jobs = { job_number: 'J-2207', deleted_at: '2026-10-01T00:00:00Z' };
    expect(await archiveRecord.run({ entity: 'job', id: ID }, envAs('admin'))).toEqual({
      ok: false,
      message: 'The job J-2207 is already archived, so nothing was changed.',
    });
    expect(archived.deleteJob).not.toHaveBeenCalled();
  });

  it("does not find a record that isn't in this company", async () => {
    expect(await archiveRecord.run({ entity: 'work_center', id: ID }, envAs('admin'))).toEqual({
      ok: false,
      message: 'There is no work center with that id in Acme Machining.',
    });
    expect(archived.deleteWorkCenter).not.toHaveBeenCalled();
  });

  it("lets the access layer's own refusal through", async () => {
    rows.parts = { part_name: 'BRKT-100', deleted_at: null };
    archived.deletePart.mockRejectedValue(new Error('Failed to archive these parts.'));
    await expect(archiveRecord.run({ entity: 'part', id: ID }, envAs('user'))).rejects.toThrow('Failed to archive these parts.');
  });
});
