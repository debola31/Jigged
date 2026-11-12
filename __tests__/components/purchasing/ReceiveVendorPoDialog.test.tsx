/**
 * The office receive dialog (plan §3.7, criterion R6).
 *
 * One delivery is ONE atomic, idempotent `receive_vendor_purchase_order` call: its group id is
 * minted once per opening and reused on a retry. Rows are prefilled with what is outstanding; a
 * cleared row is skipped; a part row needs a place, which defaults to where the part already holds
 * the most. Certificates upload only AFTER the write, and only against the lots that landed; a
 * failed upload offers the recovery panel and Done is never blocked. Outside work is never
 * received here — it links out to its vendor packing slip.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import userEvent from '@testing-library/user-event';
import { render, screen, waitFor, within } from '../../test-utils';
import { draftPoDetail, otherLine, outsideLine, poDetail, poLine, poReceipt } from './vendorPoFixtures';
import type { VendorPoDetail, VendorPoReceiveResult } from '@/types/vendorPo';

const receiveVendorPo = vi.fn();
const markVendorPoSent = vi.fn();
const getRecentNoPoReceipts = vi.fn();
const newVendorPoReceiptGroupId = vi.fn();
vi.mock('@/utils/vendorPoAccess', () => ({
  receiveVendorPo: (...args: unknown[]) => receiveVendorPo(...args),
  markVendorPoSent: (...args: unknown[]) => markVendorPoSent(...args),
  getRecentNoPoReceipts: (...args: unknown[]) => getRecentNoPoReceipts(...args),
  newVendorPoReceiptGroupId: () => newVendorPoReceiptGroupId(),
}));
const getLocations = vi.fn();
const getBalancesForPart = vi.fn();
vi.mock('@/utils/inventoryLocationsAccess', () => ({
  getLocations: (...args: unknown[]) => getLocations(...args),
  getBalancesForPart: (...args: unknown[]) => getBalancesForPart(...args),
}));
const getPart = vi.fn();
vi.mock('@/utils/partsAccess', () => ({ getPart: (...args: unknown[]) => getPart(...args) }));
const uploadLotCertificate = vi.fn();
vi.mock('@/utils/lotCertificatesAccess', () => ({
  uploadLotCertificate: (...args: unknown[]) => uploadLotCertificate(...args),
}));
vi.mock('@/lib/localDate', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/localDate')>()),
  todayLocalISODate: () => '2026-11-12',
}));
const capture = vi.fn();
vi.mock('posthog-js', () => ({ default: { capture: (...args: unknown[]) => capture(...args) } }));
vi.mock('@/hooks/useUserRole', () => ({ useUserRole: () => ({ role: 'user', isAdmin: false, loading: false }) }));

// A native select stands in for the location Autocomplete: the rule under test is WHICH place is
// chosen, not how MUI renders a combobox.
vi.mock('@/components/inventory/locations/LocationPicker', () => ({
  default: ({
    label,
    options,
    value,
    onChange,
  }: {
    label: string;
    options: Array<{ id: string; label: string }>;
    value: { id: string } | null;
    onChange: (o: { id: string; label: string } | null) => void;
  }) => (
    <select aria-label={label} value={value?.id ?? ''} onChange={(e) => onChange(options.find((o) => o.id === e.target.value) ?? null)}>
      <option value="">(none)</option>
      {options.map((o) => (
        <option key={o.id} value={o.id}>
          {o.label}
        </option>
      ))}
    </select>
  ),
}));
vi.mock('@/components/inventory/MillCertField', () => ({
  default: ({ onChange, disabled }: { onChange: (f: File | null) => void; disabled?: boolean }) => (
    <input type="file" aria-label="Mill cert" disabled={disabled} onChange={(e) => onChange(e.target.files?.[0] ?? null)} />
  ),
}));
vi.mock('@/components/inventory/CertAfterBatchPanel', () => ({
  default: ({ lots, onDone }: { lots: Array<{ lotId: string }>; onDone: () => void }) => (
    <div data-testid="cert-panel">
      {lots.map((l) => l.lotId).join(',')}
      <button type="button" onClick={onDone}>
        Done
      </button>
    </div>
  ),
}));

import ReceiveVendorPoDialog from '@/components/purchasing/ReceiveVendorPoDialog';

const LOCATIONS = [
  { id: 'loc-root', company_id: 'test-company-id', parent_id: null, name: 'Rack', kind: 'unit', sort_order: 0 },
  { id: 'loc-small', company_id: 'test-company-id', parent_id: 'loc-root', name: 'Shelf A', kind: 'shelf', sort_order: 1 },
  { id: 'loc-big', company_id: 'test-company-id', parent_id: 'loc-root', name: 'Shelf B', kind: 'shelf', sort_order: 2 },
];

function balance(locationId: string, quantity: number) {
  return { location_id: locationId, location_name: locationId, path: ['Rack', locationId], quantity, lot_id: null, lot_code: null, heat_number: null, kind: 'shelf' };
}

function receiveResult(over: Partial<VendorPoReceiveResult> = {}): VendorPoReceiveResult {
  return {
    vendorPurchaseOrderId: 'po-1',
    receiptGroupId: 'g-1',
    status: 'partially_received',
    closedLineIds: [],
    receipts: [],
    landedLots: [],
    ...over,
  };
}

const onClose = vi.fn();
const onReceived = vi.fn();
const onReceiveOutside = vi.fn();

function open(po: VendorPoDetail = poDetail({ lines: [poLine(), otherLine(), outsideLine()] })) {
  return render(
    <ReceiveVendorPoDialog
      open
      companyId="test-company-id"
      po={po}
      onClose={onClose}
      onReceived={onReceived}
      onReceiveOutside={onReceiveOutside}
    />,
  );
}

const line = (id: string) => screen.getByTestId(`receive-line-${id}`);
const recordButton = () => screen.getByRole('button', { name: /record receipt/i });

beforeEach(() => {
  vi.clearAllMocks();
  let n = 0;
  newVendorPoReceiptGroupId.mockImplementation(() => `g-${++n}`);
  getLocations.mockResolvedValue(LOCATIONS);
  getBalancesForPart.mockResolvedValue([balance('loc-small', 10), balance('loc-big', 400)]);
  getPart.mockResolvedValue({ id: 'p1', lot_tracked: false });
  getRecentNoPoReceipts.mockResolvedValue([]);
  receiveVendorPo.mockResolvedValue(receiveResult());
  markVendorPoSent.mockResolvedValue({ id: 'po-1' });
  uploadLotCertificate.mockResolvedValue({ id: 'cert-1' });
});

describe('ReceiveVendorPoDialog — rows', () => {
  it('prefills each open part and other line with what is outstanding, and shows it in stock units', async () => {
    open();
    const bar = await screen.findByTestId('receive-line-l1');
    expect(within(bar).getByLabelText(/quantity received/i)).toHaveValue('3');
    expect(within(bar).getByText('= 432 in into stock')).toBeInTheDocument();
    expect(within(line('l2')).getByLabelText(/quantity received/i)).toHaveValue('1');
  });

  it('defaults the place to where the part already holds the most', async () => {
    open();
    const bar = await screen.findByTestId('receive-line-l1');
    await waitFor(() => expect(within(bar).getByLabelText(/where it goes/i)).toHaveValue('loc-big'));
  });

  it('falls back to where this PO last received the part, when it holds none', async () => {
    getBalancesForPart.mockResolvedValue([]);
    open(poDetail({ lines: [poLine({ receivedStockQuantity: 144, receivedQuantity: 1 })], receipts: [poReceipt({ locationId: 'loc-small' })] }));
    const bar = await screen.findByTestId('receive-line-l1');
    await waitFor(() => expect(within(bar).getByLabelText(/where it goes/i)).toHaveValue('loc-small'));
  });

  it('requires a place: with none, Save is off and the notice says which line', async () => {
    getBalancesForPart.mockResolvedValue([]);
    open();
    await screen.findByTestId('receive-line-l1');
    await waitFor(() => expect(recordButton()).toBeDisabled());
    expect(screen.getByText(/line 1: choose where it goes/i)).toBeInTheDocument();
  });

  it('leaves a cleared row out of the delivery', async () => {
    const user = userEvent.setup();
    open();
    await screen.findByTestId('receive-line-l1');
    await waitFor(() => expect(within(line('l1')).getByLabelText(/where it goes/i)).toHaveValue('loc-big'));
    await user.clear(within(line('l2')).getByLabelText(/quantity received/i));
    await user.click(recordButton());
    await waitFor(() => expect(receiveVendorPo).toHaveBeenCalled());
    const input = receiveVendorPo.mock.calls[0][1] as { entries: Array<{ line_id: string }> };
    expect(input.entries.map((e) => e.line_id)).toEqual(['l1']);
  });

  it('warns in amber about an over-receipt, and still records it', async () => {
    const user = userEvent.setup();
    open();
    const qty = within(await screen.findByTestId('receive-line-l1')).getByLabelText(/quantity received/i);
    await user.clear(qty);
    await user.type(qty, '4');
    expect(within(line('l1')).getByText('1 bar more than ordered — recorded as over-received')).toBeInTheDocument();
  });

  it('offers to close the rest only while the line is short', async () => {
    const user = userEvent.setup();
    open();
    const bar = await screen.findByTestId('receive-line-l1');
    expect(within(bar).queryByRole('checkbox', { name: /close the remaining/i })).not.toBeInTheDocument();
    const qty = within(bar).getByLabelText(/quantity received/i);
    await user.clear(qty);
    await user.type(qty, '2');
    await user.click(within(bar).getByRole('checkbox', { name: /that.s everything — close the remaining 1 bar/i }));
    await waitFor(() => expect(within(bar).getByLabelText(/where it goes/i)).toHaveValue('loc-big'));
    await user.click(recordButton());
    await waitFor(() => expect(receiveVendorPo).toHaveBeenCalled());
    const input = receiveVendorPo.mock.calls[0][1] as { entries: Array<{ line_id: string; close_remaining: boolean }> };
    expect(input.entries.find((e) => e.line_id === 'l1')?.close_remaining).toBe(true);
  });

  it('splits a line across another heat or place', async () => {
    const user = userEvent.setup();
    open(poDetail({ lines: [poLine()] }));
    const bar = await screen.findByTestId('receive-line-l1');
    await user.click(within(bar).getByRole('button', { name: /another heat or place/i }));
    expect(within(bar).getAllByLabelText(/quantity received/i)).toHaveLength(2);
  });

  it('warns that a heat starts tracking for good on a part not yet tracked by heat', async () => {
    open();
    const bar = await screen.findByTestId('receive-line-l1');
    expect(await within(bar).findByText(/starts tracking this part by heat, for good/i)).toBeInTheDocument();
  });

  it('says nothing about tracking on a part already tracked by heat', async () => {
    getPart.mockResolvedValue({ id: 'p1', lot_tracked: true });
    open();
    const bar = await screen.findByTestId('receive-line-l1');
    await waitFor(() => expect(getPart).toHaveBeenCalled());
    expect(within(bar).queryByText(/starts tracking/i)).not.toBeInTheDocument();
  });
});

describe('ReceiveVendorPoDialog — the write', () => {
  async function readyToRecord() {
    open();
    await screen.findByTestId('receive-line-l1');
    await waitFor(() => expect(within(line('l1')).getByLabelText(/where it goes/i)).toHaveValue('loc-big'));
  }

  it('records one delivery with the group id minted for this opening, quantities exactly as typed', async () => {
    const user = userEvent.setup();
    await readyToRecord();
    await user.type(screen.getByLabelText(/vendor packing slip/i), 'PS-88');
    await user.click(recordButton());
    await waitFor(() => expect(receiveVendorPo).toHaveBeenCalledTimes(1));
    const [poId, input] = receiveVendorPo.mock.calls[0] as [string, { receiptGroupId: string; vendorPackingSlip: string; entries: Array<Record<string, unknown>> }];
    expect(poId).toBe('po-1');
    expect(input.receiptGroupId).toBe('g-1');
    expect(input.vendorPackingSlip).toBe('PS-88');
    expect(input.entries[0]).toMatchObject({ line_id: 'l1', quantity: 3, quantity_unit: 'purchase', location_id: 'loc-big' });
    expect(onReceived).toHaveBeenCalled();
    expect(capture).toHaveBeenCalledWith(
      'vendor po received',
      expect.objectContaining({ line_count: 2, entry_count: 2, has_packing_slip: true, marked_sent_first: false }),
    );
  });

  it('retries a failed delivery with the SAME group id, so a lost reply can never add the stock twice', async () => {
    receiveVendorPo.mockRejectedValueOnce(new Error('Failed to receive against the purchase order.'));
    const user = userEvent.setup();
    await readyToRecord();
    await user.click(recordButton());
    expect(await screen.findByText(/failed to receive/i)).toBeInTheDocument();
    await user.click(recordButton());
    await waitFor(() => expect(receiveVendorPo).toHaveBeenCalledTimes(2));
    const ids = receiveVendorPo.mock.calls.map((c) => (c[1] as { receiptGroupId: string }).receiptGroupId);
    expect(ids).toEqual(['g-1', 'g-1']);
  });

  it('uploads a staged cert only AFTER the receipt resolves, and only against the lot that landed', async () => {
    receiveVendorPo.mockResolvedValue(
      receiveResult({ landedLots: [{ entryIndex: 0, lineId: 'l1', lotId: 'lot-new', lotCode: 'H1', heatNumber: 'H1' }] }),
    );
    const user = userEvent.setup();
    await readyToRecord();
    const bar = line('l1');
    await user.type(within(bar).getByLabelText(/heat number/i), 'H1');
    const file = new File(['pdf'], 'cert.pdf', { type: 'application/pdf' });
    await user.upload(within(bar).getByLabelText('Mill cert'), file);
    await user.click(recordButton());

    await waitFor(() => expect(uploadLotCertificate).toHaveBeenCalledWith('test-company-id', 'lot-new', file));
    expect(receiveVendorPo.mock.invocationCallOrder[0]).toBeLessThan(uploadLotCertificate.mock.invocationCallOrder[0]);
    expect(capture).toHaveBeenCalledWith('lot certificate uploaded', expect.objectContaining({ surface: 'office_po_receipt', at_receipt: true }));
  });

  it('never uploads a cert when the receipt itself failed', async () => {
    receiveVendorPo.mockRejectedValue(new Error('Line 1 is closed. Reopen it to receive against it.'));
    const user = userEvent.setup();
    await readyToRecord();
    const bar = line('l1');
    await user.type(within(bar).getByLabelText(/heat number/i), 'H1');
    await user.upload(within(bar).getByLabelText('Mill cert'), new File(['pdf'], 'cert.pdf', { type: 'application/pdf' }));
    await user.click(recordButton());
    expect(await screen.findByText(/line 1 is closed/i)).toBeInTheDocument();
    expect(uploadLotCertificate).not.toHaveBeenCalled();
  });

  it('shows the recovery panel only for a cert that failed, and Done is always there', async () => {
    receiveVendorPo.mockResolvedValue(
      receiveResult({ landedLots: [{ entryIndex: 0, lineId: 'l1', lotId: 'lot-new', lotCode: 'H1', heatNumber: 'H1' }] }),
    );
    uploadLotCertificate.mockRejectedValue(new Error('upload failed'));
    const user = userEvent.setup();
    await readyToRecord();
    const bar = line('l1');
    await user.type(within(bar).getByLabelText(/heat number/i), 'H1');
    await user.upload(within(bar).getByLabelText('Mill cert'), new File(['pdf'], 'cert.pdf', { type: 'application/pdf' }));
    await user.click(recordButton());

    const panel = await screen.findByTestId('cert-panel');
    expect(panel).toHaveTextContent('lot-new');
    expect(capture).toHaveBeenCalledWith('lot certificate upload failed', expect.objectContaining({ surface: 'office_po_receipt' }));
    const done = within(panel).getByRole('button', { name: 'Done' });
    expect(done).toBeEnabled();
    await user.click(done);
    expect(onClose).toHaveBeenCalled();
  });

  it('asks once before receiving on a draft — "Mark it sent today and receive?" — and marks it first', async () => {
    const user = userEvent.setup();
    open(draftPoDetail({ lines: [poLine({ status: 'draft' })] }));
    await screen.findByTestId('receive-line-l1');
    await waitFor(() => expect(within(line('l1')).getByLabelText(/where it goes/i)).toHaveValue('loc-big'));
    await user.click(recordButton());

    const confirm = await screen.findByRole('dialog', { name: /mark it sent today and receive/i });
    expect(receiveVendorPo).not.toHaveBeenCalled();
    await user.click(within(confirm).getByRole('button', { name: /mark sent and receive/i }));

    await waitFor(() => expect(receiveVendorPo).toHaveBeenCalled());
    expect(markVendorPoSent).toHaveBeenCalledWith('po-1', '2026-11-12');
    expect(markVendorPoSent.mock.invocationCallOrder[0]).toBeLessThan(receiveVendorPo.mock.invocationCallOrder[0]);
    expect(capture).toHaveBeenCalledWith('vendor po received', expect.objectContaining({ marked_sent_first: true }));
  });
});

describe('ReceiveVendorPoDialog — what it does not do', () => {
  it('shows outside lines read-only, handing them to their vendor packing slip', async () => {
    const user = userEvent.setup();
    open();
    const outside = await screen.findByTestId('receive-outside-l3');
    expect(within(outside).queryByLabelText(/quantity received/i)).not.toBeInTheDocument();
    await user.click(within(outside).getByRole('button', { name: /receive on j-1042/i }));
    expect(onReceiveOutside).toHaveBeenCalledWith(expect.objectContaining({ id: 'l3' }));
  });

  it('lists this part’s recent stock additions made without a PO — a notice, never a block', async () => {
    getRecentNoPoReceipts.mockResolvedValue([
      {
        transactionId: 't9',
        createdAt: '2026-11-04T15:00:00Z',
        quantity: 3,
        unit: 'bar',
        convertedQuantity: 432,
        locationName: 'Rack A',
        heatNumber: null,
        notes: null,
      },
    ]);
    open();
    expect(await screen.findByText(/3 bar into Rack A on 11\/4/)).toBeInTheDocument();
    expect(screen.getByText(/was that this delivery\?/i)).toBeInTheDocument();
    expect(getRecentNoPoReceipts).toHaveBeenCalledWith('p1', 14);
  });
});
