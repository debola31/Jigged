/**
 * Shared kit for the purchasing MCP tool tests (plan §5.4): one Supabase stub that LOGS every
 * query beside every access-function call, so a test can prove the company-scoped lookup ran
 * before any id-only call; logged wrappers for the mocked access functions; fixtures shaped
 * exactly like the access layer's results (and "every nullable field null" variants); and the
 * contract every tool output is held to — it parses, names nobody, and every `url` resolves to
 * a real `app/**\/page.tsx`.
 *
 * Use it from a `vi.mock` factory through a dynamic import (the `purchasingTestStub` precedent):
 *
 *   vi.mock('@/lib/supabase', async () => (await import('./purchasingTestKit')).kit.supabaseModule());
 *   vi.mock('@/utils/vendorPoAccess', async (importOriginal) => ({
 *     ...(await importOriginal<typeof import('@/utils/vendorPoAccess')>()),
 *     ...(await import('./purchasingTestKit')).kit.wrap(['getVendorPo']),
 *   }));
 *
 * Each test file gets its own module instance, so the kit is per file. Call `kit.reset()` in
 * `beforeEach`.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { vi, type Mock } from 'vitest';
import { z } from 'zod';

import type { CompanyToolEnv } from '@/lib/mcp/defineTool';
import type { BuyListResult } from '@/types/buyList';
import type { PartCostPreview, PartVendorList, PartVendorRow } from '@/types/partVendor';
import type {
  OpenOutsideOperation,
  VendorPoDetail,
  VendorPoHeader,
  VendorPoJobLine,
  VendorPoLine,
  VendorPoListRow,
  VendorPoOutsideSlip,
  VendorPoPriceDefaultInputs,
  VendorPoQuickBooksInfo,
  VendorPoReceipt,
  VendorPoSummary,
} from '@/types/vendorPo';
import type { VendorRfqDetail, VendorRfqListRow } from '@/types/vendorRfq';

// ------------------------------------------------------------------------------------------------
// Ids and the env
// ------------------------------------------------------------------------------------------------

export const CO = 'co-1';
export const PO_ID = '0b8e6c1e-5d1a-4c6e-9f00-1d2c3b4a5e61';
export const PO2_ID = '0b8e6c1e-5d1a-4c6e-9f00-1d2c3b4a5e62';
export const LINE1 = '1a000000-0000-4000-8000-000000000001';
export const LINE2 = '1a000000-0000-4000-8000-000000000002';
export const LINE3 = '1a000000-0000-4000-8000-000000000003';
export const VENDOR_ID = '2b000000-0000-4000-8000-000000000001';
export const VENDOR2_ID = '2b000000-0000-4000-8000-000000000002';
export const PART_ID = '3c000000-0000-4000-8000-000000000001';
export const PART2_ID = '3c000000-0000-4000-8000-000000000002';
export const JOB_ID = '4d000000-0000-4000-8000-000000000001';
export const JOB_PART_ID = '4d000000-0000-4000-8000-0000000000a1';
export const OP_ID = '4d000000-0000-4000-8000-0000000000b1';
export const RFQ_ID = '5e000000-0000-4000-8000-000000000001';
export const RFQ_LINE1 = '5e000000-0000-4000-8000-0000000000c1';
export const INVITE1 = '5e000000-0000-4000-8000-0000000000d1';
export const INVITE2 = '5e000000-0000-4000-8000-0000000000d2';
export const RESP1 = '5e000000-0000-4000-8000-0000000000e1';
export const RESP2 = '5e000000-0000-4000-8000-0000000000e2';
export const PV_ID = '6f000000-0000-4000-8000-000000000001';
export const RECEIPT_ID = '7a000000-0000-4000-8000-000000000001';
export const LINK_ID = '8b000000-0000-4000-8000-000000000001';
export const LOC_SHELF = '9c000000-0000-4000-8000-000000000002';
export const LOC_RACK = '9c000000-0000-4000-8000-000000000001';
export const WC_ID = 'ad000000-0000-4000-8000-000000000001';

export const TODAY = '2026-11-09';
export const ORIGIN = 'https://jigged.app';

export function envAs(role: 'admin' | 'user' = 'user'): CompanyToolEnv {
  return {
    caller: { token: 't', clientId: 'c', userId: 'u', email: null, expiresAt: 0 },
    company: { id: CO, name: 'Acme Machining', role, isDemo: false, governingCompanyId: CO },
    origin: ORIGIN,
    link: (path) => `${ORIGIN}${path}`,
  };
}

export const poUrl = (id = PO_ID) => `${ORIGIN}/dashboard/${CO}/purchasing/orders/${id}`;
export const rfqUrl = (id = RFQ_ID) => `${ORIGIN}/dashboard/${CO}/purchasing/rfqs/${id}`;

// ------------------------------------------------------------------------------------------------
// The stub: every query and every access call, in one ordered log
// ------------------------------------------------------------------------------------------------

export interface Logged {
  kind: 'query' | 'call';
  /** The table, or the access function. */
  name: string;
  method: string;
  args: unknown[];
}

