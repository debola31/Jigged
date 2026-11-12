/**
 * Recording one vendor's quote (criterion Q2).
 *
 * The grid is priced per the RFQ line's unit at each quantity, with the line's lead time, minimum
 * order, valid-until and the vendor's part number, or No bid. `saveVendorRfqResponses` REPLACES the
 * vendor's whole quote, so the editor must send everything it means to keep — an awarded answer
 * exactly as stored, and a note it never showed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import userEvent from '@testing-library/user-event';
import { render, screen, within, waitFor } from '../../test-utils';

const { mockSave, mockCapture } = vi.hoisted(() => ({ mockSave: vi.fn(), mockCapture: vi.fn() }));

vi.mock('@/lib/supabase', () => ({ getSupabase: () => ({}), createClient: () => ({}) }));
vi.mock('posthog-js', () => ({ default: { capture: mockCapture } }));
vi.mock('@/utils/vendorRfqAccess', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/vendorRfqAccess')>()),
  saveVendorRfqResponses: (...a: unknown[]) => mockSave(...a),
}));

import RfqResponseEditor from '@/components/purchasing/RfqResponseEditor';
import { rfqDetail, response, RESPONSES } from './rfqFixtures';

const onSaved = vi.fn();
const onClose = vi.fn();

function renderEditor(rfq = rfqDetail({ responses: [] }), invitationId = 'inv-beta') {
  return render(<RfqResponseEditor open rfq={rfq} invitationId={invitationId} onClose={onClose} onSaved={onSaved} />);
}

const section = (name: RegExp) => screen.getByRole('group', { name });

beforeEach(() => {
  vi.clearAllMocks();
  mockSave.mockResolvedValue({ invitationId: 'inv-beta', vendorRfqId: 'rfq-1', responseIds: [], status: 'quoted' });
});

describe('RfqResponseEditor — the grid (Q2)', () => {
  const user = userEvent.setup();

  it('asks for a price per line unit at each quantity', () => {
    renderEditor();
    const bar = section(/Line 1/);
    expect(within(bar).getByLabelText('Price at 10 bar')).toBeInTheDocument();
    expect(within(bar).getByLabelText('Price at 25 bar')).toBeInTheDocument();
    expect(within(section(/Line 2/)).getByLabelText('Price at 50 ea')).toBeInTheDocument();
  });

  it("sends the vendor's whole quote: priced quantities, the line's terms, a blank quantity left out", async () => {
    renderEditor();
    const bar = section(/Line 1/);
    await user.type(within(bar).getByLabelText('Price at 10 bar'), '48.5');
    await user.type(within(bar).getByLabelText('Lead time (days)'), '7');
    await user.type(within(bar).getByLabelText(/Minimum order/), '5');
    await user.type(within(bar).getByLabelText('Their part #'), 'BM-61');
    // 25 bars left blank: not quoted at that quantity.
    await user.click(within(section(/Line 2/)).getByRole('checkbox', { name: /No bid/ }));
    await user.type(screen.getByLabelText('Their quote #'), 'BQ-9');

    await user.click(screen.getByRole('button', { name: 'Save quote' }));

    await waitFor(() => expect(mockSave).toHaveBeenCalled());
    const [invitationId, payload, options] = mockSave.mock.calls[0];
    expect(invitationId).toBe('inv-beta');
    expect(payload).toEqual([
      {
        lineId: 'line-bar',
        quantity: 10,
        unitPrice: 48.5,
        noBid: false,
        leadTimeDays: 7,
        minimumOrderQuantity: 5,
        validUntil: null,
        vendorPartNumber: 'BM-61',
        notes: null,
      },
      {
        lineId: 'line-brush',
        quantity: 50,
        noBid: true,
        leadTimeDays: null,
        minimumOrderQuantity: null,
        validUntil: null,
        vendorPartNumber: null,
        notes: null,
      },
    ]);
    expect(options).toEqual({ vendorQuoteReference: 'BQ-9', quotedOn: null });
    expect(onSaved).toHaveBeenCalled();
    expect(mockCapture).toHaveBeenCalledWith('vendor rfq response recorded', {
      priced_cell_count: 1,
      no_bid_count: 1,
      has_lead_time: true,
      has_valid_until: false,
    });
  });

  it('No bid clears the prices and takes them out of the payload', async () => {
    renderEditor();
    const bar = section(/Line 1/);
    const price = within(bar).getByLabelText('Price at 10 bar');
    await user.type(price, '12');
    await user.click(within(bar).getByRole('checkbox', { name: /No bid/ }));
    expect(price).toHaveValue('');
    expect(price).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Save quote' }));
    await waitFor(() => expect(mockSave).toHaveBeenCalled());
    const payload = mockSave.mock.calls[0][1] as Array<Record<string, unknown>>;
    expect(payload.filter((r) => r.lineId === 'line-bar')).toEqual([
      expect.objectContaining({ quantity: 10, noBid: true }),
      expect.objectContaining({ quantity: 25, noBid: true }),
    ]);
    expect(payload.every((r) => !('unitPrice' in r) || r.unitPrice === undefined)).toBe(true);
  });

  it('refuses a price that is not a number before any request', async () => {
    renderEditor();
    await user.type(within(section(/Line 1/)).getByLabelText('Price at 10 bar'), '1.2.3');
    expect(screen.getByRole('button', { name: 'Save quote' })).toBeDisabled();
    expect(screen.getByText(/Line 1: enter prices as numbers/)).toBeInTheDocument();
    expect(mockSave).not.toHaveBeenCalled();
  });
});

describe('RfqResponseEditor — what it must keep', () => {
  const user = userEvent.setup();

  it('opens on what the vendor already quoted', () => {
    renderEditor(rfqDetail(), 'inv-acme');
    const bar = section(/Line 1/);
    expect(within(bar).getByLabelText('Price at 10 bar')).toHaveValue('60');
    expect(within(bar).getByLabelText('Lead time (days)')).toHaveValue('5');
    expect(within(bar).getByLabelText('Their part #')).toHaveValue('ACME-61');
    expect(screen.getByLabelText('Their quote #')).toHaveValue('Q-1001');
  });

  it('an awarded line is read-only and goes back exactly as stored', async () => {
    const awarded = RESPONSES.map((r) =>
      r.id === 'r-acme-10' ? { ...r, awardedAt: '2026-11-09T10:00:00Z', notes: 'Price incl. cutting' } : r,
    );
    renderEditor(rfqDetail({ responses: awarded }), 'inv-acme');
    const bar = section(/Line 1/);
    expect(within(bar).getByText(/Awarded/)).toBeInTheDocument();
    expect(within(bar).getByLabelText('Price at 10 bar')).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Save quote' }));
    await waitFor(() => expect(mockSave).toHaveBeenCalled());
    const payload = mockSave.mock.calls[0][1] as Array<Record<string, unknown>>;
    expect(payload).toContainEqual({
      lineId: 'line-bar',
      quantity: 10,
      unitPrice: 60,
      noBid: false,
      leadTimeDays: 5,
      minimumOrderQuantity: null,
      validUntil: '2026-12-31',
      vendorPartNumber: 'ACME-61',
      notes: 'Price incl. cutting',
    });
  });

  it("keeps a note it never showed, rather than wiping it on save", async () => {
    renderEditor(
      rfqDetail({
        responses: [response({ id: 'x', invitationId: 'inv-beta', lineId: 'line-brush', quantity: 50, unitPrice: 2, notes: 'Box of 50' })],
      }),
    );
    await user.click(screen.getByRole('button', { name: 'Save quote' }));
    await waitFor(() => expect(mockSave).toHaveBeenCalled());
    expect(mockSave.mock.calls[0][1]).toContainEqual(expect.objectContaining({ lineId: 'line-brush', notes: 'Box of 50' }));
  });

  it('a declined vendor gets the reason instead of a grid', () => {
    renderEditor(
      rfqDetail({
        invitations: rfqDetail().invitations.map((i) =>
          i.id === 'inv-beta' ? { ...i, declinedAt: '2026-11-09T10:00:00Z' } : i,
        ),
      }),
    );
    expect(screen.getByText(/declined this RFQ/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save quote' })).toBeNull();
  });

  it('a refusal stays on screen and the dialog stays open', async () => {
    mockSave.mockRejectedValue(new Error('RFQ-0007 is closed. Reopen it first.'));
    renderEditor();
    await user.type(within(section(/Line 1/)).getByLabelText('Price at 10 bar'), '9');
    await user.click(screen.getByRole('button', { name: 'Save quote' }));
    expect(await screen.findByText('RFQ-0007 is closed. Reopen it first.')).toBeInTheDocument();
    expect(onSaved).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});
