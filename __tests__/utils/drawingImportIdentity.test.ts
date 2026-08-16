import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The collision guard. Every test here corresponds to a way the drawings import
 * could silently merge two customers' parts, which is the incident
 * `part_customer_references` was added to prevent.
 */

const { tableResponses, mockSupabase } = vi.hoisted(() => {
  // Per-table canned responses, so a test can say "parts returns X, references
  // return Y" without caring about chain order.
  const responses: Record<string, { data: unknown[] | null; error: unknown }> = {};

  function builderFor(table: string) {
    const result = () => responses[table] ?? { data: [], error: null };
    const builder: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'in', 'is', 'ilike', 'limit', 'order', 'upsert', 'insert']) {
      builder[m] = vi.fn(() => builder);
    }
    // Awaiting the builder resolves to the canned response.
    (builder as { then: unknown }).then = (
      resolve: (v: unknown) => unknown,
    ) => Promise.resolve(result()).then(resolve);
    return builder;
  }

  return {
    tableResponses: responses,
    mockSupabase: { from: vi.fn((t: string) => builderFor(t)) },
  };
});

vi.mock('@/lib/supabase', () => ({ getSupabase: () => mockSupabase }));

const findByNumbers = vi.fn();
vi.mock('@/utils/partCustomerReferencesAccess', () => ({
  findPartsByCustomerNumbers: (...args: unknown[]) => findByNumbers(...args),
}));

import { resolveIdentities, needsAttention } from '@/utils/drawingImportIdentity';

const CO = 'co-1';
const CUST_A = 'cust-a';
const CUST_B = 'cust-b';

function setParts(rows: Array<{ id: string; part_name: string; deleted_at?: string | null }>) {
  tableResponses.parts = {
    data: rows.map((r) => ({ deleted_at: null, ...r })),
    error: null,
  };
}
function setRefs(rows: Array<{ part_id: string; customer_id: string }>) {
  tableResponses.part_customer_references = { data: rows, error: null };
}

describe('resolveIdentities', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const k of Object.keys(tableResponses)) delete tableResponses[k];
    setParts([]);
    setRefs([]);
    findByNumbers.mockResolvedValue(new Map());
  });

  it('creates nothing to worry about when the name and number are both fresh', async () => {
    const out = await resolveIdentities(CO, CUST_A, [
      { stem: 's1', partName: '1003308', customerPartNumber: '1003308' },
    ]);
    expect(out.get('s1')).toEqual({ kind: 'new' });
  });

  it('keys on the customer number, not the name', async () => {
    // The reference says this is part p9 even though no part is named 1003308.
    findByNumbers.mockResolvedValue(new Map([['1003308', { part_id: 'p9' }]]));
    const out = await resolveIdentities(CO, CUST_A, [
      { stem: 's1', partName: '1003308', customerPartNumber: '1003308' },
    ]);
    expect(out.get('s1')).toMatchObject({ kind: 'known', partId: 'p9' });
  });

  /**
   * THE INCIDENT. Customer B sends 1003308; customer A already has a live part of
   * that name. Writing to it would merge two customers' parts, with A's quotes and
   * jobs still pointing at the row.
   */
  it('refuses to merge onto a live part that answers to another customer', async () => {
    setParts([{ id: 'pA', part_name: '1003308' }]);
    setRefs([{ part_id: 'pA', customer_id: CUST_A }]);

    const out = await resolveIdentities(CO, CUST_B, [
      { stem: 's1', partName: '1003308', customerPartNumber: '1003308' },
    ]);
    const outcome = out.get('s1')!;
    expect(outcome.kind).toBe('name_taken');
    expect(outcome).toMatchObject({ partId: 'pA', suggestedName: '1003308-2' });
    expect(needsAttention(outcome)).toBe(true);
  });

  /**
   * `checkPartNameExists` filters `deleted_at IS NULL`, which is why this module
   * queries archived rows itself — an archived name is exactly the one that would
   * be silently revived.
   */
  it('surfaces an archived match as a CHOICE rather than reviving it', async () => {
    setParts([{ id: 'pOld', part_name: 'BASE PLATE', deleted_at: '2026-01-01T00:00:00Z' }]);

    const out = await resolveIdentities(CO, CUST_A, [
      { stem: 's1', partName: 'BASE PLATE', customerPartNumber: '999' },
    ]);
    const outcome = out.get('s1')!;
    expect(outcome.kind).toBe('archived');
    expect(outcome).toMatchObject({ partId: 'pOld', choice: 'revive' });
    // create_new needs a name: parts_unique_per_company covers archived rows too.
    expect((outcome as { suggestedName: string }).suggestedName).toBe('BASE PLATE-2');
    expect(needsAttention(outcome)).toBe(true);
  });

  it('updates the shop\'s own live part when nobody else claims it', async () => {
    setParts([{ id: 'pMine', part_name: 'SPACER' }]);
    setRefs([]);
    const out = await resolveIdentities(CO, CUST_A, [
      { stem: 's1', partName: 'SPACER', customerPartNumber: '77' },
    ]);
    expect(out.get('s1')).toMatchObject({ kind: 'known', partId: 'pMine' });
  });

  it('does not offer the same disambiguated name to two rows in one import', async () => {
    setParts([{ id: 'pA', part_name: 'PLATE' }]);
    setRefs([{ part_id: 'pA', customer_id: CUST_A }]);
    const out = await resolveIdentities(CO, CUST_B, [
      { stem: 's1', partName: 'PLATE', customerPartNumber: '1' },
      { stem: 's2', partName: 'PLATE', customerPartNumber: '2' },
    ]);
    const a = out.get('s1') as { suggestedName: string };
    const b = out.get('s2') as { suggestedName: string };
    expect(a.suggestedName).not.toBe(b.suggestedName);
  });

  /** "Couldn't check" must never render as "clear to create". */
  it('reports a failed lookup as unknown, never as new', async () => {
    tableResponses.parts = { data: null, error: { message: 'boom' } };
    const out = await resolveIdentities(CO, CUST_A, [
      { stem: 's1', partName: 'X', customerPartNumber: '1' },
    ]);
    const outcome = out.get('s1')!;
    expect(outcome.kind).toBe('unknown');
    expect(needsAttention(outcome)).toBe(true);
  });

  it('still detects name collisions when no customer was chosen', async () => {
    setParts([{ id: 'pOld', part_name: 'COVER', deleted_at: '2026-01-01T00:00:00Z' }]);
    const out = await resolveIdentities(CO, null, [
      { stem: 's1', partName: 'COVER', customerPartNumber: '' },
    ]);
    expect(out.get('s1')!.kind).toBe('archived');
    // With no customer there is nothing to look a reference up by.
    expect(findByNumbers).not.toHaveBeenCalled();
  });

  it('issues no queries for an empty row set', async () => {
    const out = await resolveIdentities(CO, CUST_A, []);
    expect(out.size).toBe(0);
    expect(mockSupabase.from).not.toHaveBeenCalled();
  });
});