export interface Answer {
  data?: unknown;
  count?: number | null;
  error?: unknown;
}

const CHAIN = [
  'select', 'eq', 'neq', 'in', 'is', 'not', 'gt', 'gte', 'lt', 'lte', 'ilike', 'like', 'or',
  'contains', 'filter', 'match', 'order', 'limit', 'range',
];

function createKit() {
  const log: Logged[] = [];
  const queues = new Map<string, Answer[]>();
  const fixed = new Map<string, Answer>();
  const fns = new Map<string, Mock>();

  function builder(table: string) {
    const answer = queues.get(table)?.shift() ?? fixed.get(table) ?? { data: [], count: 0 };
    let single = false;
    const b: Record<string, unknown> = {};
    for (const m of CHAIN) {
      b[m] = (...args: unknown[]) => {
        log.push({ kind: 'query', name: table, method: m, args });
        return b;
      };
    }
    for (const m of ['maybeSingle', 'single']) {
      b[m] = () => {
        log.push({ kind: 'query', name: table, method: m, args: [] });
        single = true;
        return b;
      };
    }
    b.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
      if (answer.error) return Promise.resolve({ data: null, error: answer.error, count: null }).then(resolve, reject);
      let data = answer.data ?? null;
      if (single) data = Array.isArray(data) ? (data[0] ?? null) : data;
      else if (data === null) data = [];
      const count = answer.count !== undefined ? answer.count : Array.isArray(answer.data) ? answer.data.length : null;
      return Promise.resolve({ data, error: null, count }).then(resolve, reject);
    };
    return b;
  }

  const client = { from: (table: string) => builder(table) };

  function fn(name: string): Mock {
    let f = fns.get(name);
    if (!f) {
      f = vi.fn();
      fns.set(name, f);
    }
    return f;
  }

  return {
    log,
    client,
    fn,
    /** What `vi.mock('@/lib/supabase')` returns. */
    supabaseModule: () => ({ getSupabase: () => client, registerScopedClientResolver: () => {} }),
    /** Logged stand-ins for access functions, each delegating to `fn(name)`. */
    wrap(names: readonly string[]): Record<string, (...a: unknown[]) => unknown> {
      return Object.fromEntries(
        names.map((name) => [
          name,
          (...args: unknown[]) => {
            log.push({ kind: 'call', name, method: 'call', args });
            return fn(name)(...args);
          },
        ]),
      );
    },
    /** Every query of a table answers this (unless something is queued for it). */
    answer(table: string, data: unknown, count?: number | null) {
      fixed.set(table, { data, count });
    },
    /** The next queries of a table answer these, in order, before falling back to `answer`. */
    queue(table: string, ...answers: Answer[]) {
      queues.set(table, [...(queues.get(table) ?? []), ...answers]);
    },
    queries(table?: string): Logged[] {
      return log.filter((e) => e.kind === 'query' && (table === undefined || e.name === table));
    },
    calls(name: string): unknown[][] {
      return log.filter((e) => e.kind === 'call' && e.name === name).map((e) => e.args);
    },
    /** A company-scoped `.eq('company_id', co-1)` was logged before the first call of `name`. */
    companyScopedBefore(name: string): boolean {
      const scoped = log.findIndex(
        (e) => e.kind === 'query' && e.method === 'eq' && e.args[0] === 'company_id' && e.args[1] === CO,
      );
      const call = log.findIndex((e) => e.kind === 'call' && e.name === name);
      return scoped !== -1 && call !== -1 && scoped < call;
    },
    reset() {
      log.length = 0;
      queues.clear();
      fixed.clear();
      for (const f of fns.values()) f.mockReset();
    },
  };
}

export const kit = createKit();

// ------------------------------------------------------------------------------------------------
// The contract every output is held to
// ------------------------------------------------------------------------------------------------

/** No output names a person against the work: the catalogue's regexes, plus the purchasing ones. */
export const PERSON_KEY =
  /^(completed|sent|received|created|updated|performed|issued|moved|counted|ordered|approved|requested|closed|voided|pushed|reopened|awarded|mapped|linked|chosen)_by|^author|^operator|^user_id$|^user_name$|_by_name$|^buyer/;

export function keysOf(value: unknown, into: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const v of value) keysOf(v, into);
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      into.push(k);
      keysOf(v, into);
    }
  }
  return into;
}

/** Every value of every `url` key, anywhere in the output. */
export function urlsOf(value: unknown, into: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const v of value) urlsOf(v, into);
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (k === 'url' && typeof v === 'string') into.push(v);
      else urlsOf(v, into);
    }
  }
  return into;
}

