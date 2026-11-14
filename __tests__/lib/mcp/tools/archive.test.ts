import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';

import type { CompanyToolEnv } from '@/lib/mcp/defineTool';
import { archiveRecord } from '@/lib/mcp/tools/archive';

import { resolvesToPage } from './purchasingTestKit';

/**
 * archive_record, run directly (the wrapper's guards are covered in defineTool.test.ts). What
 * matters here: each entity goes through the archive function its own page's Delete calls, with
 * the arguments it passes; the lookup is company-scoped and by id; an archived record is left
 * alone; nothing is admin-only, as in the app; and a purchase order to a vendor that is in
 * QuickBooks says it stays open there (archive never calls QuickBooks).
 */

const archived = {
  softDeleteCustomer: vi.fn(),
  deleteVendor: vi.fn(),
  deletePart: vi.fn(),
  deleteQuote: vi.fn(),
  deleteJob: vi.fn(),
  deleteWorkCenter: vi.fn(),
  archiveVendorPo: vi.fn(),
  setVendorRfqState: vi.fn(),
  archivePartVendor: vi.fn(),
};
const mockImpact = vi.fn();
vi.mock('@/utils/customerAccess', () => ({ softDeleteCustomer: (...a: unknown[]) => archived.softDeleteCustomer(...a) }));
vi.mock('@/utils/vendorsAccess', () => ({ deleteVendor: (...a: unknown[]) => archived.deleteVendor(...a) }));
vi.mock('@/utils/partsAccess', () => ({ deletePart: (...a: unknown[]) => archived.deletePart(...a) }));
vi.mock('@/utils/quotesAccess', () => ({ deleteQuote: (...a: unknown[]) => archived.deleteQuote(...a) }));
vi.mock('@/utils/jobsAccess', () => ({ deleteJob: (...a: unknown[]) => archived.deleteJob(...a) }));
vi.mock('@/utils/workCentersAccess', () => ({ deleteWorkCenter: (...a: unknown[]) => archived.deleteWorkCenter(...a) }));
vi.mock('@/utils/vendorPoAccess', () => ({
  archiveVendorPo: (...a: unknown[]) => archived.archiveVendorPo(...a),
  getVendorPoArchiveImpact: (...a: unknown[]) => mockImpact(...a),
}));
vi.mock('@/utils/vendorRfqAccess', () => ({ setVendorRfqState: (...a: unknown[]) => archived.setVendorRfqState(...a) }));
vi.mock('@/utils/partVendorsAccess', () => ({ archivePartVendor: (...a: unknown[]) => archived.archivePartVendor(...a) }));

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

function impact(overrides: Record<string, unknown> = {}) {
  return {
    poNumber: 'PO-1042',
    vendorName: 'Acme Metals',
    wasSent: true,
    issuedAt: '2026-11-02T15:00:00Z',
    receiptCount: 0,
    linkedSlipCount: 0,
    inQuickBooks: false,
    quickbooksDocNumber: null,
    closedInQuickBooks: false,
    isArchived: false,
    ...overrides,
  };
}

const CASES = [
  { entity: 'customer', table: 'customers', row: { name: 'Boeing' }, label: 'Boeing', fn: 'softDeleteCustomer', args: [ID], url: `customers/${ID}` },
  { entity: 'vendor', table: 'vendors', row: { name: 'Anodize Co' }, label: 'Anodize Co', fn: 'deleteVendor', args: [ID], url: `vendors/${ID}` },
  { entity: 'part', table: 'parts', row: { part_name: 'BRKT-100' }, label: 'BRKT-100', fn: 'deletePart', args: [ID], url: `parts/${ID}` },
  { entity: 'quote', table: 'quotes', row: { quote_number: 'Q-1042' }, label: 'Q-1042', fn: 'deleteQuote', args: [ID, 'co-1'], url: `quotes/${ID}` },
  { entity: 'job', table: 'jobs', row: { job_number: 'J-2207' }, label: 'J-2207', fn: 'deleteJob', args: [ID, 'co-1'], url: `jobs/${ID}` },
  { entity: 'work_center', table: 'work_centers', row: { name: 'Haas VF-2' }, label: 'Haas VF-2', fn: 'deleteWorkCenter', args: [ID], url: `work-centers/${ID}` },
  {
    entity: 'vendor_po',
    table: 'vendor_purchase_orders',
    row: { po_number: 'PO-1042' },
    label: 'PO-1042',
    fn: 'archiveVendorPo',
    args: [ID],
    url: `purchasing/orders/${ID}`,
  },
  {
    entity: 'vendor_rfq',
    table: 'vendor_rfqs',
    row: { rfq_number: 'RFQ-0004' },
    label: 'RFQ-0004',
    fn: 'setVendorRfqState',
    args: [ID, 'archive'],
    url: `purchasing/rfqs/${ID}`,
  },
  {
    entity: 'part_vendor',
    table: 'part_vendors',
    row: { part_id: 'part-1', parts: { part_name: 'BRKT-100' }, vendors: { name: 'Anodize Co' } },
    label: 'Anodize Co for BRKT-100',
    fn: 'archivePartVendor',
    args: [ID],
    // The approved vendor list lives on the part's page (its Buying tab).
    url: 'parts/part-1',
  },
] as const;

