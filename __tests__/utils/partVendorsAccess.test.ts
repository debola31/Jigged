/**
 * Approved vendors, price sheets and "Use as part cost" — access layer (criteria V1–V3, L1).
 *
 * The test that matters most: `applyPartCostFromVendor` goes through
 * `apply_part_cost_from_vendor` and NEVER through `from('part_pricing_tiers')` — the browser path
 * the earlier design used had no staleness check and no office check. And counts throw rather
 * than claiming 0 ("couldn't count" is never "nothing affected").
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { stub, PURCHASING_TABLES } from './purchasingTestStub';

const { mockCapture } = vi.hoisted(() => ({ mockCapture: vi.fn() }));

vi.mock('@/lib/supabase', async () => {
  const { stub: s } = await import('./purchasingTestStub');
  return { getSupabase: () => s.client, createClient: () => s.client, supabase: s.client };
});
vi.mock('@sentry/nextjs', () => ({ captureException: mockCapture }));

import {
  applyPartCostFromVendor,
  archivePartVendor,
  countBomParents,
  countOpenQuotesWithPart,
  listPartVendors,
  listVendorParts,
  previewPartCostFromVendor,
  savePartVendor,
  toSourcingPreview,
} from '@/utils/partVendorsAccess';
import { sourcingPreviewRows } from '@/lib/purchasing/sourcing';

const TODAY = '2026-11-09';

beforeEach(() => {
  vi.clearAllMocks();
  stub.reset();
});

function expectNoPurchasingTableWrites() {
  expect(stub.writes().filter((w) => PURCHASING_TABLES.includes(w.table))).toEqual([]);
}

describe('listPartVendors', () => {
  function queue() {
    stub.queue('parts', {
      data: [{ id: 'part-bar', part_name: 'BAR-6061', source: 'bought', primary_unit: 'inches', preferred_vendor_id: 'v-2', parts_unit_conversions: [{ from_unit: 'bar', to_primary_factor: 144 }] }],
    });
    stub.queue('part_vendors', {
      data: [
        { id: 'pv-1', part_id: 'part-bar', vendor_id: 'v-1', status: 'conditional', status_note: 'late twice', vendor_part_number: 'A-1', purchase_unit: 'Bar', lead_time_days: 5, minimum_order_quantity: 2, quoted_on: '2026-09-01', valid_until: '2026-10-31', notes: null, created_at: 'c', updated_at: 'u', vendors: { id: 'v-1', name: 'Acme Steel', deleted_at: null }, part_vendor_price_breaks: [{ id: 'b2', min_quantity: 10, unit_price: 50, source: 'manual', vendor_rfq_response_id: null }, { id: 'b1', min_quantity: 1, unit_price: 60, source: 'rfq', vendor_rfq_response_id: 'resp-1' }] },
        { id: 'pv-2', part_id: 'part-bar', vendor_id: 'v-2', status: 'approved', status_note: null, vendor_part_number: null, purchase_unit: 'inches', lead_time_days: null, minimum_order_quantity: null, quoted_on: null, valid_until: null, notes: null, created_at: 'c', updated_at: 'u', vendors: { id: 'v-2', name: 'Beta Metals', deleted_at: null }, part_vendor_price_breaks: [] },
      ],
    });
    stub.queue('part_vendor_last_purchase', {
      data: [{ vendor_id: 'v-1', vendor_purchase_order_id: 'po-1', po_number: 'PO-0040', ordered_on: '2026-10-01', vendor_purchase_order_line_id: 'l-1', quantity: 3, unit: 'bar', unit_price: 55, unit_price_per_stock_unit: 0.381944, stock_unit: 'inches', stock_factor: 144 }],
    });
  }

  it('lists live rows of live vendors, preferred first, with breaks, sheet dates and Last PO price', async () => {
    queue();
    const list = await listPartVendors('part-bar', { today: TODAY });
    expect(stub.callsOf('part_vendors', 'is')).toEqual([
      ['deleted_at', null],
      ['vendors.deleted_at', null],
    ]);
    expect(list?.rows.map((r) => r.vendorName)).toEqual(['Beta Metals', 'Acme Steel']);
    const acme = list!.rows[1];
    expect(acme).toMatchObject({
      status: 'conditional',
      // Stored as "Bar", the part's conversion is "bar": the same unit, as the database says.
      purchaseFactor: 144,
      factorLabel: '1 bar = 144 in',
      isExpired: true,
      isPreferred: false,
      lastPurchase: { poNumber: 'PO-0040', unitPrice: 55 },
    });
    expect(acme.breaks.map((b) => b.minQuantity)).toEqual([1, 10]);
    expect(list!.rows[0]).toMatchObject({ isPreferred: true, factorLabel: null, purchaseFactor: 1 });
    expect(list!.preferredVendorMissing).toBe(false);
  });

  it('flags a preferred vendor that is not among the live rows (its vendor is archived)', async () => {
    stub.queue('parts', { data: [{ id: 'part-bar', part_name: 'BAR', source: 'bought', primary_unit: 'inches', preferred_vendor_id: 'v-9', parts_unit_conversions: [] }] });
    stub.queue('part_vendors', { data: [] });
    const list = await listPartVendors('part-bar', { today: TODAY });
    expect(list?.preferredVendorMissing).toBe(true);
  });

  it('throws on a failed read', async () => {
    stub.queue('part_vendors', { error: { code: '08006', message: 'connection failure' } });
    await expect(listPartVendors('part-bar', { today: TODAY })).rejects.toThrow("Failed to load the part's vendors.");
  });
});

describe('listVendorParts', () => {
  it("lists the vendor's live rows on live parts, by part name", async () => {
    stub.queue('part_vendors', {
      data: [
        { id: 'pv-2', part_id: 'p-2', status: 'approved', vendor_part_number: null, purchase_unit: 'each', lead_time_days: null, minimum_order_quantity: null, quoted_on: null, valid_until: null, parts: { id: 'p-2', part_name: 'Z-10', description: null, source: 'bought', deleted_at: null, preferred_vendor_id: 'v-1' } },
        { id: 'pv-1', part_id: 'p-1', status: 'disapproved', vendor_part_number: 'X', purchase_unit: 'each', lead_time_days: 3, minimum_order_quantity: 10, quoted_on: null, valid_until: '2027-01-01', parts: { id: 'p-1', part_name: 'A-2', description: 'Washer', source: 'bought', deleted_at: null, preferred_vendor_id: null } },
      ],
    });
    const rows = await listVendorParts('v-1', { today: TODAY });
    expect(stub.callsOf('part_vendors', 'eq')).toEqual([['vendor_id', 'v-1']]);
    expect(stub.callsOf('part_vendors', 'is')).toEqual([
      ['deleted_at', null],
      ['parts.deleted_at', null],
    ]);
    expect(rows.map((r) => [r.partName, r.status, r.isPreferred])).toEqual([
      ['A-2', 'disapproved', false],
      ['Z-10', 'approved', true],
    ]);
  });
});

describe('savePartVendor', () => {
  it('goes through save_part_vendor; a given sheet replaces the whole sheet', async () => {
    stub.queue('parts', { data: [{ id: 'part-bar', part_name: 'BAR', primary_unit: 'inches', parts_unit_conversions: [{ from_unit: 'bar', to_primary_factor: 144 }] }] });
    stub.rpc.mockResolvedValue({ data: { part_vendor_id: 'pv-1', created: false, revived: true, preferred: true }, error: null });

    const result = await savePartVendor({
      partId: 'part-bar',
      vendorId: 'v-1',
      changes: { status: 'approved', purchaseUnit: 'BAR', leadTimeDays: 7, validUntil: null },
      priceBreaks: [{ minQuantity: 1, unitPrice: 60 }, { minQuantity: 10, unitPrice: 50 }],
      makePreferred: true,
    });

    expect(stub.rpc).toHaveBeenCalledWith('save_part_vendor', {
      p_part_id: 'part-bar',
      p_vendor_id: 'v-1',
      p_changes: { status: 'approved', purchase_unit: 'bar', lead_time_days: 7, valid_until: null },
      p_price_breaks: [{ min_quantity: 1, unit_price: 60 }, { min_quantity: 10, unit_price: 50 }],
      p_make_preferred: true,
    });
    // Revive is the RPC's job: adding the same vendor again brings the archived row back.
    expect(result).toEqual({ partVendorId: 'pv-1', created: false, revived: true, preferred: true });
    expectNoPurchasingTableWrites();
  });

  it('leaves the sheet alone when no breaks are given', async () => {
    stub.rpc.mockResolvedValue({ data: { part_vendor_id: 'pv-1', created: true, revived: false, preferred: false }, error: null });
    await savePartVendor({ partId: 'part-bar', vendorId: 'v-1', changes: { vendorPartNumber: 'A-1' } });
    expect(stub.rpc.mock.calls[0][1].p_price_breaks).toBeUndefined();
    expect(stub.rpc.mock.calls[0][1].p_make_preferred).toBe(false);
  });

  it('stores a preset sheet unit as the part conversion first', async () => {
    stub.queue('parts', { data: [{ id: 'part-screw', part_name: 'SCREW', primary_unit: 'each', parts_unit_conversions: [] }] });
    stub.queue('parts_unit_conversions', { data: [] });
    stub.rpc.mockResolvedValue({ data: { part_vendor_id: 'pv-1', created: true, revived: false, preferred: false }, error: null });
    await savePartVendor({ partId: 'part-screw', vendorId: 'v-1', changes: { purchaseUnit: 'hundred' } });
    expect(stub.callsOf('parts_unit_conversions', 'insert')).toEqual([[{ part_id: 'part-screw', from_unit: 'hundred', to_primary_factor: 100 }]]);
    expect(stub.rpc.mock.calls[0][1].p_changes).toEqual({ purchase_unit: 'hundred' });
  });

  it('a Do-not-use refusal keeps its sentence and is not reported', async () => {
    stub.rpc.mockResolvedValue({
      data: null,
      error: { code: 'P0001', message: 'Acme is the preferred vendor for BAR. Choose another preferred vendor before marking it Do not use.' },
    });
    await expect(savePartVendor({ partId: 'p', vendorId: 'v', changes: { status: 'disapproved' } })).rejects.toThrow(/preferred vendor for BAR/);
    expect(mockCapture).not.toHaveBeenCalled();
  });
});

describe('archivePartVendor', () => {
  it('goes through archive_part_vendor and says whether the preference was cleared', async () => {
    stub.rpc.mockResolvedValue({ data: { part_vendor_id: 'pv-1', archived: true, cleared_preferred: true }, error: null });
    await expect(archivePartVendor('pv-1')).resolves.toEqual({ partVendorId: 'pv-1', archived: true, clearedPreferred: true });
    expect(stub.rpc).toHaveBeenCalledWith('archive_part_vendor', { p_part_vendor_id: 'pv-1' });
    expect(stub.writes()).toEqual([]);
  });
});

describe('"Use as part cost"', () => {
  const preview = {
    part_vendor_id: 'pv-1',
    part_id: 'part-bar',
    part_name: 'BAR-6061',
    vendor_id: 'v-1',
    vendor_name: 'Acme',
    purchase_unit: 'bar',
    stock_unit: 'inches',
    stock_factor: 144,
    quoted_on: null,
    valid_until: null,
    tiers: [
      { tier_id: 't-1', quantity: 72, markup_percent: 25, current_cost: 0.4, proposed_cost: 0.416667, current_price: 0.5, proposed_price: 0.52, vendor_min_quantity: 1, vendor_unit_price: 60, below_vendor_minimum: true },
      { tier_id: 't-2', quantity: 1440, markup_percent: null, current_cost: 0.4, proposed_cost: 0.347222, current_price: null, proposed_price: null, vendor_min_quantity: 10, vendor_unit_price: 50, below_vendor_minimum: false },
    ],
    inserts: [],
    open_quote_count: 2,
    bom_parent_part_count: 1,
    warnings: ['below_vendor_minimum'],
  };

  it('previews through the INVOKER RPC, and keeps the database reply for the apply', async () => {
    stub.rpc.mockResolvedValue({ data: preview, error: null });
    const result = await previewPartCostFromVendor('pv-1', TODAY);
    expect(stub.rpc).toHaveBeenCalledWith('preview_part_cost_from_vendor', { p_part_vendor_id: 'pv-1', p_today: TODAY });
    expect(result.tiers[0]).toMatchObject({ tierId: 't-1', proposedCost: 0.416667, belowVendorMinimum: true, markupPercent: 25 });
    expect(result.openQuoteCount).toBe(2);
    expect(result.expected).toBe(preview);
    // The words come from the pure sourcing helpers.
    const rows = sourcingPreviewRows(toSourcingPreview(result));
    expect(rows[0].note).toBe("Below Acme's 1 bar minimum");
    expect(stub.writes()).toEqual([]);
  });

  it('a made part is refused with its sentence, unreported', async () => {
    stub.rpc.mockResolvedValue({
      data: null,
      error: { code: 'P0001', message: "WIDGET is made in-house, so its cost comes from its routing and materials, not a vendor's price." },
    });
    await expect(previewPartCostFromVendor('pv-9', TODAY)).rejects.toThrow(/made in-house/);
    expect(mockCapture).not.toHaveBeenCalled();
  });

  it('applies through apply_part_cost_from_vendor ONLY — never from(part_pricing_tiers)', async () => {
    stub.rpc.mockResolvedValue({
      data: { part_id: 'part-bar', part_vendor_id: 'pv-1', updated_tier_ids: ['t-1', 't-2'], inserted_tier_ids: [] },
      error: null,
    });
    const result = await applyPartCostFromVendor('pv-1', TODAY, preview);
    expect(stub.rpc).toHaveBeenCalledWith('apply_part_cost_from_vendor', { p_part_vendor_id: 'pv-1', p_today: TODAY, p_expected: preview });
    expect(result).toEqual({ partId: 'part-bar', partVendorId: 'pv-1', updatedTierIds: ['t-1', 't-2'], insertedTierIds: [] });
    expect(stub.tables).not.toContain('part_pricing_tiers');
    expect(stub.tables).toEqual([]);
  });

  it('"changed since you previewed" reaches the person as its sentence', async () => {
    stub.rpc.mockResolvedValue({
      data: null,
      error: { code: 'P0001', message: "This part's pricing or the price sheet changed since you previewed. Preview it again." },
    });
    await expect(applyPartCostFromVendor('pv-1', TODAY, preview)).rejects.toThrow(/changed since you previewed/);
    expect(mockCapture).not.toHaveBeenCalled();
  });
});

describe('consequence counts throw — "couldn\'t count" is never 0', () => {
  it('counts open quotes with the part or any assembly above it', async () => {
    // part-bar is in sub-1, which is in top-1.
    stub.queue('parts_bom', { data: [{ parent_part_id: 'sub-1' }] }, { data: [{ parent_part_id: 'top-1' }] }, { data: [] });
    stub.queue('quotes', { data: [], count: 4 });
    await expect(countOpenQuotesWithPart('part-bar', TODAY)).resolves.toBe(4);
    expect(stub.callsOf('quotes', 'in')).toEqual([['quote_line_items.part_id', ['part-bar', 'sub-1', 'top-1']]]);
    expect(stub.callsOf('quotes', 'eq')).toEqual([['status', 'active']]);
    expect(stub.callsOf('quotes', 'is')).toEqual([
      ['converted_at', null],
      ['deleted_at', null],
    ]);
    expect(stub.callsOf('quotes', 'or')).toEqual([[`expiration_date.is.null,expiration_date.gte.${TODAY}`]]);
  });

  it('counts the live assemblies above it', async () => {
    stub.queue('parts_bom', { data: [{ parent_part_id: 'sub-1' }, { parent_part_id: 'sub-2' }] }, { data: [] });
    stub.queue('parts', { data: [], count: 1 });
    await expect(countBomParents('part-bar')).resolves.toBe(1);
    expect(stub.callsOf('parts', 'is')).toEqual([['deleted_at', null]]);
  });

  it('a part nothing uses is a real 0, with no part read', async () => {
    stub.queue('parts_bom', { data: [] });
    await expect(countBomParents('part-bar')).resolves.toBe(0);
    expect(stub.tables).toEqual(['parts_bom']);
  });

  it('a failed read throws instead of answering 0', async () => {
    stub.queue('parts_bom', { error: { code: '08006', message: 'connection failure' } });
    await expect(countBomParents('part-bar')).rejects.toThrow('Failed to count the parts that use this part.');
    stub.queue('parts_bom', { data: [] });
    stub.queue('quotes', { error: { code: '08006', message: 'connection failure' } });
    await expect(countOpenQuotesWithPart('part-bar', TODAY)).rejects.toThrow('Failed to count the open quotes with this part.');
  });
});