const APP_DIR = join(process.cwd(), 'app');

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** The directories a path segment may enter from `dir`: route groups `(x)` add nothing to a URL. */
function childDirs(dir: string): string[] {
  if (!isDir(dir)) return [];
  return readdirSync(dir).filter((name) => isDir(join(dir, name)) && !name.startsWith('_'));
}

function walk(dir: string, segments: readonly string[]): boolean {
  const children = childDirs(dir);
  for (const group of children.filter((n) => n.startsWith('(') && n.endsWith(')'))) {
    if (walk(join(dir, group), segments)) return true;
  }
  if (segments.length === 0) return existsSync(join(dir, 'page.tsx')) || existsSync(join(dir, 'page.ts'));
  const [head, ...rest] = segments;
  if (children.includes(head) && walk(join(dir, head), rest)) return true;
  const dynamic = children.filter((n) => /^\[[^.\]][^\]]*\]$/.test(n));
  return dynamic.some((n) => walk(join(dir, n), rest));
}

/**
 * Does this link land on a real page of the app — a `page.tsx` under `app/`, walked segment by
 * segment (route groups and `[dynamic]` folders included)? The query string is the page's own
 * business.
 */
export function resolvesToPage(url: string): boolean {
  const segments = new URL(url, ORIGIN).pathname.split('/').filter(Boolean);
  return walk(APP_DIR, segments);
}

/**
 * The §5.4 "every tool" checks on one result: it parses against the tool's own output schema, no
 * key names a person, the top-level record has a url, and every url lands on a page.
 */
export function expectContract(tool: { output: z.ZodRawShape }, data: unknown): void {
  const parsed = z.object(tool.output).safeParse(data);
  if (!parsed.success) throw new Error(`output does not parse: ${parsed.error.message}`);
  const people = keysOf(data).filter((k) => PERSON_KEY.test(k));
  if (people.length > 0) throw new Error(`output names a person: ${people.join(', ')}`);
  if ('url' in tool.output && typeof (data as { url?: unknown }).url !== 'string') {
    throw new Error('the record has no url');
  }
  const broken = urlsOf(data).filter((u) => !resolvesToPage(u));
  if (broken.length > 0) throw new Error(`urls that land on no page: ${broken.join(', ')}`);
}

// ------------------------------------------------------------------------------------------------
// Fixtures, shaped exactly like the access layer's results
// ------------------------------------------------------------------------------------------------

const address = {
  address_line1: '9 Mill Rd',
  address_line2: null,
  city: 'Akron',
  state: 'OH',
  postal_code: '44301',
  country: 'USA',
  attention_to: null,
};

export function poHeader(o: Partial<VendorPoHeader> = {}): VendorPoHeader {
  return {
    id: PO_ID,
    companyId: CO,
    poNumber: 'PO-1042',
    vendorId: VENDOR_ID,
    vendorName: 'Acme Metals',
    vendorAddressId: 'va-1',
    vendorAddress: address,
    vendorContactId: 'vc-1',
    vendorContact: { name: 'Lee Sales', email: 'lee@acme.test', phone: '555-0100' },
    shipToKind: 'shop',
    shipToVendorId: null,
    shipToVendorAddressId: null,
    shipToCustomerId: null,
    shipToCustomerAddressId: null,
    shipToName: 'Acme Machining',
    shipToAddress: { ...address, address_line1: '1 Shop St' },
    orderedOn: '2026-11-02',
    needByOn: '2026-11-20',
    paymentTerms: 'Net 30',
    shipVia: 'UPS Ground',
    notesToVendor: 'Certs with the shipment.',
    internalNotes: 'Ask Lee about the mill cert.',
    revision: 0,
    sentRevision: 0,
    issuedAt: '2026-11-02T15:00:00Z',
    lastSentAt: '2026-11-02T15:00:00Z',
    contentVersion: 3,
    closedAt: null,
    closedReason: null,
    vendorRfqId: null,
    createdAt: '2026-11-02T14:00:00Z',
    updatedAt: '2026-11-02T15:00:00.123456+00:00',
    deletedAt: null,
    isArchived: false,
    ...o,
  };
}

export function poSummary(o: Partial<VendorPoSummary> = {}): VendorPoSummary {
  return {
    status: 'partially_received',
    isLate: false,
    nextExpectedOn: '2026-11-18',
    lineCount: 2,
    outstandingLineCount: 1,
    orderedAmount: 475,
    openAmount: 255,
    hasUnpricedLines: false,
    hasUnsentChanges: false,
    quickbooksState: 'not_sent',
    jobIds: [JOB_ID],
    jobNumbers: ['J-1042'],
    ...o,
  };
}

