/**
 * The hub's RFQs tab: number · status · vendors · replies (n of m) · respond-by, with an empty
 * state that is not mistaken for a failure, and a failure that is not mistaken for "none yet".
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import userEvent from '@testing-library/user-event';
import { render, screen, within } from '../../test-utils';

const { mockList } = vi.hoisted(() => ({ mockList: vi.fn() }));

vi.mock('@/lib/supabase', () => ({ getSupabase: () => ({}), createClient: () => ({}) }));
vi.mock('@/utils/vendorRfqAccess', () => ({ listVendorRfqs: (...a: unknown[]) => mockList(...a) }));

import { RfqList } from '@/components/purchasing/RfqList';
import type { VendorRfqListRow } from '@/types/vendorRfq';

function row(over: Partial<VendorRfqListRow>): VendorRfqListRow {
  return {
    id: 'rfq-1',
    rfqNumber: 'RFQ-0001',
    title: null,
    status: 'draft',
    neededByOn: null,
    respondByOn: null,
    closedAt: null,
    lineCount: 1,
    awardedLineCount: 0,
    invitedCount: 0,
    sentCount: 0,
    declinedCount: 0,
    respondedCount: 0,
    vendorNames: [],
    createdAt: '2026-11-01T00:00:00Z',
    updatedAt: '2026-11-01T00:00:00Z',
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('RfqList', () => {
  it('lists each RFQ with its status, vendors, replies and respond-by date', async () => {
    mockList.mockResolvedValue({
      rows: [
        row({
          id: 'rfq-7',
          rfqNumber: 'RFQ-0007',
          title: 'Bar stock',
          status: 'quoted',
          respondByOn: '2026-11-20',
          invitedCount: 3,
          sentCount: 3,
          respondedCount: 2,
          declinedCount: 1,
          vendorNames: ['Acme Steel', 'Beta Metals', 'Zeta Supply'],
        }),
      ],
      total: 1,
      truncated: false,
    });
    render(<RfqList companyId="c1" />);

    const link = await screen.findByRole('link', { name: 'RFQ-0007' });
    expect(link).toHaveAttribute('href', '/dashboard/c1/purchasing/rfqs/rfq-7');
    const r = screen.getByRole('row', { name: /RFQ-0007/ });
    expect(within(r).getByText('Quoted')).toBeInTheDocument();
    expect(within(r).getByText('Acme Steel, Beta Metals, Zeta Supply')).toBeInTheDocument();
    expect(within(r).getByText(/2 of 3/)).toBeInTheDocument();
    expect(within(r).getByText(/1 declined/)).toBeInTheDocument();
    expect(within(r).getByText('Bar stock')).toBeInTheDocument();
    expect(mockList).toHaveBeenCalledWith('c1');
  });

  it('puts the RFQs still waiting on vendors first, soonest respond-by first', async () => {
    mockList.mockResolvedValue({
      rows: [
        row({ id: 'a', rfqNumber: 'RFQ-0003', status: 'awarded' }),
        row({ id: 'b', rfqNumber: 'RFQ-0002', status: 'sent', respondByOn: '2026-12-01' }),
        row({ id: 'c', rfqNumber: 'RFQ-0001', status: 'sent', respondByOn: '2026-11-15' }),
      ],
      total: 3,
      truncated: false,
    });
    render(<RfqList companyId="c1" />);
    await screen.findByRole('link', { name: 'RFQ-0001' });
    const numbers = screen.getAllByRole('link', { name: /^RFQ-/ }).map((a) => a.textContent);
    expect(numbers).toEqual(['RFQ-0001', 'RFQ-0002', 'RFQ-0003']);
  });

  it('has a New RFQ button', async () => {
    mockList.mockResolvedValue({ rows: [], total: 0, truncated: false });
    render(<RfqList companyId="c1" />);
    expect(await screen.findByRole('link', { name: /New RFQ/ })).toHaveAttribute('href', '/dashboard/c1/purchasing/rfqs/new');
  });

  it('says plainly when there are none yet', async () => {
    mockList.mockResolvedValue({ rows: [], total: 0, truncated: false });
    render(<RfqList companyId="c1" />);
    expect(await screen.findByText('No RFQs yet')).toBeInTheDocument();
    expect(screen.queryByText(/Couldn't load/)).toBeNull();
  });

  it('a failed load offers Try Again, never the empty state', async () => {
    const user = userEvent.setup();
    mockList.mockRejectedValueOnce(new Error('Failed to load the RFQs.'));
    mockList.mockResolvedValueOnce({ rows: [row({ rfqNumber: 'RFQ-0009', id: 'r9' })], total: 1, truncated: false });
    render(<RfqList companyId="c1" />);
    expect(await screen.findByText(/Couldn't load RFQs/)).toBeInTheDocument();
    expect(screen.queryByText('No RFQs yet')).toBeNull();
    await user.click(screen.getByRole('button', { name: /Try Again/ }));
    expect(await screen.findByRole('link', { name: 'RFQ-0009' })).toBeInTheDocument();
  });

  it('says when the list is capped', async () => {
    mockList.mockResolvedValue({ rows: [row({})], total: 250, truncated: true });
    render(<RfqList companyId="c1" />);
    expect(await screen.findByText(/Showing the 1 newest of 250 RFQs/)).toBeInTheDocument();
  });
});
