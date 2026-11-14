/**
 * The late-PO predicate (plan §3.4 "Dates", criterion P7).
 *
 * THE CASES LIVE IN A FILE THAT SQL ALSO READS. `__tests__/fixtures/vendorPoLateCases.json` is fed
 * to `isVendorPoLate()` here and to `public.is_vendor_purchase_order_late()` by the DB tests, so the
 * PO list's amber "Overdue", the MCP `overdue` flag and the insights chat cannot disagree about
 * which POs — or lines — are late. Add a case there, not here.
 *
 * `today` is always the caller's local calendar date — never the server's UTC CURRENT_DATE, which
 * runs a day ahead every evening in the Americas.
 */
import { describe, it, expect } from 'vitest';
import lateFixture from '../../fixtures/vendorPoLateCases.json';
import { LATE_ELIGIBLE_STATUSES, isVendorPoLate } from '@/lib/purchasing/late';
import { VENDOR_PO_LINE_STATUSES, VENDOR_PO_STATUSES } from '@/lib/purchasing/vendorPoStatus';

interface LateCase {
  name: string;
  status: string;
  expected_on: string | null;
  today?: string;
  late: boolean;
}

// A case's own `today` wins; the file's `today` is the default — the same rule the SQL runner uses.
const cases = (lateFixture.cases as LateCase[]).map((c) => ({ ...c, today: c.today ?? lateFixture.today }));

describe('isVendorPoLate — golden cases shared with SQL (P7)', () => {
  it.each(cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    expect(isVendorPoLate(c.status, c.expected_on, c.today)).toBe(c.late);
  });

  it('covers both sides of the day boundary, so a strict < is actually pinned', () => {
    // A case list that never puts "expected today" beside "expected yesterday" would let < and
    // <= both pass — and that one character is a whole day of POs.
    const onTheDay = cases.find((c) => c.status === 'sent' && c.expected_on === c.today);
    const dayBefore = cases.find((c) => c.status === 'sent' && c.expected_on === '2026-11-08' && c.today === '2026-11-09');
    expect(onTheDay?.late).toBe(false);
    expect(dayBefore?.late).toBe(true);
  });

  it('covers every PO status and every line status, so a status added to the late set would be caught', () => {
    const statuses = new Set(cases.map((c) => c.status));
    for (const s of [...VENDOR_PO_STATUSES, ...VENDOR_PO_LINE_STATUSES]) expect(statuses, s).toContain(s);
  });

  it('gives every case a unique name and a date to judge it by', () => {
    expect(lateFixture.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    for (const c of cases) {
      expect(c.name, JSON.stringify(c)).toBeTruthy();
      expect(c.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    expect(new Set(cases.map((c) => c.name)).size).toBe(cases.length);
  });

  it('can be late only while something is still owed: a sent or partly received PO, an open or partly received line', () => {
    expect([...LATE_ELIGIBLE_STATUSES].sort()).toEqual(['open', 'partially_received', 'sent']);
  });
});

describe('isVendorPoLate — inputs the fixture does not carry (P7)', () => {
  it('is never late without a caller date', () => {
    expect(isVendorPoLate('sent', '2020-01-01', null)).toBe(false);
    expect(isVendorPoLate('sent', '2020-01-01', '')).toBe(false);
  });

  it('refuses to compare anything that is not a plain YYYY-MM-DD date', () => {
    // A timestamp would compare as text and be "late" on its own due day.
    expect(isVendorPoLate('sent', '2026-11-09T00:00:00Z', '2026-11-10')).toBe(false);
    expect(isVendorPoLate('sent', '2026-11-8', '2026-11-10')).toBe(false);
  });

  it('treats an unknown or missing status as not late', () => {
    expect(isVendorPoLate('mystery', '2020-01-01', '2026-11-09')).toBe(false);
    expect(isVendorPoLate(null, '2020-01-01', '2026-11-09')).toBe(false);
  });
});
