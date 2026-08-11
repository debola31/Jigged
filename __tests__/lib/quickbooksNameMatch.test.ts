import { describe, it, expect } from 'vitest';
import {
  QBD_NAME_MAX,
  exceedsQuickBooksNameLimit,
  normalizeCustomerName,
  suggestQuickBooksCustomer,
  truncateForQuickBooks,
  type MatchableCustomer,
} from '@/lib/quickbooksNameMatch';

const qb = (qb_id: string, full_name: string): MatchableCustomer => ({
  qb_id,
  full_name,
  name: full_name,
});

describe('normalizeCustomerName', () => {
  it('folds case, punctuation and spacing', () => {
    expect(normalizeCustomerName('  ACME   Machining ')).toBe('acme machining');
    expect(normalizeCustomerName('Acme, Machining.')).toBe('acme machining');
  });

  it('drops legal suffixes so the same shop recorded two ways still matches', () => {
    expect(normalizeCustomerName('Acme Machining, Inc.')).toBe('acme machining');
    expect(normalizeCustomerName('acme machining llc')).toBe('acme machining');
    expect(normalizeCustomerName('Acme Machining Corporation')).toBe('acme machining');
  });

  it('returns empty for blank input rather than throwing', () => {
    expect(normalizeCustomerName('')).toBe('');
  });
});

describe('truncateForQuickBooks', () => {
  it('cuts at the QuickBooks cap and trims a dangling space', () => {
    const long = 'A'.repeat(50);
    expect(truncateForQuickBooks(long)).toHaveLength(QBD_NAME_MAX);
    expect(truncateForQuickBooks(`${'B'.repeat(40)} tail`)).toBe('B'.repeat(40));
  });

  it('leaves a short name alone', () => {
    expect(truncateForQuickBooks('Acme')).toBe('Acme');
  });
});

describe('exceedsQuickBooksNameLimit', () => {
  it('flags names QuickBooks cannot store as-is', () => {
    expect(exceedsQuickBooksNameLimit('A'.repeat(42))).toBe(true);
    expect(exceedsQuickBooksNameLimit('A'.repeat(41))).toBe(false);
  });
});

describe('suggestQuickBooksCustomer', () => {
  it('matches an exact fold', () => {
    const s = suggestQuickBooksCustomer('Acme Machining, Inc.', [
      qb('1', 'Acme Machining'),
      qb('2', 'Other Co'),
    ]);
    expect(s).toEqual({ qbId: '1', confidence: 'exact' });
  });

  it('matches a Jigged name against its 41-char QuickBooks truncation', () => {
    // The line that makes the screen useful: without it, every customer over the
    // cap reads as unlinked even though its shortened twin is already in
    // QuickBooks — so the admin links nothing and the push creates duplicates.
    const long = 'Precision Aerospace Components of Northern California';
    expect(long.length).toBeGreaterThan(QBD_NAME_MAX);
    const s = suggestQuickBooksCustomer(long, [qb('9', truncateForQuickBooks(long))]);
    expect(s).toEqual({ qbId: '9', confidence: 'exact' });
  });

  it('reports a merely-similar name as close, never exact', () => {
    const s = suggestQuickBooksCustomer('Acme Machining', [
      qb('1', 'Acme Machining and Fabrication'),
    ]);
    expect(s?.confidence).toBe('close');
  });

  it('returns null when two candidates fold to the same name', () => {
    // Picking one would be a coin flip with an invoice on it.
    const s = suggestQuickBooksCustomer('Acme Machining', [
      qb('1', 'Acme Machining Inc'),
      qb('2', 'Acme Machining LLC'),
    ]);
    expect(s).toBeNull();
  });

  it('returns null rather than the nearest option when nothing matches', () => {
    const s = suggestQuickBooksCustomer('Acme Machining', [qb('1', 'Zenith Tooling')]);
    expect(s).toBeNull();
  });

  it('returns null for a blank Jigged name', () => {
    expect(suggestQuickBooksCustomer('', [qb('1', 'Acme')])).toBeNull();
  });

  it('prefers the exact match when a close one also exists', () => {
    const s = suggestQuickBooksCustomer('Acme Machining', [
      qb('1', 'Acme Machining and Fabrication'),
      qb('2', 'Acme Machining, Inc.'),
    ]);
    expect(s).toEqual({ qbId: '2', confidence: 'exact' });
  });
});
