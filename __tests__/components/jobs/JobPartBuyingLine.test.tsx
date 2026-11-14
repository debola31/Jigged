/**
 * A bought part on a job, and the job's vendor POs (plan §3.13 "Elsewhere", criterion B4).
 *
 * A bought job part is `completed` the moment the job exists, so its production status says
 * nothing about whether anyone ordered it. This line is where the job page says so — and the one
 * thing it must never do is read a failed lookup as "Not on a purchase order", which invites a
 * second PO for a part already on one.
 */
import { describe, it, expect, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { render, screen } from '../../test-utils';

import JobPartBuyingLine, { JobVendorPosSummary, noOperationsSlot } from '@/components/jobs/JobPartBuyingLine';
import type { VendorPoJobLine } from '@/types/vendorPo';

const line = (over: Partial<VendorPoJobLine> = {}): VendorPoJobLine => ({
  lineId: 'line-1',
  vendorPurchaseOrderId: 'po-1042',
  poNumber: 'PO-1042',
  poStatus: 'partially_received',
  vendorId: 'acme',
  vendorName: 'Acme Steel',
  lineNumber: 1,
  lineKind: 'part',
  partId: 'pump',
  partName: 'PUMP-200',
  description: 'PUMP-200',
  jobPartId: 'jp-pump',
  jobOperationId: null,
  operationLabel: null,
  quantity: 100,
  unit: 'each',
  receivedQuantity: 40,
  openQuantity: 60,
  status: 'partially_received',
  needByOn: '2026-03-04',
  expectedOn: '2026-03-04',
  isLate: false,
  ...over,
});

const draw = (lines: VendorPoJobLine[] | null, over: Partial<Parameters<typeof JobPartBuyingLine>[0]> = {}) =>
  render(<JobPartBuyingLine companyId="co1" jobId="job-7" partId="pump" jobPartId="jp-pump" lines={lines} canBuy {...over} />);

describe('JobPartBuyingLine', () => {
  it('reads the PO, the vendor, what has come in and when the rest is due', () => {
    draw([line()]);
    expect(screen.getByTestId('job-part-buying-line')).toHaveTextContent(
      'Bought · PO-1042 (Acme Steel) · 40 of 100 ea received · due 3/4/26',
    );
    expect(screen.getByRole('link', { name: 'PO-1042' })).toHaveAttribute(
      'href',
      '/dashboard/co1/purchasing/orders/po-1042',
    );
  });

  it('marks a late line Overdue, in words', () => {
    draw([line({ isLate: true })]);
    expect(screen.getByText(/overdue/i)).toBeInTheDocument();
  });

  it('says a draft has not gone to the vendor yet', () => {
    draw([line({ status: 'draft', poStatus: 'draft', receivedQuantity: 0, openQuantity: 0 })]);
    expect(screen.getByTestId('job-part-buying-line')).toHaveTextContent('Draft PO-1042 (Acme Steel) · not sent yet');
  });

  it('says a line closed short is closed', () => {
    draw([line({ status: 'closed', openQuantity: 0 })]);
    expect(screen.getByTestId('job-part-buying-line')).toHaveTextContent('40 of 100 ea received · closed short');
  });

  it('lists each PO line for the part, and only this part’s', () => {
    draw([
      line(),
      line({ lineId: 'line-2', vendorPurchaseOrderId: 'po-1050', poNumber: 'PO-1050', vendorName: 'Beta Supply' }),
      line({ lineId: 'line-3', jobPartId: 'jp-other', poNumber: 'PO-1060' }),
      line({ lineId: 'line-4', lineKind: 'outside_service', jobPartId: 'jp-pump', poNumber: 'PO-1070' }),
    ]);
    expect(screen.getByRole('link', { name: 'PO-1042' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'PO-1050' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'PO-1060' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'PO-1070' })).not.toBeInTheDocument();
  });

  /** The form starts a part line only when given the PART: a job part alone opened a blank form. */
  it('offers "Buy it" when the part is on no purchase order, carrying the part, its job and the job part', () => {
    draw([line({ jobPartId: 'jp-other' })]);
    expect(screen.getByText(/not on a purchase order/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /buy it/i })).toHaveAttribute(
      'href',
      '/dashboard/co1/purchasing/orders/new?part=pump&job=job-7&jobPart=jp-pump',
    );
  });

  it('does not offer "Buy it" once there is nothing left to buy for', () => {
    draw([], { canBuy: false });
    expect(screen.getByText(/not on a purchase order/i)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /buy it/i })).not.toBeInTheDocument();
  });

  it('never reads a failed lookup as "Not on a purchase order"', async () => {
    const onRetry = vi.fn();
    draw(null, { onRetry });
    expect(screen.queryByText(/not on a purchase order/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /buy it/i })).not.toBeInTheDocument();
    expect(screen.getByText(/couldn't check its purchase orders/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});

describe('JobVendorPosSummary — the "Vendor POs" row in Job Details', () => {
  it('renders nothing when the job is on no vendor PO', () => {
    const { container } = render(<JobVendorPosSummary companyId="co1" lines={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing while the lines are unknown — the buying line carries that error', () => {
    const { container } = render(<JobVendorPosSummary companyId="co1" lines={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('lists each PO once, as a link, with its vendor', () => {
    render(
      <JobVendorPosSummary
        companyId="co1"
        lines={[
          line(),
          line({ lineId: 'line-2', lineNumber: 2 }),
          line({ lineId: 'line-3', vendorPurchaseOrderId: 'po-1050', poNumber: 'PO-1050', vendorName: 'Beta Supply', lineKind: 'outside_service' }),
        ]}
      />,
    );
    expect(screen.getByText('Vendor POs')).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'PO-1042' })).toHaveLength(1);
    expect(screen.getByRole('link', { name: 'PO-1050' })).toHaveAttribute(
      'href',
      '/dashboard/co1/purchasing/orders/po-1050',
    );
    expect(screen.getByText(/Beta Supply/)).toBeInTheDocument();
  });
});

describe('noOperationsSlot — what sits under a part with no operations', () => {
  const base = { jobPartId: 'jp-pump', partSource: 'bought', lines: [] as VendorPoJobLine[], pending: false };

  it('gives a bought part its buying line', () => {
    expect(noOperationsSlot(base)).toBe('buying');
  });

  it('gives a made part on a vendor PO its buying line too — bought whole from a subcontractor', () => {
    expect(noOperationsSlot({ ...base, partSource: 'made', lines: [line()] })).toBe('buying');
  });

  it('keeps the old sentence for a made part on no PO', () => {
    expect(noOperationsSlot({ ...base, partSource: 'made' })).toBe('plain');
  });

  it('shows nothing yet while a read it depends on is in flight', () => {
    expect(noOperationsSlot({ ...base, lines: null, pending: true })).toBe('pending');
  });

  it('still names a part already on a PO while the other read finishes', () => {
    expect(noOperationsSlot({ ...base, partSource: undefined, lines: [line()], pending: true })).toBe('buying');
  });

  /** So the line can say "Couldn't check its purchase orders" with Retry, not "No operations". */
  it('gives a bought part its line when the PO lines could not be read', () => {
    expect(noOperationsSlot({ ...base, lines: null })).toBe('buying');
  });

  it('falls back to the old sentence when the part’s source could not be read', () => {
    expect(noOperationsSlot({ ...base, partSource: undefined })).toBe('plain');
  });
});
