/**
 * The default price on a PO line (plan §3.5 "Price default", §3.8; criteria L2 and L4).
 *
 * Part lines: this vendor's valid sheet → Last PO price from this vendor → part cost estimate →
 * blank. Outside lines: the vendor service price → the operation's frozen price. Every result
 * names its source in a caption, and nothing here ever writes a cost back.
 */
import { describe, it, expect } from 'vitest';
import {
  defaultOutsideLinePrice,
  defaultPartLinePrice,
  formatShortDate,
  partVendorLineNotice,
  VENDOR_PO_PRICE_SOURCES,
  type LastPurchaseCandidate,
  type PriceSheet,
} from '@/lib/purchasing/priceDefault';

const TODAY = '2026-11-09';

const sheet = (over: Partial<PriceSheet> = {}): PriceSheet => ({
  vendorName: 'Acme',
  status: 'approved',
  purchaseUnit: 'bar',
  stockFactor: 144,
  validUntil: '2027-03-01',
  breaks: [
    { minQuantity: 1, unitPrice: 40 },
    { minQuantity: 10, unitPrice: 36 },
  ],
  ...over,
});

const lastPo = (over: Partial<LastPurchaseCandidate> = {}): LastPurchaseCandidate => ({
  vendorId: 'acme',
  poNumber: 'PO-1004',
  orderedOn: '2026-02-03',
  isSent: true,
  isArchived: false,
  unitPrice: 38,
  unit: 'bar',
  stockFactor: 144,
  ...over,
});

const tiers = [
  { quantity: 1, costPerUnit: 0.3 },
  { quantity: 1000, costPerUnit: 0.25 },
];

const partLine = (over: Partial<Parameters<typeof defaultPartLinePrice>[0]> = {}) =>
  defaultPartLinePrice({
    vendorId: 'acme',
    vendorName: 'Acme',
    quantity: 10,
    unit: 'bar',
    stockFactor: 144,
    today: TODAY,
    sheet: sheet(),
    lastPurchases: [lastPo()],
    costTiers: tiers,
    ...over,
  });

describe('defaultPartLinePrice — the precedence (L2)', () => {
  it('uses this vendor\'s valid price sheet first, naming the break and its validity', () => {
    expect(partLine()).toEqual({
      unitPrice: 36,
      priceSource: 'price_sheet',
      caption: 'Acme price sheet · 10+ bar · valid to 3/1/27',
      warnings: [],
    });
  });

  it('falls back to the Last PO price when there is no sheet', () => {
    expect(partLine({ sheet: null })).toMatchObject({
      unitPrice: 38,
      priceSource: 'last_po',
      caption: 'Last PO price · PO-1004 (2/3/26)',
    });
  });

  it('falls back to the part cost estimate when nothing has been bought from this vendor', () => {
    expect(partLine({ sheet: null, lastPurchases: [] })).toMatchObject({
      unitPrice: 36, // tier 1000+ in at $0.25 × 144 in a bar
      priceSource: 'estimate',
      caption: 'Part cost estimate',
    });
  });

  it('is blank — to be confirmed — when there is no source at all', () => {
    expect(partLine({ sheet: null, lastPurchases: [], costTiers: [] })).toEqual({
      unitPrice: null,
      priceSource: null,
      caption: 'No price yet — prints as TBC',
      warnings: [],
    });
  });

  it('lets a typed price win over every default', () => {
    expect(partLine({ typedPrice: 50 })).toEqual({
      unitPrice: 50,
      priceSource: 'manual',
      caption: 'Typed',
      warnings: [],
    });
  });

  it('keeps a price the user deliberately cleared as to be confirmed', () => {
    expect(partLine({ typedPrice: null })).toMatchObject({ unitPrice: null, priceSource: null });
  });

  it('only ever persists a source the database accepts', () => {
    expect([...VENDOR_PO_PRICE_SOURCES]).toEqual(['price_sheet', 'last_po', 'estimate', 'vendor_service', 'rfq', 'manual']);
  });
});

