import { describe, it, expect, vi, beforeEach } from 'vitest';

// A chainable builder: every method returns the builder, and awaiting it
// destructures { data, error } straight off it. Mirrors the harness in
// customerAccess.test.ts.
const { mockQueryBuilder, mockSupabase, errorQueue } = vi.hoisted(() => {
  // `update` writes go through more than one round trip (clear-then-set), so a
  // single shared `error` cannot say WHICH one failed. The queue lets a test
  // fail the second write while the first succeeds — which is the only case
  // that can actually happen, since an UPDATE setting a flag to false cannot
  // violate a unique index.
  const queue: Array<{ code: string; message: string } | null> = [];
  const builder: Record<string, unknown> = {};
  for (const m of ['from', 'select', 'insert', 'eq', 'is', 'order', 'single']) {
    builder[m] = vi.fn(() => builder);
  }
  builder.update = vi.fn(() => {
    builder.error = queue.length ? queue.shift()! : null;
    return builder;
  });
  builder.data = null;
  builder.error = null;
  return {
    mockQueryBuilder: builder,
    mockSupabase: { from: vi.fn(() => builder) },
    errorQueue: queue,
  };
});

vi.mock('@/lib/supabase', () => ({
  getSupabase: () => mockSupabase,
  createClient: () => mockSupabase,
  supabase: mockSupabase,
}));

import {
  getContactsForCustomer,
  archiveCustomerContact,
  setBillingDefaultContact,
} from '@/utils/customerContactsAccess';

const update = () => mockQueryBuilder.update as ReturnType<typeof vi.fn>;
const is = () => mockQueryBuilder.is as ReturnType<typeof vi.fn>;
const eq = () => mockQueryBuilder.eq as ReturnType<typeof vi.fn>;

describe('customer contacts — archive rather than destroy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    errorQueue.length = 0;
    mockQueryBuilder.data = [];
    mockQueryBuilder.error = null;
  });

  it('only offers live contacts', async () => {
    // Someone who left the company must stop being offered on new work. A
    // document that already names them resolves by id instead.
    await getContactsForCustomer('cust-1');
    expect(is()).toHaveBeenCalledWith('deleted_at', null);
  });

  it('stamps deleted_at instead of issuing a DELETE', async () => {
    // A hard delete would take the row a quote's contact_id still points at.
    await archiveCustomerContact('contact-1');

    expect(mockQueryBuilder.delete).toBeUndefined();
    const patch = update().mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(patch.deleted_at).toEqual(expect.any(String));
  });

  // The load-bearing half. Both "at most one per customer" indexes are scoped
  // to live rows, so an archived contact that kept its flag would hold the slot
  // forever and the customer could never name a replacement.
  it('hands back both roles it held, so the slots are free again', async () => {
    await archiveCustomerContact('contact-1');

    const patch = update().mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(patch.is_primary).toBe(false);
    expect(patch.is_billing_default).toBe(false);
  });
});

describe('customer contacts — who invoices go to', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    errorQueue.length = 0;
    mockQueryBuilder.data = [];
    mockQueryBuilder.error = null;
  });

  it('clears the previous billing contact before naming the new one', async () => {
    // The DB index is the real guarantee; clearing first is what stops the UI
    // tripping it. Same shape as setPrimaryContact.
    await setBillingDefaultContact('cust-1', 'contact-2');

    const patches = update().mock.calls.map((c) => c[0] as Record<string, unknown>);
    expect(patches[0]).toEqual({ is_billing_default: false });
    expect(patches[1]).toMatchObject({ is_billing_default: true });
    expect(eq()).toHaveBeenCalledWith('id', 'contact-2');
  });

  it('clears without naming a replacement when passed null', async () => {
    // A customer is allowed to have no billing contact. Nothing falls back to
    // the primary — inferring one would put invoices somewhere nobody chose.
    await setBillingDefaultContact('cust-1', null);

    const patches = update().mock.calls.map((c) => c[0] as Record<string, unknown>);
    expect(patches).toHaveLength(1);
    expect(patches[0]).toEqual({ is_billing_default: false });
  });

  it('surfaces a lost race as a retry rather than a raw 23505', async () => {
    // Two people naming a billing contact at once: both clear, then one loses
    // the insert to the partial unique index. The clear succeeds; the set 23505s.
    errorQueue.push(null, { code: '23505', message: 'duplicate key' });
    await expect(setBillingDefaultContact('cust-1', 'contact-2')).rejects.toThrow(
      /just marked for billing/i,
    );
  });
});
