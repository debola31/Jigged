import { describe, it, expect, vi, beforeEach } from 'vitest';

// Per-table Supabase mock: each supabase.from(table) returns its own thenable
// builder that resolves to table-specific fixture data, so the UNION-on-read
// across jobs/quotes/shipments/notes/job_operations can be exercised.
const DATA: Record<string, unknown[]> & { error?: unknown } = {
  jobsCreated: [],
  jobsCompleted: [],
  quotes: [],
  shipments: [],
  notes: [],
  operations: [],
  inventory: [],
  invoices: [],
  poRevisions: [],
  poReceipts: [],
};

function resolveData(state: { table: string; completedFilter: boolean }) {
  if (DATA.error) return { data: null, error: DATA.error };
  switch (state.table) {
    case 'jobs':
      return { data: state.completedFilter ? DATA.jobsCompleted : DATA.jobsCreated, error: null };
    case 'quotes':
      return { data: DATA.quotes, error: null };
    case 'shipments':
      return { data: DATA.shipments, error: null };
    case 'notes':
      return { data: DATA.notes, error: null };
    case 'job_operations':
      return { data: DATA.operations, error: null };
    case 'quickbooks_invoice_links':
      return { data: DATA.invoices, error: null };
    case 'inventory_transactions':
      return { data: DATA.inventory, error: null };
    case 'vendor_purchase_order_revisions':
      return { data: DATA.poRevisions, error: null };
    case 'vendor_purchase_order_receipts':
      return { data: DATA.poReceipts, error: null };
    default:
      return { data: [], error: null };
  }
}

function makeBuilder(table: string) {
  const state = { table, completedFilter: false };
  const b: Record<string, unknown> = {};
  const ret = () => b;
  b.select = vi.fn(ret);
  b.eq = vi.fn(ret);
  b.in = vi.fn(ret);
  b.is = vi.fn(ret);
  b.not = vi.fn((col: string) => {
    if (col === 'completed_at') state.completedFilter = true;
    return b;
  });
  b.order = vi.fn(ret);
  b.limit = vi.fn(ret);
  b.lt = vi.fn(ret);
  // Thenable: `await builder` (or `.then`) resolves to the table's data.
  b.then = (resolve: (v: unknown) => void) => resolve(resolveData(state));
  return b;
}

const mockSupabase = { from: vi.fn((t: string) => makeBuilder(t)) };

vi.mock('@/lib/supabase', () => ({
  getSupabase: () => mockSupabase,
}));

import { getActivityStream } from '@/utils/dashboardAccess';
import { formatActivityText } from '@/components/dashboard/activityFormat';

beforeEach(() => {
  vi.clearAllMocks();
  DATA.jobsCreated = [];
  DATA.jobsCompleted = [];
  DATA.quotes = [];
  DATA.shipments = [];
  DATA.notes = [];
  DATA.operations = [];
  DATA.invoices = [];
  DATA.poRevisions = [];
  DATA.poReceipts = [];
  delete DATA.error;
});