describe('defaultPartLinePrice — the price sheet (L2)', () => {
  it('takes the highest break at or below the quantity', () => {
    expect(partLine({ quantity: 25 }).unitPrice).toBe(36);
    expect(partLine({ quantity: 9 }).unitPrice).toBe(40);
    expect(partLine({ quantity: 10 }).unitPrice).toBe(36);
  });

  it('compares the quantity in stock units when the sheet and the line use different units', () => {
    // Sheet in feet: 10+ ft $1.20, 100+ ft $1.00. Line: 10 bars = 1,440 in = 120 ft → the 100+ break.
    const result = partLine({
      sheet: sheet({
        purchaseUnit: 'feet',
        stockFactor: 12,
        breaks: [
          { minQuantity: 10, unitPrice: 1.2 },
          { minQuantity: 100, unitPrice: 1 },
        ],
      }),
    });
    expect(result).toMatchObject({
      unitPrice: 12, // $1.00 a foot is $12.00 a 144-inch bar
      priceSource: 'price_sheet',
      caption: 'Acme price sheet · 100+ ft · valid to 3/1/27',
    });
  });

  it('uses the lowest break below the minimum and says so', () => {
    const result = partLine({
      quantity: 2,
      sheet: sheet({ breaks: [{ minQuantity: 10, unitPrice: 36 }, { minQuantity: 50, unitPrice: 33 }] }),
    });
    expect(result.unitPrice).toBe(36);
    expect(result.warnings).toEqual(['Below Acme\'s 10 bar minimum']);
  });

  it('says nothing about the minimum before a quantity is typed', () => {
    const result = partLine({ quantity: 0 });
    expect(result).toMatchObject({ unitPrice: 40, priceSource: 'price_sheet', warnings: [] });
  });

  it('names an expired sheet and does not use it', () => {
    const result = partLine({ sheet: sheet({ validUntil: '2026-10-31' }) });
    expect(result.priceSource).toBe('last_po');
    expect(result.warnings).toEqual(['Acme\'s sheet expired 10/31/26 — not used']);
  });

  it('still uses a sheet on its last valid day', () => {
    expect(partLine({ sheet: sheet({ validUntil: TODAY }) }).priceSource).toBe('price_sheet');
  });

  it('leaves the validity off the caption for a sheet with no end date', () => {
    expect(partLine({ sheet: sheet({ validUntil: null }) }).caption).toBe('Acme price sheet · 10+ bar');
  });

  it('never prices from a vendor marked Do not use', () => {
    expect(partLine({ sheet: sheet({ status: 'disapproved' }) }).priceSource).toBe('last_po');
  });

  it('skips a sheet with no breaks', () => {
    expect(partLine({ sheet: sheet({ breaks: [] }) }).priceSource).toBe('last_po');
  });
});

describe('defaultPartLinePrice — the Last PO price (L2)', () => {
  it('reads only POs that were sent, to this vendor', () => {
    const result = partLine({
      sheet: null,
      lastPurchases: [
        lastPo({ vendorId: 'other', poNumber: 'PO-2000', orderedOn: '2026-11-01', unitPrice: 1 }),
        lastPo({ isSent: false, poNumber: 'PO-2001', orderedOn: '2026-11-02', unitPrice: 2 }),
        lastPo({ isArchived: true, poNumber: 'PO-2002', orderedOn: '2026-11-03', unitPrice: 3 }),
        lastPo({ unitPrice: null, poNumber: 'PO-2003', orderedOn: '2026-11-04' }),
        lastPo(),
      ],
    });
    expect(result).toMatchObject({ unitPrice: 38, caption: 'Last PO price · PO-1004 (2/3/26)' });
  });

  it('takes the newest sent PO', () => {
    const result = partLine({
      sheet: null,
      lastPurchases: [lastPo(), lastPo({ poNumber: 'PO-1010', orderedOn: '2026-06-01', unitPrice: 39 })],
    });
    expect(result).toMatchObject({ unitPrice: 39, caption: 'Last PO price · PO-1010 (6/1/26)' });
  });

  it('converts a price paid in another unit', () => {
    // Last bought at $1 a foot; this line is in 144-inch bars.
    const result = partLine({
      sheet: null,
      lastPurchases: [lastPo({ unit: 'feet', stockFactor: 12, unitPrice: 1 })],
    });
    expect(result.unitPrice).toBe(12);
  });
});

describe('defaultPartLinePrice — the estimate (L2)', () => {
  it('is the tier cost at the stock quantity, times the factor', () => {
    // 2 bars = 288 in → the 1+ tier at $0.30 an inch → $43.20 a bar.
    expect(partLine({ quantity: 2, sheet: null, lastPurchases: [] }).unitPrice).toBe(43.2);
  });

  it('uses the lowest tier below its quantity, and skips tiers with no cost', () => {
    const result = partLine({
      quantity: 1,
      unit: 'inches',
      stockFactor: 1,
      sheet: null,
      lastPurchases: [],
      costTiers: [
        { quantity: 5, costPerUnit: 0.3 },
        { quantity: 10, costPerUnit: null },
      ],
    });
    expect(result.unitPrice).toBe(0.3);
  });

  it('rounds the estimate to the five places a price is stored at', () => {
    const result = partLine({
      quantity: 1,
      unit: 'feet',
      stockFactor: 12,
      sheet: null,
      lastPurchases: [],
      costTiers: [{ quantity: 1, costPerUnit: 0.0833333 }],
    });
    expect(result.unitPrice).toBe(1);
  });
});