/** A part line: 10 bars of 6061 (144 in each), 4 in. */
export function poLine(o: Partial<VendorPoLine> = {}): VendorPoLine {
  return {
    id: LINE1,
    vendorPurchaseOrderId: PO_ID,
    lineNumber: 1,
    lineKind: 'part',
    partId: PART_ID,
    partName: 'BAR-6061',
    description: '6061-T6 bar, 1in round',
    vendorPartNumber: 'AL-6061-1',
    quantity: 10,
    unit: 'bar',
    stockUnit: 'inches',
    stockFactor: 144,
    unitPrice: 42.5,
    priceSource: 'price_sheet',
    amount: 425,
    openAmount: 255,
    needByOn: '2026-11-20',
    promisedOn: '2026-11-18',
    expectedOn: '2026-11-18',
    certRequired: true,
    expectsReceipt: true,
    jobId: JOB_ID,
    jobNumber: 'J-1042',
    jobPartId: null,
    jobOperationId: null,
    operationLabel: null,
    vendorServiceId: null,
    serviceName: null,
    workCenterId: null,
    workCenterName: null,
    closedAt: null,
    status: 'partially_received',
    isLate: false,
    orderedStockQuantity: 1440,
    receivedQuantity: 4,
    receivedStockQuantity: 576,
    remainingQuantity: 6,
    remainingStockQuantity: 864,
    openQuantity: 6,
    openStockQuantity: 864,
    overReceivedQuantity: 0,
    sentQuantity: null,
    atVendorQuantity: null,
    linkedSlipCount: 0,
    hasLiveReceipts: true,
    removable: false,
    createdAt: '2026-11-02T14:00:00Z',
    updatedAt: '2026-11-02T14:00:00Z',
    ...o,
  };
}

/** An other line: freight, no receipt expected. */
export function otherLine(o: Partial<VendorPoLine> = {}): VendorPoLine {
  return poLine({
    id: LINE2,
    lineNumber: 2,
    lineKind: 'other',
    partId: null,
    partName: null,
    description: 'Freight',
    vendorPartNumber: null,
    quantity: 1,
    unit: 'each',
    stockUnit: null,
    stockFactor: null,
    unitPrice: 50,
    priceSource: 'manual',
    amount: 50,
    openAmount: 0,
    promisedOn: null,
    expectedOn: '2026-11-20',
    certRequired: false,
    expectsReceipt: false,
    jobId: null,
    jobNumber: null,
    status: 'no_receipt',
    orderedStockQuantity: null,
    receivedQuantity: 0,
    receivedStockQuantity: null,
    remainingQuantity: 0,
    remainingStockQuantity: null,
    openQuantity: 0,
    openStockQuantity: null,
    hasLiveReceipts: false,
    removable: true,
    ...o,
  });
}

/** An outside-service line: anodize 40 pieces for J-1042 Op 30. */
export function outsideLine(o: Partial<VendorPoLine> = {}): VendorPoLine {
  return poLine({
    id: LINE3,
    lineNumber: 3,
    lineKind: 'outside_service',
    partId: PART2_ID,
    partName: 'BRKT-100',
    description: 'Anodize — BRKT-100 — Job J-1042, Op 30',
    vendorPartNumber: null,
    quantity: 40,
    unit: 'each',
    stockUnit: null,
    stockFactor: null,
    unitPrice: 1.25,
    priceSource: 'vendor_service',
    amount: 50,
    openAmount: 25,
    promisedOn: null,
    expectedOn: '2026-11-15',
    certRequired: false,
    jobPartId: JOB_PART_ID,
    jobOperationId: OP_ID,
    operationLabel: 'Op 30 Anodize',
    vendorServiceId: 'vs-1',
    serviceName: 'Anodize',
    status: 'partially_received',
    orderedStockQuantity: null,
    receivedQuantity: 20,
    receivedStockQuantity: null,
    remainingQuantity: 20,
    remainingStockQuantity: null,
    openQuantity: 20,
    openStockQuantity: null,
    sentQuantity: 40,
    atVendorQuantity: 20,
    linkedSlipCount: 1,
    hasLiveReceipts: true,
    removable: false,
    ...o,
  });
}

export function poReceipt(o: Partial<VendorPoReceipt> = {}): VendorPoReceipt {
  return {
    id: RECEIPT_ID,
    vendorPurchaseOrderLineId: LINE1,
    lineNumber: 1,
    lineKind: 'part',
    receiptGroupId: 'g-1',
    entryIndex: 0,
    quantity: 4,
    unit: 'bar',
    stockQuantity: 576,
    stockUnit: 'inches',
    partId: PART_ID,
    locationId: LOC_SHELF,
    locationName: 'Shelf 2',
    lotId: 'lot-1',
    lotCode: 'H4471',
    heatNumber: 'H4471',
    startedTracking: true,
    inventoryTransactionId: 'txn-1',
    voidTransactionId: null,
    vendorPackingSlip: 'PS-88',
    notes: 'Two bars scratched.',
    receivedAt: '2026-11-05T16:00:00Z',
    receivedByName: 'Pat Receiver',
    voidedAt: null,
    voidReason: null,
    ...o,
  };
}

