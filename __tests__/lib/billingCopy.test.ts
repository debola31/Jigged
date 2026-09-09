import { describe, it, expect } from 'vitest';
import {
  backpaySummary,
  blockedMessageForAdmin,
  blockedMessageForNonAdmin,
  blockedNoticeForAdmin,
  blockedNoticeForNonAdmin,
  writeBlockedState,
} from '@/lib/billingCopy';
import type { BillingRow } from '@/lib/entitlement';

const row = (status: string | null): BillingRow => ({
  billing_exempt: false,
  subscription_status: status,
  current_period_end: null,
  cancel_at: null,
  ended_at: null,
});

describe('writeBlockedState', () => {
  it('treats a company with no billing row as never started', () => {
    // The common case: a brand-new company has no company_billing row at all.
    expect(writeBlockedState(null)).toBe('never_started');
  });

  it('treats a subscription that never completed as never started', () => {
    expect(writeBlockedState(row('incomplete'))).toBe('never_started');
    expect(writeBlockedState(row('incomplete_expired'))).toBe('never_started');
    expect(writeBlockedState(row(null))).toBe('never_started');
  });

  it('treats canceled and unpaid as ended', () => {
    expect(writeBlockedState(row('canceled'))).toBe('ended');
    expect(writeBlockedState(row('unpaid'))).toBe('ended');
  });

  it('keeps paused distinct from ended', () => {
    // The bug this file exists to fix. Entitlement collapses canceled, unpaid AND paused into
    // `read_only` because the write gate treats them identically — correct for enforcement,
    // untrue as copy.
    expect(writeBlockedState(row('paused'))).toBe('paused');
  });

  it('falls back to never started for an unrecognised status', () => {
    // Safer than "ended": inventing an ending for something that may never have begun reads as
    // a billing error to the user.
    expect(writeBlockedState(row('something_new_from_stripe'))).toBe('never_started');
  });
});

describe('blocked copy', () => {
  it('never tells a shop that has not subscribed that anything ended', () => {
    const admin = blockedMessageForAdmin('never_started', 'part');
    expect(admin).toContain("hasn't started yet");
    expect(admin).not.toMatch(/ended|resubscribe/i);
    expect(blockedMessageForNonAdmin('never_started')).not.toMatch(/ended|restart/i);
    expect(blockedNoticeForAdmin('never_started', 'parts')).not.toMatch(/ended|again/i);
  });

  it('never tells a paused shop that its subscription ended', () => {
    for (const text of [
      blockedMessageForAdmin('paused', 'part'),
      blockedMessageForNonAdmin('paused'),
      blockedNoticeForAdmin('paused', 'parts'),
      blockedNoticeForNonAdmin('paused', 'parts'),
    ]) {
      expect(text).toMatch(/paused/i);
      expect(text).not.toMatch(/ended/i);
    }
  });

  it('uses a verb that matches the state', () => {
    expect(blockedMessageForAdmin('never_started', 'part')).toContain('Start it');
    expect(blockedMessageForAdmin('ended', 'part')).toContain('Resubscribe');
    expect(blockedMessageForAdmin('paused', 'part')).toContain('Resume it');
    // Non-admins get the same verb, attributed to whoever can use it.
    expect(blockedMessageForNonAdmin('never_started')).toContain('start it');
    expect(blockedMessageForNonAdmin('ended')).toContain('restart it');
    expect(blockedMessageForNonAdmin('paused')).toContain('resume it');
  });

  it('names the entity the user was acting on', () => {
    expect(blockedMessageForAdmin('ended', 'quote')).toContain('save this quote');
    expect(blockedNoticeForAdmin('never_started', 'work centers')).toContain(
      'add work centers to Jigged',
    );
    expect(blockedNoticeForNonAdmin('ended', 'customers')).toContain("new customers can't be saved");
  });

  it('points a non-admin at an admin rather than at an action they cannot take', () => {
    for (const state of ['never_started', 'ended', 'paused'] as const) {
      expect(blockedMessageForNonAdmin(state)).toContain('An admin at your shop');
      expect(blockedNoticeForNonAdmin(state, 'parts')).toContain('An admin at your shop');
    }
  });
});

describe('backpaySummary', () => {
  const backpay = (over: Partial<Parameters<typeof backpaySummary>[0]> = {}) => ({
    backpay_monthly_cents: 25000,
    backpay_months: 3,
    backpay_first_month: '2026-06-01',
    backpay_charged_at: null,
    ...over,
  });

  it('states the total and the months it covers', () => {
    expect(backpaySummary(backpay())).toBe(
      '$750.00 for 3 previously unbilled months (June 2026 – August 2026)',
    );
  });

  it('does not render a month range or a plural for a single month', () => {
    expect(backpaySummary(backpay({ backpay_months: 1 }))).toBe(
      '$250.00 for 1 previously unbilled month (June 2026)',
    );
  });

  it('labels the first month correctly in a negative-offset timezone', () => {
    // `new Date('2026-06-01')` is UTC midnight, which is May 31 in US timezones —
    // the whole reason the date is parsed by parts rather than by Date.parse.
    expect(backpaySummary(backpay())).toContain('June 2026');
    expect(backpaySummary(backpay())).not.toContain('May');
  });

  it('rolls the year over rather than producing a month 13', () => {
    expect(
      backpaySummary(backpay({ backpay_first_month: '2026-11-01', backpay_months: 4 })),
    ).toBe('$1,000.00 for 4 previously unbilled months (November 2026 – February 2027)');
  });

  it('says nothing once the backpay has been paid', () => {
    // Advertising a charge the customer has already settled would be a lie.
    expect(backpaySummary(backpay({ backpay_charged_at: '2026-09-09T00:00:00Z' }))).toBeNull();
  });

  it('says nothing when no backpay is configured, or it is half-configured', () => {
    expect(backpaySummary(null)).toBeNull();
    expect(backpaySummary(backpay({ backpay_monthly_cents: null }))).toBeNull();
    expect(backpaySummary(backpay({ backpay_months: null }))).toBeNull();
    expect(backpaySummary(backpay({ backpay_first_month: null }))).toBeNull();
  });
});
