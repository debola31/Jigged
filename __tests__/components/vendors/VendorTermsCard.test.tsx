/**
 * The vendor's standing payment terms (plan §3.13 "Elsewhere", criteria QB1 and UI-46).
 *
 * Auto-save, like the customer's terms card: a standing term only seeds a NEW purchase order, so a
 * slip here cannot change what any open PO says. And the vendor page promises no QuickBooks call
 * before a click — for QuickBooks Online the terms list IS one — so the picker loads them on open.
 * That is asserted on the network: `utils/quickbooksAccess` is real and `fetch` is the spy.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import userEvent from '@testing-library/user-event';
import { render, screen, waitFor } from '../../test-utils';

const getCustomPaymentTerms = vi.hoisted(() => vi.fn());
const setVendorDefaultPaymentTerms = vi.hoisted(() => vi.fn());

vi.mock('@/utils/companyAccess', () => ({
  getCustomPaymentTerms,
  addCustomPaymentTerm: vi.fn().mockResolvedValue([]),
  removeCustomPaymentTerm: vi.fn().mockResolvedValue([]),
}));
vi.mock('@/utils/vendorsAccess', () => ({ setVendorDefaultPaymentTerms }));
vi.mock('@/lib/supabase', () => ({
  getSupabase: () => ({
    auth: { getSession: vi.fn().mockResolvedValue({ data: { session: { access_token: 'tok' } }, error: null }) },
  }),
}));

import VendorTermsCard from '@/components/vendors/VendorTermsCard';

const fetchSpy = vi.fn();
const quickBooksCalls = () => fetchSpy.mock.calls.filter(([url]) => String(url).includes('/api/quickbooks'));

const draw = (terms: string | null = 'Net 30') =>
  render(<VendorTermsCard companyId="co1" vendorId="v1" vendorName="Acme Steel" terms={terms} />);

const picker = () => screen.getByRole('combobox', { name: /payment terms/i });

beforeEach(() => {
  vi.clearAllMocks();
  getCustomPaymentTerms.mockResolvedValue([]);
  setVendorDefaultPaymentTerms.mockImplementation(async (_id: string, terms: string | null) => terms);
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

describe('VendorTermsCard', () => {
  it('shows the vendor’s standing terms', async () => {
    draw('Net 30');
    await waitFor(() => expect(getCustomPaymentTerms).toHaveBeenCalledWith('co1'));
    expect(picker()).toHaveValue('Net 30');
    expect(screen.getByText(/new purchase orders to Acme Steel/i)).toBeInTheDocument();
  });

  it('makes no QuickBooks request until the picker is opened', async () => {
    const user = userEvent.setup();
    draw();
    await waitFor(() => expect(getCustomPaymentTerms).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 50));
    expect(quickBooksCalls()).toEqual([]);

    await user.click(picker());
    await waitFor(() => expect(quickBooksCalls()).toHaveLength(1));
  });

  it('saves a chosen term straight away, and says so', async () => {
    const user = userEvent.setup();
    draw(null);
    await user.click(picker());
    await user.click(await screen.findByRole('option', { name: 'Net 60' }));

    await waitFor(() => expect(setVendorDefaultPaymentTerms).toHaveBeenCalledWith('v1', 'Net 60'));
    expect(await screen.findByText('Saved')).toBeInTheDocument();
    expect(picker()).toHaveValue('Net 60');
  });

  it('saves "none" when the terms are cleared', async () => {
    const user = userEvent.setup();
    draw('Net 30');
    await user.click(picker());
    // MUI hides the clear icon with CSS until hover, which leaves it no accessible name in jsdom.
    await user.click(screen.getByTitle('Clear'));
    await waitFor(() => expect(setVendorDefaultPaymentTerms).toHaveBeenCalledWith('v1', null));
  });

  it('says it could not save, rather than looking saved', async () => {
    const user = userEvent.setup();
    setVendorDefaultPaymentTerms.mockRejectedValue(new Error("Failed to save the vendor's terms."));
    draw(null);
    await user.click(picker());
    await user.click(await screen.findByRole('option', { name: 'Net 60' }));
    expect(await screen.findByText(/couldn.t save/i)).toBeInTheDocument();
    expect(screen.queryByText('Saved')).not.toBeInTheDocument();
  });
});
