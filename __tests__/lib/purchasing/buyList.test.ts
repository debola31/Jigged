/**
 * The "To buy" list (plan §3.10, criteria B2 and B3) — a hand port of 87df208's
 * `rollUpShortages`, with the dropped `is_hot` / `is_stocked` columns gone and on order, drafts,
 * bought job parts and reorder points added.
 *
 * Per part, in stock units:
 *   demand   = material still to issue on open jobs (issued counted once per job and part)
 *            + bought job parts still to ship
 *   position = on hand (once) + on order + on draft − demand
 *   listed   ⇔ position ≤ reorder point, or position < 0 when there is none
 *   suggest  = with a reorder point, the fewest whole purchase units that lift the position
 *              strictly ABOVE it; without one, enough to cover −position, rounded up to whole
 *              purchase units. Either way at least the minimum order, and at least one.
 *
 * The reorder half is "above", not "to": a part AT its point is listed, so an order that only
 * reached the point brought the part straight back asking for one more (the E2E journey found it).
 *
 * The arithmetic is pinned by `__tests__/fixtures/buyListCases.json`; the cases below it are the
 * ported 87df208 behaviours and the presentation rules (grouping, sorting, the buckets).
 */
import { describe, it, expect } from 'vitest';
import buyListFixture from '../../fixtures/buyListCases.json';
import {
  buildBuyList,
  chooseBuyListVendor,
  evaluateBuyListPart,
  suggestPurchaseQuantity,
  type BuyListDemand,
  type BuyListPart,
  type BuyListRow,
  type BuyListVendorOption,
} from '@/lib/purchasing/buyList';

// ------------------------------------------------------------------------------------------------
// The fixture runner
// ------------------------------------------------------------------------------------------------

interface FixtureVendor {
  vendor_id: string;
  vendor_name?: string;
  status: 'approved' | 'conditional' | 'disapproved';
  purchase_unit: string;
  purchase_factor: number | null;
  minimum_order_quantity?: number | null;
  vendor_archived?: boolean;
}

interface FixtureCase {
  name: string;
  part: {
    stock_unit: string | null;
    on_hand: number;
    on_order?: number;
    on_draft?: number;
    reorder_point?: number | null;
    preferred_vendor_id?: string | null;
  };
  vendors?: FixtureVendor[];
  material?: Array<{ job: string; job_part?: string; due?: string | null; required: number | null; issued: number }>;
  bought?: Array<{ job: string; job_part: string; due?: string | null; still_to_ship: number }>;
  expected: Record<string, unknown>;
}

const cases = buyListFixture.cases as FixtureCase[];

function fromFixture(c: FixtureCase): { parts: BuyListPart[]; demand: BuyListDemand[] } {
  const vendors: BuyListVendorOption[] = (c.vendors ?? []).map((v) => ({
    partVendorId: `pv-${v.vendor_id}`,
    vendorId: v.vendor_id,
    vendorName: v.vendor_name ?? v.vendor_id.toUpperCase(),
    status: v.status,
    vendorArchived: v.vendor_archived ?? false,
    purchaseUnit: v.purchase_unit,
    purchaseFactor: v.purchase_factor,
    minimumOrderQuantity: v.minimum_order_quantity ?? null,
  }));
  const part: BuyListPart = {
    partId: 'p1',
    partName: 'P1',
    source: 'bought',
    stockUnit: c.part.stock_unit,
    onHand: c.part.on_hand,
    onOrder: c.part.on_order ?? 0,
    onDraft: c.part.on_draft ?? 0,
    reorderPoint: c.part.reorder_point ?? null,
    isArchived: false,
    preferredVendorId: c.part.preferred_vendor_id ?? null,
    vendors,
  };
  const demand: BuyListDemand[] = [
    ...(c.material ?? []).map((m, i): BuyListDemand => ({
      kind: 'material',
      partId: 'p1',
      jobId: m.job,
      jobNumber: m.job,
      jobPartId: m.job_part ?? `${m.job}-made-${i}`,
      madePartName: 'Widget',
      dueDate: m.due ?? null,
      requiredInStockUnit: m.required,
      issued: m.issued,
    })),
    ...(c.bought ?? []).map((b): BuyListDemand => ({
      kind: 'bought_part',
      partId: 'p1',
      jobId: b.job,
      jobNumber: b.job,
      jobPartId: b.job_part,
      dueDate: b.due ?? null,
      stillToShip: b.still_to_ship,
    })),
  ];
  return { parts: [part], demand };
}

