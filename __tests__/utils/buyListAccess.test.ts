/**
 * "To buy" — access layer (criterion B3, plan §3.10).
 *
 * The tests that earn their keep:
 *   - A FIXED number of reads: six, whatever the shop's size. Counted against a 20-job fixture,
 *     because a comment saying "don't loop" is not a guarantee (issue #68).
 *   - NO writes. The buy list only proposes.
 *   - A capped read is NAMED — never the silent `.range(0, 999)` of 87df208.
 * The rule itself is lib/purchasing/buyList.ts, pinned by buyListCases.json; here it is only fed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { stub } from './purchasingTestStub';

vi.mock('@/lib/supabase', async () => {
  const { stub: s } = await import('./purchasingTestStub');
  return { getSupabase: () => s.client, createClient: () => s.client, supabase: s.client };
});
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));

import { buildBuyListFromSnapshot, getBuyList, priceBuyListRowAt } from '@/utils/buyListAccess';

const TODAY = '2026-11-09';

beforeEach(() => {
  vi.clearAllMocks();
  stub.reset();
});

const STEEL = {
  id: 'steel',
  part_name: 'STEEL-BAR',
  source: 'bought',
  primary_unit: 'inches',
  quantity: 100,
  reorder_point: null,
  preferred_vendor_id: 'v-acme',
  parts_unit_conversions: [{ from_unit: 'bar', to_primary_factor: 144 }],
  part_pricing_tiers: [{ quantity: 1, cost_per_unit: 0.4 }],
  part_vendors: [
    {
      id: 'pv-acme',
      vendor_id: 'v-acme',
      status: 'approved',
      purchase_unit: 'bar',
      minimum_order_quantity: null,
      lead_time_days: 5,
      valid_until: null,
      deleted_at: null,
      vendors: { id: 'v-acme', name: 'Acme Steel', deleted_at: null },
      part_vendor_price_breaks: [{ min_quantity: 1, unit_price: 60 }],
    },
    {
      id: 'pv-beta',
      vendor_id: 'v-beta',
      status: 'approved',
      purchase_unit: 'inches',
      minimum_order_quantity: 200,
      lead_time_days: 2,
      valid_until: null,
      deleted_at: null,
      vendors: { id: 'v-beta', name: 'Beta Metals', deleted_at: null },
      part_vendor_price_breaks: [],
    },
    // An archived row never offers itself.
    { id: 'pv-old', vendor_id: 'v-old', status: 'approved', purchase_unit: 'inches', minimum_order_quantity: null, lead_time_days: null, valid_until: null, deleted_at: '2026-01-01', vendors: { id: 'v-old', name: 'Old Co', deleted_at: null }, part_vendor_price_breaks: [] },
  ],
};

const BUSHING = {
  id: 'bushing',
  part_name: 'BUSHING-7',
  source: 'bought',
  primary_unit: 'each',
  quantity: 4,
  reorder_point: 20,
  preferred_vendor_id: null,
  parts_unit_conversions: [],
  part_pricing_tiers: [],
  part_vendors: [],
};

/** One open job making a widget whose BOM draws 2 in of steel each, plus a bought bushing. */
function jobPart(i: number, over: Record<string, unknown> = {}) {
  return {
    id: `jp-${i}`,
    job_id: `job-${i}`,
    part_id: 'widget',
    quantity: 100,
    production_status: 'in_progress',
    fulfillment_status: 'unshipped',
    jobs: { id: `job-${i}`, job_number: `J-${1000 + i}`, due_date: `2026-11-${String(10 + (i % 15)).padStart(2, '0')}`, production_status: 'in_progress', deleted_at: null },
    parts: { id: 'widget', part_name: 'WIDGET', source: 'made', deleted_at: null, parts_bom: [{ id: `b-${i}`, child_part_id: 'steel', quantity: 2, unit: 'inches' }] },
    shipment_line_items: [],
    ...over,
  };
}

function queueAll(jobParts: unknown[], over: { counts?: Partial<Record<string, number>> } = {}) {
  stub.queue('job_parts', { data: jobParts, count: over.counts?.job_parts ?? jobParts.length });
  stub.queue('parts', { data: [STEEL, BUSHING], count: over.counts?.parts ?? 2 });
  stub.queue('inventory_transactions', { data: [{ job_id: 'job-0', part_id: 'steel', converted_quantity: 50 }], count: 1 });
  stub.queue('part_on_order', { data: [{ part_id: 'steel', on_order_quantity: 144, on_draft_quantity: 0 }], count: 1 });
  stub.queue('vendor_purchase_orders', {
    data: [
      { id: 'po-new', po_number: 'PO-0060', vendor_id: 'v-acme', created_at: '2026-11-08' },
      { id: 'po-old', po_number: 'PO-0051', vendor_id: 'v-acme', created_at: '2026-11-01' },
    ],
    count: over.counts?.vendor_purchase_orders ?? 2,
  });
  stub.queue('part_vendor_last_purchase', { data: [], count: 0 });
}

