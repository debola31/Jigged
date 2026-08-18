import { describe, it, expect, beforeEach } from 'vitest';
import { isTermsExempt, termsGateMode } from '@/lib/termsGate';
import { canDefer, recordDeferral, deferralDeadline, MAX_DEFERRALS } from '@/lib/termsDeferral';
import type { LegalVersion } from '@/lib/legal/manifest';

const entry = (over: Partial<LegalVersion> = {}): LegalVersion => ({
  version: 2,
  effective_date: '2026-08-18',
  enforcement_starts_on: '2026-09-01',
  requires_reacceptance: true,
  sha256: 'a'.repeat(64),
  bytes: 10,
  effective_date_appears_in_body: true,
  ...over,
});

describe('termsGate — routes the prompt must never cover', () => {
  /**
   * THE ONE THAT MATTERS. A modal covering the document you are being asked to
   * agree to is a clickwrap that does not survive contact with a court.
   */
  it('never covers the legal documents themselves, including their archives', () => {
    for (const p of ['/terms', '/privacy', '/cookies', '/terms/v1', '/privacy/v2', '/legal/tos/v1.html']) {
      expect(isTermsExempt(p), p).toBe(true);
    }
  });

  it('never covers the auth and recovery paths', () => {
    // Someone whose session is expiring must be able to sign back in without
    // first agreeing to anything.
    for (const p of ['/login', '/signup', '/forgot-password', '/reset-password', '/change-password', '/auth/confirm']) {
      expect(isTermsExempt(p), p).toBe(true);
    }
  });

  it('never covers accept-invite, which owns its own checkbox', () => {
    expect(isTermsExempt('/accept-invite/abc-123')).toBe(true);
  });

  it('never covers the transient scan stubs', () => {
    // They read nothing and immediately replace() onward, so a modal would flash
    // over a screen nobody is looking at.
    expect(isTermsExempt('/T/ABC123')).toBe(true);
    expect(isTermsExempt('/L/ABC123')).toBe(true);
  });

  it('never covers the operator login passthrough', () => {
    expect(isTermsExempt('/operator/company-1/login')).toBe(true);
  });

  it('does not treat an unknown location as a place to block', () => {
    expect(isTermsExempt(null)).toBe(true);
  });

  it('does cover the working surfaces', () => {
    for (const p of ['/dashboard/c1/jobs', '/operator/c1', '/select-company', '/no-access', '/launch']) {
      expect(isTermsExempt(p), p).toBe(false);
    }
  });
});

describe('termsGate — how hard it blocks', () => {
  it('blocks the dashboard, where the shop is bound by its admin', () => {
    expect(termsGateMode('/dashboard/c1/jobs')).toBe('blocking');
    expect(termsGateMode('/admin')).toBe('blocking');
  });

  /**
   * Defaulting to deferrable is deliberate. Keying on "/operator/" alone would
   * hard-block an operator on /launch, /select-company, /no-access and the scan
   * stubs — the exact mid-shift interruption the deferral exists to prevent.
   */
  it('defaults to deferrable everywhere else, not just on /operator', () => {
    for (const p of ['/operator/c1', '/launch', '/select-company', '/no-access', null]) {
      expect(termsGateMode(p), String(p)).toBe('deferrable');
    }
  });
});

/**
 * This runner starts without a localStorage (Node's built-in needs
 * --localstorage-file and jsdom does not supply one), so the deferral tests
 * install a real in-memory store. lib/termsDeferral.ts survives its absence via
 * try/catch — the last test here proves that — but the cap itself cannot be
 * exercised without somewhere to count.
 */
function installLocalStorage() {
  let store: Record<string, string> = {};
  const mock = {
    getItem: (k: string) => (k in store ? store[k] : null),
    setItem: (k: string, v: string) => {
      store[k] = String(v);
    },
    removeItem: (k: string) => {
      delete store[k];
    },
    clear: () => {
      store = {};
    },
    key: (i: number) => Object.keys(store)[i] ?? null,
    get length() {
      return Object.keys(store).length;
    },
  };
  Object.defineProperty(window, 'localStorage', { value: mock, configurable: true, writable: true });
  return mock;
}

describe('termsDeferral — the cap', () => {
  beforeEach(() => installLocalStorage());

  it('offers the escape at first sight', () => {
    expect(canDefer('tos', entry(), new Date('2026-09-02T00:00:00Z'))).toBe(true);
  });

  it('stops offering it after five dismissals', () => {
    const now = new Date('2026-09-02T00:00:00Z');
    for (let i = 0; i < MAX_DEFERRALS; i += 1) {
      expect(canDefer('tos', entry(), now)).toBe(true);
      recordDeferral('tos', 2, now);
    }
    expect(canDefer('tos', entry(), now)).toBe(false);
  });

  it('stops offering it once the 14 days are up, however few dismissals were used', () => {
    recordDeferral('tos', 2, new Date('2026-09-01T00:00:00Z'));
    expect(canDefer('tos', entry(), new Date('2026-09-20T00:00:00Z'))).toBe(false);
  });

  /**
   * The unforgeable half. The deadline counts from the EARLIER of the platform's
   * enforcement date and this device's first prompt, so clearing storage cannot
   * hand someone a fresh 14 days over and over.
   */
  it('does not restart the clock when a device clears its storage', () => {
    const wayLater = '2027-01-01T00:00:00Z';
    const deadline = deferralDeadline(entry(), wayLater);
    expect(deadline.toISOString().slice(0, 10)).toBe('2026-09-15');
  });

  it('counts per version, so a new version gets its own grace', () => {
    const now = new Date('2026-09-02T00:00:00Z');
    for (let i = 0; i < MAX_DEFERRALS; i += 1) recordDeferral('tos', 2, now);
    expect(canDefer('tos', entry({ version: 2 }), now)).toBe(false);
    expect(canDefer('tos', entry({ version: 3 }), now)).toBe(true);
  });

  it('survives storage being unavailable by failing toward prompting', () => {
    // Safari private mode, a locked-down phone, or this very test runner. The
    // operator simply gets no grace, which is the safe direction.
    Object.defineProperty(window, 'localStorage', { value: undefined, configurable: true });
    expect(() => canDefer('tos', entry(), new Date('2026-09-02T00:00:00Z'))).not.toThrow();
    expect(() => recordDeferral('tos', 2)).not.toThrow();
  });
});