function onlyRow(list: ReturnType<typeof buildBuyList>): BuyListRow | null {
  const rows = list.groups.flatMap((g) => g.rows);
  expect(rows.length).toBeLessThanOrEqual(1);
  return rows[0] ?? null;
}

describe('the buy-list rule — golden cases (B2)', () => {
  it.each(cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const { parts, demand } = fromFixture(c);
    const evaluation = evaluateBuyListPart(parts[0], demand);
    const e = c.expected;

    expect(evaluation.listed).toBe(e.listed);
    if ('incomparable' in e) expect(evaluation.incomparable).toBe(e.incomparable);
    if ('demand' in e) expect(evaluation.demand).toBeCloseTo(e.demand as number, 9);
    if ('position' in e) expect(evaluation.position).toBeCloseTo(e.position as number, 9);

    // The whole list must say the same thing as the per-part rule it is built from.
    const list = buildBuyList({ parts, demand });
    const row = onlyRow(list);
    expect(row).toEqual(evaluation.row);
    expect(list.incomparable.some((i) => i.partId === 'p1')).toBe(evaluation.incomparable);
    if (!row) return;

    if ('reason' in e) expect(row.reason).toBe(e.reason);
    if ('shortfall' in e) expect(row.shortfall).toBeCloseTo(e.shortfall as number, 9);
    if ('vendor_id' in e) expect(row.vendor?.vendorId ?? null).toBe(e.vendor_id);
    if ('vendor_basis' in e) expect(row.vendorBasis).toBe(e.vendor_basis);
    if ('purchase_unit' in e) expect(row.purchaseUnit).toBe(e.purchase_unit);
    if ('suggested_quantity' in e) expect(row.suggestedQuantity).toBe(e.suggested_quantity);
    if ('suggested_stock_quantity' in e) expect(row.suggestedStockQuantity).toBe(e.suggested_stock_quantity);
    if ('incomparable_job_count' in e) expect(row.incomparableJobCount).toBe(e.incomparable_job_count);
    if ('job_link' in e) {
      const link = e.job_link as { job: string; job_part: string | null } | null;
      expect(row.jobLink).toEqual(link === null ? null : { jobId: link.job, jobNumber: link.job, jobPartId: link.job_part });
    }
  });

  it('every case says whether the part is listed, so none passes by asserting nothing', () => {
    for (const c of cases) expect(typeof c.expected.listed, c.name).toBe('boolean');
  });
});

// ------------------------------------------------------------------------------------------------
// Hand-built cases
// ------------------------------------------------------------------------------------------------

const vendor = (over: Partial<BuyListVendorOption> & { vendorId: string }): BuyListVendorOption => ({
  partVendorId: `pv-${over.vendorId}`,
  vendorName: over.vendorId.toUpperCase(),
  status: 'approved',
  vendorArchived: false,
  purchaseUnit: 'each',
  purchaseFactor: 1,
  minimumOrderQuantity: null,
  ...over,
});

const part = (over: Partial<BuyListPart> & { partId: string }): BuyListPart => ({
  partName: over.partId.toUpperCase(),
  source: 'bought',
  stockUnit: 'each',
  onHand: 0,
  onOrder: 0,
  onDraft: 0,
  reorderPoint: null,
  isArchived: false,
  preferredVendorId: null,
  vendors: [],
  ...over,
});

const material = (partId: string, jobId: string, required: number | null, over: Partial<BuyListDemand> = {}): BuyListDemand => ({
  kind: 'material',
  partId,
  jobId,
  jobNumber: jobId,
  jobPartId: `${jobId}-jp`,
  madePartName: 'Widget',
  dueDate: null,
  requiredInStockUnit: required,
  issued: 0,
  ...over,
} as BuyListDemand);