describe('getActivityStream', () => {
  beforeEach(() => {
    DATA.notes = [
      { id: 'n1', created_at: '2026-06-23T03:00:00Z', job_id: 'j1', job: { job_number: 'J-1' }, author: { name: 'Sam' }, media: [] },
      { id: 'n2', created_at: '2026-06-23T02:00:00Z', job_id: 'j1', job: { job_number: 'J-1' }, author: { name: 'Lee' }, media: [{ id: 'm1' }] },
    ];
    DATA.jobsCreated = [
      { id: 'j1', job_number: 'J-1', created_at: '2026-06-23T01:00:00Z', completed_at: null, customer: { name: 'Acme' } },
    ];
  });

  it('includes floor activity and separates text notes from photo notes', async () => {
    const noteOnly = await getActivityStream('c1', { types: ['note'] });
    expect(noteOnly).toHaveLength(1);
    expect(noteOnly[0].type).toBe('note');
    expect(noteOnly[0].authorName).toBe('Sam');

    const photoOnly = await getActivityStream('c1', { types: ['photo'] });
    expect(photoOnly).toHaveLength(1);
    expect(photoOnly[0].type).toBe('photo');
    expect(photoOnly[0].action).toBe('photo_added');
  });

  it('merges multiple sources newest-first and caps to the limit', async () => {
    const all = await getActivityStream('c1', { limit: 2 });
    expect(all).toHaveLength(2);
    // Newest two across notes(03:00, 02:00) + job(01:00) → the two notes.
    expect(all.map((i) => i.timestamp)).toEqual(['2026-06-23T03:00:00Z', '2026-06-23T02:00:00Z']);
  });

  it('returns [] (best-effort) when a source query errors', async () => {
    DATA.error = { message: 'boom' };
    const items = await getActivityStream('c1', { types: ['job'] });
    expect(items).toEqual([]);
  });

  it('emits an internal completion as a plain "completed" operation activity', async () => {
    DATA.operations = [
      { id: 'opI', completed_at: '2026-07-23T06:00:00Z', sent_at: null, job_id: 'j1', jobs: { job_number: 'J-1' }, work_center: null },
    ];
    const ops = await getActivityStream('c1', { types: ['operation'] });
    expect(ops).toHaveLength(1);
    expect(ops[0].type).toBe('operation');
    expect(ops[0].action).toBe('completed');
    expect(ops[0].vendorName).toBeUndefined();
  });

  it('emits external send/receive as vendor-tagged "sent"/"received" operation activities', async () => {
    // A received external op carries both stamps → both a sent and a received row.
    DATA.operations = [
      {
        id: 'opX',
        completed_at: '2026-07-23T05:00:00Z',
        sent_at: '2026-07-23T04:00:00Z',
        job_id: 'j1',
        jobs: { job_number: 'J-1' },
        vendor_service_id: 'vs-1',
        vendor_service: { vendor: { name: 'ProFinish Coatings' } },
      },
    ];
    const ops = await getActivityStream('c1', { types: ['operation'] });
    expect(ops.map((o) => o.action).sort()).toEqual(['received', 'sent']);
    for (const o of ops) {
      expect(o.type).toBe('operation');
      expect(o.vendorName).toBe('ProFinish Coatings');
    }
    // Newest-first: received (05:00) before sent (04:00).
    expect(ops[0].action).toBe('received');
  });
});

/**
 * Stock movements in the shared feed.
 *
 * The owner had no shop-wide view of stock moving: `getRecentActivity` did exactly this and its
 * only caller was the operator's Inventory tab.
 */
describe('inventory activity', () => {
  const txn = (over: Record<string, unknown>) => ({
    id: 'x',
    created_at: '2026-08-01T10:00:00Z',
    type: 'addition',
    item_name: 'BUY-ORING-214',
    quantity: 828,
    unit: 'ea',
    part_id: 'p1',
    location_name: 'Shelf A',
    transfer_group_id: null,
    notes: null,
    ...over,
  });

  beforeEach(() => {
    DATA.inventory = [];
  });

  it('says what moved, how much, and where', async () => {
    DATA.inventory = [txn({})];
    const [item] = await getActivityStream('co1', { types: ['inventory'] });

    expect(item.type).toBe('inventory');
    expect(item.entityNumber).toBe('BUY-ORING-214');
    expect(item.action).toBe('stock_in');
    expect(item.quantityLabel).toBe('828 ea');
    expect(item.locationName).toBe('Shelf A');
    // Straight to that part's ledger — its Activity tab, slug `history` — which is where you go
    // to ask "why". It named the Storage tab's slug until that tab went (2026-09-09), and the
    // workspace quietly fell back to Workspace, where no movement is shown.
    expect(item.href).toBe('/dashboard/co1/parts/p1?tab=history');
  });

  /** A transfer writes two rows sharing a group id; the feed must not show the event twice. */
  it('folds a transfer to the leg that says where the stock ended up', async () => {
    DATA.inventory = [
      txn({ id: 'to', type: 'addition', transfer_group_id: 'g1', location_name: 'Shelf A' }),
      txn({ id: 'from', type: 'depletion', transfer_group_id: 'g1', location_name: 'Unassigned' }),
    ];

    const items = await getActivityStream('co1', { types: ['inventory'] });

    expect(items).toHaveLength(1);
    expect(items[0].action).toBe('moved');
    expect(items[0].locationName).toBe('Shelf A');
  });

  /** A half-pair whose partner fell outside the window is still a movement that happened. */
  it('keeps a lone depletion leg rather than dropping it', async () => {
    DATA.inventory = [txn({ id: 'from', type: 'depletion', transfer_group_id: 'g1' })];

    const items = await getActivityStream('co1', { types: ['inventory'] });
    expect(items).toHaveLength(1);
    expect(items[0].action).toBe('moved');
  });

  it('reads an adjustment as a count', async () => {
    DATA.inventory = [txn({ type: 'adjustment', quantity: 30 })];
    const [item] = await getActivityStream('co1', { types: ['inventory'] });
    expect(item.action).toBe('counted');
  });

  it('is left out of the feed unless asked for', async () => {
    DATA.inventory = [txn({})];
    const items = await getActivityStream('co1', { types: ['job'] });
    expect(items.every((i) => i.type !== 'inventory')).toBe(true);
  });
});

