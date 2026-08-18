import { describe, it, expect } from 'vitest';
import { PRICING } from '@/lib/constants/marketing';

/**
 * The pricing page is cited in the Terms of Service, so its headline facts are
 * commercial terms rather than ordinary marketing copy. These assertions exist to make
 * an accidental edit fail loudly — the price in particular, which is a hardcoded string
 * with nothing structurally linking it to Stripe's `STRIPE_PRICE_ID`
 * (docs/modules/billing.md §6). Changing any of these on purpose means changing the
 * ToS, and the price also means a new Stripe Price object.
 */
describe('PRICING copy', () => {
  it('states the price that live Stripe charges', () => {
    expect(PRICING.amount).toBe('$399');
    expect(PRICING.period).toBe('/month');
    expect(PRICING.unit).toBe('per shop');
  });

  it('points its CTA at the request-access flow', () => {
    // Must match the token in app/(marketing)/invite/tokens.ts, or the CTA 404s.
    expect(PRICING.cta.href).toBe('/invite/early-access');
  });

  it('keeps the FAQ to three items', () => {
    expect(PRICING.faq).toHaveLength(3);
    for (const { q, a } of PRICING.faq) {
      expect(q.length).toBeGreaterThan(0);
      expect(a.length).toBeGreaterThan(0);
    }
  });

  it('keeps the meta description inside the snippet budget', () => {
    // ~155 chars is where Google truncates — same budget MARKETING_META documents.
    expect(PRICING.meta.description.length).toBeLessThanOrEqual(155);
  });

  it('does not append the title template by hand', () => {
    // The root layout applies '%s | Jigged'; a hand-written suffix double-renders it.
    expect(PRICING.meta.title).not.toContain('| Jigged');
  });
});
