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
    case 'inventory_transactions':
      return { data: DATA.inventory, error: null };
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
  getTypedSupabase: () => mockSupabase,
}));

import { getDashboardActivity, getActivityStream } from '@/utils/dashboardAccess';

beforeEach(() => {
  vi.clearAllMocks();
  DATA.jobsCreated = [];
  DATA.jobsCompleted = [];
  DATA.quotes = [];
  DATA.shipments = [];
  DATA.notes = [];
  DATA.operations = [];
  delete DATA.error;
});

describe('getDashboardActivity', () => {
  beforeEach(() => {
    DATA.jobsCreated = [
      { id: 'j1', job_number: 'J-1', created_at: '2026-06-23T05:00:00Z', completed_at: null, customer: { name: 'Acme' } },
    ];
    DATA.jobsCompleted = [
      { id: 'j2', job_number: 'J-2', created_at: '2026-06-20T00:00:00Z', completed_at: '2026-06-23T06:00:00Z', customer: null },
    ];
    DATA.quotes = [
      { id: 'q1', quote_number: 'Q-1', created_at: '2026-06-23T04:00:00Z', customer: { name: 'Beta' } },
    ];
    DATA.shipments = [
      { id: 's1', created_at: '2026-06-23T07:00:00Z', job_id: 'j9', job: { job_number: 'J-9' }, customer: { name: 'Gamma' } },
    ];
    // These must NOT appear on the compact dashboard card.
    DATA.notes = [
      { id: 'n1', created_at: '2026-06-23T08:00:00Z', job_id: 'j1', job: { job_number: 'J-1' }, author: { name: 'Sam' }, media: [] },
    ];
    DATA.operations = [
      { id: 'o1', completed_at: '2026-06-23T08:30:00Z', job_id: 'j1', jobs: { job_number: 'J-1' } },
    ];
  });

  it('returns only business milestones (no notes/photos/operations), newest first', async () => {
    const items = await getDashboardActivity('c1', { limit: 6 });

    expect(items.map((i) => i.type).sort()).toEqual(['job', 'job', 'quote', 'shipment']);
    expect(items.every((i) => ['job', 'quote', 'shipment'].includes(i.type))).toBe(true);
    // Newest first: shipment 07:00 > job-completed 06:00 > job-created 05:00 > quote 04:00.
    expect(items.map((i) => i.timestamp)).toEqual([
      '2026-06-23T07:00:00Z',
      '2026-06-23T06:00:00Z',
      '2026-06-23T05:00:00Z',
      '2026-06-23T04:00:00Z',
    ]);
    // Mapped fields: shipment uses the joined job number + customer + deep link.
    const shipment = items[0];
    expect(shipment.entityNumber).toBe('J-9');
    expect(shipment.customerName).toBe('Gamma');
    expect(shipment.href).toBe('/dashboard/c1/jobs/j9');
  });

  it('caps the card to the requested limit', async () => {
    const items = await getDashboardActivity('c1', { limit: 2 });
    expect(items).toHaveLength(2);
    expect(items[0].timestamp).toBe('2026-06-23T07:00:00Z'); // still newest-first
  });
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
        work_center: { kind: 'external', vendor: { name: 'ProFinish Coatings' } },
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
    // Straight to that part's ledger, which is where you go to ask "why".
    expect(item.href).toContain('/parts/p1?tab=inventory');
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