export function poSlip(o: Partial<VendorPoOutsideSlip> = {}): VendorPoOutsideSlip {
  return {
    id: 'os-1',
    slipNumber: 'VPS-1042-1',
    vendorPurchaseOrderLineId: LINE3,
    jobId: JOB_ID,
    jobOperationId: OP_ID,
    quantity: 40,
    shippedAt: '2026-11-03T09:00:00Z',
    dueBackOn: '2026-11-15',
    closedAt: null,
    voidedAt: null,
    receivedQuantity: 20,
    outstandingQuantity: 20,
    ...o,
  };
}

export function poQuickBooks(o: Partial<VendorPoQuickBooksInfo> = {}): VendorPoQuickBooksInfo {
  return {
    state: 'not_sent',
    linkId: null,
    provider: null,
    linkStatus: null,
    docNumber: null,
    url: null,
    closedInQuickBooks: false,
    pushedRevision: null,
    pushedAt: null,
    ...o,
  };
}

export function poDetail(o: Partial<VendorPoDetail> = {}): VendorPoDetail {
  return {
    header: poHeader(),
    summary: poSummary(),
    lines: [poLine(), otherLine()],
    receipts: [poReceipt()],
    outsideSlips: [],
    revisionCount: 1,
    quickbooks: poQuickBooks(),
    ...o,
  };
}

/** A PO with every nullable field the access layer can hand back set to null. */
export function poDetailAllNull(): VendorPoDetail {
  return {
    header: poHeader({
      vendorAddressId: null,
      vendorAddress: null,
      vendorContactId: null,
      vendorContact: null,
      shipToAddress: null,
      needByOn: null,
      paymentTerms: null,
      shipVia: null,
      notesToVendor: null,
      internalNotes: null,
      sentRevision: null,
      issuedAt: null,
      lastSentAt: null,
      closedAt: null,
      closedReason: null,
      vendorRfqId: null,
      deletedAt: null,
    }),
    summary: poSummary({ status: 'draft', nextExpectedOn: null, jobIds: [], jobNumbers: [] }),
    lines: [
      poLine({
        partId: null,
        partName: null,
        vendorPartNumber: null,
        stockUnit: null,
        stockFactor: null,
        unitPrice: null,
        priceSource: null,
        amount: null,
        openAmount: null,
        needByOn: null,
        promisedOn: null,
        expectedOn: null,
        jobId: null,
        jobNumber: null,
        jobPartId: null,
        jobOperationId: null,
        operationLabel: null,
        vendorServiceId: null,
        serviceName: null,
        workCenterId: null,
        workCenterName: null,
        closedAt: null,
        status: 'draft',
        orderedStockQuantity: null,
        receivedStockQuantity: null,
        remainingStockQuantity: null,
        openStockQuantity: null,
        sentQuantity: null,
        atVendorQuantity: null,
      }),
    ],
    receipts: [
      poReceipt({
        lineNumber: null,
        stockQuantity: null,
        stockUnit: null,
        partId: null,
        locationId: null,
        locationName: null,
        lotId: null,
        lotCode: null,
        heatNumber: null,
        inventoryTransactionId: null,
        voidTransactionId: null,
        vendorPackingSlip: null,
        notes: null,
        receivedByName: null,
        voidedAt: null,
        voidReason: null,
      }),
    ],
    outsideSlips: [poSlip({ dueBackOn: null, closedAt: null, voidedAt: null })],
    revisionCount: 0,
    quickbooks: poQuickBooks(),
  };
}

export function listRow(o: Partial<VendorPoListRow> = {}): VendorPoListRow {
  return {
    id: PO_ID,
    companyId: CO,
    poNumber: 'PO-1042',
    vendorId: VENDOR_ID,
    vendorName: 'Acme Metals',
    status: 'sent',
    orderedOn: '2026-11-02',
    needByOn: '2026-11-20',
    nextExpectedOn: '2026-11-05',
    isLate: true,
    revision: 1,
    sentRevision: 0,
    hasUnsentChanges: true,
    issuedAt: '2026-11-02T15:00:00Z',
    lastSentAt: '2026-11-02T15:00:00Z',
    closedAt: null,
    lineCount: 2,
    outstandingLineCount: 2,
    orderedAmount: 475,
    openAmount: 475,
    hasUnpricedLines: false,
    quickbooksState: 'out_of_date',
    jobIds: [JOB_ID],
    jobNumbers: ['J-1042'],
    vendorRfqId: null,
    createdAt: '2026-11-02T14:00:00Z',
    updatedAt: '2026-11-02T15:00:00Z',
    isArchived: false,
    ...o,
  };
}