describe('an archived job takes its paperwork with it', () => {
  // CLAUDE.md's most-violated rule: every list query filters deleted_at. None of
  // these tables carries one — a shipment is voided, an operation and a note
  // belong to a job — so the job's archive flag is the only one there is.
  function buildersFor(table: string) {
    return mockSupabase.from.mock.calls
      .map((call, i) => ({ table: call[0], builder: mockSupabase.from.mock.results[i]?.value }))
      .filter((c) => c.table === table)
      .map((c) => c.builder as Record<string, ReturnType<typeof vi.fn>>);
  }

  it('excludes shipments on an archived job', async () => {
    DATA.shipments = [
      { id: 's1', created_at: '2026-06-23T07:00:00Z', job_id: 'j1', job: { job_number: 'J-1' }, customer: null },
    ];
    await getActivityStream('c1', { types: ['shipment'] });

    const [builder] = buildersFor('shipments');
    expect(builder.is).toHaveBeenCalledWith('jobs.deleted_at', null);
  });

  it('excludes operations on an archived job — both the completed and the sent query', async () => {
    DATA.operations = [
      { id: 'o1', completed_at: '2026-06-23T08:00:00Z', job_id: 'j1', jobs: { job_number: 'J-1' } },
    ];
    await getActivityStream('c1', { types: ['operation'] });

    const builders = buildersFor('job_operations');
    expect(builders).toHaveLength(2);
    for (const b of builders) {
      expect(b.is).toHaveBeenCalledWith('jobs.deleted_at', null);
    }
  });

  it('drops a note whose job is archived', async () => {
    DATA.notes = [
      {
        id: 'n-live',
        created_at: '2026-06-23T09:00:00Z',
        job_id: 'j1',
        job: { job_number: 'J-1', deleted_at: null },
        author: { name: 'Sam' },
        media: [],
      },
      {
        id: 'n-archived',
        created_at: '2026-06-23T08:00:00Z',
        job_id: 'j2',
        job: { job_number: 'J-2', deleted_at: '2026-06-24T00:00:00Z' },
        author: { name: 'Sam' },
        media: [],
      },
    ];

    const items = await getActivityStream('c1', { types: ['note'] });

    expect(items.map((i) => i.id)).toEqual(['note-n-live']);
  });

  it('drops a note captured on an archived job, keyed on the job it resolves to', async () => {
    // A durable part-subject note has no job_id — captured_job_id is what says
    // which job it was written on, and it is that job's archive that counts.
    DATA.notes = [
      {
        id: 'n-captured',
        created_at: '2026-06-23T08:00:00Z',
        job_id: null,
        captured_job_id: 'j2',
        job: null,
        captured_job: { job_number: 'J-2', deleted_at: '2026-06-24T00:00:00Z' },
        author: { name: 'Sam' },
        media: [],
      },
    ];

    expect(await getActivityStream('c1', { types: ['note'] })).toEqual([]);
  });

  it('keeps a work-center note, which has no job to be archived', async () => {
    // The reason the note filter is in JS and not the query: `!inner` on either
    // nullable FK would drop this whole row kind silently.
    DATA.notes = [
      {
        id: 'n-wc',
        created_at: '2026-06-23T08:00:00Z',
        job_id: null,
        captured_job_id: null,
        job: null,
        captured_job: null,
        author: { name: 'Sam' },
        media: [],
      },
    ];

    const items = await getActivityStream('c1', { types: ['note'] });

    expect(items.map((i) => i.id)).toEqual(['note-n-wc']);
    expect(items[0].entityNumber).toBe('');
    expect(items[0].href).toBe('/dashboard/c1/activity');
  });
});