describe('archive_record', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rows = {};
    queryCalls.length = 0;
    for (const fn of Object.values(archived)) fn.mockResolvedValue(undefined);
    archived.archivePartVendor.mockResolvedValue({ partVendorId: ID, archived: true, clearedPreferred: false });
    mockImpact.mockResolvedValue(impact());
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
      warnings: [],
      url: `https://jigged.app/dashboard/co-1/${c.url}`,
    });
    expect(resolvesToPage(res.data.url ?? '')).toBe(true);
    expect(() => z.object(archiveRecord.output).parse(res.data)).not.toThrow();
    expect(Object.keys(res.data).filter((k) => PERSON_FIELD.test(k))).toEqual([]);
    // Found by id within this company, archived or not (no deleted_at filter on a by-id read).
    expect(queryCalls).toContainEqual([c.table, 'eq', ['company_id', 'co-1']]);
    expect(queryCalls).toContainEqual([c.table, 'eq', ['id', ID]]);
    expect(queryCalls.some(([, m]) => m === 'is')).toBe(false);
  });

  it("says a vendor PO stays open in QuickBooks, and which slips it lets go, without calling QuickBooks", async () => {
    rows.vendor_purchase_orders = { po_number: 'PO-1042', deleted_at: null };
    mockImpact.mockResolvedValue(impact({ inQuickBooks: true, quickbooksDocNumber: '1042', linkedSlipCount: 2 }));
    const res = await archiveRecord.run({ entity: 'vendor_po', id: ID }, envAs('user'));
    if (!res.ok) throw new Error(res.message);
    expect(mockImpact).toHaveBeenCalledWith(ID);
    expect(res.data.warnings).toEqual([
      'PO-1042 stays open in QuickBooks; close it there.',
      '2 vendor slips that shipped against it are no longer linked to it; they stay on their jobs.',
    ]);

    mockImpact.mockResolvedValue(impact({ inQuickBooks: true, closedInQuickBooks: true, linkedSlipCount: 1 }));
    const closed = await archiveRecord.run({ entity: 'vendor_po', id: ID }, envAs('user'));
    expect(closed.ok && closed.data.warnings).toEqual([
      '1 vendor slip that shipped against it is no longer linked to it; it stays on its job.',
    ]);
  });

  it("says when archiving an approved-vendor entry cleared the part's preferred vendor", async () => {
    rows.part_vendors = { part_id: 'part-1', parts: { part_name: 'BRKT-100' }, vendors: { name: 'Anodize Co' }, deleted_at: null };
    archived.archivePartVendor.mockResolvedValue({ partVendorId: ID, archived: true, clearedPreferred: true });
    const res = await archiveRecord.run({ entity: 'part_vendor', id: ID }, envAs('user'));
    expect(res.ok && res.data.warnings).toEqual(["Anodize Co was BRKT-100's preferred vendor, so the part has none now."]);
  });

  it('leaves an archived record alone, so its archive time stands', async () => {
    rows.jobs = { job_number: 'J-2207', deleted_at: '2026-10-01T00:00:00Z' };
    expect(await archiveRecord.run({ entity: 'job', id: ID }, envAs('admin'))).toEqual({
      ok: false,
      message: 'The job J-2207 is already archived, so nothing was changed.',
    });
    expect(archived.deleteJob).not.toHaveBeenCalled();
    rows.vendor_purchase_orders = { po_number: 'PO-1042', deleted_at: '2026-10-01T00:00:00Z' };
    expect(await archiveRecord.run({ entity: 'vendor_po', id: ID }, envAs('admin'))).toEqual({
      ok: false,
      message: 'The vendor PO PO-1042 is already archived, so nothing was changed.',
    });
    expect(archived.archiveVendorPo).not.toHaveBeenCalled();
  });

  it("does not find a record that isn't in this company", async () => {
    expect(await archiveRecord.run({ entity: 'work_center', id: ID }, envAs('admin'))).toEqual({
      ok: false,
      message: 'There is no work center with that id in Acme Machining.',
    });
    expect(await archiveRecord.run({ entity: 'vendor_rfq', id: ID }, envAs('admin'))).toEqual({
      ok: false,
      message: 'There is no RFQ with that id in Acme Machining.',
    });
    expect(archived.deleteWorkCenter).not.toHaveBeenCalled();
    expect(archived.setVendorRfqState).not.toHaveBeenCalled();
  });

  it("lets the access layer's own refusal through", async () => {
    rows.parts = { part_name: 'BRKT-100', deleted_at: null };
    archived.deletePart.mockRejectedValue(new Error('Failed to archive these parts.'));
    await expect(archiveRecord.run({ entity: 'part', id: ID }, envAs('user'))).rejects.toThrow('Failed to archive these parts.');
  });

  it("names the vendor PO as one to a vendor, so it can't be read as a customer's PO", () => {
    expect(archiveRecord.description).toMatch(/purchase order to a vendor/);
  });
});