export function jobLine(o: Partial<VendorPoJobLine> = {}): VendorPoJobLine {
  return {
    lineId: LINE3,
    vendorPurchaseOrderId: PO_ID,
    poNumber: 'PO-1042',
    poStatus: 'partially_received',
    vendorId: VENDOR_ID,
    vendorName: 'Acme Metals',
    lineNumber: 3,
    lineKind: 'outside_service',
    partId: PART2_ID,
    partName: 'BRKT-100',
    description: 'Anodize — BRKT-100 — Job J-1042, Op 30',
    jobPartId: JOB_PART_ID,
    jobOperationId: OP_ID,
    operationLabel: 'Op 30 Anodize',
    quantity: 40,
    unit: 'each',
    receivedQuantity: 20,
    openQuantity: 20,
    status: 'partially_received',
    expectedOn: '2026-11-15',
    isLate: false,
    ...o,
  };
}

/** What `getPriceDefaultInputs` reads for BAR-6061 from Acme: a sheet in bars of 144 in. */
export function priceInputs(o: Partial<VendorPoPriceDefaultInputs> = {}): VendorPoPriceDefaultInputs {
  return {
    partId: PART_ID,
    partName: 'BAR-6061',
    partSource: 'bought',
    stockUnit: 'inches',
    conversions: [{ from_unit: 'bar', to_primary_factor: 144 }],
    vendorId: VENDOR_ID,
    vendorName: 'Acme Metals',
    partVendor: {
      id: PV_ID,
      status: 'approved',
      statusNote: null,
      vendorPartNumber: 'AL-6061-1',
      purchaseUnit: 'bar',
      leadTimeDays: 5,
      minimumOrderQuantity: null,
      validUntil: '2027-03-01',
    },
    sheet: {
      vendorName: 'Acme Metals',
      status: 'approved',
      purchaseUnit: 'bar',
      stockFactor: 144,
      validUntil: '2027-03-01',
      breaks: [
        { minQuantity: 1, unitPrice: 45 },
        { minQuantity: 10, unitPrice: 42.5 },
      ],
    },
    lastPurchases: [],
    lastOrderedUnit: 'bar',
    costTiers: [{ quantity: 1, costPerUnit: 0.3 }],
    ...o,
  };
}

export function openOp(o: Partial<OpenOutsideOperation> = {}): OpenOutsideOperation {
  return {
    jobOperationId: OP_ID,
    jobId: JOB_ID,
    jobNumber: 'J-1042',
    jobDueDate: '2026-11-30',
    jobPartId: JOB_PART_ID,
    partId: PART2_ID,
    partName: 'BRKT-100',
    stockUnit: 'each',
    sequence: 30,
    operationName: 'Anodize',
    operationStatus: 'pending',
    vendorServiceId: 'vs-1',
    serviceName: 'Anodize',
    vendorServicePrice: 1.25,
    frozenOperationPrice: 1.1,
    priceDefault: {
      unitPrice: 1.25,
      priceSource: 'vendor_service',
      caption: "Acme Metals's price for Anodize · Job costed at $1.10",
      warnings: [],
    },
    orderedQuantity: 40,
    sentQuantity: 0,
    goodQuantity: 0,
    atVendorQuantity: 0,
    leftToSendQuantity: 40,
    openLine: null,
    defaultDescription: 'Anodize — BRKT-100 — Job J-1042, Op 30',
    ...o,
  };
}

export function partVendorRow(o: Partial<PartVendorRow> = {}): PartVendorRow {
  return {
    id: PV_ID,
    partId: PART_ID,
    vendorId: VENDOR_ID,
    vendorName: 'Acme Metals',
    status: 'approved',
    statusNote: null,
    vendorPartNumber: 'AL-6061-1',
    purchaseUnit: 'bar',
    purchaseFactor: 144,
    factorLabel: '1 bar = 144 in',
    leadTimeDays: 5,
    minimumOrderQuantity: 2,
    quotedOn: '2026-10-01',
    validUntil: '2027-03-01',
    isExpired: false,
    notes: 'Ships from Akron.',
    isPreferred: true,
    breaks: [
      { id: 'br-1', minQuantity: 1, unitPrice: 45, source: 'manual', vendorRfqResponseId: null },
      { id: 'br-2', minQuantity: 10, unitPrice: 42.5, source: 'rfq', vendorRfqResponseId: RESP1 },
    ],
    lastPurchase: {
      vendorPurchaseOrderId: PO_ID,
      poNumber: 'PO-1042',
      orderedOn: '2026-11-02',
      lineId: LINE1,
      quantity: 10,
      unit: 'bar',
      unitPrice: 42.5,
      unitPricePerStockUnit: 0.295139,
      stockUnit: 'inches',
      stockFactor: 144,
    },
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
    ...o,
  };
}

export function partVendorList(o: Partial<PartVendorList> = {}): PartVendorList {
  return {
    part: {
      id: PART_ID,
      partName: 'BAR-6061',
      source: 'bought',
      stockUnit: 'inches',
      preferredVendorId: VENDOR_ID,
      conversions: [{ from_unit: 'bar', to_primary_factor: 144 }],
    },
    rows: [partVendorRow()],
    preferredVendorMissing: false,
    ...o,
  };
}