describe('invoice activity', () => {
  function link(over: Record<string, unknown> = {}) {
    return {
      id: 'inv-1',
      created_at: '2026-09-05T16:00:00Z',
      job_id: 'job-1',
      qb_invoice_doc_number: '1043',
      job: { job_number: 'J-0148', customer: { name: 'Classic Turning Inc.' } },
      ...over,
    };
  }

  it('reads a created invoice as a job-anchored feed row', async () => {
    DATA.invoices = [link()];

    const [item] = await getActivityStream('co1', { types: ['invoice'] });

    expect(item).toMatchObject({
      id: 'invoice-inv-1',
      type: 'invoice',
      action: 'created',
      // The JOB number is the row's bold label, as it is for a shipment; the
      // invoice number is a separate field the sentence uses.
      entityNumber: 'J-0148',
      invoiceNumber: '1043',
      customerName: 'Classic Turning Inc.',
      href: '/dashboard/co1/jobs/job-1',
    });
  });

  it('survives an invoice QuickBooks has not numbered yet', async () => {
    DATA.invoices = [link({ qb_invoice_doc_number: null })];
    const [item] = await getActivityStream('co1', { types: ['invoice'] });
    expect(item.invoiceNumber).toBeUndefined();
  });

  it('asks only for created invoices on live jobs', async () => {
    // The mock returns whatever the fixture holds regardless of filters, so the
    // assertion is on the QUERY: a pending push is not an event, and an
    // archived job's paperwork should not outlive it in the feed.
    DATA.invoices = [link()];
    await getActivityStream('co1', { types: ['invoice'] });

    const builder = mockSupabase.from.mock.results.at(-1)?.value as Record<
      string,
      ReturnType<typeof vi.fn>
    >;
    expect(builder.eq).toHaveBeenCalledWith('status', 'created');
    expect(builder.is).toHaveBeenCalledWith('jobs.deleted_at', null);
  });

  it('is left out of the feed unless asked for', async () => {
    DATA.invoices = [link()];
    const items = await getActivityStream('co1', { types: ['job'] });
    expect(items.every((i) => i.type !== 'invoice')).toBe(true);
  });
});

