import { describe, it, expect } from 'vitest';
import { isTermsExempt, termsSurface } from '@/lib/termsGate';

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

describe('termsGate — which surface is asking', () => {
  /**
   * This used to decide how HARD to block. That distinction is gone: the prompt
   * is universal and blocking. Deferral did not reduce shop-floor interruption,
   * it multiplied it -- the same prompt up to six times instead of once. What
   * survives is only the label, which must match the DB CHECK on accepted_via.
   */
  it('names the operator surface from the path', () => {
    expect(termsSurface('/operator/c1')).toBe('reacceptance_operator');
    expect(termsSurface('/operator/c1/jobs')).toBe('reacceptance_operator');
  });

  it('calls everything else the dashboard surface', () => {
    for (const p of ['/dashboard/c1/jobs', '/admin', '/select-question', '/launch', null]) {
      expect(termsSurface(p), String(p)).toBe('reacceptance_dashboard');
    }
  });
});

