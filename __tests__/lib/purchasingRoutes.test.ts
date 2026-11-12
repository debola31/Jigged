import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  NEW_VENDOR_PO_PREFILL_KEYS,
  PURCHASING_PAGE_TITLES,
  newVendorPoPath,
  purchasingHubPath,
  purchasingPageTitle,
  vendorPoPath,
  vendorRfqPath,
} from '@/lib/purchasingRoutes';

/**
 * Every real page under /purchasing is named (criterion P8).
 *
 * The slot after `orders` or `rfqs` is either a named page (`new`) or a record ID, and nothing can
 * tell them apart by looking — so an unlisted page does not error, it silently takes its parent's
 * title in the header AND the feedback dialog. That is how /parts/drawings shipped calling itself
 * "Part Details" (lib/partsSubroutes.ts).
 *
 * This reads the routes off disk, so adding a page without a title fails here rather than in a
 * screenshot. Until the purchasing pages exist the disk half has nothing to read and passes; the
 * moment the folder appears, every page in it must be in the table.
 */
const PURCHASING_DIR = join(process.cwd(), 'app/dashboard/[companyId]/purchasing');

/** Route patterns, relative to /purchasing, of every `page.tsx` under `dir`. */
function pagePatterns(dir: string, prefix: string[] = []): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name.startsWith('_')) continue; // private folder: not a route
      // A route group `(x)` adds nothing to the URL.
      const next = name.startsWith('(') && name.endsWith(')') ? prefix : [...prefix, name];
      found.push(...pagePatterns(full, next));
    } else if (/^page\.(tsx|ts|jsx|js)$/.test(name)) {
      found.push(prefix.join('/'));
    }
  }
  return found;
}

describe('PURCHASING_PAGE_TITLES (P8)', () => {
  it('names every page under /purchasing that exists on disk', () => {
    if (!existsSync(PURCHASING_DIR)) return; // the pages land in a later stage of this PR
    const missing = pagePatterns(PURCHASING_DIR).filter((p) => !(p in PURCHASING_PAGE_TITLES));
    expect(missing, `add these to lib/purchasingRoutes.ts: ${missing.join(', ')}`).toEqual([]);
  });

  it('titles the hub, the new-PO page, a PO, the new-RFQ page and an RFQ', () => {
    expect(PURCHASING_PAGE_TITLES).toEqual({
      '': 'Purchasing',
      'orders/new': 'New Purchase Order',
      'orders/[poId]': 'Purchase Order',
      'rfqs/new': 'New RFQ',
      'rfqs/[rfqId]': 'RFQ',
    });
  });
});

describe('purchasingPageTitle (P8)', () => {
  it('titles each purchasing page from its pathname', () => {
    expect(purchasingPageTitle('/dashboard/c1/purchasing')).toBe('Purchasing');
    expect(purchasingPageTitle('/dashboard/c1/purchasing/orders/new')).toBe('New Purchase Order');
    expect(purchasingPageTitle('/dashboard/c1/purchasing/orders/0b8e6c1e-5d1a-4c6e-9f00-1d2c3b4a5e6f')).toBe('Purchase Order');
    expect(purchasingPageTitle('/dashboard/c1/purchasing/rfqs/new')).toBe('New RFQ');
    expect(purchasingPageTitle('/dashboard/c1/purchasing/rfqs/abc')).toBe('RFQ');
  });

  it('prefers a named page over the record slot, so /orders/new is never "Purchase Order"', () => {
    expect(purchasingPageTitle('/dashboard/c1/purchasing/orders/new/')).toBe('New Purchase Order');
  });

  it('falls back to the hub title for anything else under /purchasing', () => {
    expect(purchasingPageTitle('/dashboard/c1/purchasing/orders')).toBe('Purchasing');
    expect(purchasingPageTitle('/dashboard/c1/purchasing/orders/abc/extra')).toBe('Purchasing');
  });

  it('answers nothing outside /purchasing, so the other title rules still apply', () => {
    expect(purchasingPageTitle('/dashboard/c1/parts/new')).toBeNull();
    expect(purchasingPageTitle('/dashboard/c1/vendors/v1')).toBeNull();
  });
});

describe('purchasing paths (P8, M1)', () => {
  it('builds the hub, PO and RFQ links every surface and MCP record points at', () => {
    expect(purchasingHubPath('c1')).toBe('/dashboard/c1/purchasing');
    expect(purchasingHubPath('c1', 'to-buy')).toBe('/dashboard/c1/purchasing?view=to-buy');
    expect(vendorPoPath('c1', 'po-1')).toBe('/dashboard/c1/purchasing/orders/po-1');
    expect(vendorPoPath('c1', 'new')).toBe('/dashboard/c1/purchasing/orders/new');
    expect(vendorRfqPath('c1', 'rfq-1')).toBe('/dashboard/c1/purchasing/rfqs/rfq-1');
  });

  it('only builds links whose pattern has a title', () => {
    const pattern = (path: string) =>
      path
        .replace(/^\/dashboard\/c1\/purchasing\/?/, '')
        .replace(/\?.*$/, '')
        .replace(/^orders\/(?!new$)[^/]+$/, 'orders/[poId]')
        .replace(/^rfqs\/(?!new$)[^/]+$/, 'rfqs/[rfqId]');
    for (const path of [purchasingHubPath('c1', 'orders'), vendorPoPath('c1', 'x'), vendorPoPath('c1', 'new'), newVendorPoPath('c1', { vendorId: 'v1' }), vendorRfqPath('c1', 'y'), vendorRfqPath('c1', 'new')]) {
      expect(pattern(path) in PURCHASING_PAGE_TITLES, path).toBe(true);
    }
  });
});

describe('newVendorPoPath — the new-PO form, prefilled by ids', () => {
  /** An outside step's "Create PO": the form fills the line from THAT VENDOR's open steps. */
  it('carries the vendor and the step together', () => {
    expect(newVendorPoPath('c1', { vendorId: 'v1', jobOperationId: 'op-1' })).toBe(
      '/dashboard/c1/purchasing/orders/new?vendor=v1&jobOperation=op-1',
    );
  });

  it('writes every key the page reads, in one order, and leaves out what is blank', () => {
    expect(
      newVendorPoPath('c1', { workCenterId: 'wc', jobOperationId: 'op', jobPartId: 'jp', jobId: 'j', partId: 'p', vendorId: 'v' }),
    ).toBe('/dashboard/c1/purchasing/orders/new?vendor=v&part=p&job=j&jobPart=jp&jobOperation=op&workCenter=wc');
    expect(newVendorPoPath('c1', { vendorId: null, partId: 'p', jobId: '' })).toBe('/dashboard/c1/purchasing/orders/new?part=p');
  });

  it('is the bare form with nothing to prefill', () => {
    expect(newVendorPoPath('c1')).toBe(vendorPoPath('c1', 'new'));
  });

  it('names the keys the new-PO page reads', () => {
    expect(NEW_VENDOR_PO_PREFILL_KEYS).toEqual({
      vendorId: 'vendor',
      partId: 'part',
      jobId: 'job',
      jobPartId: 'jobPart',
      jobOperationId: 'jobOperation',
      workCenterId: 'workCenter',
    });
  });
});