describe('ported from 87df208 (B2)', () => {
  /**
   * THE test, ported. Two jobs each need 10 of a part with 15 on hand. Individually neither is
   * short; aggregated, the shop is 5 short. A list that compares each job to the full on-hand —
   * or sums per-job shortfalls — says "fine" and the shop runs out mid-week.
   */
  it('counts on-hand once across jobs instead of once per job', () => {
    const list = buildBuyList({
      parts: [part({ partId: 'steel', onHand: 15 })],
      demand: [material('steel', 'j1', 10), material('steel', 'j2', 10)],
    });
    const [row] = list.groups[0].rows;
    expect(row).toMatchObject({ partId: 'steel', onHand: 15, demand: 20, position: -5, shortfall: 5 });
    expect(row.jobs.map((j) => j.jobId)).toEqual(['j1', 'j2']);
  });

  it('leaves archived and made parts off a purchasing list', () => {
    const list = buildBuyList({
      parts: [
        part({ partId: 'gone', isArchived: true }),
        part({ partId: 'core', source: 'made' }),
      ],
      demand: [material('gone', 'j1', 5), material('core', 'j1', 5)],
    });
    expect(list.groups).toEqual([]);
    expect(list.incomparable).toEqual([]);
    expect(list.rowCount).toBe(0);
  });

  it('ignores demand for a part it was not given facts for', () => {
    const list = buildBuyList({ parts: [], demand: [material('unknown', 'j1', 5)] });
    expect(list.rowCount).toBe(0);
  });

  it('never calls an incomparable part fine: it lands in its own bucket with the jobs affected', () => {
    const list = buildBuyList({
      parts: [part({ partId: 'odd', stockUnit: 'pounds' })],
      demand: [material('odd', 'j1', null, { dueDate: '2026-11-20' }), material('odd', 'j2', null)],
    });
    expect(list.groups).toEqual([]);
    expect(list.incomparable).toEqual([
      expect.objectContaining({
        partId: 'odd',
        stockUnit: 'pounds',
        incomparableJobCount: 2,
        jobs: [
          { jobId: 'j1', jobNumber: 'j1', dueDate: '2026-11-20' },
          { jobId: 'j2', jobNumber: 'j2', dueDate: null },
        ],
      }),
    ]);
  });

  it('sorts by need date (undated last), then worst first; jobs by due date with undated last', () => {
    const list = buildBuyList({
      parts: [
        part({ partId: 'mild', onHand: 10 }),
        part({ partId: 'bad', onHand: 0 }),
        part({ partId: 'early', onHand: 0 }),
        part({ partId: 'restock', onHand: 1, reorderPoint: 5 }),
      ],
      demand: [
        material('mild', 'j1', 12, { dueDate: '2026-11-20' }),
        material('bad', 'j2', 50, { dueDate: null }),
        material('bad', 'j3', 1, { dueDate: '2026-11-20' }),
        material('early', 'j4', 1, { dueDate: '2026-11-12' }),
      ],
    });
    const rows = list.groups.flatMap((g) => g.rows);
    // early (11/12) → bad and mild both need it 11/20, bad is worse → restock has no date.
    expect(rows.map((r) => r.partId)).toEqual(['early', 'bad', 'mild', 'restock']);
    expect(rows.find((r) => r.partId === 'bad')?.jobs.map((j) => j.jobId)).toEqual(['j3', 'j2']);
    expect(rows.find((r) => r.partId === 'bad')?.needBy).toBe('2026-11-20');
    expect(rows.find((r) => r.partId === 'restock')?.needBy).toBeNull();
  });
});

