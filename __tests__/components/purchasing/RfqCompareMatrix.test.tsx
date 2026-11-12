/**
 * The RFQ comparison and award (criterion Q3).
 *
 * "Lowest" is a WORD on the cell, never colour alone; an expired quote is never Lowest; the award
 * picks one quote per line and makes one draft PO per vendor in a single call, with "Save to price
 * sheets" off unless someone ticks it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import userEvent from '@testing-library/user-event';
import { render, screen, within, waitFor } from '../../test-utils';

const { mockAward, mockCapture } = vi.hoisted(() => ({ mockAward: vi.fn(), mockCapture: vi.fn() }));

vi.mock('@/lib/supabase', () => ({ getSupabase: () => ({}), createClient: () => ({}) }));
vi.mock('posthog-js', () => ({ default: { capture: mockCapture } }));
vi.mock('@/utils/vendorRfqAccess', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/vendorRfqAccess')>()),
  awardVendorRfq: (...a: unknown[]) => mockAward(...a),
}));

import RfqCompareMatrix from '@/components/purchasing/RfqCompareMatrix';
import { TODAY, rfqDetail, response, RESPONSES } from './rfqFixtures';

const onAwarded = vi.fn();

function renderMatrix(rfq = rfqDetail(), readOnly = false) {
  return render(
    <RfqCompareMatrix companyId="test-company-id" rfq={rfq} today={TODAY} readOnly={readOnly} onAwarded={onAwarded} />,
  );
}

/** The table cell for one vendor on one row, found by the row's own label (a row header). */
function cell(rowLabel: RegExp, vendorIndex: number) {
  const row = screen.getByRole('row', { name: rowLabel });
  return within(row).getAllByRole('cell')[vendorIndex];
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('RfqCompareMatrix — reading the quotes (Q3)', () => {
  it('labels the cheapest valid quote "Lowest" in words', () => {
    renderMatrix();
    // Line 1 at 25: only Acme quoted.
    expect(within(cell(/BAR-6061.*25 bar/, 0)).getByText('Lowest')).toBeInTheDocument();
    // The brushes: Acme quoted, Beta said no bid.
    expect(within(cell(/Deburring brushes.*50 ea/, 0)).getByText('Lowest')).toBeInTheDocument();
    expect(within(cell(/Deburring brushes.*50 ea/, 1)).getByText('No bid')).toBeInTheDocument();
  });

  it('never calls an expired quote Lowest, even when it is cheaper', () => {
    renderMatrix();
    const beta = cell(/BAR-6061.*10 bar/, 1);
    expect(within(beta).getByText(/Expired/)).toBeInTheDocument();
    expect(within(beta).queryByText('Lowest')).toBeNull();
    // Acme's dearer but valid quote takes it.
    expect(within(cell(/BAR-6061.*10 bar/, 0)).getByText('Lowest')).toBeInTheDocument();
  });

  it('breaks a price tie on the shorter lead time', () => {
    renderMatrix(
      rfqDetail({
        responses: [
          response({ id: 'a', invitationId: 'inv-acme', lineId: 'line-brush', quantity: 50, unitPrice: 2, leadTimeDays: 9 }),
          response({ id: 'b', invitationId: 'inv-beta', lineId: 'line-brush', quantity: 50, unitPrice: 2, leadTimeDays: 2 }),
        ],
      }),
    );
    expect(within(cell(/Deburring brushes.*50 ea/, 1)).getByText('Lowest')).toBeInTheDocument();
    expect(within(cell(/Deburring brushes.*50 ea/, 0)).queryByText('Lowest')).toBeNull();
  });

  it('shows a vendor that has not answered as waiting, not as a price', () => {
    renderMatrix();
    expect(within(cell(/BAR-6061.*25 bar/, 1)).getByText(/No reply/)).toBeInTheDocument();
  });
});

describe('RfqCompareMatrix — award (Q3)', () => {
  const user = userEvent.setup();

  it('starts with "Save to price sheets" UNticked and nothing chosen', () => {
    renderMatrix();
    expect(screen.getByRole('checkbox', { name: /save .*price sheets/i })).not.toBeChecked();
    expect(screen.getByRole('button', { name: /Create draft POs/i })).toBeDisabled();
  });

  it('counts one draft PO per vendor, and awards by response id in one call', async () => {
    mockAward.mockResolvedValue({
      vendorRfqId: 'rfq-1',
      purchaseOrders: [
        { id: 'po-1', poNumber: 'PO-0042', vendorId: 'v-acme', vendorName: 'Acme Steel', lineIds: ['l1'] },
      ],
      awardedResponseIds: ['r-acme-25', 'r-acme-brush'],
      savedPartVendorIds: [],
      status: 'awarded',
    });
    renderMatrix();

    await user.click(screen.getByRole('radio', { name: /Award line 1 at 25 bar to Acme Steel/i }));
    await user.click(screen.getByRole('radio', { name: /Award line 2 at 50 ea to Acme Steel/i }));
    // Two lines, one vendor: one draft.
    const create = screen.getByRole('button', { name: 'Create draft POs (1)' });
    await user.click(create);

    await waitFor(() =>
      expect(mockAward).toHaveBeenCalledWith('rfq-1', ['r-acme-25', 'r-acme-brush'], {
        saveToPriceSheets: false,
        today: TODAY,
      }),
    );
    // Afterwards: a link to the draft it made.
    const link = await screen.findByRole('link', { name: /PO-0042/ });
    expect(link).toHaveAttribute('href', '/dashboard/test-company-id/purchasing/orders/po-1');
    expect(onAwarded).toHaveBeenCalled();
    expect(mockCapture).toHaveBeenCalledWith('vendor rfq awarded', {
      po_count: 1,
      split_award: false,
      saved_to_price_sheets: false,
    });
  });

  it('a split award makes two drafts, and the price-sheet box is passed through only when ticked', async () => {
    mockAward.mockResolvedValue({
      vendorRfqId: 'rfq-1',
      purchaseOrders: [
        { id: 'po-1', poNumber: 'PO-0042', vendorId: 'v-acme', vendorName: 'Acme Steel', lineIds: ['l1'] },
        { id: 'po-2', poNumber: 'PO-0043', vendorId: 'v-beta', vendorName: 'Beta Metals', lineIds: ['l2'] },
      ],
      awardedResponseIds: ['r-acme-25', 'b'],
      savedPartVendorIds: ['pv-1'],
      status: 'awarded',
    });
    renderMatrix(
      rfqDetail({
        responses: [...RESPONSES.filter((r) => r.lineId === 'line-bar'), response({ id: 'b', invitationId: 'inv-beta', lineId: 'line-brush', quantity: 50, unitPrice: 2 })],
      }),
    );

    await user.click(screen.getByRole('radio', { name: /Award line 1 at 25 bar to Acme Steel/i }));
    await user.click(screen.getByRole('radio', { name: /Award line 2 at 50 ea to Beta Metals/i }));
    await user.click(screen.getByRole('checkbox', { name: /save .*price sheets/i }));
    await user.click(screen.getByRole('button', { name: 'Create draft POs (2)' }));

    await waitFor(() =>
      expect(mockAward).toHaveBeenCalledWith('rfq-1', ['r-acme-25', 'b'], { saveToPriceSheets: true, today: TODAY }),
    );
    expect(await screen.findByRole('link', { name: /PO-0043/ })).toBeInTheDocument();
    expect(mockCapture).toHaveBeenCalledWith('vendor rfq awarded', {
      po_count: 2,
      split_award: true,
      saved_to_price_sheets: true,
    });
  });

  it('warns when the chosen quote has expired, and still lets the shop award it', async () => {
    renderMatrix();
    await user.click(screen.getByRole('radio', { name: /Award line 1 at 10 bar to Beta Metals/i }));
    expect(screen.getByText(/Beta Metals's quote for line 1 expired/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create draft POs (1)' })).toBeEnabled();
  });

  it('a refusal reaches the person as its sentence and nothing claims success', async () => {
    mockAward.mockRejectedValue(new Error('Line 1 is already awarded.'));
    renderMatrix();
    await user.click(screen.getByRole('radio', { name: /Award line 1 at 25 bar to Acme Steel/i }));
    await user.click(screen.getByRole('button', { name: 'Create draft POs (1)' }));
    expect(await screen.findByText('Line 1 is already awarded.')).toBeInTheDocument();
    expect(onAwarded).not.toHaveBeenCalled();
    expect(mockCapture).not.toHaveBeenCalled();
  });

  it('an awarded line says who won it and offers no radios', () => {
    renderMatrix(
      rfqDetail({
        responses: RESPONSES.map((r) => (r.id === 'r-acme-25' ? { ...r, awardedAt: '2026-11-09T10:00:00Z' } : r)),
      }),
    );
    expect(screen.getByText(/Awarded to Acme Steel at 25 bar/)).toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: /Award line 1/i })).toBeNull();
    expect(screen.getByRole('radio', { name: /Award line 2 at 50 ea to Acme Steel/i })).toBeInTheDocument();
  });

  it('read-only (closed or archived): the quotes, and no award controls', () => {
    renderMatrix(rfqDetail(), true);
    expect(screen.getAllByText('Lowest').length).toBeGreaterThan(0);
    expect(screen.queryByRole('radio')).toBeNull();
    expect(screen.queryByRole('button', { name: /Create draft POs/i })).toBeNull();
  });
});
