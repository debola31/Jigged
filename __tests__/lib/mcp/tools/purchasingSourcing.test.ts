import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { getPartVendorsTool, previewPartCostFromVendorTool } from '@/lib/mcp/tools/purchasing';
import { savePartVendorTool, setPartCostFromVendorTool } from '@/lib/mcp/tools/purchasingWrites';

import {
  CO,
  ORIGIN,
  PART_ID,
  PO_ID,
  PV_ID,
  TODAY,
  VENDOR2_ID,
  VENDOR_ID,
  costPreview,
  envAs,
  expectContract,
  kit,
  partVendorList,
  partVendorRow,
  poUrl,
} from './purchasingTestKit';

/**
 * The approved vendor list, price sheets and "Use as part cost" (plan §3.8, §5.4; V1–V3, M3). What
 * matters: the part's Buying tab reads and writes through the same access functions; the part,
 * vendor and approved-vendor row are found in this company first; prices go to every office user;
 * the sourcing preview writes nothing; and the apply sends back exactly what was previewed.
 */

vi.mock('@/lib/supabase', async () => (await import('./purchasingTestKit')).kit.supabaseModule());
vi.mock('@/utils/partVendorsAccess', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/partVendorsAccess')>()),
  ...(await import('./purchasingTestKit')).kit.wrap([
    'listPartVendors',
    'savePartVendor',
    'previewPartCostFromVendor',
    'applyPartCostFromVendor',
  ]),
}));

const env = envAs('user');

const BAR = { id: PART_ID, part_name: 'BAR-6061', source: 'bought', primary_unit: 'inches', deleted_at: null };
const ACME = { id: VENDOR_ID, name: 'Acme Metals', created_at: '2026-01-01T00:00:00Z', deleted_at: null };
const ROW = { id: PV_ID, part_id: PART_ID, vendor_id: VENDOR_ID, deleted_at: null };
const partUrl = `${ORIGIN}/dashboard/${CO}/parts/${PART_ID}`;

beforeEach(() => {
  kit.reset();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(`${TODAY}T18:00:00Z`));
  kit.answer('parts', [BAR]);
  kit.answer('vendors', ACME);
  kit.fn('listPartVendors').mockResolvedValue(partVendorList());
});

afterEach(() => {
  vi.useRealTimers();
});

describe('get_part_vendors', () => {
  it("reads the part's approved vendors the Buying tab shows, with sheets and Last PO price, to a user too", async () => {
    const res = await getPartVendorsTool.run({ part_name: 'BAR-6061' }, env);
    if (!res.ok) throw new Error(res.message);
    expect(kit.calls('listPartVendors')).toEqual([[PART_ID, { today: TODAY }]]);
    expect(kit.companyScopedBefore('listPartVendors')).toBe(true);
    expect(res.data).toEqual({
      part: { part_id: PART_ID, part_name: 'BAR-6061', source: 'bought', stock_unit: 'inches', archived: false, url: partUrl },
      preferred_vendor_missing: false,
      vendors: [
        {
          part_vendor_id: PV_ID,
          vendor: { vendor_id: VENDOR_ID, name: 'Acme Metals', url: `${ORIGIN}/dashboard/${CO}/vendors/${VENDOR_ID}` },
          status: 'approved',
          status_note: null,
          preferred: true,
          vendor_part_number: 'AL-6061-1',
          purchase_unit: 'bar',
          units_per_purchase_unit: 144,
          unit_note: '1 bar = 144 in',
          lead_time_days: 5,
          minimum_order_quantity: 2,
          quoted_on: '2026-10-01',
          valid_until: '2027-03-01',
          expired: false,
          notes: 'Ships from Akron.',
          price_breaks: [
            { min_quantity: 1, unit_price: 45, from_rfq: false },
            { min_quantity: 10, unit_price: 42.5, from_rfq: true },
          ],
          last_po_price: {
            vendor_po_id: PO_ID,
            po_number: 'PO-1042',
            ordered_on: '2026-11-02',
            quantity: 10,
            unit: 'bar',
            unit_price: 42.5,
            unit_price_per_stock_unit: 0.295139,
            url: poUrl(),
          },
        },
      ],
      url: partUrl,
    });
    expectContract(getPartVendorsTool, res.data);
  });

  it('parses with every nullable field null, and reads an archived part by id', async () => {
    kit.answer('parts', { ...BAR, deleted_at: '2026-10-01T00:00:00Z' });
    kit.fn('listPartVendors').mockResolvedValue(
      partVendorList({
        part: { id: PART_ID, partName: 'BAR-6061', source: 'bought', stockUnit: null, preferredVendorId: null, conversions: [] },
        rows: [
          partVendorRow({
            statusNote: null,
            vendorPartNumber: null,
            purchaseFactor: null,
            factorLabel: null,
            leadTimeDays: null,
            minimumOrderQuantity: null,
            quotedOn: null,
            validUntil: null,
            notes: null,
            breaks: [],
            lastPurchase: { ...partVendorRow().lastPurchase!, orderedOn: null, unitPricePerStockUnit: null, stockUnit: null, stockFactor: null },
          }),
          partVendorRow({ id: 'pv-2', vendorId: VENDOR2_ID, vendorName: 'Bay Steel', isPreferred: false, lastPurchase: null }),
        ],
      }),
    );
    const res = await getPartVendorsTool.run({ part_id: PART_ID }, env);
    if (!res.ok) throw new Error(res.message);
    expect(res.data.part.archived).toBe(true);
    expect(res.data.vendors[1].last_po_price).toBeNull();
    expect(kit.queries('parts').some((q) => q.method === 'is')).toBe(false);
    expectContract(getPartVendorsTool, res.data);
  });

  it('says so when the part is not in this company, or none was named', async () => {
    kit.answer('parts', []);
    expect(await getPartVendorsTool.run({ part_name: 'NOPE-1' }, env)).toEqual({ ok: false, message: 'There is no part named NOPE-1 in Acme Machining.' });
    expect(await getPartVendorsTool.run({ part_id: PART_ID }, env)).toEqual({ ok: false, message: 'There is no part with that id in Acme Machining.' });
    expect(await getPartVendorsTool.run({}, env)).toEqual({ ok: false, message: 'Give a part_id or a part_name.' });
    expect(kit.calls('listPartVendors')).toEqual([]);
  });
});