describe('job needs on a row (B2, B3)', () => {
  it('reports each job\'s need with material and bought parts kept apart', () => {
    const list = buildBuyList({
      parts: [part({ partId: 'p', onHand: 0 })],
      demand: [
        material('p', 'j1', 4, { jobPartId: 'jp-made', madePartName: 'Bracket', issued: 1, dueDate: '2026-11-20' }),
        { kind: 'bought_part', partId: 'p', jobId: 'j1', jobNumber: 'j1', jobPartId: 'jp-bought', dueDate: '2026-11-20', stillToShip: 2 },
      ],
    });
    const [row] = list.groups[0].rows;
    expect(row.jobs).toEqual([
      {
        jobId: 'j1', jobNumber: 'j1', dueDate: '2026-11-20',
        materialStillToIssue: 3, boughtStillToShip: 2, need: 5,
        jobPartIds: ['jp-made', 'jp-bought'], madePartNames: ['Bracket'], incomparableLineCount: 0,
      },
    ]);
    // One job, but the need is not only the bought part, so the line links the job alone.
    expect(row.jobLink).toEqual({ jobId: 'j1', jobNumber: 'j1', jobPartId: null });
    expect(row.jobNumbers).toEqual(['j1']);
  });

  it('names every contributing job when several do, in need order', () => {
    const list = buildBuyList({
      parts: [part({ partId: 'p' })],
      demand: [
        material('p', 'J-1050', 2, { dueDate: '2026-12-01' }),
        material('p', 'J-1042', 2, { dueDate: '2026-11-15' }),
      ],
    });
    const [row] = list.groups[0].rows;
    expect(row.jobLink).toBeNull();
    expect(row.jobNumbers).toEqual(['J-1042', 'J-1050']);
  });
});

describe('vendor grouping and "Buy from" (B3)', () => {
  const acme = vendor({ vendorId: 'acme', vendorName: 'Acme', purchaseUnit: 'bar', purchaseFactor: 144, minimumOrderQuantity: 2 });
  const beta = vendor({ vendorId: 'beta', vendorName: 'Beta', purchaseUnit: 'feet', purchaseFactor: 12 });

  it('groups rows per vendor, alphabetically, with "No vendor chosen" last', () => {
    const list = buildBuyList({
      parts: [
        part({ partId: 'a', stockUnit: 'inches', preferredVendorId: 'beta', vendors: [beta] }),
        part({ partId: 'b', stockUnit: 'inches' }),
        part({ partId: 'c', stockUnit: 'inches', preferredVendorId: 'acme', vendors: [acme] }),
      ],
      demand: [material('a', 'j1', 10), material('b', 'j1', 10), material('c', 'j1', 10)],
    });
    expect(list.groups.map((g) => [g.vendorId, g.vendorName, g.rows.map((r) => r.partId)])).toEqual([
      ['acme', 'Acme', ['c']],
      ['beta', 'Beta', ['a']],
      [null, null, ['b']],
    ]);
  });

  it('attaches an existing draft to its vendor\'s group, so the action reads "Add to draft"', () => {
    const list = buildBuyList({
      parts: [part({ partId: 'c', stockUnit: 'inches', preferredVendorId: 'acme', vendors: [acme] })],
      demand: [material('c', 'j1', 10)],
      draftsByVendor: { acme: { vendorPurchaseOrderId: 'po-9', poNumber: 'PO-1043' } },
    });
    expect(list.groups[0].draft).toEqual({ vendorPurchaseOrderId: 'po-9', poNumber: 'PO-1043' });
  });

  it('re-suggests in the chosen vendor\'s unit when "Buy from" switches vendors', () => {
    const p = part({ partId: 'c', stockUnit: 'inches', preferredVendorId: 'acme', vendors: [acme, beta] });
    const demand = [material('c', 'j1', 100)];
    const preferred = buildBuyList({ parts: [p], demand }).groups[0].rows[0];
    expect(preferred).toMatchObject({ purchaseUnit: 'bar', suggestedQuantity: 2, vendorBasis: 'preferred' }); // minimum 2 bars
    const switched = buildBuyList({ parts: [p], demand, chosenVendors: { c: { vendorId: 'beta', vendorName: 'Beta' } } }).groups[0].rows[0];
    expect(switched).toMatchObject({ purchaseUnit: 'feet', suggestedQuantity: 9, vendorBasis: 'chosen' }); // 100 in = 8.33 ft
    expect(switched.vendor?.vendorId).toBe('beta');
  });

  it('can buy from a vendor not on the list, in the stock unit', () => {
    const p = part({ partId: 'c', stockUnit: 'inches', vendors: [acme] });
    const row = buildBuyList({
      parts: [p],
      demand: [material('c', 'j1', 100)],
      chosenVendors: { c: { vendorId: 'gamma', vendorName: 'Gamma' } },
    }).groups[0].rows[0];
    expect(row).toMatchObject({ purchaseUnit: 'inches', purchaseFactor: 1, suggestedQuantity: 100, vendorBasis: 'chosen' });
    expect(row.vendor).toMatchObject({ vendorId: 'gamma', vendorName: 'Gamma', partVendorId: null });
  });

  it('refuses to switch to a vendor marked Do not use', () => {
    const banned = vendor({ vendorId: 'banned', status: 'disapproved' });
    const p = part({ partId: 'c', preferredVendorId: 'acme', vendors: [vendor({ vendorId: 'acme' }), banned] });
    expect(chooseBuyListVendor(p, { vendorId: 'banned', vendorName: 'BANNED' })).toMatchObject({
      vendor: { vendorId: 'acme' },
      basis: 'preferred',
    });
  });

  it('falls back to the stock unit when the vendor\'s unit no longer relates to it', () => {
    const stale = vendor({ vendorId: 'acme', purchaseUnit: 'bar', purchaseFactor: null });
    const row = buildBuyList({
      parts: [part({ partId: 'c', stockUnit: 'inches', preferredVendorId: 'acme', vendors: [stale] })],
      demand: [material('c', 'j1', 10)],
    }).groups[0].rows[0];
    expect(row).toMatchObject({ purchaseUnit: 'inches', purchaseFactor: 1, purchaseUnitFallback: true, suggestedQuantity: 10 });
  });

  it('keys each row by part and vendor, so an edited quantity survives a refresh', () => {
    const list = buildBuyList({
      parts: [
        part({ partId: 'c', stockUnit: 'inches', preferredVendorId: 'acme', vendors: [acme] }),
        part({ partId: 'b' }),
      ],
      demand: [material('c', 'j1', 10), material('b', 'j1', 1)],
    });
    expect(list.groups.flatMap((g) => g.rows.map((r) => r.key))).toEqual(['c:acme', 'b:none']);
  });
});

