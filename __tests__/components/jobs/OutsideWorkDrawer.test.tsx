/**
 * "Out at vendors" — the slips still at a vendor, with the vendor PO each one ships against
 * (plan §3.6, criterion O4).
 *
 * The PO number is the thing the plater quotes back on the phone, so each row carries it as
 * text — and receiving here offers the same "Also close the PO line" step the operation card
 * does, through the same helper, after the receipt.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import userEvent from '@testing-library/user-event';
import { render, screen, waitFor } from '../../test-utils';

vi.mock('@/lib/supabase', () => ({ getSupabase: () => ({}) }));
vi.mock('posthog-js', () => ({ default: { capture: vi.fn() } }));
vi.mock('@/utils/outsideShipmentsAccess', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/outsideShipmentsAccess')>()),
  listOutsideShipmentsForCompany: vi.fn(),
  receiveOutsideShipment: vi.fn(),
}));
vi.mock('@/utils/vendorPoAccess', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/vendorPoAccess')>();
  return {
    closeVendorPoLines: vi.fn(),
    isNothingLeftToReceiveRefusal: actual.isNothingLeftToReceiveRefusal,
    isAlreadyClosedRefusal: actual.isAlreadyClosedRefusal,
  };
});

import { toFriendlyError } from '@/lib/supabaseErrors';
import OutsideWorkDrawer from '@/components/jobs/OutsideWorkDrawer';
import { listOutsideShipmentsForCompany, receiveOutsideShipment } from '@/utils/outsideShipmentsAccess';
import { closeVendorPoLines } from '@/utils/vendorPoAccess';
import type { OutsideShipmentWithRelations } from '@/types/outsideShipment';

const slip = (over: Partial<OutsideShipmentWithRelations> = {}): OutsideShipmentWithRelations => ({
  id: 's1',
  company_id: 'co1',
  job_id: 'j1',
  job_part_id: 'jp1',
  job_operation_id: 'op1',
  vendor_id: 'v1',
  vendor_address_id: null,
  vendor_contact_id: null,
  vendor_name: 'ProFinish',
  service_name: 'Anodize Type II',
  ship_to_address: null,
  ship_to_contact: null,
  slip_number: 'VPS-0141-1',
  quantity: 50,
  shipped_at: '2026-11-01T12:00:00Z',
  due_back_on: null,
  carrier: null,
  notes: null,
  created_by: 'u1',
  closed_at: null,
  closed_by: null,
  voided_at: null,
  voided_by: null,
  created_at: '2026-11-01T12:00:00Z',
  updated_at: '2026-11-01T12:00:00Z',
  vendor_purchase_order_line_id: 'line-2',
  job: { id: 'j1', job_number: 'J-0141' },
  receipts: [],
  vendor_purchase_order_line: {
    id: 'line-2',
    line_number: 2,
    vendor_purchase_order_id: 'po-1042',
    vendor_purchase_order: { id: 'po-1042', po_number: 'PO-1042' },
  },
  ...over,
});

const draw = () => render(<OutsideWorkDrawer companyId="co1" onClose={vi.fn()} />);

/** Receive 48 of 50, write off the rest, and (optionally) close the PO line too. */
async function receiveShort(alsoCloseLine: boolean) {
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: /^receive$/i }));
  const qty = await screen.findByLabelText(/amount received/i);
  await user.clear(qty);
  await user.type(qty, '48');
  await user.click(screen.getByRole('checkbox', { name: /everything we're getting/i }));
  if (alsoCloseLine) await user.click(screen.getByRole('checkbox', { name: /also close PO-1042 line 2/i }));
  await user.click(screen.getByRole('button', { name: /record receipt/i }));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listOutsideShipmentsForCompany).mockResolvedValue([slip()]);
  vi.mocked(receiveOutsideShipment).mockResolvedValue({ receiptId: 'r1' });
  vi.mocked(closeVendorPoLines).mockResolvedValue({} as Awaited<ReturnType<typeof closeVendorPoLines>>);
});