describe('getBuyList — request budget', () => {
  it('reads six tables once each, however many jobs there are, and never writes', async () => {
    queueAll(Array.from({ length: 20 }, (_, i) => jobPart(i)));
    await getBuyList('co-1', { today: TODAY });
    expect(stub.tables).toEqual([
      'job_parts',
      'parts',
      'inventory_transactions',
      'part_on_order',
      'vendor_purchase_orders',
      'part_vendor_last_purchase',
    ]);
    expect(stub.writes()).toEqual([]);
    expect(stub.rpc).not.toHaveBeenCalled();
  });

  it('scopes every read to the company and to live, open work', async () => {
    queueAll([jobPart(0)]);
    await getBuyList('co-1', { today: TODAY });
    for (const table of ['job_parts', 'parts', 'inventory_transactions', 'part_on_order', 'vendor_purchase_orders', 'part_vendor_last_purchase']) {
      expect(stub.callsOf(table, 'eq')).toContainEqual(['company_id', 'co-1']);
    }
    expect(stub.callsOf('job_parts', 'is')).toEqual([['jobs.deleted_at', null]]);
    expect(stub.callsOf('job_parts', 'neq')).toEqual([
      ['jobs.production_status', 'cancelled'],
      ['production_status', 'cancelled'],
    ]);
    expect(stub.callsOf('parts', 'eq')).toContainEqual(['source', 'bought']);
    expect(stub.callsOf('parts', 'is')).toEqual([['deleted_at', null]]);
    expect(stub.callsOf('inventory_transactions', 'eq')).toContainEqual(['type', 'depletion']);
    expect(stub.callsOf('vendor_purchase_orders', 'is')).toEqual([
      ['issued_at', null],
      ['deleted_at', null],
    ]);
    // Every read takes one page, so a capped one can be named.
    for (const table of ['job_parts', 'parts', 'inventory_transactions', 'part_on_order', 'vendor_purchase_orders', 'part_vendor_last_purchase']) {
      expect(stub.callsOf(table, 'range')).toEqual([[0, 999]]);
    }
  });
});

describe('getBuyList — what it proposes', () => {
  it('nets BOM demand still to issue against on hand once, plus on order', async () => {
    // 3 jobs × 100 widgets × 2 in = 600 in; job-0 already took 50 → 550 still to issue.
    // On hand 100 + on order 144 = 244 → 306 in short → 3 bars of 144 (432 in).
    queueAll([jobPart(0), jobPart(1), jobPart(2)]);
    const list = await getBuyList('co-1', { today: TODAY });
    const steel = list.groups.flatMap((g) => g.rows).find((r) => r.partId === 'steel')!;
    expect(steel).toMatchObject({ demand: 550, onHand: 100, onOrder: 144, position: -306, shortfall: 306, suggestedQuantity: 3, purchaseUnit: 'bar', vendorBasis: 'preferred' });
    expect(steel.jobNumbers).toEqual(['J-1000', 'J-1001', 'J-1002']);
    // Priced by the one price default: Acme's sheet, 60 a bar.
    expect(steel.price).toMatchObject({ unitPrice: 60, priceSource: 'price_sheet' });
    expect(steel.amount).toBe(180);
    // "Buy from": each usable listed vendor, priced at what it would suggest.
    expect(steel.vendorPrices.map((v) => [v.vendorName, v.purchaseUnit, v.suggestedQuantity])).toEqual([
      ['Acme Steel', 'bar', 3],
      ['Beta Metals', 'inches', 306],
    ]);
    // An existing draft to the vendor: "Add to draft PO-0060" (the newest).
    const acme = list.groups.find((g) => g.vendorId === 'v-acme')!;
    expect(acme.draft).toEqual({ vendorPurchaseOrderId: 'po-new', poNumber: 'PO-0060' });
    expect(acme.total).toBe(180);
  });

  it('a bought part on a job counts what is still to ship (shipped on live slips only), and a reorder point lists it', async () => {
    queueAll([
      jobPart(0, {
        id: 'jp-b',
        part_id: 'bushing',
        quantity: 10,
        production_status: 'completed',
        fulfillment_status: 'partially_shipped',
        parts: { id: 'bushing', part_name: 'BUSHING-7', source: 'bought', deleted_at: null, parts_bom: [] },
        shipment_line_items: [
          { quantity: 3, shipments: { voided_at: null } },
          { quantity: 5, shipments: { voided_at: '2026-11-02T00:00:00Z' } },
        ],
      }),
    ]);
    const list = await getBuyList('co-1', { today: TODAY });
    const bushing = list.groups.flatMap((g) => g.rows).find((r) => r.partId === 'bushing')!;
    // Still to ship 7; on hand 4 → position −3; reorder point 20 → 24 to buy: 23 would land ON the
    // point, where the part is still listed.
    expect(bushing).toMatchObject({ demand: 7, position: -3, reason: 'both', shortfall: 23, suggestedQuantity: 24 });
    // Exactly one job wants it, so the line links that job (and the job part it is for).
    expect(bushing.jobLink).toEqual({ jobId: 'job-0', jobNumber: 'J-1000', jobPartId: 'jp-b' });
    // No vendor chosen: the group a person starts an RFQ from.
    expect(list.groups.find((g) => g.vendorId === null)?.rows.map((r) => r.partId)).toEqual(['bushing']);
  });

  it('says when a read hit its cap, and which', async () => {
    queueAll([jobPart(0)], { counts: { job_parts: 1203, parts: 2 } });
    const list = await getBuyList('co-1', { today: TODAY });
    expect(list.truncated).toBe(true);
    expect(list.truncatedSources).toEqual(['job_parts']);
  });

  it('is complete and says so when nothing was capped', async () => {
    queueAll([jobPart(0)]);
    const list = await getBuyList('co-1', { today: TODAY });
    expect(list).toMatchObject({ truncated: false, truncatedSources: [] });
  });

  it('throws on a failed read — never an empty, "nothing to buy" list', async () => {
    stub.queue('parts', { error: { code: '08006', message: 'connection failure' } });
    await expect(getBuyList('co-1', { today: TODAY })).rejects.toThrow('Failed to load the buy list.');
  });
});

