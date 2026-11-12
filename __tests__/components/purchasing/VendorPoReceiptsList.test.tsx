/**
 * The Receipts tab — every receipt on a live PO, for the bookkeeper's month end (plan §3.7,
 * criterion R6): by date range, vendor, PO and packing slip, newest first.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import userEvent from '@testing-library/user-event';
import { render, screen, waitFor, routerMocks, resetRouterMocks, setSearchParams } from '../../test-utils';
import type { VendorPoReceiptListRow } from '@/types/vendorPo';

const listVendorPoReceipts = vi.fn();
vi.mock('@/utils/vendorPoAccess', () => ({
  listVendorPoReceipts: (...args: unknown[]) => listVendorPoReceipts(...args),
}));
const getAllVendors = vi.fn();
vi.mock('@/utils/vendorsAccess', () => ({
  getAllVendors: (...args: unknown[]) => getAllVendors(...args),
}));

import VendorPoReceiptsList, { dayRangeToInstants } from '@/components/purchasing/VendorPoReceiptsList';

function receipt(over: Partial<VendorPoReceiptListRow> = {}): VendorPoReceiptListRow {
  return {
    id: 'r1',
    vendorPurchaseOrderLineId: 'l1',
    lineNumber: 1,
    lineKind: 'part',
    receiptGroupId: 'g1',
    entryIndex: 0,
    quantity: 2,
    unit: 'bar',
    stockQuantity: 288,
    stockUnit: 'inches',
    partId: 'p1',
    locationId: 'loc1',
    locationName: 'Rack A',
    lotId: 'lot1',
    lotCode: 'H4471',
    heatNumber: 'H4471',
    startedTracking: false,
    inventoryTransactionId: 't1',
    voidTransactionId: null,
    vendorPackingSlip: 'PS-88',
    notes: null,
    receivedAt: '2026-11-03T15:00:00Z',
    receivedByName: null,
    voidedAt: null,
    voidReason: null,
    vendorPurchaseOrderId: 'po-1',
    poNumber: 'PO-1042',
    vendorId: 'v1',
    vendorName: 'Acme Steel',
    partName: '6061 bar 1in',
    description: '6061-T6 round bar, 1 in',
    ...over,
  };
}

const lastFilters = () => listVendorPoReceipts.mock.calls[listVendorPoReceipts.mock.calls.length - 1][1];

beforeEach(() => {
  vi.clearAllMocks();
  resetRouterMocks();
  setSearchParams();
  listVendorPoReceipts.mockResolvedValue({ rows: [receipt()], total: 1, truncated: false });
  getAllVendors.mockResolvedValue([{ id: 'v1', company_id: 'c', name: 'Acme Steel', created_at: '', updated_at: '' }]);
});

describe('VendorPoReceiptsList', () => {
  it('lists each receipt with its PO, vendor, line, quantity in the unit typed, place, heat and slip', async () => {
    render(<VendorPoReceiptsList companyId="test-company-id" />);
    expect(await screen.findByRole('link', { name: 'PO-1042' })).toHaveAttribute(
      'href',
      '/dashboard/test-company-id/purchasing/orders/po-1',
    );
    expect(screen.getByText('Acme Steel')).toBeInTheDocument();
    expect(screen.getByText(/2 bar/)).toBeInTheDocument();
    expect(screen.getByText('= 288 in')).toBeInTheDocument();
    expect(screen.getByText('Rack A')).toBeInTheDocument();
    expect(screen.getByText('H4471')).toBeInTheDocument();
    expect(screen.getByText('PS-88')).toBeInTheDocument();
    expect(listVendorPoReceipts).toHaveBeenCalledWith('test-company-id', expect.objectContaining({ includeVoided: false }));
  });

  it('turns a date range into the instants the read takes: from local midnight, before the day after', () => {
    const { receivedFrom, receivedBefore } = dayRangeToInstants('2026-11-01', '2026-11-30');
    expect(receivedFrom).toBe(new Date(2026, 10, 1).toISOString());
    expect(receivedBefore).toBe(new Date(2026, 11, 1).toISOString());
    expect(dayRangeToInstants('', '')).toEqual({ receivedFrom: null, receivedBefore: null });
  });

  it('takes its filters from the URL', async () => {
    setSearchParams({ from: '2026-11-01', to: '2026-11-30', vendor: 'v1', po: 'po-1', slip: 'PS', voided: 'true' });
    render(<VendorPoReceiptsList companyId="test-company-id" />);
    await waitFor(() => expect(listVendorPoReceipts).toHaveBeenCalled());
    expect(lastFilters()).toMatchObject({
      receivedFrom: new Date(2026, 10, 1).toISOString(),
      receivedBefore: new Date(2026, 11, 1).toISOString(),
      vendorId: 'v1',
      vendorPurchaseOrderId: 'po-1',
      packingSlip: 'PS',
      includeVoided: true,
    });
  });

  it('writes a filter into the URL with router.replace', async () => {
    const user = userEvent.setup();
    render(<VendorPoReceiptsList companyId="test-company-id" />);
    await screen.findByText('PS-88');
    await user.click(screen.getByRole('checkbox', { name: /show voided/i }));
    expect(routerMocks.replace).toHaveBeenCalledWith('?voided=true', { scroll: false });
    await waitFor(() => expect(lastFilters()).toMatchObject({ includeVoided: true }));
  });

  it('marks a voided receipt in words', async () => {
    listVendorPoReceipts.mockResolvedValue({
      rows: [receipt({ voidedAt: '2026-11-04T10:00:00Z' })],
      total: 1,
      truncated: false,
    });
    render(<VendorPoReceiptsList companyId="test-company-id" />);
    expect(await screen.findByText('Voided')).toBeInTheDocument();
  });

  it('a failed load offers Retry, not "no receipts"', async () => {
    listVendorPoReceipts.mockRejectedValueOnce(new Error('Failed to load the receipts.'));
    render(<VendorPoReceiptsList companyId="test-company-id" />);
    expect(await screen.findByText(/couldn.t load receipts/i)).toBeInTheDocument();
    expect(screen.queryByText(/no receipts/i)).not.toBeInTheDocument();
  });

  it('says when nothing has been received yet, and when the filters match nothing', async () => {
    listVendorPoReceipts.mockResolvedValue({ rows: [], total: 0, truncated: false });
    const { unmount } = render(<VendorPoReceiptsList companyId="test-company-id" />);
    expect(await screen.findByText('No receipts yet')).toBeInTheDocument();
    unmount();

    setSearchParams({ slip: 'nothing' });
    render(<VendorPoReceiptsList companyId="test-company-id" />);
    expect(await screen.findByText('No receipts match these filters.')).toBeInTheDocument();
  });

  it('says how many it is showing when the page is capped', async () => {
    listVendorPoReceipts.mockResolvedValue({ rows: [receipt()], total: 1200, truncated: true });
    render(<VendorPoReceiptsList companyId="test-company-id" />);
    expect(await screen.findByText(/showing the newest 1 of 1,200/i)).toBeInTheDocument();
  });
});