describe('save_part_vendor', () => {
  it("adds or edits a vendor on the part's list as the Buying tab saves it, replacing the sheet only when given", async () => {
    kit.fn('savePartVendor').mockResolvedValue({ partVendorId: PV_ID, created: false, revived: true, preferred: true });
    const res = await savePartVendorTool.run(
      {
        part_name: 'BAR-6061',
        vendor_name: 'Acme Metals',
        status: 'conditional',
        status_note: 'Late twice in October',
        purchase_unit: 'bar',
        lead_time_days: 7,
        valid_until: null,
        price_breaks: [
          { min_quantity: 1, unit_price: 45 },
          { min_quantity: 10, unit_price: 42.5 },
        ],
        make_preferred: true,
      },
      env,
    );
    if (!res.ok) throw new Error(res.message);
    expect(kit.calls('savePartVendor')).toEqual([
      [
        {
          partId: PART_ID,
          vendorId: VENDOR_ID,
          changes: { status: 'conditional', statusNote: 'Late twice in October', purchaseUnit: 'bar', leadTimeDays: 7, validUntil: null },
          priceBreaks: [
            { minQuantity: 1, unitPrice: 45 },
            { minQuantity: 10, unitPrice: 42.5 },
          ],
          makePreferred: true,
        },
      ],
    ]);
    expect(kit.companyScopedBefore('savePartVendor')).toBe(true);
    expect(res.data).toMatchObject({ part_vendor_id: PV_ID, created: false, revived: true, url: partUrl });
    expectContract(savePartVendorTool, res.data);
  });

  it('leaves the sheet alone when no price_breaks are given, and refuses an archived part or vendor', async () => {
    kit.fn('savePartVendor').mockResolvedValue({ partVendorId: PV_ID, created: true, revived: false, preferred: false });
    await savePartVendorTool.run({ part_id: PART_ID, vendor_id: VENDOR_ID, vendor_part_number: 'X-1' }, env);
    expect(kit.calls('savePartVendor')[0][0]).toEqual({ partId: PART_ID, vendorId: VENDOR_ID, changes: { vendorPartNumber: 'X-1' }, makePreferred: false });

    kit.answer('vendors', { ...ACME, deleted_at: '2026-10-01T00:00:00Z' });
    expect(await savePartVendorTool.run({ part_id: PART_ID, vendor_id: VENDOR_ID }, env)).toEqual({
      ok: false,
      message: "Acme Metals is archived in Jigged, so it can't go on a part's vendor list.",
    });
    kit.answer('parts', { ...BAR, deleted_at: '2026-10-01T00:00:00Z' });
    expect(await savePartVendorTool.run({ part_id: PART_ID, vendor_id: VENDOR_ID }, env)).toEqual({
      ok: false,
      message: 'BAR-6061 is archived in Jigged, so nothing was changed.',
    });
    expect(kit.calls('savePartVendor')).toHaveLength(1);
  });
});

