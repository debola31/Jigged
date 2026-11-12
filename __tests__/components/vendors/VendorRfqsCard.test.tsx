/**
 * The vendor page's RFQs card (plan §3.13 "Elsewhere"): the RFQs this vendor was asked on, each a
 * link. `listVendorRfqs` carries each RFQ's invited vendors by name, so the card keeps the ones
 * naming this vendor. A failed read offers Retry and never reads as "never asked".
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

const draw = () => render(<VendorRfqsCard companyId="co1" vendorName="Acme Steel" />);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listVendorRfqs).mockResolvedValue({
    rows: [rfq(), rfq({ id: 'rfq-2', rfqNumber: 'RFQ-0002', vendorNames: ['Beta Supply'] })],
    total: 2,
    truncated: false,
  });
});

describe('VendorRfqsCard', () => {
  it('lists the RFQs this vendor was asked on — and only those — each a link', async () => {
    draw();
    expect(await screen.findByRole('link', { name: 'RFQ-0001' })).toHaveAttribute(
      'href',
      '/dashboard/co1/purchasing/rfqs/rfq-1',
    );
    expect(screen.queryByRole('link', { name: 'RFQ-0002' })).not.toBeInTheDocument();
    expect(screen.getByText('Quoted')).toBeInTheDocument();
    expect(screen.getByText(/Bar stock for Q2/)).toBeInTheDocument();
    expect(listVendorRfqs).toHaveBeenCalledWith('co1', expect.anything());
  });

  it('says when the vendor has never been asked', async () => {
    vi.mocked(listVendorRfqs).mockResolvedValue({ rows: [rfq({ vendorNames: ['Beta Supply'] })], total: 1, truncated: false });
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
