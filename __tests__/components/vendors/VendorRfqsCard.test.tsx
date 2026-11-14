/**
 * The vendor page's RFQs card (plan §3.13 "Elsewhere"): the RFQs this vendor was asked on, each a
 * link. They are read through `listVendorRfqs` with its `vendorId` filter — by id, through the
 * invitations — so an RFQ sent before the vendor was renamed still lists. A failed read offers
 * Retry and never reads as "never asked".
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import userEvent from '@testing-library/user-event';
import { render, screen } from '../../test-utils';

vi.mock('@/utils/vendorRfqAccess', () => ({ listVendorRfqs: vi.fn() }));

import VendorRfqsCard from '@/components/vendors/VendorRfqsCard';
import { listVendorRfqs } from '@/utils/vendorRfqAccess';
import type { VendorRfqListRow } from '@/types/vendorRfq';

const rfq = (over: Partial<VendorRfqListRow> = {}): VendorRfqListRow => ({
  id: 'rfq-1',
  rfqNumber: 'RFQ-0001',
  title: 'Bar stock for Q2',
  status: 'quoted',
  neededByOn: null,
  respondByOn: '2026-03-15',
  closedAt: null,
  lineCount: 2,
  awardedLineCount: 0,
  invitedCount: 2,
  sentCount: 2,
  declinedCount: 0,
  respondedCount: 1,
  vendorNames: ['Acme Steel', 'Beta Supply'],
  createdAt: '2026-03-01T14:00:00Z',
  updatedAt: '2026-03-01T15:00:00Z',
  ...over,
});

const draw = () => render(<VendorRfqsCard companyId="co1" vendorId="v-acme" vendorName="Acme Steel" />);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listVendorRfqs).mockResolvedValue({ rows: [rfq()], total: 1, truncated: false });
});

describe('VendorRfqsCard', () => {
  it('asks for this vendor’s RFQs by id, and lists each as a link', async () => {
    draw();
    expect(await screen.findByRole('link', { name: 'RFQ-0001' })).toHaveAttribute(
      'href',
      '/dashboard/co1/purchasing/rfqs/rfq-1',
    );
    expect(screen.getByText('Quoted')).toBeInTheDocument();
    expect(screen.getByText(/Bar stock for Q2/)).toBeInTheDocument();
    expect(listVendorRfqs).toHaveBeenCalledWith('co1', { vendorId: 'v-acme', limit: 10 });
  });

  /** The invitation's copy of the name is the old one; finding by id is what keeps it listed. */
  it('lists an RFQ that names the vendor by an old name', async () => {
    vi.mocked(listVendorRfqs).mockResolvedValue({
      rows: [rfq({ id: 'rfq-7', rfqNumber: 'RFQ-0007', vendorNames: ['Acme Steel Co (before the rename)'] })],
      total: 1,
      truncated: false,
    });
    draw();
    expect(await screen.findByRole('link', { name: 'RFQ-0007' })).toBeInTheDocument();
  });

  it('says how many there are when it shows only the newest', async () => {
    vi.mocked(listVendorRfqs).mockResolvedValue({
      rows: Array.from({ length: 10 }, (_, i) => rfq({ id: `rfq-${i}`, rfqNumber: `RFQ-00${i}` })),
      total: 14,
      truncated: true,
    });
    draw();
    expect(await screen.findByText('Showing 10 of 14.')).toBeInTheDocument();
  });

  it('says when the vendor has never been asked', async () => {
    vi.mocked(listVendorRfqs).mockResolvedValue({ rows: [], total: 0, truncated: false });
    draw();
    expect(await screen.findByText(/no RFQs have gone to Acme Steel/i)).toBeInTheDocument();
  });

  it('offers Retry on a failed read, and never says "never asked"', async () => {
    vi.mocked(listVendorRfqs).mockRejectedValueOnce(new Error('Failed to load the RFQs.'));
    draw();
    expect(await screen.findByText(/couldn't load the RFQs/i)).toBeInTheDocument();
    expect(screen.queryByText(/no RFQs have gone/i)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(await screen.findByRole('link', { name: 'RFQ-0001' })).toBeInTheDocument();
  });
});
