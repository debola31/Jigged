import { vi } from 'vitest';

/**
 * A Supabase client stub for the purchasing access-layer tests — the pattern of
 * `outsideShipmentsAccess.test.ts:9-53` (a chainable builder that doubles as its own awaited
 * result), with results queued PER TABLE so parallel reads (`Promise.all`) cannot be served each
 * other's rows, and every call recorded so a test can assert which tables were read, how many
 * times, with what filters, and that nothing was ever written.
 *
 * Rows are queued as arrays; `.single()` / `.maybeSingle()` hand back the first row (or null).
 * A table nobody queued answers `{ data: [], error: null, count: 0 }`.
 */
export interface StubResult {
  data?: unknown;
  error?: unknown;
  count?: number | null;
}

export interface StubCall {
  table: string;
  method: string;
  args: unknown[];
}

const CHAIN_METHODS = [
  'select', 'insert', 'update', 'upsert', 'delete',
  'eq', 'neq', 'in', 'is', 'not', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'or', 'contains',
  'filter', 'match', 'order', 'limit', 'range',
] as const;

export const WRITE_METHODS = new Set(['insert', 'update', 'upsert', 'delete']);

export function createSupabaseStub() {
  const queues = new Map<string, StubResult[]>();
  const calls: StubCall[] = [];
  const tables: string[] = [];

  function builder(table: string) {
    const queued = queues.get(table)?.shift();
    const base: StubResult = queued ?? { data: [], error: null, count: 0 };
    let single = false;
    const b: Record<string, unknown> = {};
    for (const m of CHAIN_METHODS) {
      b[m] = (...args: unknown[]) => {
        calls.push({ table, method: m, args });
        return b;
      };
    }
    b.single = (...args: unknown[]) => {
      calls.push({ table, method: 'single', args });
      single = true;
      return b;
    };
    b.maybeSingle = (...args: unknown[]) => {
      calls.push({ table, method: 'maybeSingle', args });
      single = true;
      return b;
    };
    const settle = () => {
      if (base.error) return { data: null, error: base.error, count: null };
      let data = base.data ?? null;
      if (single && Array.isArray(data)) data = data[0] ?? null;
      const count = base.count !== undefined ? base.count : Array.isArray(base.data) ? base.data.length : null;
      return { data, error: null, count };
    };
    b.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(settle()).then(resolve, reject);
    return b;
  }

  const rpc = vi.fn();
  const client = {
    from: vi.fn((table: string) => {
      tables.push(table);
      return builder(table);
    }),
    rpc,
    auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session: { user: { id: 'user-1' }, access_token: 't' } }, error: null }),
      getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null }),
    },
  };

  return {
    client,
    rpc,
    calls,
    tables,
    /** Queue the next result(s) for a table, in the order its reads happen. */
    queue(table: string, ...results: StubResult[]) {
      queues.set(table, [...(queues.get(table) ?? []), ...results]);
    },
    /** Every call of one method on one table, as argument lists. */
    callsOf(table: string, method: string): unknown[][] {
      return calls.filter((c) => c.table === table && c.method === method).map((c) => c.args);
    },
    /** Every write attempted through `.from()`. */
    writes(): StubCall[] {
      return calls.filter((c) => WRITE_METHODS.has(c.method));
    },
    reset() {
      queues.clear();
      calls.length = 0;
      tables.length = 0;
      rpc.mockReset();
      client.from.mockClear();
      client.auth.getSession.mockClear();
      client.auth.getUser.mockClear();
    },
  };
}

export type SupabaseStub = ReturnType<typeof createSupabaseStub>;

/**
 * The one stub a test file shares with its `vi.mock('@/lib/supabase')` factory:
 *
 *   vi.mock('@/lib/supabase', async () => {
 *     const { stub } = await import('./purchasingTestStub');
 *     return { getSupabase: () => stub.client };
 *   });
 *
 * Each test file gets its own module instance, so this is per file. Call `stub.reset()` in
 * `beforeEach`.
 */
export const stub = createSupabaseStub();

/** The purchasing tables the browser may only READ: a write to any of them is a bug. */
export const PURCHASING_TABLES = [
  'purchasing_document_series',
  'vendor_purchase_orders',
  'vendor_purchase_order_lines',
  'vendor_purchase_order_receipts',
  'vendor_purchase_order_revisions',
  'part_vendors',
  'part_vendor_price_breaks',
  'vendor_rfqs',
  'vendor_rfq_lines',
  'vendor_rfq_invitations',
  'vendor_rfq_responses',
  'quickbooks_vendor_map',
  'quickbooks_purchasing_setup',
  'quickbooks_purchase_order_links',
  'quickbooks_purchase_order_line_links',
  'part_pricing_tiers',
  'outside_shipments',
];