describe('preview_part_cost_from_vendor', () => {
  it('previews "Use as part cost" for an approved-vendor row of this company, writing nothing', async () => {
    kit.answer('part_vendors', ROW);
    kit.fn('previewPartCostFromVendor').mockResolvedValue(costPreview({ warnings: ['below_vendor_minimum'] }));
    const res = await previewPartCostFromVendorTool.run({ part_vendor_id: PV_ID }, env);
    if (!res.ok) throw new Error(res.message);
    expect(kit.calls('previewPartCostFromVendor')).toEqual([[PV_ID, TODAY]]);
    expect(kit.companyScopedBefore('previewPartCostFromVendor')).toBe(true);
    expect(kit.calls('applyPartCostFromVendor')).toEqual([]);
    expect(res.data).toEqual({
      part_vendor_id: PV_ID,
      part: { part_id: PART_ID, part_name: 'BAR-6061', url: partUrl },
      vendor: { vendor_id: VENDOR_ID, name: 'Acme Metals', url: `${ORIGIN}/dashboard/${CO}/vendors/${VENDOR_ID}` },
      purchase_unit: 'bar',
      stock_unit: 'inches',
      units_per_purchase_unit: 144,
      quoted_on: '2026-10-01',
      valid_until: '2027-03-01',
      tiers: [
        {
          quantity: 144,
          cost_per_unit_now: 0.33,
          cost_per_unit_new: 0.3125,
          markup_percent: 30,
          unit_price_now: 0.429,
          unit_price_new: 0.40625,
          vendor_break_quantity: 1,
          vendor_unit_price: 45,
          below_vendor_minimum: false,
        },
      ],
      new_tiers: [],
      open_quotes_affected: 2,
      parts_using_it: 1,
      warnings: ["Some of the part's quantity breaks are below Acme Metals's smallest price break, so that break's price is used for them."],
      url: partUrl,
    });
    expectContract(previewPartCostFromVendorTool, res.data);
  });

  it('finds the row from the part and the vendor, and says when the vendor is not on the list', async () => {
    kit.answer('part_vendors', ROW);
    kit.fn('previewPartCostFromVendor').mockResolvedValue(costPreview({ tiers: [], inserts: [{ quantity: 1, proposedCost: 0.3125, markupPercent: 0, vendorMinQuantity: 1, vendorUnitPrice: 45 }], warnings: ['starter_tiers_inserted'] }));
    const res = await previewPartCostFromVendorTool.run({ part_name: 'BAR-6061', vendor_name: 'Acme Metals' }, env);
    if (!res.ok) throw new Error(res.message);
    expect(kit.queries('part_vendors')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ method: 'eq', args: ['company_id', CO] }),
        expect.objectContaining({ method: 'eq', args: ['part_id', PART_ID] }),
        expect.objectContaining({ method: 'eq', args: ['vendor_id', VENDOR_ID] }),
      ]),
    );
    expect(res.data.new_tiers).toEqual([{ quantity: 1, cost_per_unit: 0.3125, markup_percent: 0, vendor_break_quantity: 1, vendor_unit_price: 45 }]);
    expect(res.data.warnings).toEqual([
      'BAR-6061 has no pricing tiers yet, so these would be added at 0% markup. Set its markups before quoting it.',
    ]);

    kit.answer('part_vendors', null);
    expect(await previewPartCostFromVendorTool.run({ part_id: PART_ID, vendor_id: VENDOR_ID }, env)).toEqual({
      ok: false,
      message: "Acme Metals isn't on BAR-6061's vendor list. Add it with save_part_vendor first.",
    });
    expect(await previewPartCostFromVendorTool.run({ part_id: PART_ID }, env)).toEqual({
      ok: false,
      message: 'Give a part_vendor_id, or the part and the vendor.',
    });
    expect(await previewPartCostFromVendorTool.run({ part_vendor_id: PV_ID }, env)).toEqual({
      ok: false,
      message: 'There is no approved-vendor entry with that id in Acme Machining.',
    });
  });
});

describe('set_part_cost_from_vendor', () => {
  it('previews, then applies exactly what was previewed', async () => {
    kit.answer('part_vendors', ROW);
    const preview = costPreview();
    kit.fn('previewPartCostFromVendor').mockResolvedValue(preview);
    kit.fn('applyPartCostFromVendor').mockResolvedValue({ partId: PART_ID, partVendorId: PV_ID, updatedTierIds: ['tier-1'], insertedTierIds: [] });
    const res = await setPartCostFromVendorTool.run({ part_vendor_id: PV_ID }, env);
    if (!res.ok) throw new Error(res.message);
    expect(kit.calls('previewPartCostFromVendor')).toEqual([[PV_ID, TODAY]]);
    expect(kit.calls('applyPartCostFromVendor')).toEqual([[PV_ID, TODAY, preview.expected]]);
    expect(kit.companyScopedBefore('applyPartCostFromVendor')).toBe(true);
    expect(res.data).toMatchObject({ updated_tier_count: 1, inserted_tier_count: 0, open_quotes_affected: 2, url: partUrl });
    expectContract(setPartCostFromVendorTool, res.data);
  });

  it('refuses an archived approved-vendor row before previewing', async () => {
    kit.answer('part_vendors', { ...ROW, deleted_at: '2026-10-01T00:00:00Z' });
    expect(await setPartCostFromVendorTool.run({ part_vendor_id: PV_ID }, env)).toEqual({
      ok: false,
      message: "That vendor was taken off this part's vendor list, so nothing was changed.",
    });
    expect(kit.calls('previewPartCostFromVendor')).toEqual([]);
    expect(kit.calls('applyPartCostFromVendor')).toEqual([]);
  });
});
