import { describe, it, expect } from 'vitest';

import { filterOperatorJobs, jobMatchesQuery } from '@/lib/operatorJobSearch';
import type { OperatorJob } from '@/types/operator';

function row(over: Partial<OperatorJob> = {}): OperatorJob {
  return {
    id: 'jp-1',
    job_id: 'j-1',
    job_number: 'J-0118',
    customer_name: 'Apex Aerospace',
    part_name: 'Spindle Bracket',
    part_quantity: 12,
    production_status: 'in_progress',
    operation_id: 'op-1',
    operation_name: 'Mill OP20',
    operation_status: 'pending',
    operations_total: 3,
    operations_completed: 1,
    ...over,
  };
}

describe('filterOperatorJobs', () => {
  it('matches on job number, part name and customer', () => {
    const rows = [
      row({ id: 'a', job_number: 'J-0118' }),
      row({ id: 'b', job_number: 'J-0992', part_name: 'Manifold Cap' }),
      row({ id: 'c', job_number: 'J-0450', customer_name: 'Northwind Medical' }),
    ];
    expect(filterOperatorJobs(rows, '0118').map((r) => r.id)).toEqual(['a']);
    expect(filterOperatorJobs(rows, 'manifold').map((r) => r.id)).toEqual(['b']);
    expect(filterOperatorJobs(rows, 'northwind').map((r) => r.id)).toEqual(['c']);
  });

  /**
   * THE DECISION THIS PINS. `operation_name` sits right there on the row and is
   * the obvious fourth field to add — so the reason it is absent has to be
   * asserted, not just written in a comment. "What is running at Deburr" is
   * already answered by switching stations or by the All Stations lens; matching
   * it here would mean a query aimed at ONE job ("mill") answers with a whole
   * category of steps across the plant.
   */
  it('does NOT match on operation name', () => {
    const rows = [row({ operation_name: 'Deburr OP40', part_name: 'Cap', job_number: 'J-1' })];
    expect(filterOperatorJobs(rows, 'deburr')).toEqual([]);
  });

  it('is case-insensitive and matches mid-string, not just a prefix', () => {
    const rows = [row({ part_name: 'Spindle Bracket' })];
    expect(filterOperatorJobs(rows, 'BRACKET')).toHaveLength(1);
    expect(filterOperatorJobs(rows, 'ndle')).toHaveLength(1);
  });

  it('trims the query, so a trailing space from a phone keyboard still matches', () => {
    // Mobile keyboards insert a space after autocorrect; without the trim this
    // reads as "no jobs match", which is the most alarming way to be wrong here.
    expect(filterOperatorJobs([row()], '  0118  ')).toHaveLength(1);
  });

  it('tolerates a null part name or customer', () => {
    const rows = [row({ part_name: null, customer_name: null })];
    expect(filterOperatorJobs(rows, '0118')).toHaveLength(1);
    expect(filterOperatorJobs(rows, 'apex')).toEqual([]);
  });

  it('returns the input array by reference for a blank query', () => {
    // The no-filter path is the overwhelmingly common one. Returning the same
    // reference keeps the caller's useMemo stable and allocates nothing.
    const rows = [row()];
    expect(filterOperatorJobs(rows, '')).toBe(rows);
    expect(filterOperatorJobs(rows, '   ')).toBe(rows);
  });

  it('returns an empty list rather than everything when nothing matches', () => {
    expect(filterOperatorJobs([row()], 'zzzz')).toEqual([]);
  });
});

describe('jobMatchesQuery', () => {
  it('treats a blank query as matching everything', () => {
    expect(jobMatchesQuery(row(), '')).toBe(true);
  });

  it('expects an already-normalized query', () => {
    // The caller lowercases once for the whole list rather than once per row;
    // an unnormalized query reaching here is a caller bug, and this pins the
    // contract so the normalization cannot quietly move.
    expect(jobMatchesQuery(row({ part_name: 'Bracket' }), 'bracket')).toBe(true);
    expect(jobMatchesQuery(row({ part_name: 'Bracket' }), 'Bracket')).toBe(false);
  });
});