describe('the counts the page reports (B3)', () => {
  it('counts rows by reason, rows with no vendor, and the incomparable bucket', () => {
    const list = buildBuyList({
      parts: [
        part({ partId: 'jobs', onHand: 0 }),
        part({ partId: 'restock', onHand: 1, reorderPoint: 5 }),
        part({ partId: 'odd', stockUnit: 'pounds' }),
      ],
      demand: [material('jobs', 'j1', 3), material('odd', 'j1', null)],
    });
    expect(list).toMatchObject({
      rowCount: 2,
      jobRowCount: 1,
      reorderRowCount: 1,
      noVendorRowCount: 2,
      incomparableCount: 1,
    });
  });

  it('is empty — the healthy state — when nothing is needed', () => {
    const list = buildBuyList({ parts: [part({ partId: 'fine', onHand: 100, reorderPoint: 10 })], demand: [] });
    expect(list.groups).toEqual([]);
    expect(list.incomparable).toEqual([]);
    expect(list.rowCount).toBe(0);
  });
});

describe('suggestPurchaseQuantity (B2)', () => {
  it('covers a job shortage in whole purchase units, at least one, or the minimum order', () => {
    const jobs = (shortfall: number, purchaseFactor: number, minimumOrderQuantity: number | null) =>
      suggestPurchaseQuantity({ shortfall, purchaseFactor, minimumOrderQuantity, aboveReorderPoint: false });
    expect(jobs(400, 144, null)).toBe(3);
    // Exactly enough is enough: a part with no reorder point is listed only below zero.
    expect(jobs(288, 144, null)).toBe(2);
    expect(jobs(0, 144, null)).toBe(1);
    expect(jobs(5, 1, 25)).toBe(25);
    expect(jobs(1, 1, 2.5)).toBe(3);
  });

  it('lifts a position strictly above its reorder point — one unit more when the gap is whole units', () => {
    const reorder = (shortfall: number, purchaseFactor: number, minimumOrderQuantity: number | null = null) =>
      suggestPurchaseQuantity({ shortfall, purchaseFactor, minimumOrderQuantity, aboveReorderPoint: true });
    expect(reorder(7, 1)).toBe(8);
    expect(reorder(0, 1)).toBe(1); // AT the point
    expect(reorder(0, 144)).toBe(1);
    expect(reorder(288, 144)).toBe(3); // 2 bars would land on the point
    expect(reorder(400, 144)).toBe(3); // 432 in already clears 400
    expect(reorder(1.1, 0.1)).toBe(12); // float noise never hides the landing
    expect(reorder(2, 1, 25)).toBe(25); // the minimum order still wins
    expect(reorder(2, 1, 2)).toBe(3);
  });
});