describe('defaultOutsideLinePrice (L2)', () => {
  it('uses the vendor\'s current service price', () => {
    expect(
      defaultOutsideLinePrice({ vendorName: 'Acme', serviceName: 'Anodize', vendorServicePrice: 12.5, frozenOperationPrice: 12.5 }),
    ).toEqual({ unitPrice: 12.5, priceSource: 'vendor_service', caption: 'Acme\'s price for Anodize', warnings: [] });
  });

  it('says what the job was costed at when the two differ', () => {
    expect(
      defaultOutsideLinePrice({ vendorName: 'Acme', serviceName: 'Anodize', vendorServicePrice: 14, frozenOperationPrice: 12.5 }),
    ).toMatchObject({ unitPrice: 14, caption: 'Acme\'s price for Anodize · Job costed at $12.50' });
  });

  it('falls back to the operation\'s frozen price', () => {
    expect(
      defaultOutsideLinePrice({ vendorName: 'Acme', serviceName: 'Anodize', vendorServicePrice: null, frozenOperationPrice: 12.5 }),
    ).toEqual({ unitPrice: 12.5, priceSource: 'estimate', caption: 'Job costed at $12.50', warnings: [] });
  });

  it('treats a $0 service price as a price', () => {
    expect(
      defaultOutsideLinePrice({ vendorName: 'Acme', serviceName: 'Rework', vendorServicePrice: 0, frozenOperationPrice: null }),
    ).toMatchObject({ unitPrice: 0, priceSource: 'vendor_service' });
  });

  it('is blank when neither exists', () => {
    expect(
      defaultOutsideLinePrice({ vendorName: 'Acme', serviceName: null, vendorServicePrice: null, frozenOperationPrice: null }),
    ).toMatchObject({ unitPrice: null, priceSource: null, caption: 'No price yet — prints as TBC' });
  });

  it('lets a typed price win', () => {
    expect(
      defaultOutsideLinePrice({ vendorName: 'Acme', serviceName: 'Anodize', vendorServicePrice: 12.5, frozenOperationPrice: 12.5, typedPrice: 11 }),
    ).toMatchObject({ unitPrice: 11, priceSource: 'manual', caption: 'Typed' });
  });

  it('names the service generically when it has no name', () => {
    expect(
      defaultOutsideLinePrice({ vendorName: 'Acme', serviceName: null, vendorServicePrice: 3, frozenOperationPrice: null }).caption,
    ).toBe('Acme\'s service price');
  });
});

describe('partVendorLineNotice — approved-vendor warnings on a PO line (L4)', () => {
  it('says nothing for an approved vendor', () => {
    expect(partVendorLineNotice({ vendorName: 'Acme', status: 'approved' })).toBeNull();
  });

  it('is a quiet caption with "Add to list" when the vendor is not on the list', () => {
    expect(partVendorLineNotice({ vendorName: 'Acme', status: null })).toEqual({
      tone: 'quiet',
      text: 'Acme isn\'t on this part\'s approved vendor list.',
      action: 'add_to_list',
    });
  });

  it('is amber for a conditional vendor, carrying the condition', () => {
    expect(partVendorLineNotice({ vendorName: 'Acme', status: 'conditional', statusNote: 'Certs from Mill 7 only' })).toEqual({
      tone: 'warning',
      text: 'Acme is Conditional for this part — Certs from Mill 7 only',
      action: null,
    });
    expect(partVendorLineNotice({ vendorName: 'Acme', status: 'conditional' })?.text).toBe('Acme is Conditional for this part.');
  });

  it('blocks a vendor marked Do not use', () => {
    expect(partVendorLineNotice({ vendorName: 'Acme', status: 'disapproved' })).toEqual({
      tone: 'blocked',
      text: 'Acme is marked Do not use for this part, so it can\'t go on this PO.',
      action: null,
    });
  });
});

describe('formatShortDate', () => {
  it('reads a date column as the shop wrote it, with no timezone shift', () => {
    expect(formatShortDate('2027-03-01')).toBe('3/1/27');
    expect(formatShortDate('2026-12-31')).toBe('12/31/26');
    expect(formatShortDate('not a date')).toBe('not a date');
  });
});
