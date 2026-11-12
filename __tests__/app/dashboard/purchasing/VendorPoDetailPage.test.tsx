/**
 * The purchase order page — Pattern B, a document opened to act on (plan §3.13 "PO detail page",
 * criteria P5 and P8).
 *
 * What is pinned: the parties come from the PO's FROZEN copy; the actions are the ones that make
 * sense in each state; exactly ONE amber next-step line shows; every write runs the one
 * `refreshAfterWrite`; archive goes through the impact dialog, not revivable by name; the internal
 * auto-saves never touch the vendor-visible save; and a slip opens with its Void (`onVoided`).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThemeProvider } from '@mui/material/styles';
import jiggedTheme from '@/lib/theme';
import { draftPoDetail, outsideLine, poDetail, poHeader, poLine, poReceipt, poSlip, poSummary } from '../../../components/purchasing/vendorPoFixtures';
import type { VendorPoDetail } from '@/types/vendorPo';

const push = vi.fn();
vi.mock('next/navigation', () => ({
  useParams: () => ({ companyId: 'test-company-id', poId: 'po-1' }),
  useRouter: () => ({ push, replace: vi.fn(), back: vi.fn() }),
  usePathname: () => '/dashboard/test-company-id/purchasing/orders/po-1',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/lib/localDate', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/localDate')>()),
  todayLocalISODate: () => '2026-11-12',
}));
vi.mock('@/hooks/useUserRole', () => ({ useUserRole: () => ({ role: 'user', isAdmin: false, loading: false }) }));
const capture = vi.fn();
vi.mock('posthog-js', () => ({ default: { capture: (...args: unknown[]) => capture(...args) } }));

const access = {
  getVendorPo: vi.fn(),
  markVendorPoSent: vi.fn(),
  setVendorPoInternalNotes: vi.fn(),
  setVendorPoLinePromisedOn: vi.fn(),
  updateVendorPo: vi.fn(),
  archiveVendorPo: vi.fn(),
  getVendorPoArchiveImpact: vi.fn(),
  duplicateVendorPo: vi.fn(),
  reopenVendorPoLines: vi.fn(),
  closeVendorPoLines: vi.fn(),
  voidVendorPoReceipt: vi.fn(),
  relinkOutsideShipment: vi.fn(),
  listUnlinkedOutsideSlips: vi.fn(),
};
vi.mock('@/utils/vendorPoAccess', () => ({
  relinkOutsideShipment: (...a: unknown[]) => access.relinkOutsideShipment(...a),
  listUnlinkedOutsideSlips: (...a: unknown[]) => access.listUnlinkedOutsideSlips(...a),
  getVendorPo: (...a: unknown[]) => access.getVendorPo(...a),
  markVendorPoSent: (...a: unknown[]) => access.markVendorPoSent(...a),
  setVendorPoInternalNotes: (...a: unknown[]) => access.setVendorPoInternalNotes(...a),
  setVendorPoLinePromisedOn: (...a: unknown[]) => access.setVendorPoLinePromisedOn(...a),
  updateVendorPo: (...a: unknown[]) => access.updateVendorPo(...a),
  archiveVendorPo: (...a: unknown[]) => access.archiveVendorPo(...a),
  getVendorPoArchiveImpact: (...a: unknown[]) => access.getVendorPoArchiveImpact(...a),
  duplicateVendorPo: (...a: unknown[]) => access.duplicateVendorPo(...a),
  reopenVendorPoLines: (...a: unknown[]) => access.reopenVendorPoLines(...a),
  closeVendorPoLines: (...a: unknown[]) => access.closeVendorPoLines(...a),
  voidVendorPoReceipt: (...a: unknown[]) => access.voidVendorPoReceipt(...a),
}));
const receiveOutsideShipment = vi.fn();
const receiveOutsideOperation = vi.fn();
vi.mock('@/utils/outsideShipmentsAccess', () => ({
  receiveOutsideShipment: (...a: unknown[]) => receiveOutsideShipment(...a),
  receiveOutsideOperation: (...a: unknown[]) => receiveOutsideOperation(...a),
}));

// Children with their own suites are stood in for, keeping the props this page hands them.
const { props, keep } = vi.hoisted(() => {
  const kept: Record<string, Record<string, unknown>> = {};
  return {
    props: kept,
    keep: (name: string) => (p: Record<string, unknown>) => {
      kept[name] = p;
      return null;
    },
  };
});
vi.mock('@/components/purchasing/VendorPoForm', () => ({
  default: (p: Record<string, unknown>) => {
    props.form = p;
    return <div data-testid="po-form">editing {String((p.po as VendorPoDetail).header.poNumber)}</div>;
  },
}));
vi.mock('@/components/purchasing/ReceiveVendorPoDialog', () => ({ default: keep('receive') }));
vi.mock('@/components/purchasing/VendorPoPreviewDialog', () => ({ default: keep('preview') }));
vi.mock('@/components/purchasing/SendVendorPoToQuickBooksDialog', () => ({ SendVendorPoToQuickBooksDialog: keep('quickbooks') }));
vi.mock('@/components/outsideShipments/OutsideShipmentPreviewDialog', () => ({ default: keep('slip') }));
type LineCloseOutcome = { kind: 'closed' } | { kind: 'received' } | { kind: 'failed'; message: string } | null;
const closePoLineAfterReceipt = vi.fn(async (_target: unknown, _received: number): Promise<LineCloseOutcome> => null);
vi.mock('@/components/jobs/ReceiveFromVendorDialog', () => ({
  default: keep('receiveOutside'),
  closePoLineAfterReceipt: (target: unknown, received: number) => closePoLineAfterReceipt(target, received),
}));
vi.mock('@/components/common/DeleteImpactDialog', () => ({ default: keep('archive') }));

import VendorPoDetailPage from '@/app/dashboard/[companyId]/purchasing/orders/[poId]/page';

function show(detail: VendorPoDetail | null) {
  access.getVendorPo.mockResolvedValue(detail);
  return render(
    <ThemeProvider theme={jiggedTheme}>
      <VendorPoDetailPage />
    </ThemeProvider>,
  );
}

const loads = () => access.getVendorPo.mock.calls.length;

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of Object.keys(props)) delete props[k];
  closePoLineAfterReceipt.mockResolvedValue(null);
  access.markVendorPoSent.mockResolvedValue({ id: 'po-1' });
  access.setVendorPoInternalNotes.mockResolvedValue({ updatedAt: 'x' });
  access.setVendorPoLinePromisedOn.mockResolvedValue({ updatedAt: 'x' });
  access.archiveVendorPo.mockResolvedValue({ id: 'po-1' });
  access.reopenVendorPoLines.mockResolvedValue({ id: 'po-1' });
  access.getVendorPoArchiveImpact.mockResolvedValue({
    poNumber: 'PO-1042',
    vendorName: 'Acme Steel Supply (frozen)',
    wasSent: true,
    issuedAt: '2026-11-02T15:00:00Z',
    receiptCount: 2,
    linkedSlipCount: 1,
    inQuickBooks: true,
    quickbooksDocNumber: '1042',
    closedInQuickBooks: false,
    isArchived: false,
  });
  access.duplicateVendorPo.mockResolvedValue({
    id: 'po-2',
    poNumber: 'PO-1043',
    droppedOutsideLineCount: 0,
    droppedJobLinkCount: 1,
    droppedDateCount: 2,
  });
});

describe('VendorPoDetailPage — what it shows', () => {
  it('shows the parties from the frozen copy on the PO, with mailto and tel links', async () => {
    show(poDetail());
    expect(await screen.findByRole('heading', { name: 'PO-1042' })).toBeInTheDocument();
    expect(screen.getAllByText('Acme Steel Supply (frozen)').length).toBeGreaterThan(0);
    expect(screen.getByRole('link', { name: 'jane@acme.test' })).toHaveAttribute('href', 'mailto:jane@acme.test');
    expect(screen.getByRole('link', { name: '(219) 555-0100' })).toHaveAttribute('href', 'tel:(219) 555-0100');
    expect(screen.getAllByText('Contour Tool & Machine').length).toBeGreaterThan(0);
    expect(access.getVendorPo).toHaveBeenCalledWith('po-1', { today: '2026-11-12' });
  });

  it('shows prices to a user, not only to admins', async () => {
    show(poDetail());
    await screen.findByRole('heading', { name: 'PO-1042' });
    expect(screen.getByText('$125.00')).toBeInTheDocument();
    expect(screen.getByText('$375.00')).toBeInTheDocument();
  });

  it('says when a PO is not available', async () => {
    show(null);
    expect(await screen.findByText(/isn.t available/i)).toBeInTheDocument();
  });
});

describe('VendorPoDetailPage — one next step at a time', () => {
  it('a draft: send it', async () => {
    show(draftPoDetail());
    expect(await screen.findByText(/next: send it to acme steel supply \(frozen\)/i)).toBeInTheDocument();
    expect(screen.getAllByText(/^next:/i)).toHaveLength(1);
  });

  it('a revision not yet sent: send it again — even when QuickBooks is also behind', async () => {
    show(
      poDetail({
        header: poHeader({ revision: 1, sentRevision: 0 }),
        summary: poSummary({ hasUnsentChanges: true, quickbooksState: 'out_of_date' }),
        quickbooks: { ...poDetail().quickbooks, state: 'out_of_date', pushedRevision: 0 },
      }),
    );
    expect(await screen.findByText(/next: rev 1 hasn.t gone to/i)).toBeInTheDocument();
    expect(screen.getAllByText(/^next:/i)).toHaveLength(1);
    expect(screen.getByText('Rev 1 not sent')).toBeInTheDocument();
  });

  it('sent and current, but QuickBooks behind: update QuickBooks', async () => {
    show(
      poDetail({
        header: poHeader({ revision: 2, sentRevision: 2 }),
        summary: poSummary({ quickbooksState: 'out_of_date' }),
        quickbooks: { ...poDetail().quickbooks, state: 'out_of_date', pushedRevision: 1, provider: 'qbo', linkStatus: 'created', docNumber: '1042' },
      }),
    );
    expect(await screen.findByText(/next: quickbooks still has rev 1/i)).toBeInTheDocument();
  });

  it('nothing to do: no next-step line', async () => {
    show(poDetail());
    await screen.findByRole('heading', { name: 'PO-1042' });
    expect(screen.queryByText(/^next:/i)).not.toBeInTheDocument();
  });
});

describe('VendorPoDetailPage — actions per state', () => {
  const button = (name: RegExp) => screen.queryByRole('button', { name });

  it('a draft can be received, edited, previewed, marked sent, duplicated and archived — not closed or pushed', async () => {
    show(draftPoDetail());
    await screen.findByRole('heading', { name: 'PO-1042' });
    for (const name of [/^receive$/i, /^edit$/i, /preview pdf/i, /mark as sent/i, /duplicate/i, /archive purchase order/i]) {
      expect(button(name)).toBeInTheDocument();
    }
    expect(button(/^close/i)).not.toBeInTheDocument();
    expect(button(/quickbooks/i)).not.toBeInTheDocument();
  });

  it('a sent, current PO can be closed and sent to QuickBooks, and is not marked sent again', async () => {
    show(poDetail());
    await screen.findByRole('heading', { name: 'PO-1042' });
    expect(button(/^close…$/i)).toBeInTheDocument();
    expect(button(/send to quickbooks/i)).toBeInTheDocument();
    expect(button(/mark as sent/i)).not.toBeInTheDocument();
  });

  it('a closed PO offers Reopen, and neither Edit nor Receive', async () => {
    show(poDetail({ header: poHeader({ closedAt: '2026-11-09T00:00:00Z' }), summary: poSummary({ status: 'closed' }) }));
    await screen.findByRole('heading', { name: 'PO-1042' });
    expect(button(/^reopen$/i)).toBeInTheDocument();
    expect(button(/^edit$/i)).not.toBeInTheDocument();
    expect(button(/^receive$/i)).not.toBeInTheDocument();
  });

  it('an archived PO opened by id is read-only, with a banner', async () => {
    show(poDetail({ header: poHeader({ deletedAt: '2026-11-10T00:00:00Z', isArchived: true }) }));
    expect(await screen.findByText(/this purchase order is archived/i)).toBeInTheDocument();
    for (const name of [/^receive$/i, /^edit$/i, /mark as sent/i, /^close…$/i, /duplicate/i, /archive purchase order/i]) {
      expect(button(name)).not.toBeInTheDocument();
    }
    expect(button(/preview pdf/i)).toBeInTheDocument();
  });

  it('Edit replaces the page with the form — there is no /edit route', async () => {
    const user = userEvent.setup();
    show(poDetail());
    await user.click(await screen.findByRole('button', { name: /^edit$/i }));
    expect(screen.getByTestId('po-form')).toHaveTextContent('editing PO-1042');
    expect(push).not.toHaveBeenCalled();
  });
});

describe('VendorPoDetailPage — every write runs the one refresh', () => {
  it('Mark as sent stamps the send, reports it, and re-reads the PO without a loading flash', async () => {
    const user = userEvent.setup();
    show(draftPoDetail());
    await user.click(await screen.findByRole('button', { name: /mark as sent/i }));
    await waitFor(() => expect(access.markVendorPoSent).toHaveBeenCalledWith('po-1', '2026-11-12'));
    await waitFor(() => expect(loads()).toBe(2));
    expect(screen.getByRole('heading', { name: 'PO-1042' })).toBeInTheDocument();
    expect(capture).toHaveBeenCalledWith('vendor po sent', { is_resend: false, with_download: false, has_contact_email: true });
  });

  it('a delivery recorded in the receive dialog refreshes the page', async () => {
    show(poDetail());
    await screen.findByRole('heading', { name: 'PO-1042' });
    (props.receive.onReceived as () => void)();
    await waitFor(() => expect(loads()).toBe(2));
  });

  it('the preview’s Mark as sent & download refreshes the page', async () => {
    show(poDetail());
    await screen.findByRole('heading', { name: 'PO-1042' });
    expect(props.preview.onMarkedSent).toBeTypeOf('function');
    (props.preview.onMarkedSent as () => void)();
    await waitFor(() => expect(loads()).toBe(2));
  });

  it('QuickBooks: closed until clicked, refreshes on a push AND on close', async () => {
    const user = userEvent.setup();
    show(poDetail());
    await screen.findByRole('heading', { name: 'PO-1042' });
    expect(props.quickbooks.open).toBe(false);
    await user.click(screen.getByRole('button', { name: /send to quickbooks/i }));
    expect(props.quickbooks).toMatchObject({ open: true, companyId: 'test-company-id', poId: 'po-1' });
    (props.quickbooks.onPushed as (r: unknown) => void)({});
    await waitFor(() => expect(loads()).toBe(2));
    (props.quickbooks.onClose as () => void)();
    await waitFor(() => expect(loads()).toBe(3));
  });

  it('opens an outside line’s slip in its preview WITH its Void, and a void refreshes the page', async () => {
    const user = userEvent.setup();
    show(poDetail({ lines: [poLine(), outsideLine()], outsideSlips: [poSlip()] }));
    await user.click(await screen.findByRole('button', { name: 'VPS-0141-1' }));
    expect(props.slip).toMatchObject({ open: true, shipmentId: 's1' });
    expect(props.slip.onVoided).toBeTypeOf('function');
    (props.slip.onVoided as () => void)();
    await waitFor(() => expect(loads()).toBe(2));
  });

  it('hands an outside line from the receive dialog to the job’s own receive, with that line’s open slips', async () => {
    receiveOutsideShipment.mockResolvedValue({ receiptId: 'or1' });
    show(poDetail({ lines: [poLine(), outsideLine()], outsideSlips: [poSlip(), poSlip({ id: 's2', slipNumber: 'VPS-0141-2', outstandingQuantity: 0, closedAt: '2026-11-08T00:00:00Z' })] }));
    await screen.findByRole('heading', { name: 'PO-1042' });
    const line = outsideLine();
    (props.receive.onReceiveOutside as (l: unknown) => void)(line);
    await waitFor(() => expect(props.receiveOutside).toBeDefined());
    // Every slip here ships against THIS line, so the dialog can offer "Also close PO-1042 line 3" —
    // with what the line still expects (40 of 100), so a receipt that completes it closes nothing.
    const slipPoLine = { vendorPurchaseOrderId: 'po-1', poNumber: 'PO-1042', lineId: 'l3', lineNumber: 3, remainingQuantity: 40 };
    expect(props.receiveOutside.openSlips).toEqual([
      { id: 's1', slip_number: 'VPS-0141-1', shipped_at: '2026-11-04T12:00:00Z', outstanding: 40, poLine: slipPoLine },
    ]);
    (props.receiveOutside.onSubmit as (v: unknown) => void)({ shipmentId: 's1', quantityGood: 40, closeShipment: false, closePoLine: null });
    await waitFor(() => expect(receiveOutsideShipment).toHaveBeenCalledWith('s1', { quantityGood: 40, closeShipment: false }));
    await waitFor(() => expect(loads()).toBe(2));
    expect(closePoLineAfterReceipt).toHaveBeenCalledWith(null, 40);
    expect(capture).toHaveBeenCalledWith('outside shipment received', expect.objectContaining({ surface: 'office', is_full: true }));
  });

  it('closes the PO line after the receipt when asked, and says so if that part failed', async () => {
    receiveOutsideShipment.mockResolvedValue({ receiptId: 'or1' });
    closePoLineAfterReceipt.mockResolvedValue({
      kind: 'failed',
      message: 'The receipt was recorded, but PO-1042 line 3 could not be closed: nope Close it on the PO.',
    });
    show(poDetail({ lines: [poLine(), outsideLine()], outsideSlips: [poSlip()] }));
    await screen.findByRole('heading', { name: 'PO-1042' });
    (props.receive.onReceiveOutside as (l: unknown) => void)(outsideLine());
    await waitFor(() => expect(props.receiveOutside).toBeDefined());
    const slipPoLine = { vendorPurchaseOrderId: 'po-1', poNumber: 'PO-1042', lineId: 'l3', lineNumber: 3, remainingQuantity: 40 };
    (props.receiveOutside.onSubmit as (v: unknown) => void)({ shipmentId: 's1', quantityGood: 30, closeShipment: true, closePoLine: slipPoLine });
    await waitFor(() => expect(closePoLineAfterReceipt).toHaveBeenCalledWith(slipPoLine, 30));
    expect(receiveOutsideShipment.mock.invocationCallOrder[0]).toBeLessThan(closePoLineAfterReceipt.mock.invocationCallOrder[0]);
    expect(await screen.findByText(/could not be closed/i)).toBeInTheDocument();
  });

  /** The E2E finding, on this page: a receipt that completed the line is done, not refused. */
  it('treats a receipt that completed the PO line as done — the receipt is recorded, nothing warns', async () => {
    receiveOutsideShipment.mockResolvedValue({ receiptId: 'or1' });
    closePoLineAfterReceipt.mockResolvedValue({ kind: 'received' });
    show(poDetail({ lines: [poLine(), outsideLine()], outsideSlips: [poSlip()] }));
    await screen.findByRole('heading', { name: 'PO-1042' });
    (props.receive.onReceiveOutside as (l: unknown) => void)(outsideLine());
    await waitFor(() => expect(props.receiveOutside).toBeDefined());
    const slipPoLine = { vendorPurchaseOrderId: 'po-1', poNumber: 'PO-1042', lineId: 'l3', lineNumber: 3, remainingQuantity: 40 };
    (props.receiveOutside.onSubmit as (v: unknown) => void)({ shipmentId: 's1', quantityGood: 40, closeShipment: true, closePoLine: slipPoLine });
    expect(await screen.findByText('Recorded 40 back from Acme Steel Supply (frozen).')).toBeInTheDocument();
    expect(closePoLineAfterReceipt).toHaveBeenCalledWith(slipPoLine, 40);
    expect(screen.queryByText(/could not be closed/i)).not.toBeInTheDocument();
    await waitFor(() => expect(loads()).toBe(2));
  });

  it('reopens a closed PO, and refreshes', async () => {
    const user = userEvent.setup();
    show(poDetail({ header: poHeader({ closedAt: '2026-11-09T00:00:00Z' }), summary: poSummary({ status: 'closed' }) }));
    await user.click(await screen.findByRole('button', { name: /^reopen$/i }));
    await waitFor(() => expect(access.reopenVendorPoLines).toHaveBeenCalledWith('po-1', 'all'));
    await waitFor(() => expect(loads()).toBe(2));
    expect(capture).toHaveBeenCalledWith('vendor po lines reopened', { whole_po: true, line_count: 2 });
  });
});