describe('OutsideWorkDrawer — the vendor PO on each slip', () => {
  it('names the PO a slip ships against, as text beside the process', async () => {
    draw();
    expect(await screen.findByText('Anodize Type II · PO-1042')).toBeInTheDocument();
    // Still ONE link per row: the job number.
    expect(screen.queryByRole('link', { name: /PO-1042/ })).not.toBeInTheDocument();
  });

  it('names no PO on a slip that is on none', async () => {
    vi.mocked(listOutsideShipmentsForCompany).mockResolvedValue([
      slip({ vendor_purchase_order_line_id: null, vendor_purchase_order_line: null }),
    ]);
    draw();
    expect(await screen.findByText('Anodize Type II')).toBeInTheDocument();
    expect(screen.queryByText(/PO-/)).not.toBeInTheDocument();
  });

  it('closes the PO line after the receipt, when that box is ticked', async () => {
    draw();
    await receiveShort(true);

    await waitFor(() => expect(closeVendorPoLines).toHaveBeenCalledWith('po-1042', ['line-2'], expect.any(String)));
    expect(receiveOutsideShipment).toHaveBeenCalledWith('s1', { quantityGood: 48, closeShipment: true });
    expect(vi.mocked(receiveOutsideShipment).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(closeVendorPoLines).mock.invocationCallOrder[0],
    );
  });

  it('leaves the PO line alone on a plain short-close', async () => {
    draw();
    await receiveShort(false);
    await waitFor(() => expect(receiveOutsideShipment).toHaveBeenCalledTimes(1));
    expect(closeVendorPoLines).not.toHaveBeenCalled();
  });

  it('says the receipt stands when the PO line would not close', async () => {
    vi.mocked(closeVendorPoLines).mockRejectedValue(new Error('PO-1042 is archived.'));
    draw();
    await receiveShort(true);
    expect(await screen.findByText(/receipt was recorded, but PO-1042 line 2 could not be closed/i)).toBeInTheDocument();
  });

  /**
   * The drawer reads slips only, so it cannot tell that a receipt completes the line — the database
   * can, and refuses the close ("Line 2 has nothing left to receive."). That line is DONE: no
   * warning, and the drawer moves on as after any receipt.
   */
  it('counts "nothing left to receive" as done — a receipt that completes the line warns of nothing', async () => {
    vi.mocked(closeVendorPoLines).mockRejectedValue(
      toFriendlyError({ code: 'P0001', message: 'Line 2 has nothing left to receive.', details: null, hint: null }),
    );
    draw();
    await receiveShort(true);
    await waitFor(() => expect(closeVendorPoLines).toHaveBeenCalledTimes(1));
    // The list re-reads, as after any receipt; nothing is left on screen about the line.
    await waitFor(() => expect(listOutsideShipmentsForCompany).toHaveBeenCalledTimes(2));
    expect(screen.queryByText(/could not be closed/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/nothing left to receive/i)).not.toBeInTheDocument();
  });

  /**
   * The E2E journey's run-tagged names squeezed "service · PO" to no width and pushed Receive out of
   * the drawer. jsdom has no layout engine, so this pins the DECLARATIONS that prevent it — the text
   * gives way (min-width 0, one line, an ellipsis) and the button never shrinks — and that the full
   * text stays reachable when the ellipsis cuts it.
   */
  it('cuts a long service and PO to one line, keeps the full text in a title, and keeps Receive whole', async () => {
    const service = 'E2E Anodize Type II Class 2 Black Hardcoat MIL-A-8625 LZ8K4Q2Y1ABC';
    vi.mocked(listOutsideShipmentsForCompany).mockResolvedValue([
      slip({ service_name: service, job: { id: 'j1', job_number: 'E2E-OUT-LZ8K4Q2Y1ABC' } }),
    ]);
    draw();

    const full = `${service} · PO-1042`;
    const text = await screen.findByText(full);
    expect(text).toHaveAttribute('title', full);
    // Read straight from the computed style: jest-dom's toHaveStyle drops text-overflow and
    // white-space when it normalises the expected object.
    const style = getComputedStyle(text);
    expect(parseFloat(style.minWidth)).toBe(0);
    expect([style.overflow, style.textOverflow, style.whiteSpace]).toEqual(['hidden', 'ellipsis', 'nowrap']);

    const receive = screen.getByRole('button', { name: /^receive$/i });
    expect(receive).toBeVisible();
    expect(getComputedStyle(receive).flexShrink).toBe('0');
  });

  it('says why a refused receipt was refused, rather than doing nothing', async () => {
    vi.mocked(receiveOutsideShipment).mockRejectedValue(new Error('That slip was voided — nothing can be received against it.'));
    draw();
    await receiveShort(false);
    expect(await screen.findByText(/that slip was voided/i)).toBeInTheDocument();
    expect(closeVendorPoLines).not.toHaveBeenCalled();
  });
});