/**
 * THE BUG THE E2E JOURNEY FOUND. The old rule suggested exactly the gap to the reorder point, so
 * ordering what it suggested landed the position ON the point — which is listed — and the part came
 * straight back asking for one more. Ordering the suggestion must take a part off the list, and the
 * suggestion must still be the least that does (unless the vendor's minimum order says otherwise).
 */
describe('order the suggestion, it doesn\'t come back (B2)', () => {
  const each = vendor({ vendorId: 'acme' });
  const bars = vendor({ vendorId: 'acme', purchaseUnit: 'bar', purchaseFactor: 144 });
  const tenths = vendor({ vendorId: 'acme', purchaseUnit: 'tenth', purchaseFactor: 0.1 });
  const moq = vendor({ vendorId: 'acme', minimumOrderQuantity: 25 });

  const shapes: Array<[string, BuyListPart, BuyListDemand[]]> = [
    ['under its reorder point', part({ partId: 'p', onHand: 3, reorderPoint: 10, preferredVendorId: 'acme', vendors: [each] }), []],
    ['at its reorder point', part({ partId: 'p', onHand: 10, reorderPoint: 10, preferredVendorId: 'acme', vendors: [each] }), []],
    ['a reorder point of 0 with nothing on hand', part({ partId: 'p', onHand: 0, reorderPoint: 0, preferredVendorId: 'acme', vendors: [each] }), []],
    [
      'a gap of exactly two bars',
      part({ partId: 'p', stockUnit: 'inches', onHand: 0, reorderPoint: 288, preferredVendorId: 'acme', vendors: [bars] }),
      [],
    ],
    [
      'a gap that is not whole bars',
      part({ partId: 'p', stockUnit: 'inches', onHand: 100, reorderPoint: 500, preferredVendorId: 'acme', vendors: [bars] }),
      [],
    ],
    [
      'a fractional purchase unit',
      part({ partId: 'p', stockUnit: 'pounds', onHand: 0, reorderPoint: 1.1, preferredVendorId: 'acme', vendors: [tenths] }),
      [],
    ],
    [
      'a job shortage under a reorder point (both)',
      part({ partId: 'p', onHand: 40, reorderPoint: 10, preferredVendorId: 'acme', vendors: [each] }),
      [material('p', 'j1', 50)],
    ],
    ['already partly on order and on draft', part({ partId: 'p', onHand: 30, onOrder: 10, onDraft: 5, reorderPoint: 50 }), []],
    ['a minimum order larger than the gap', part({ partId: 'p', onHand: 8, reorderPoint: 10, preferredVendorId: 'acme', vendors: [moq] }), []],
    ['no reorder point: a job shortage only', part({ partId: 'p', onHand: 15 }), [material('p', 'j1', 10), material('p', 'j2', 10)]],
    [
      'no reorder point: a shortage of exactly two bars',
      part({ partId: 'p', stockUnit: 'inches', onHand: 0, preferredVendorId: 'acme', vendors: [bars] }),
      [material('p', 'j1', 288)],
    ],
  ];

  it.each(shapes)('%s', (_name, p, demand) => {
    const before = evaluateBuyListPart(p, demand);
    expect(before.listed).toBe(true);
    const row = before.row!;

    // Draft exactly what the list suggested, as "Create draft PO" does, and read the list again.
    const after = evaluateBuyListPart({ ...p, onDraft: p.onDraft + row.suggestedStockQuantity }, demand);
    expect(after.listed).toBe(false);
    expect(after.row).toBeNull();

    // And it is the LEAST that does: one purchase unit fewer would leave the part listed — unless the
    // vendor's minimum order is what set the quantity.
    const minimum = row.minimumOrderQuantity ?? 0;
    if (row.suggestedQuantity > Math.max(1, Math.ceil(minimum))) {
      const fewer = evaluateBuyListPart(
        { ...p, onDraft: p.onDraft + row.suggestedStockQuantity - row.purchaseFactor },
        demand,
      );
      expect(fewer.listed).toBe(true);
    }
  });
});
