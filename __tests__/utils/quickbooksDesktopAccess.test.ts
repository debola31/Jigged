import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFrom = vi.fn();
vi.mock('@/lib/supabase', () => ({ getSupabase: () => ({ from: mockFrom }) }));
vi.mock('@/lib/api', () => ({ API_BASE_URL: '' }));

import {
  QB_ERROR,
  QuickBooksError,
  isQuickBooksUnreachable,
  isQuickBooksUnverified,
  getQuickBooksInvoiceLinkForJob,
} from '@/utils/quickbooksAccess';

function chain(result: unknown) {
  const c: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'order', 'limit', 'is', 'in']) {
    c[m] = vi.fn(() => c);
  }
  c.maybeSingle = vi.fn(async () => result);
  return c;
}

describe('QuickBooks error classification', () => {
  it('treats an unreachable shop PC as retryable, not as a failure', () => {
    const err = new QuickBooksError('offline', 409, QB_ERROR.desktopUnreachable);
    expect(isQuickBooksUnreachable(err)).toBe(true);
    expect(isQuickBooksUnverified(err)).toBe(false);
  });

  it('treats an unconfirmed invoice as needing a human', () => {
    expect(isQuickBooksUnverified(new QuickBooksError('x', 409, QB_ERROR.desktopVerify))).toBe(true);
    expect(isQuickBooksUnverified(new QuickBooksError('x', 409, QB_ERROR.desktopBlocked))).toBe(true);
  });

  it('does not misclassify a plain error or an uncoded 500', () => {
    expect(isQuickBooksUnreachable(new Error('boom'))).toBe(false);
    expect(isQuickBooksUnreachable(new QuickBooksError('boom', 500))).toBe(false);
  });
});

describe('getQuickBooksInvoiceLinkForJob', () => {
  beforeEach(() => mockFrom.mockReset());

  it('returns a link for a Desktop invoice, which never has a deep link', async () => {
    // The regression guard: this used to key on qb_invoice_url, so every
    // QuickBooks Desktop invoice returned null and the job page silently lost
    // its delete gate.
    mockFrom.mockReturnValue(
      chain({
        data: {
          qb_invoice_id: 'QBD-1',
          qb_invoice_doc_number: '1100',
          qb_invoice_url: null,
        },
      }),
    );
    const link = await getQuickBooksInvoiceLinkForJob('co', 'job');
    expect(link).toEqual({ invoiceId: 'QBD-1', docNumber: '1100', url: null });
  });

  it('returns null when there is no invoice at all', async () => {
    mockFrom.mockReturnValue(chain({ data: null }));
    expect(await getQuickBooksInvoiceLinkForJob('co', 'job')).toBeNull();
  });
});
