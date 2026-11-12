/**
 * The vendor page's Purchase orders card (plan §3.13 "Elsewhere", criterion UI-46): this vendor's
 * OPEN POs, each a link, read from the same view as the hub's list. A failed read offers Retry and
 * never reads as "no open POs" — that answer is how a second PO to the same vendor gets raised.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import userEvent from '@testing-library/user-event';
import { render, screen } from '../../test-utils';

vi.mock('@/utils/vendorPoAccess', () => ({ listVendorPosForVendor: vi.fn() }));

import VendorPurchaseOrdersCard from '@/components/vendors/VendorPurchaseOrdersCard';
import { listVendorPosForVendor } from '@/utils/vendorPoAccess';
import { todayLocalISODate } from '@/lib/localDate';
import type { VendorPoListRow } from '@/types/vendorPo';

const po = (over: Partial<VendorPoListRow> = {}): VendorPoListRow => ({
  id: 'po-1042',
  companyId: 'co1',
  poNumber: 'PO-1042',
  vendorId: 'v1',
  vendorName: 'Acme Steel',
  status: 'sent',
  orderedOn: '2026-03-01',
  needByOn: '2026-03-09',
  nextExpectedOn: '2026-03-09',
  isLate: false,
  revision: 0,
  sentRevision: 0,
  hasUnsentChanges: false,
  issuedAt: '2026-03-01T15:00:00Z',
  lastSentAt: '2026-03-01T15:00:00Z',
  closedAt: null,
  lineCount: 2,
  outstandingLineCount: 2,
  orderedAmount: 1234.5,
  openAmount: 1000,
  hasUnpricedLines: false,
  quickbooksState: 'not_sent',
  jobIds: [],
  jobNumbers: [],
  vendorRfqId: null,
  createdAt: '2026-03-01T14:00:00Z',
  updatedAt: '2026-03-01T15:00:00Z',
  isArchived: false,
  ...over,
});

const draw = () => render(<VendorPurchaseOrdersCard companyId="co1" vendorId="v1" vendorName="Acme Steel" />);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listVendorPosForVendor).mockResolvedValue({ rows: [po()], total: 1, truncated: false });
});

describe('VendorPurchaseOrdersCard', () => {
  it('lists the vendor’s open POs, each a link to it', async () => {
    draw();
    expect(await screen.findByRole('link', { name: 'PO-1042' })).toHaveAttribute(
      'href',
      '/dashboard/co1/purchasing/orders/po-1042',
    );
    expect(screen.getByText('Sent')).toBeInTheDocument();
    expect(screen.getByText(/\$1,000\.00 open/)).toBeInTheDocument();
    expect(listVendorPosForVendor).toHaveBeenCalledWith(
      'v1',
      expect.objectContaining({ today: todayLocalISODate(), statuses: ['draft', 'sent', 'partially_received'] }),
    );
  });

  it('flags an overdue PO in words', async () => {
    vi.mocked(listVendorPosForVendor).mockResolvedValue({ rows: [po({ isLate: true })], total: 1, truncated: false });
    draw();
    expect(await screen.findByText(/overdue/i)).toBeInTheDocument();
  });

  it('says when there are none', async () => {
    vi.mocked(listVendorPosForVendor).mockResolvedValue({ rows: [], total: 0, truncated: false });
    draw();
    expect(await screen.findByText(/no open purchase orders to Acme Steel/i)).toBeInTheDocument();
  });

  it('offers a new PO to this vendor', async () => {
    draw();
    expect(await screen.findByRole('link', { name: /new po/i })).toHaveAttribute(
      'href',
      '/dashboard/co1/purchasing/orders/new?vendor=v1',
    );
  });

  it('says when it shows only some, and links to them all', async () => {
    vi.mocked(listVendorPosForVendor).mockResolvedValue({ rows: [po()], total: 14, truncated: true });
    draw();
    expect(await screen.findByText(/showing 1 of 14/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /see all/i })).toHaveAttribute(
      'href',
      '/dashboard/co1/purchasing?view=orders&vendor=v1',
    );
  });

  it('offers Retry on a failed read, and never says "none"', async () => {
    vi.mocked(listVendorPosForVendor).mockRejectedValueOnce(new Error('Failed to load purchase orders.'));
    draw();
    expect(await screen.findByText(/couldn't load the purchase orders/i)).toBeInTheDocument();
    expect(screen.queryByText(/no open purchase orders/i)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(await screen.findByRole('link', { name: 'PO-1042' })).toBeInTheDocument();
  });
});
