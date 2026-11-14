import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '../../test-utils';
import userEvent from '@testing-library/user-event';

/**
 * PaymentTermsPicker — lazy mode (plan §3.13 "PO form", criterion QB1).
 *
 * For QuickBooks Online the terms route is a live QuickBooks call, and the purchasing surfaces
 * promise that nothing reaches QuickBooks before a click. So the assertion is on the NETWORK:
 * `utils/quickbooksAccess` is real here and `fetch` is the spy, which proves no `/api/quickbooks`
 * request leaves the page on mount in lazy mode — and that the default (every existing caller)
 * still loads on mount, unchanged.
 */

const getCustomPaymentTerms = vi.hoisted(() => vi.fn());

vi.mock('@/utils/companyAccess', () => ({
  getCustomPaymentTerms,
  addCustomPaymentTerm: vi.fn().mockResolvedValue([]),
  removeCustomPaymentTerm: vi.fn().mockResolvedValue([]),
}));

// authHeader() reads the session locally; the token is what the backend would check.
vi.mock('@/lib/supabase', () => ({
  getSupabase: () => ({
    auth: { getSession: vi.fn().mockResolvedValue({ data: { session: { access_token: 'tok' } }, error: null }) },
  }),
}));

import PaymentTermsPicker from '@/components/common/PaymentTermsPicker';

const fetchSpy = vi.fn();

const quickBooksCalls = () =>
  fetchSpy.mock.calls.filter(([url]) => String(url).includes('/api/quickbooks'));

beforeEach(() => {
  vi.clearAllMocks();
  getCustomPaymentTerms.mockResolvedValue(['2% Net 30']);
  fetchSpy.mockImplementation(
    async () =>
      new Response(JSON.stringify({ connected: true, terms: [{ id: '7', name: 'Net 45' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
  );
  vi.stubGlobal('fetch', fetchSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('PaymentTermsPicker', () => {
  it('lazy mode makes NO /api/quickbooks request on mount', async () => {
    render(<PaymentTermsPicker companyId="co-1" value="" onChange={() => {}} lazyQuickBooksTerms />);
    // Let the mount effects (the saved-terms read) settle first.
    await waitFor(() => expect(getCustomPaymentTerms).toHaveBeenCalledWith('co-1'));
    await new Promise((r) => setTimeout(r, 50));
    expect(quickBooksCalls()).toEqual([]);
  });

  it('lazy mode asks QuickBooks once the picker is opened, and folds its terms in', async () => {
    const user = userEvent.setup();
    render(<PaymentTermsPicker companyId="co-1" value="" onChange={() => {}} lazyQuickBooksTerms />);
    await waitFor(() => expect(getCustomPaymentTerms).toHaveBeenCalled());
    expect(quickBooksCalls()).toEqual([]);

    await user.click(screen.getByRole('combobox', { name: /payment terms/i }));

    await waitFor(() => expect(quickBooksCalls()).toHaveLength(1));
    expect(String(quickBooksCalls()[0][0])).toContain('/api/quickbooks/co-1/terms');
    expect(await screen.findByRole('option', { name: 'Net 45' })).toBeInTheDocument();

    // Opening it again does not ask again.
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('combobox', { name: /payment terms/i }));
    expect(quickBooksCalls()).toHaveLength(1);
  });

  it('by default (every existing caller) still loads QuickBooks terms on mount', async () => {
    render(<PaymentTermsPicker companyId="co-1" value="" onChange={() => {}} />);
    await waitFor(() => expect(quickBooksCalls()).toHaveLength(1));
  });
});