export function costPreview(o: Partial<PartCostPreview> = {}): PartCostPreview {
  return {
    partVendorId: PV_ID,
    partId: PART_ID,
    partName: 'BAR-6061',
    vendorId: VENDOR_ID,
    vendorName: 'Acme Metals',
    purchaseUnit: 'bar',
    stockUnit: 'inches',
    stockFactor: 144,
    quotedOn: '2026-10-01',
    validUntil: '2027-03-01',
    tiers: [
      {
        tierId: 'tier-1',
        quantity: 144,
        markupPercent: 30,
        currentCost: 0.33,
        proposedCost: 0.3125,
        currentPrice: 0.429,
        proposedPrice: 0.40625,
        vendorMinQuantity: 1,
        vendorUnitPrice: 45,
        belowVendorMinimum: false,
      },
    ],
    inserts: [],
    openQuoteCount: 2,
    bomParentPartCount: 1,
    warnings: [],
    expected: { part_vendor_id: PV_ID, tiers: [{ tier_id: 'tier-1', proposed_cost: 0.3125 }] },
    ...o,
  };
}

export function rfqDetail(o: Partial<VendorRfqDetail> = {}): VendorRfqDetail {
  return {
    header: {
      id: RFQ_ID,
      companyId: CO,
      rfqNumber: 'RFQ-0004',
      title: 'Bar stock for November',
      neededByOn: '2026-11-30',
      respondByOn: '2026-11-16',
      notesToVendors: 'Certs required.',
      internalNotes: 'Compare with last year.',
      shipToName: 'Acme Machining',
      shipToAddress: address,
      closedAt: null,
      closedReason: null,
      createdAt: '2026-11-04T00:00:00Z',
      updatedAt: '2026-11-04T00:00:00.123456+00:00',
      deletedAt: null,
      isArchived: false,
    },
    status: 'quoted',
    lineCount: 1,
    awardedLineCount: 0,
    invitedCount: 2,
    sentCount: 2,
    declinedCount: 0,
    respondedCount: 2,
    lines: [
      {
        id: RFQ_LINE1,
        lineNumber: 1,
        partId: PART_ID,
        partName: 'BAR-6061',
        description: '6061-T6 bar, 1in round',
        unit: 'bar',
        quantities: [10, 25],
        jobId: null,
        jobNumber: null,
        certRequired: true,
        notes: null,
      },
    ],
    invitations: [
      {
        id: INVITE1,
        vendorId: VENDOR_ID,
        vendorName: 'Acme Metals',
        vendorContactId: 'vc-1',
        vendorContact: { name: 'Lee Sales', email: 'lee@acme.test', phone: null },
        sentAt: '2026-11-04T10:00:00Z',
        declinedAt: null,
        declinedReason: null,
        vendorQuoteReference: 'Q-77',
        quotedOn: '2026-11-05',
      },
      {
        id: INVITE2,
        vendorId: VENDOR2_ID,
        vendorName: 'Bay Steel',
        vendorContactId: null,
        vendorContact: null,
        sentAt: '2026-11-04T10:00:00Z',
        declinedAt: null,
        declinedReason: null,
        vendorQuoteReference: null,
        quotedOn: null,
      },
    ],
    responses: [
      {
        id: RESP1,
        invitationId: INVITE1,
        lineId: RFQ_LINE1,
        quantity: 10,
        unitPrice: 42.5,
        noBid: false,
        leadTimeDays: 5,
        minimumOrderQuantity: 2,
        validUntil: '2027-01-31',
        vendorPartNumber: 'AL-6061-1',
        notes: null,
        awardedAt: null,
        vendorPurchaseOrderLineId: null,
      },
      {
        id: RESP2,
        invitationId: INVITE2,
        lineId: RFQ_LINE1,
        quantity: 10,
        unitPrice: 44,
        noBid: false,
        leadTimeDays: 3,
        minimumOrderQuantity: null,
        validUntil: null,
        vendorPartNumber: null,
        notes: 'Mill cert extra.',
        awardedAt: null,
        vendorPurchaseOrderLineId: null,
      },
    ],
    comparison: {
      vendors: [
        { invitationId: INVITE1, vendorId: VENDOR_ID, vendorName: 'Acme Metals', declined: false },
        { invitationId: INVITE2, vendorId: VENDOR2_ID, vendorName: 'Bay Steel', declined: false },
      ],
      rows: [
        {
          lineId: RFQ_LINE1,
          lineNumber: 1,
          label: 'BAR-6061',
          unit: 'bar',
          quantity: 10,
          cells: [
            { invitationId: INVITE1, vendorId: VENDOR_ID, vendorName: 'Acme Metals', responseId: RESP1, state: 'priced', unitPrice: 42.5, amount: 425, leadTimeDays: 5, validUntil: '2027-01-31', isLowest: true },
            { invitationId: INVITE2, vendorId: VENDOR2_ID, vendorName: 'Bay Steel', responseId: RESP2, state: 'priced', unitPrice: 44, amount: 440, leadTimeDays: 3, validUntil: null, isLowest: false },
          ],
          lowestResponseIds: [RESP1],
        },
        {
          lineId: RFQ_LINE1,
          lineNumber: 1,
          label: 'BAR-6061',
          unit: 'bar',
          quantity: 25,
          cells: [
            { invitationId: INVITE1, vendorId: VENDOR_ID, vendorName: 'Acme Metals', responseId: null, state: 'no_response', unitPrice: null, amount: null, leadTimeDays: null, validUntil: null, isLowest: false },
            { invitationId: INVITE2, vendorId: VENDOR2_ID, vendorName: 'Bay Steel', responseId: null, state: 'no_response', unitPrice: null, amount: null, leadTimeDays: null, validUntil: null, isLowest: false },
          ],
          lowestResponseIds: [],
        },
      ],
    },
    ...o,
  };
}

