/**
 * The operations panel's outside-processing wiring with vendor POs (plan §3.6, criteria O1/O4).
 *
 * The page reads the job's vendor PO lines once and hands them down. The panel turns them into
 * the card's caption ("PO-1042 · due …" or "Create PO"), the send dialog's read-only line, the
 * `has_po_line` shape on `outside shipment created`, and — after a receipt — the optional close of
 * the slip's PO line. Unknown lines must produce none of it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import userEvent from '@testing-library/user-event';
import { render, screen, waitFor, within } from '../../test-utils';

vi.mock('posthog-js', () => ({ default: { capture: vi.fn() } }));
vi.mock('@/utils/jobsAccess', () => ({ completeJobOperation: vi.fn(), undoJobOperation: vi.fn() }));
vi.mock('@/utils/outsideShipmentsAccess', () => ({
  createOutsideShipment: vi.fn(),
  getOpenOutsideShipments: vi.fn(),
  getOutsideSummariesForPart: vi.fn(),
  receiveOutsideOperation: vi.fn(),
  receiveOutsideShipment: vi.fn(),
  undoLastOutsideMovement: vi.fn(),
  resolveVendorShipTo: vi.fn(async () => ({ address: null, choices: [], requiresChoice: false })),
}));
vi.mock('@/utils/operationCompletionsAccess', () => ({
  CompletionConflictError: class CompletionConflictError extends Error {},
  getOperationCompletionSummaries: vi.fn(async () => []),
}));
vi.mock('@/utils/operationIntervalsAccess', () => ({ getOperationActuals: vi.fn(async () => new Map()) }));
vi.mock('@/components/outsideShipments', () => ({ OutsideShipmentPreviewDialog: () => null }));
vi.mock('@/utils/vendorPoAccess', () => ({ closeVendorPoLines: vi.fn() }));

import posthog from 'posthog-js';
import OperationsPanel from '@/components/jobs/OperationsPanel';
import {
  createOutsideShipment,
  getOpenOutsideShipments,
  getOutsideSummariesForPart,
  receiveOutsideShipment,
} from '@/utils/outsideShipmentsAccess';
import { closeVendorPoLines } from '@/utils/vendorPoAccess';
import type { Job, JobOperation } from '@/types/job';
import type { OutsideOperationSummary } from '@/types/outsideShipment';
import type { VendorPoJobLine } from '@/types/vendorPo';

const job = { id: 'job-1', company_id: 'co1', job_number: 'J-1042', production_status: 'in_progress' } as Job;

const anodize = {
  id: 'op-1',
  job_id: 'job-1',
  job_part_id: 'jp-1',
  sequence: 30,
  operation_name: 'Anodize',
  status: 'pending',
  instructions: null,
  vendor_service_id: 'vs-1',
  vendor_service: { id: 'vs-1', name: 'Anodize', unit_price: null, vendor: { id: 'v1', name: 'ProFinish' } },
  work_center: null,
  estimated_setup_minutes: 0,
  estimated_run_minutes_per_unit: 0,
} as unknown as JobOperation;

const ledger = (over: Partial<OutsideOperationSummary> = {}): OutsideOperationSummary => ({
  job_operation_id: 'op-1',
  qty_ordered: 100,
  qty_sent: 0,
  qty_good: 0,
  qty_at_vendor: 0,
  qty_to_send: 100,
  oldest_open_shipped_at: null,
  earliest_due_back_on: null,
  open_slip_count: 0,
  ...over,
});

const line: VendorPoJobLine = {
  lineId: 'line-2',
  vendorPurchaseOrderId: 'po-1042',
  poNumber: 'PO-1042',
  poStatus: 'sent',
  vendorId: 'v1',
  vendorName: 'ProFinish',
  lineNumber: 2,
  lineKind: 'outside_service',
  partId: null,
  partName: null,
  description: 'Anodize — BRACKET-A — Job J-1042, Op 30',
  jobPartId: 'jp-1',
  jobOperationId: 'op-1',
  operationLabel: 'Op 30 Anodize',
  quantity: 100,
  unit: 'each',
  receivedQuantity: 0,
  openQuantity: 100,
  status: 'open',
  expectedOn: '2026-03-09',
  isLate: false,
};

const draw = (vendorPoLines: VendorPoJobLine[] | null | undefined) =>
  render(
    <OperationsPanel
      job={job}
      operations={[anodize]}
      onOperationUpdate={vi.fn()}
      partName="BRACKET-A"
      vendorPoLines={vendorPoLines}
    />,
  );

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getOutsideSummariesForPart).mockResolvedValue([ledger()]);
  vi.mocked(createOutsideShipment).mockResolvedValue({ shipmentId: 's-new', slipNumber: 'VPS-1042-1' });
});

describe('OperationsPanel — outside steps on a vendor PO', () => {
  it('names the PO on the card, and sends against it with Due back from the line', async () => {
    const user = userEvent.setup();
    draw([line]);

    expect(await screen.findByRole('link', { name: 'PO-1042' })).toHaveAttribute(
      'href',
      '/dashboard/co1/purchasing/orders/po-1042',
    );
    await user.click(await screen.findByRole('button', { name: /send to profinish/i }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('link', { name: /PO-1042 line 2/i })).toBeInTheDocument();
    expect(within(dialog).getByLabelText(/due back/i)).toHaveValue('2026-03-09');

    await user.click(within(dialog).getByRole('button', { name: /send & print slip/i }));
    await waitFor(() => expect(createOutsideShipment).toHaveBeenCalledTimes(1));
    expect(createOutsideShipment).toHaveBeenCalledWith(
      expect.objectContaining({ jobOperationId: 'op-1', quantity: 100, dueBackOn: '2026-03-09' }),
    );
    expect(posthog.capture).toHaveBeenCalledWith(
      'outside shipment created',
      expect.objectContaining({ surface: 'office', has_po_line: true }),
    );
  });

  /** With a batch already out, `expectedOn` is that batch's promise — not the line's need-by. */
  it('leaves Due back empty when part of the step is already at the vendor', async () => {
    const user = userEvent.setup();
    vi.mocked(getOutsideSummariesForPart).mockResolvedValue([
      ledger({ qty_sent: 50, qty_at_vendor: 50, qty_to_send: 50, open_slip_count: 1 }),
    ]);
    draw([{ ...line, expectedOn: '2026-03-02' }]);

    await user.click(await screen.findByRole('button', { name: /send to profinish/i }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText(/due back/i)).toHaveValue('');
  });

  it('offers "Create PO" for a step on no PO, and reports the send as off-PO', async () => {
    const user = userEvent.setup();
    draw([]);

    expect(await screen.findByRole('link', { name: /create po/i })).toHaveAttribute(
      'href',
      '/dashboard/co1/purchasing/orders/new?jobOperation=op-1',
    );
    await user.click(await screen.findByRole('button', { name: /send to profinish/i }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: /send & print slip/i }));
    await waitFor(() =>
      expect(posthog.capture).toHaveBeenCalledWith(
        'outside shipment created',
        expect.objectContaining({ has_po_line: false }),
      ),
    );
  });

  it('says nothing about POs while the lines are unknown — and reports the send as unknown, not off-PO', async () => {
    const user = userEvent.setup();
    draw(null);
    expect(await screen.findByRole('button', { name: /send to profinish/i })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /PO-/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /create po/i })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /send to profinish/i }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: /send & print slip/i }));
    await waitFor(() =>
      expect(posthog.capture).toHaveBeenCalledWith(
        'outside shipment created',
        expect.objectContaining({ has_po_line: null }),
      ),
    );
  });

  it('closes the slip’s PO line after the receipt when asked', async () => {
    const user = userEvent.setup();
    vi.mocked(getOutsideSummariesForPart).mockResolvedValue([
      ledger({ qty_sent: 50, qty_at_vendor: 50, qty_to_send: 50, open_slip_count: 1 }),
    ]);
    vi.mocked(getOpenOutsideShipments).mockResolvedValue([
      {
        id: 's1',
        slip_number: 'VPS-1042-1',
        shipped_at: '2026-03-01T12:00:00Z',
        outstanding: 50,
        vendor_purchase_order_line_id: 'line-2',
        vendor_purchase_order_line: {
          id: 'line-2',
          line_number: 2,
          vendor_purchase_order_id: 'po-1042',
          vendor_purchase_order: { id: 'po-1042', po_number: 'PO-1042' },
        },
      },
    ] as unknown as Awaited<ReturnType<typeof getOpenOutsideShipments>>);
    vi.mocked(receiveOutsideShipment).mockResolvedValue({ receiptId: 'r1' });
    vi.mocked(closeVendorPoLines).mockResolvedValue({} as Awaited<ReturnType<typeof closeVendorPoLines>>);
    draw([line]);

    await user.click(await screen.findByRole('button', { name: /receive 50/i }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/Against VPS-1042-1 · PO-1042/)).toBeInTheDocument();
    const qty = within(dialog).getByLabelText(/amount received/i);
    await user.clear(qty);
    await user.type(qty, '48');
    await user.click(within(dialog).getByRole('checkbox', { name: /everything we're getting/i }));
    await user.click(within(dialog).getByRole('checkbox', { name: /also close PO-1042 line 2/i }));
    await user.click(within(dialog).getByRole('button', { name: /record receipt/i }));

    await waitFor(() => expect(closeVendorPoLines).toHaveBeenCalledWith('po-1042', ['line-2'], expect.any(String)));
    expect(vi.mocked(receiveOutsideShipment).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(closeVendorPoLines).mock.invocationCallOrder[0],
    );
    expect(await screen.findByText(/PO-1042 line 2 is closed/)).toBeInTheDocument();
  });
});