/**
 * The explicit slip relink (plan §3.6; criterion O1) lives here, under each outside line's slips:
 * the send dialog says the link is corrected on the PO page, and this is where. Both corrections
 * run the page's one refresh, say what they did, and capture nothing — slip relink is deliberately
 * not instrumented (plan §3.14).
 */
describe('VendorPoDetailPage — correcting which slips an outside line counts', () => {
  const withSlip = (over: Parameters<typeof poDetail>[0] = {}) =>
    poDetail({ lines: [poLine(), outsideLine()], outsideSlips: [poSlip()], ...over });

  it('Unlink asks first, then the slip stops counting: said, and refreshed in place — no PostHog', async () => {
    const user = userEvent.setup();
    access.relinkOutsideShipment.mockResolvedValue({ outsideShipmentId: 's1', slipNumber: 'VPS-0141-1', vendorPurchaseOrderLineId: null });
    show(withSlip());
    await user.click(await screen.findByRole('button', { name: 'Unlink VPS-0141-1' }));
    const dialog = await screen.findByRole('dialog', { name: 'Unlink VPS-0141-1 from line 3?' });
    expect(within(dialog).getByText(/stops counting toward line 3's received quantity/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Unlink' }));

    await waitFor(() => expect(access.relinkOutsideShipment).toHaveBeenCalledWith('s1', null));
    expect(await screen.findByText('VPS-0141-1 no longer counts toward line 3.')).toBeInTheDocument();
    await waitFor(() => expect(loads()).toBe(2));
    // Refreshed in place: once the dialog has gone, the page is still there — no loading flash.
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByRole('heading', { name: 'PO-1042' })).toBeInTheDocument();
    expect(capture).not.toHaveBeenCalled();
  });

  it('Link a slip… offers the step’s unlinked slips to this vendor, links one, and refreshes', async () => {
    const user = userEvent.setup();
    access.listUnlinkedOutsideSlips.mockResolvedValue([
      { id: 's2', slipNumber: 'VPS-0141-2', jobId: 'j1', jobOperationId: 'op30', quantity: 20, shippedAt: '2026-11-06T12:00:00Z', dueBackOn: null, closedAt: null, voidedAt: null, receivedQuantity: 0, outstandingQuantity: 20 },
    ]);
    access.relinkOutsideShipment.mockResolvedValue({ outsideShipmentId: 's2', slipNumber: 'VPS-0141-2', vendorPurchaseOrderLineId: 'l3' });
    show(withSlip());
    await user.click(await screen.findByRole('button', { name: 'Link a slip…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Link a slip to line 3' });
    // Scoped to the PO's company, the line's step and the PO's vendor.
    expect(access.listUnlinkedOutsideSlips).toHaveBeenCalledWith('test-company-id', 'op30', 'v1');
    await user.click(await within(dialog).findByRole('button', { name: 'Link VPS-0141-2' }));

    await waitFor(() => expect(access.relinkOutsideShipment).toHaveBeenCalledWith('s2', 'l3'));
    expect(await screen.findByText('VPS-0141-2 now counts toward line 3.')).toBeInTheDocument();
    await waitFor(() => expect(loads()).toBe(2));
    expect(capture).not.toHaveBeenCalled();
  });

  it('a closed PO and an archived PO offer no slip corrections — like every other line action', async () => {
    const { unmount } = show(withSlip({ header: poHeader({ closedAt: '2026-11-09T00:00:00Z' }), summary: poSummary({ status: 'closed' }) }));
    expect(await screen.findByRole('button', { name: 'VPS-0141-1' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /unlink/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /link a slip/i })).not.toBeInTheDocument();
    unmount();

    show(withSlip({ header: poHeader({ deletedAt: '2026-11-10T00:00:00Z', isArchived: true }) }));
    expect(await screen.findByRole('button', { name: 'VPS-0141-1' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /unlink/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /link a slip/i })).not.toBeInTheDocument();
  });
});