export function rfqListRow(o: Partial<VendorRfqListRow> = {}): VendorRfqListRow {
  return {
    id: RFQ_ID,
    rfqNumber: 'RFQ-0004',
    title: 'Bar stock for November',
    status: 'quoted',
    neededByOn: '2026-11-30',
    respondByOn: '2026-11-16',
    closedAt: null,
    lineCount: 1,
    awardedLineCount: 0,
    invitedCount: 2,
    sentCount: 2,
    declinedCount: 0,
    respondedCount: 2,
    vendorNames: ['Acme Metals', 'Bay Steel'],
    createdAt: '2026-11-04T00:00:00Z',
    updatedAt: '2026-11-04T00:00:00Z',
    ...o,
  };
}

/** One part short for J-1042, to buy from Acme, with an existing draft to Acme. */
export function buyList(o: Partial<BuyListResult> = {}): BuyListResult {
  const price = { unitPrice: 42.5, priceSource: 'price_sheet' as const, caption: 'Acme Metals price sheet · 10+ bar · valid to 3/1/27', warnings: [] };
  return {
    groups: [
      {
        vendorId: VENDOR_ID,
        vendorName: 'Acme Metals',
        draft: { vendorPurchaseOrderId: PO2_ID, poNumber: 'PO-1043' },
        total: 425,
        rows: [
          {
            key: `${PART_ID}:${VENDOR_ID}`,
            partId: PART_ID,
            partName: 'BAR-6061',
            stockUnit: 'inches',
            onHand: 100,
            onOrder: 0,
            onDraft: 0,
            demand: 1500,
            position: -1400,
            reorderPoint: null,
            reason: 'job_shortage',
            needBy: '2026-11-25',
            jobs: [
              {
                jobId: JOB_ID,
                jobNumber: 'J-1042',
                dueDate: '2026-11-25',
                materialStillToIssue: 1500,
                boughtStillToShip: 0,
                need: 1500,
                jobPartIds: [JOB_PART_ID],
                madePartNames: ['BRKT-100'],
                incomparableLineCount: 0,
              },
            ],
            jobNumbers: ['J-1042'],
            jobLink: { jobId: JOB_ID, jobNumber: 'J-1042', jobPartId: null },
            incomparableJobCount: 0,
            vendor: {
              partVendorId: PV_ID,
              vendorId: VENDOR_ID,
              vendorName: 'Acme Metals',
              status: 'approved',
              purchaseUnit: 'bar',
              purchaseFactor: 144,
              minimumOrderQuantity: 2,
              leadTimeDays: 5,
            },
            vendorBasis: 'preferred',
            purchaseUnit: 'bar',
            purchaseFactor: 144,
            purchaseUnitFallback: false,
            minimumOrderQuantity: 2,
            shortfall: 1400,
            suggestedQuantity: 10,
            suggestedStockQuantity: 1440,
            price,
            amount: 425,
            vendorPrices: [
              {
                vendorId: VENDOR_ID,
                vendorName: 'Acme Metals',
                partVendorId: PV_ID,
                status: 'approved',
                purchaseUnit: 'bar',
                suggestedQuantity: 10,
                price,
                amount: 425,
              },
            ],
          },
        ],
      },
    ],
    incomparable: [
      {
        partId: PART2_ID,
        partName: 'SHIM-2',
        stockUnit: 'each',
        incomparableJobCount: 1,
        jobs: [{ jobId: JOB_ID, jobNumber: 'J-1042', dueDate: '2026-11-25' }],
      },
    ],
    rowCount: 1,
    jobRowCount: 1,
    reorderRowCount: 0,
    noVendorRowCount: 0,
    incomparableCount: 1,
    truncated: false,
    truncatedSources: [],
    snapshot: { parts: [], demand: [], draftsByVendor: {}, priceInputsByPart: {}, truncatedSources: [] },
    ...o,
  };
}