describe('buildBuyListFromSnapshot', () => {
  it('re-prices a "Buy from" change from the snapshot, with no read', async () => {
    queueAll([jobPart(0), jobPart(1), jobPart(2)]);
    const first = await getBuyList('co-1', { today: TODAY });
    stub.reset();

    const moved = buildBuyListFromSnapshot(first.snapshot, {
      today: TODAY,
      chosenVendors: { steel: { vendorId: 'v-beta', vendorName: 'Beta Metals' } },
    });
    const steel = moved.groups.flatMap((g) => g.rows).find((r) => r.partId === 'steel')!;
    expect(steel).toMatchObject({ vendorBasis: 'chosen', purchaseUnit: 'inches', suggestedQuantity: 306 });
    expect(moved.groups.map((g) => g.vendorName)).toContain('Beta Metals');
    expect(stub.tables).toEqual([]);
  });
});

describe('priceBuyListRowAt — a typed quantity re-priced by the list’s own rule', () => {
  /** Acme's sheet with a 10+ break, so a typed quantity can cross it. */
  const snapshot = {
    priceInputsByPart: {
      steel: {
        sheetsByVendor: {
          'v-acme': {
            vendorName: 'Acme Steel',
            status: 'approved' as const,
            purchaseUnit: 'bar',
            stockFactor: 144,
            validUntil: null,
            breaks: [
              { minQuantity: 1, unitPrice: 60 },
              { minQuantity: 10, unitPrice: 50 },
            ],
          },
        },
        lastPurchases: [],
        costTiers: [{ quantity: 1, costPerUnit: 0.4 }],
      },
    },
  };
  const row = { partId: 'steel', purchaseUnit: 'bar', purchaseFactor: 144 };
  const acme = { vendorId: 'v-acme', vendorName: 'Acme Steel' };

  it('takes the break the typed quantity reaches', () => {
    expect(priceBuyListRowAt(snapshot, row, acme, 3, TODAY)).toMatchObject({ unitPrice: 60, priceSource: 'price_sheet' });
    expect(priceBuyListRowAt(snapshot, row, acme, 12, TODAY)).toMatchObject({ unitPrice: 50, priceSource: 'price_sheet' });
  });

  it('is the price the list itself gave the suggestion', async () => {
    queueAll([jobPart(0), jobPart(1), jobPart(2)]);
    const list = await getBuyList('co-1', { today: TODAY });
    const steel = list.groups.flatMap((g) => g.rows).find((r) => r.partId === 'steel')!;
    expect(priceBuyListRowAt(list.snapshot, steel, steel.vendor, steel.suggestedQuantity, TODAY)).toEqual(steel.price);
  });

  it('reads no sheet without a vendor — it falls back to the estimate', () => {
    expect(priceBuyListRowAt(snapshot, row, null, 3, TODAY)).toMatchObject({ priceSource: 'estimate' });
  });
});