describe('VendorPoDetailPage — the internal fields save themselves, never as a revision', () => {
  it('auto-saves the internal notes through their own door, never the vendor-visible save', async () => {
    const user = userEvent.setup();
    show(poDetail({ header: poHeader({ internalNotes: null }) }));
    const notes = await screen.findByLabelText(/internal notes/i);
    await user.type(notes, 'Call Jane if late');
    await user.tab();
    await waitFor(() => expect(access.setVendorPoInternalNotes).toHaveBeenCalledWith('po-1', 'Call Jane if late', '2026-11-12'));
    expect(access.updateVendorPo).not.toHaveBeenCalled();
    await waitFor(() => expect(loads()).toBe(2));
  });

  it('auto-saves a line’s promised date through its own door', async () => {
    const user = userEvent.setup();
    show(poDetail({ lines: [poLine({ promisedOn: null })] }));
    const promised = await screen.findByLabelText('Promised date, line 1');
    await user.type(promised, '2026-11-19');
    await user.tab();
    await waitFor(() => expect(access.setVendorPoLinePromisedOn).toHaveBeenCalledWith('po-1', 'l1', '2026-11-19', '2026-11-12'));
    expect(access.updateVendorPo).not.toHaveBeenCalled();
  });
});

describe('VendorPoDetailPage — duplicate and archive', () => {
  it('says what a duplicate leaves behind, then opens the new draft', async () => {
    const user = userEvent.setup();
    show(poDetail({ lines: [poLine(), outsideLine()] }));
    await user.click(await screen.findByRole('button', { name: /duplicate/i }));
    const confirm = await screen.findByRole('dialog', { name: /duplicate po-1042/i });
    expect(within(confirm).getByText(/1 outside-service line/i)).toBeInTheDocument();
    expect(within(confirm).getByText(/job links/i)).toBeInTheDocument();
    await user.click(within(confirm).getByRole('button', { name: /make the copy/i }));
    await waitFor(() => expect(access.duplicateVendorPo).toHaveBeenCalledWith('po-1', '2026-11-12'));
    expect(push).toHaveBeenCalledWith('/dashboard/test-company-id/purchasing/orders/po-2');
    expect(capture).toHaveBeenCalledWith('vendor po created', expect.objectContaining({ surface: 'duplicate', part_line_count: 1, outside_line_count: 0 }));
  });

  it('archives through the impact dialog — not revivable by name, with what it affects', async () => {
    const user = userEvent.setup();
    show(poDetail({ receipts: [poReceipt()] }));
    await user.click(await screen.findByRole('button', { name: /archive purchase order/i }));
    await waitFor(() => expect(props.archive?.open).toBe(true));
    expect(props.archive).toMatchObject({ entityLabel: 'purchase order', count: 1, revivableByName: false });
    const lines = props.archive.impactLines as string[];
    expect(lines.some((l) => /2 receipts stay in the stock ledger/i.test(l))).toBe(true);
    expect(lines.some((l) => /use close/i.test(l))).toBe(true);
    expect(lines.some((l) => /quickbooks/i.test(l))).toBe(true);

    (props.archive.onConfirm as () => void)();
    await waitFor(() => expect(access.archiveVendorPo).toHaveBeenCalledWith('po-1'));
    expect(capture).toHaveBeenCalledWith('vendor po archived', { was_sent: true, had_receipts: true, was_in_quickbooks: true });
    await waitFor(() => expect(push).toHaveBeenCalledWith('/dashboard/test-company-id/purchasing'));
  });
});
