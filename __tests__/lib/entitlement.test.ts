import { describe, it, expect } from 'vitest';
import {
  getEntitlement,
  isWriteAllowed,
  GRACE_DAYS,
  type BillingRow,
  type Entitlement,
} from '@/lib/entitlement';

// A fixed "now" so grace-window math is deterministic.
const NOW = new Date('2026-07-25T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

function row(overrides: Partial<BillingRow> = {}): BillingRow {
  return {
    billing_exempt: false,
    subscription_status: null,
    current_period_end: null,
    cancel_at: null,
    ended_at: null,
    ...overrides,
  };
}

/** ISO string for `days` days before/after NOW (negative = past). */
function iso(daysFromNow: number): string {
  return new Date(NOW.getTime() + daysFromNow * DAY).toISOString();
}

/**
 * The parity contract shared with the SQL `company_can_write()` function
 * (scripts/verify_billing_parity.sql runs these exact cases through the DB).
 * `isWriteAllowed(entitlement)` MUST equal the SQL boolean for each row.
 */
export interface GoldenCase {
  name: string;
  isDemo: boolean;
  billing: BillingRow | null;
  expected: Entitlement;
}

export const GOLDEN_CASES: GoldenCase[] = [
  { name: 'demo, no billing row', isDemo: true, billing: null, expected: 'full' },
  { name: 'demo, lapsed billing (ignored)', isDemo: true, billing: row({ subscription_status: 'canceled', ended_at: iso(-30) }), expected: 'full' },
  { name: 'grandfathered (exempt), no sub', isDemo: false, billing: row({ billing_exempt: true }), expected: 'full' },
  { name: 'trialing', isDemo: false, billing: row({ subscription_status: 'trialing', trial_end: iso(20) }), expected: 'full' },
  { name: 'active', isDemo: false, billing: row({ subscription_status: 'active', current_period_end: iso(20) }), expected: 'full' },
  { name: 'past_due', isDemo: false, billing: row({ subscription_status: 'past_due' }), expected: 'past_due' },
  { name: 'canceled within grace (ended 2d ago)', isDemo: false, billing: row({ subscription_status: 'canceled', ended_at: iso(-2) }), expected: 'full' },
  { name: 'canceled past grace (ended 30d ago)', isDemo: false, billing: row({ subscription_status: 'canceled', ended_at: iso(-30) }), expected: 'read_only' },
  { name: 'unpaid within grace', isDemo: false, billing: row({ subscription_status: 'unpaid', ended_at: iso(-1) }), expected: 'full' },
  { name: 'unpaid past grace', isDemo: false, billing: row({ subscription_status: 'unpaid', ended_at: iso(-10) }), expected: 'read_only' },
  { name: 'canceled, grace anchored on cancel_at', isDemo: false, billing: row({ subscription_status: 'canceled', cancel_at: iso(-1) }), expected: 'full' },
  { name: 'canceled, grace anchored on current_period_end', isDemo: false, billing: row({ subscription_status: 'canceled', current_period_end: iso(-1) }), expected: 'full' },
  { name: 'canceled, no anchor at all', isDemo: false, billing: row({ subscription_status: 'canceled' }), expected: 'read_only' },
  { name: 'paused', isDemo: false, billing: row({ subscription_status: 'paused' }), expected: 'read_only' },
  { name: 'incomplete', isDemo: false, billing: row({ subscription_status: 'incomplete' }), expected: 'must_subscribe' },
  { name: 'incomplete_expired', isDemo: false, billing: row({ subscription_status: 'incomplete_expired' }), expected: 'must_subscribe' },
  { name: 'no billing row, not demo', isDemo: false, billing: null, expected: 'must_subscribe' },
  { name: 'row exists, status null, not exempt', isDemo: false, billing: row(), expected: 'must_subscribe' },
];

describe('getEntitlement', () => {
  for (const c of GOLDEN_CASES) {
    it(`maps: ${c.name} → ${c.expected}`, () => {
      expect(getEntitlement(c.isDemo, c.billing, NOW)).toBe(c.expected);
    });
  }

  it('demo short-circuits regardless of billing state', () => {
    expect(getEntitlement(true, row({ subscription_status: 'incomplete' }), NOW)).toBe('full');
  });

  it('grace boundary: exactly GRACE_DAYS ago is still full; just past is read_only', () => {
    const justInside = row({ subscription_status: 'canceled', ended_at: iso(-GRACE_DAYS) });
    const justPast = row({
      subscription_status: 'canceled',
      ended_at: new Date(NOW.getTime() - GRACE_DAYS * DAY - 1000).toISOString(),
    });
    expect(getEntitlement(false, justInside, NOW)).toBe('full');
    expect(getEntitlement(false, justPast, NOW)).toBe('read_only');
  });
});

describe('isWriteAllowed', () => {
  it('full and past_due may write; read_only and must_subscribe may not', () => {
    expect(isWriteAllowed('full')).toBe(true);
    expect(isWriteAllowed('past_due')).toBe(true);
    expect(isWriteAllowed('read_only')).toBe(false);
    expect(isWriteAllowed('must_subscribe')).toBe(false);
  });

  it('every golden case: write-allowed is derivable from entitlement', () => {
    // This is the TS half of the TS↔SQL parity (scenario 29). The SQL half runs
    // the same GOLDEN_CASES through company_can_write in verify_billing_parity.sql.
    for (const c of GOLDEN_CASES) {
      const e = getEntitlement(c.isDemo, c.billing, NOW);
      const writeAllowed = isWriteAllowed(e);
      expect(typeof writeAllowed).toBe('boolean');
      // Sanity: full/past_due write; the rest don't.
      expect(writeAllowed).toBe(e === 'full' || e === 'past_due');
    }
  });
});