describe('purchasing activity', () => {
  function buildersFor(table: string) {
    return mockSupabase.from.mock.calls
      .map((call, i) => ({ table: call[0], builder: mockSupabase.from.mock.results[i]?.value }))
      .filter((c) => c.table === table)
      .map((c) => c.builder as Record<string, ReturnType<typeof vi.fn>>);
  }

  it('reads each revision the vendor received as a vendor-tagged "sent" row on the PO', async () => {
    DATA.poRevisions = [
      { id: 'rev-1', revision: 1, sent_at: '2026-11-08T15:00:00Z', vendor_purchase_order_id: 'po-1', vendor_purchase_orders: { po_number: 'PO-1042', vendor_name: 'Acme Steel', deleted_at: null } },
    ];
    const [item] = await getActivityStream('co1', { types: ['purchasing'] });
    expect(item).toMatchObject({
      id: 'po-sent-rev-1',
      type: 'purchasing',
      action: 'sent',
      entityNumber: 'PO-1042',
      vendorName: 'Acme Steel',
      revision: 1,
      timestamp: '2026-11-08T15:00:00Z',
      href: '/dashboard/co1/purchasing/orders/po-1',
    });
  });

  it('folds a delivery into ONE "received" row, however many lines it covered', async () => {
    const po = { vendor_purchase_orders: { po_number: 'PO-1042', vendor_name: 'Acme Steel', deleted_at: null } };
    DATA.poReceipts = [
      { id: 'r-1', receipt_group_id: 'g-1', received_at: '2026-11-09T10:00:00Z', vendor_purchase_order_id: 'po-1', vendor_purchase_order_lines: po },
      { id: 'r-2', receipt_group_id: 'g-1', received_at: '2026-11-09T10:00:00Z', vendor_purchase_order_id: 'po-1', vendor_purchase_order_lines: po },
      { id: 'r-3', receipt_group_id: 'g-2', received_at: '2026-11-07T10:00:00Z', vendor_purchase_order_id: 'po-1', vendor_purchase_order_lines: po },
    ];
    const items = await getActivityStream('co1', { types: ['purchasing'] });
    expect(items.map((i) => [i.id, i.action, i.lineCount])).toEqual([
      ['po-received-g-1', 'received', 2],
      ['po-received-g-2', 'received', 1],
    ]);
  });

  it('leaves archived POs out through the join, and voided receipts out', async () => {
    await getActivityStream('co1', { types: ['purchasing'] });
    const [revisions] = buildersFor('vendor_purchase_order_revisions');
    const [receipts] = buildersFor('vendor_purchase_order_receipts');
    expect(revisions.eq).toHaveBeenCalledWith('company_id', 'co1');
    expect(revisions.is).toHaveBeenCalledWith('vendor_purchase_orders.deleted_at', null);
    expect(receipts.eq).toHaveBeenCalledWith('company_id', 'co1');
    expect(receipts.is).toHaveBeenCalledWith('voided_at', null);
    expect(receipts.is).toHaveBeenCalledWith('vendor_purchase_order_lines.vendor_purchase_orders.deleted_at', null);
  });

  it('pages with the same cursor as every other source', async () => {
    await getActivityStream('co1', { types: ['purchasing'], before: '2026-11-01T00:00:00Z' });
    expect(buildersFor('vendor_purchase_order_revisions')[0].lt).toHaveBeenCalledWith('sent_at', '2026-11-01T00:00:00Z');
    expect(buildersFor('vendor_purchase_order_receipts')[0].lt).toHaveBeenCalledWith('received_at', '2026-11-01T00:00:00Z');
  });

  it('is left out of the feed unless asked for (or the feed is unfiltered)', async () => {
    DATA.poRevisions = [
      { id: 'rev-1', revision: 0, sent_at: '2026-11-08T15:00:00Z', vendor_purchase_order_id: 'po-1', vendor_purchase_orders: { po_number: 'PO-1042', vendor_name: 'Acme', deleted_at: null } },
    ];
    expect((await getActivityStream('co1', { types: ['job'] })).every((i) => i.type !== 'purchasing')).toBe(true);
    expect((await getActivityStream('co1')).some((i) => i.type === 'purchasing')).toBe(true);
  });

  it('reads as purchasing in the shared feed formatter, never as a job', () => {
    const sent = { id: 'x', type: 'purchasing' as const, action: 'sent' as const, entityNumber: 'PO-1042', vendorName: 'Acme', revision: 2, timestamp: 't' };
    expect(formatActivityText(sent)).toBe('Rev 2 sent to Acme');
    expect(formatActivityText({ ...sent, revision: 0 })).toBe('Sent to Acme');
    expect(formatActivityText({ ...sent, action: 'received', lineCount: 3 })).toBe('Received from Acme (3 lines)');
  });
});
