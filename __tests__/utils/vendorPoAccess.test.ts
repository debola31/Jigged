/**
 * Vendor purchase orders — access layer (plan §5.3 "Access layer", criteria P3, P4, R3, B1, L1).
 *
 * What earns its keep here:
 *   - EVERY write names its RPC, and nothing ever writes a purchasing table through `.from()`
 *     (the browser holds SELECT only; a mocked table write would pass here and 42501 in prod).
 *   - The one table this layer does write, `parts_unit_conversions`, is written BEFORE the RPC,
 *     so the RPC can freeze the factor; aliases are normalised first.
 *   - The staleness token goes back EXACTLY as read (toISOString drops microseconds).
 *   - A P0001 sentence reaches the person and is not reported; every other RPC failure is.
 *   - Every jsonb result is parsed; a result that does not fit is our failure, said as one.
 *   - Lists filter deleted_at; by-id reads do not; failed reads throw, never [].
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { stub, PURCHASING_TABLES } from './purchasingTestStub';

const { mockCapture } = vi.hoisted(() => ({ mockCapture: vi.fn() }));

vi.mock('@/lib/supabase', async () => {
  const { stub: s } = await import('./purchasingTestStub');
  return { getSupabase: () => s.client, createClient: () => s.client, supabase: s.client };
});
vi.mock('@sentry/nextjs', () => ({ captureException: mockCapture }));

import {
  archiveVendorPo,
  closeVendorPoLines,
  createVendorPo,
  duplicateVendorPo,
  getOnOrderForParts,
  getPriceDefaultInputs,
  getRecentNoPoReceipts,
  getVendorPo,
  getVendorPoArchiveImpact,
  isAlreadyClosedRefusal,
  isNothingLeftToReceiveRefusal,
  isPoClosedRefusal,
  listOpenOutsideOpsForVendor,
  listUnlinkedOutsideSlips,
  listVendorPoLinesForJob,
  listVendorPoLinesForPart,
  listVendorPoReceipts,
  listVendorPos,
  listVendorPosForVendor,
  markVendorPoSent,
  newVendorPoReceiptGroupId,
  receiveVendorPo,
  relinkOutsideShipment,
  reopenVendorPoLines,
  resolveLinePriceDefault,
  setVendorPoInternalNotes,
  setVendorPoLinePromisedOn,
  updateVendorPo,
  voidVendorPoReceipt,
} from '@/utils/vendorPoAccess';

const TODAY = '2026-11-09';
const STALE_TOKEN = '2026-11-09T14:03:27.123456+00:00';
const GROUP = '3f0c8a52-6d1e-4f43-9a7e-2b8d1c4e5f60';

beforeEach(() => {
  vi.clearAllMocks();
  stub.reset();
});

/** No `.from()` write ever touched a purchasing table. */
function expectNoPurchasingTableWrites() {
  const bad = stub.writes().filter((w) => PURCHASING_TABLES.includes(w.table));
  expect(bad).toEqual([]);
}

function versions(over: Record<string, unknown> = {}) {
  return {
    revision: 0,
    sent_revision: null,
    revision_bumped: false,
    content_version: 1,
    content_changed: true,
    updated_at: '2026-11-09T15:00:00.654321+00:00',
    ...over,
  };
}

function saveResult(over: Record<string, unknown> = {}) {
  return {
    id: 'po-1',
    po_number: 'PO-0042',
    status: 'draft',
    line_ids: ['line-1'],
    linked_outside_shipment_ids: [],
    unlinked_outside_shipment_ids: [],
    ...versions(),
    ...over,
  };
}

function stateResult(action: string, over: Record<string, unknown> = {}) {
  return {
    id: 'po-1',
    po_number: 'PO-0042',
    action,
    status: 'sent',
    deleted_at: null,
    unlinked_outside_shipment_ids: [],
    ...versions({ sent_revision: 0 }),
    ...over,
  };
}

/** The part facts preparePurchaseUnits reads: BAR stocked in inches with a bar = 144 in row. */
function queueParts(rows: Array<Record<string, unknown>>) {
  stub.queue('parts', { data: rows });
}

const BAR = {
  id: 'part-bar',
  part_name: 'BAR-6061',
  primary_unit: 'inches',
  parts_unit_conversions: [{ from_unit: 'bar', to_primary_factor: 144 }],
};
const SCREW = { id: 'part-screw', part_name: 'SCREW-8', primary_unit: 'each', parts_unit_conversions: [] };

// ------------------------------------------------------------------------------------------------
// Writes
// ------------------------------------------------------------------------------------------------

describe('createVendorPo', () => {
  it('goes through create_vendor_purchase_order with the header and lines as patch keys', async () => {
    queueParts([BAR]);
    stub.rpc.mockResolvedValue({ data: [{ id: 'po-1', po_number: 'PO-0042' }], error: null });

    const result = await createVendorPo({
      vendorId: 'v-1',
      orderedOn: TODAY,
      today: TODAY,
      header: {
        shipTo: { kind: 'vendor', vendorId: 'v-plater', customerId: 'stale-customer' },
        paymentTerms: null,
        notesToVendor: 'Certs with the shipment',
      },
      lines: [
        { lineKind: 'part', partId: 'part-bar', quantity: 3, unit: 'bar', unitPrice: 12.345678, priceSource: 'price_sheet' },
        { lineKind: 'other', description: 'Freight', quantity: 1, unitPrice: 40, expectsReceipt: false },
      ],
    });

    expect(result).toEqual({ id: 'po-1', poNumber: 'PO-0042' });
    expect(stub.rpc).toHaveBeenCalledTimes(1);
    const [name, args] = stub.rpc.mock.calls[0];
    expect(name).toBe('create_vendor_purchase_order');
    expect(args).toEqual({
      p_vendor_id: 'v-1',
      p_ordered_on: TODAY,
      p_today: TODAY,
      p_header: {
        // Only the side the kind names: the stale customer id never reaches the RPC.
        ship_to: { kind: 'vendor', vendor_id: 'v-plater' },
        // An explicit null is SENT (clears the vendor's standing terms); undefined is not.
        payment_terms: null,
        notes_to_vendor: 'Certs with the shipment',
      },
      p_lines: [
        {
          line_kind: 'part',
          part_id: 'part-bar',
          quantity: 3,
          unit: 'bar',
          // At the stored five places.
          unit_price: 12.34568,
          price_source: 'price_sheet',
        },
        { line_kind: 'other', description: 'Freight', quantity: 1, unit_price: 40, expects_receipt: false },
      ],
    });
    expectNoPurchasingTableWrites();
  });

  it('refuses no lines, or a zero quantity, before any request', async () => {
    await expect(createVendorPo({ vendorId: 'v-1', orderedOn: TODAY, today: TODAY, lines: [] })).rejects.toThrow(
      /at least one line/i,
    );
    await expect(
      createVendorPo({
        vendorId: 'v-1',
        orderedOn: TODAY,
        today: TODAY,
        lines: [{ lineKind: 'other', description: 'Freight', quantity: 0 }],
      }),
    ).rejects.toThrow(/quantity greater than zero/i);
    expect(stub.rpc).not.toHaveBeenCalled();
    expect(stub.tables).toEqual([]);
  });

  it('stores a PRESET unit as the part conversion BEFORE the RPC, so the RPC can freeze it', async () => {
    // feet on an inches part: a preset (12), not yet a row.
    queueParts([{ ...BAR, parts_unit_conversions: [] }]);
    stub.queue('parts_unit_conversions', { data: [] }); // ensurePartUnitConversion's existence check
    stub.rpc.mockResolvedValue({ data: [{ id: 'po-1', po_number: 'PO-0042' }], error: null });

    await createVendorPo({
      vendorId: 'v-1',
      orderedOn: TODAY,
      today: TODAY,
      lines: [{ lineKind: 'part', partId: 'part-bar', quantity: 10, unit: 'ft' }],
    });

    const inserts = stub.callsOf('parts_unit_conversions', 'insert');
    expect(inserts).toEqual([[{ part_id: 'part-bar', from_unit: 'feet', to_primary_factor: 12 }]]);
    // The alias is normalised before the RPC sees it.
    expect(stub.rpc.mock.calls[0][1].p_lines[0].unit).toBe('feet');
    // And the row exists before the RPC runs.
    const fromOrder = stub.client.from.mock.invocationCallOrder;
    const lastConversionCall = Math.max(
      ...stub.client.from.mock.calls
        .map((c, i) => (c[0] === 'parts_unit_conversions' ? fromOrder[i] : -1))
        .filter((n) => n >= 0),
    );
    expect(stub.rpc.mock.invocationCallOrder[0]).toBeGreaterThan(lastConversionCall);
  });

  it('normalises an alias of the stock unit and writes no conversion (ea on an each part)', async () => {
    queueParts([SCREW]);
    stub.rpc.mockResolvedValue({ data: [{ id: 'po-1', po_number: 'PO-0042' }], error: null });
    await createVendorPo({
      vendorId: 'v-1',
      orderedOn: TODAY,
      today: TODAY,
      lines: [{ lineKind: 'part', partId: 'part-screw', quantity: 250, unit: 'ea' }],
    });
    expect(stub.rpc.mock.calls[0][1].p_lines[0].unit).toBe('each');
    expect(stub.writes()).toEqual([]);
  });

  it('uses a stored conversion as is, and writes nothing', async () => {
    queueParts([BAR]);
    stub.rpc.mockResolvedValue({ data: [{ id: 'po-1', po_number: 'PO-0042' }], error: null });
    await createVendorPo({
      vendorId: 'v-1',
      orderedOn: TODAY,
      today: TODAY,
      lines: [{ lineKind: 'part', partId: 'part-bar', quantity: 3, unit: 'Bar' }],
    });
    expect(stub.rpc.mock.calls[0][1].p_lines[0].unit).toBe('bar');
    expect(stub.writes()).toEqual([]);
  });

  it('stores "Another unit…" with the typed factor, add-only', async () => {
    queueParts([SCREW]);
    stub.queue('parts_unit_conversions', { data: [] });
    stub.rpc.mockResolvedValue({ data: [{ id: 'po-1', po_number: 'PO-0042' }], error: null });
    await createVendorPo({
      vendorId: 'v-1',
      orderedOn: TODAY,
      today: TODAY,
      lines: [{ lineKind: 'part', partId: 'part-screw', quantity: 2, unit: 'box', unitFactor: 500 }],
    });
    expect(stub.callsOf('parts_unit_conversions', 'insert')).toEqual([
      [{ part_id: 'part-screw', from_unit: 'box', to_primary_factor: 500 }],
    ]);
  });

  it('refuses a unit with no way to relate it, with the sentence, before the RPC', async () => {
    queueParts([SCREW]);
    await expect(
      createVendorPo({
        vendorId: 'v-1',
        orderedOn: TODAY,
        today: TODAY,
        lines: [{ lineKind: 'part', partId: 'part-screw', quantity: 2, unit: 'box' }],
      }),
    ).rejects.toThrow('SCREW-8 has no conversion for "box". Say how many ea are in one box first.');
    expect(stub.rpc).not.toHaveBeenCalled();
  });

  it('refuses a second factor for a unit the part already converts', async () => {
    queueParts([BAR]);
    await expect(
      createVendorPo({
        vendorId: 'v-1',
        orderedOn: TODAY,
        today: TODAY,
        lines: [{ lineKind: 'part', partId: 'part-bar', quantity: 2, unit: 'bar', unitFactor: 120 }],
      }),
    ).rejects.toThrow(/already has 1 bar = 144 in/);
    expect(stub.rpc).not.toHaveBeenCalled();
  });

  it('unwraps the RETURNS TABLE row, and treats an empty one as our failure', async () => {
    stub.rpc.mockResolvedValue({ data: [], error: null });
    await expect(
      createVendorPo({ vendorId: 'v-1', orderedOn: TODAY, today: TODAY, lines: [{ lineKind: 'other', description: 'x', quantity: 1 }] }),
    ).rejects.toThrow(/^Failed to read the reply/);
    expect(mockCapture).toHaveBeenCalled();
  });
});

describe('updateVendorPo', () => {
  it('passes the staleness token through EXACTLY as read, with patch semantics', async () => {
    stub.rpc.mockResolvedValue({ data: saveResult({ revision: 1, sent_revision: 0, revision_bumped: true }), error: null });

    const result = await updateVendorPo('po-1', {
      today: TODAY,
      expectedUpdatedAt: STALE_TOKEN,
      changes: { needByOn: '2026-12-01', internalNotes: undefined },
      lines: [{ id: 'line-1', quantity: 5 }, { lineKind: 'other', description: 'Setup fee', quantity: 1, unitPrice: 75 }],
      removedLineIds: ['line-2', 'line-2'],
    });

    const [name, args] = stub.rpc.mock.calls[0];
    expect(name).toBe('save_vendor_purchase_order');
    expect(args).toEqual({
      p_id: 'po-1',
      p_changes: { need_by_on: '2026-12-01' },
      p_lines: [
        { id: 'line-1', quantity: 5 },
        { line_kind: 'other', description: 'Setup fee', quantity: 1, unit_price: 75 },
      ],
      p_removed_line_ids: ['line-2'],
      p_expected_updated_at: STALE_TOKEN,
      p_today: TODAY,
    });
    expect(result.revisionBumped).toBe(true);
    expect(result.revision).toBe(1);
    expect(result.updatedAt).toBe('2026-11-09T15:00:00.654321+00:00');
    expectNoPurchasingTableWrites();
  });

  it('sends ship-to as ONE ship_to key, though the visible-field list names its columns', async () => {
    stub.rpc.mockResolvedValue({ data: saveResult(), error: null });
    await updateVendorPo('po-1', {
      today: TODAY,
      changes: { shipTo: { kind: 'customer', customerId: 'c-1', customerAddressId: null, vendorId: 'old' } },
    });
    expect(stub.rpc.mock.calls[0][1].p_changes).toEqual({
      ship_to: { kind: 'customer', customer_id: 'c-1', customer_address_id: null },
    });
  });

  it("resolves a unit change against the line's stored part when the patch names none", async () => {
    stub.queue('vendor_purchase_order_lines', { data: [{ id: 'line-1', part_id: 'part-bar', line_kind: 'part' }] });
    queueParts([BAR]);
    stub.rpc.mockResolvedValue({ data: saveResult(), error: null });
    await updateVendorPo('po-1', { today: TODAY, lines: [{ id: 'line-1', unit: 'BAR' }] });
    expect(stub.callsOf('vendor_purchase_order_lines', 'eq')).toContainEqual(['vendor_purchase_order_id', 'po-1']);
    expect(stub.rpc.mock.calls[0][1].p_lines).toEqual([{ id: 'line-1', unit: 'bar' }]);
  });

  it('turns a stale save into its sentence, and does not report it (P0001)', async () => {
    stub.rpc.mockResolvedValue({
      data: null,
      error: {
        code: 'P0001',
        message: 'PO-0042 was changed by someone else since you opened it. Reload it and make your change again.',
      },
    });
    await expect(updateVendorPo('po-1', { today: TODAY, expectedUpdatedAt: STALE_TOKEN, changes: { shipVia: 'UPS' } })).rejects.toThrow(
      'PO-0042 was changed by someone else since you opened it. Reload it and make your change again.',
    );
    expect(mockCapture).not.toHaveBeenCalled();
  });
});

describe('the auto-saved internal fields never take the vendor-visible path', () => {
  it('internal notes: only internal_notes, no staleness token', async () => {
    stub.rpc.mockResolvedValue({ data: saveResult(), error: null });
    await setVendorPoInternalNotes('po-1', '  call before noon  ', TODAY);
    expect(stub.rpc).toHaveBeenCalledWith('save_vendor_purchase_order', {
      p_id: 'po-1',
      p_changes: { internal_notes: 'call before noon' },
      p_lines: [],
      p_removed_line_ids: [],
      p_today: TODAY,
    });
  });

  it('a promised date: only that line id and promised_on', async () => {
    stub.rpc.mockResolvedValue({ data: saveResult(), error: null });
    await setVendorPoLinePromisedOn('po-1', 'line-3', '2026-11-20', TODAY);
    expect(stub.rpc).toHaveBeenCalledWith('save_vendor_purchase_order', {
      p_id: 'po-1',
      p_changes: {},
      p_lines: [{ id: 'line-3', promised_on: '2026-11-20' }],
      p_removed_line_ids: [],
      p_today: TODAY,
    });
  });
});

describe('state changes', () => {
  it('mark sent, archive, and a whole-PO close or reopen go through set_vendor_purchase_order_state', async () => {
    stub.rpc.mockResolvedValueOnce({ data: stateResult('mark_sent'), error: null });
    const sent = await markVendorPoSent('po-1', TODAY);
    expect(stub.rpc).toHaveBeenLastCalledWith('set_vendor_purchase_order_state', {
      p_id: 'po-1',
      p_action: 'mark_sent',
      p_reason: undefined,
      p_today: TODAY,
    });
    expect(sent).toMatchObject({ action: 'mark_sent', status: 'sent', sentRevision: 0 });

    stub.rpc.mockResolvedValueOnce({ data: stateResult('archive', { deleted_at: '2026-11-09T16:00:00+00:00' }), error: null });
    const archived = await archiveVendorPo('po-1');
    expect(stub.rpc.mock.calls.at(-1)?.[1]).toMatchObject({ p_id: 'po-1', p_action: 'archive' });
    expect(archived.deletedAt).toBe('2026-11-09T16:00:00+00:00');

    stub.rpc.mockResolvedValueOnce({ data: stateResult('close', { status: 'closed' }), error: null });
    await closeVendorPoLines('po-1', 'all', '  vendor out of stock ');
    expect(stub.rpc.mock.calls.at(-1)).toEqual([
      'set_vendor_purchase_order_state',
      { p_id: 'po-1', p_action: 'close', p_reason: 'vendor out of stock', p_today: undefined },
    ]);

    stub.rpc.mockResolvedValueOnce({ data: stateResult('reopen'), error: null });
    await reopenVendorPoLines('po-1', 'all');
    expect(stub.rpc.mock.calls.at(-1)?.[1]).toMatchObject({ p_action: 'reopen' });
    expectNoPurchasingTableWrites();
  });

  it('chosen lines close and reopen as ONE batch through set_vendor_purchase_order_line_state', async () => {
    const lineResult = (action: string) => ({
      id: 'po-1',
      po_number: 'PO-0042',
      action,
      line_ids: ['l1', 'l2'],
      status: 'partially_received',
      ...versions({ sent_revision: 0 }),
    });
    stub.rpc.mockResolvedValueOnce({ data: lineResult('close'), error: null });
    const closed = await closeVendorPoLines('po-1', ['l1', 'l2', 'l1']);
    expect(stub.rpc).toHaveBeenLastCalledWith('set_vendor_purchase_order_line_state', {
      p_id: 'po-1',
      p_line_ids: ['l1', 'l2'],
      p_action: 'close',
      p_reason: undefined,
    });
    expect(closed).toMatchObject({ action: 'close_lines', lineIds: ['l1', 'l2'] });

    stub.rpc.mockResolvedValueOnce({ data: lineResult('reopen'), error: null });
    await reopenVendorPoLines('po-1', ['l2']);
    expect(stub.rpc.mock.calls.at(-1)?.[1]).toMatchObject({ p_line_ids: ['l2'], p_action: 'reopen' });
  });

  it('refuses an empty selection before a round trip', async () => {
    await expect(closeVendorPoLines('po-1', [])).rejects.toThrow('Choose the lines to close.');
    expect(stub.rpc).not.toHaveBeenCalled();
  });
});

/** What `closeVendorPoLines` throws when the line-state RPC fails with `error` — through the real plumbing. */
async function lineCloseRefusedWith(error: { code: string; message: string }): Promise<unknown> {
  stub.rpc.mockResolvedValueOnce({ data: null, error: { ...error, details: null, hint: null } });
  return closeVendorPoLines('po-1', ['l2']).then(
    () => null,
    (err: unknown) => err,
  );
}

describe('isNothingLeftToReceiveRefusal — a close refused because the line is received in full (O2)', () => {
  /**
   * A close after a receipt that completed the line is refused with this sentence, and that refusal
   * means the line is DONE (received in full). Told apart through the plumbing every refusal takes —
   * the P0001 code kept by `purchasingRpcFailure`, and the whole sentence, for that line.
   */
  it('names the "nothing left to receive" refusal, for that line only, by its P0001 sentence', async () => {
    const nothingLeft = await lineCloseRefusedWith({ code: 'P0001', message: 'Line 2 has nothing left to receive.' });
    expect(nothingLeft).toBeInstanceOf(Error);
    expect(isNothingLeftToReceiveRefusal(nothingLeft, 2)).toBe(true);
    // A refusal, so the person's sentence and not our failure: nothing reported.
    expect(mockCapture).not.toHaveBeenCalled();
    // Another line's sentence is not this line's.
    expect(isNothingLeftToReceiveRefusal(nothingLeft, 3)).toBe(false);

    const otherRefusal = await lineCloseRefusedWith({ code: 'P0001', message: 'Line 2 is already closed.' });
    expect(isNothingLeftToReceiveRefusal(otherRefusal, 2)).toBe(false);
    // The same words under another code are not the refusal.
    const notARefusal = await lineCloseRefusedWith({ code: 'XX000', message: 'Line 2 has nothing left to receive.' });
    expect(isNothingLeftToReceiveRefusal(notARefusal, 2)).toBe(false);
    expect(isNothingLeftToReceiveRefusal(new Error('Line 2 has nothing left to receive.'), 2)).toBe(false);
    expect(isNothingLeftToReceiveRefusal(null, 2)).toBe(false);
  });
});

describe('isAlreadyClosedRefusal — a close refused because the line was closed first (O2)', () => {
  /**
   * "Also close" on a slip whose PO line was closed before the receipt — on the PO page, or by
   * another slip's "Also close" — is refused with this sentence, and that refusal means the line is
   * DONE: nothing more is expected on it, which is what the box asked. Told apart the same way as
   * "nothing left to receive": the P0001 code, and the whole sentence, for that line.
   */
  it('names the "already closed" refusal, for that line only, by its P0001 sentence', async () => {
    const alreadyClosed = await lineCloseRefusedWith({ code: 'P0001', message: 'Line 2 is already closed.' });
    expect(alreadyClosed).toBeInstanceOf(Error);
    expect(isAlreadyClosedRefusal(alreadyClosed, 2)).toBe(true);
    // A refusal, so the person's sentence and not our failure: nothing reported.
    expect(mockCapture).not.toHaveBeenCalled();
    // Another line's sentence is not this line's.
    expect(isAlreadyClosedRefusal(alreadyClosed, 3)).toBe(false);

    // Each "done" refusal names its own sentence.
    expect(isNothingLeftToReceiveRefusal(alreadyClosed, 2)).toBe(false);
    const nothingLeft = await lineCloseRefusedWith({ code: 'P0001', message: 'Line 2 has nothing left to receive.' });
    expect(isAlreadyClosedRefusal(nothingLeft, 2)).toBe(false);
    // The whole sentence, never a fragment: the PO's own "already closed" is not the line's.
    const poClosed = await lineCloseRefusedWith({ code: 'P0001', message: 'PO-1042 is already closed.' });
    expect(isAlreadyClosedRefusal(poClosed, 2)).toBe(false);
    // The same words under another code are not the refusal.
    const notARefusal = await lineCloseRefusedWith({ code: 'XX000', message: 'Line 2 is already closed.' });
    expect(isAlreadyClosedRefusal(notARefusal, 2)).toBe(false);
    expect(isAlreadyClosedRefusal(new Error('Line 2 is already closed.'), 2)).toBe(false);
    expect(isAlreadyClosedRefusal(null, 2)).toBe(false);
  });
});

describe('isPoClosedRefusal — a close refused because the whole PO was closed first (O2)', () => {
  /**
   * "Also close" on a slip whose whole PO was closed before the receipt — on the PO page — is refused
   * before any line is looked at, with this sentence, and that refusal means the line is DONE too:
   * nothing more is expected on any line of a closed PO, which is what the box asked. Told apart the
   * same way as the line refusals: the P0001 code, and the whole sentence, for that PO's number.
   */
  it('names the "PO is closed" refusal, for that PO only, by its P0001 sentence', async () => {
    const poClosed = await lineCloseRefusedWith({ code: 'P0001', message: 'PO-1042 is closed. Reopen it first.' });
    expect(poClosed).toBeInstanceOf(Error);
    expect(isPoClosedRefusal(poClosed, 'PO-1042')).toBe(true);
    // A refusal, so the person's sentence and not our failure: nothing reported.
    expect(mockCapture).not.toHaveBeenCalled();
    // Another PO's sentence is not this PO's, nor is a number that only ends the same way.
    expect(isPoClosedRefusal(poClosed, 'PO-1043')).toBe(false);
    expect(isPoClosedRefusal(poClosed, '1042')).toBe(false);

    // Each "done" refusal names its own sentence.
    expect(isAlreadyClosedRefusal(poClosed, 2)).toBe(false);
    expect(isNothingLeftToReceiveRefusal(poClosed, 2)).toBe(false);
    const lineClosed = await lineCloseRefusedWith({ code: 'P0001', message: 'Line 2 is already closed.' });
    expect(isPoClosedRefusal(lineClosed, 'PO-1042')).toBe(false);
    // An archived PO is not a closed one.
    const archived = await lineCloseRefusedWith({ code: 'P0001', message: 'PO-1042 is archived.' });
    expect(isPoClosedRefusal(archived, 'PO-1042')).toBe(false);
    // The same words under another code are not the refusal.
    const notARefusal = await lineCloseRefusedWith({ code: 'XX000', message: 'PO-1042 is closed. Reopen it first.' });
    expect(isPoClosedRefusal(notARefusal, 'PO-1042')).toBe(false);
    expect(isPoClosedRefusal(new Error('PO-1042 is closed. Reopen it first.'), 'PO-1042')).toBe(false);
    expect(isPoClosedRefusal(null, 'PO-1042')).toBe(false);
  });
});

describe('receiveVendorPo', () => {
  const entry = {
    line_id: 'line-1',
    quantity: 2.5,
    quantity_unit: 'purchase' as const,
    location_id: 'loc-shelf',
    heat_number: 'H123',
    lot_id: null,
    notes: null,
    close_remaining: false,
  };
  const receipt = {
    receipt_id: 'r-1',
    entry_index: 0,
    line_id: 'line-1',
    line_number: 1,
    line_kind: 'part',
    quantity: 2.5,
    unit: 'hundred',
    stock_quantity: 250,
    stock_unit: 'each',
    part_id: 'part-screw',
    location_id: 'loc-shelf',
    location_name: 'Rack A › Shelf 1',
    lot_id: 'lot-1',
    lot_code: 'L-0007',
    heat_number: 'H123',
    started_tracking: true,
    transaction_id: 'txn-1',
    voided: false,
    location_balance: 250,
    part_quantity: 900,
    line_status: 'partially_received',
    over_received: false,
    over_received_quantity: 0,
  };

  it('sends one atomic call with the caller-minted group id and the quantities as typed', async () => {
    stub.rpc.mockResolvedValue({
      data: { vendor_purchase_order_id: 'po-1', receipt_group_id: GROUP, status: 'partially_received', closed_line_ids: [], receipts: [receipt] },
      error: null,
    });
    const result = await receiveVendorPo('po-1', {
      receiptGroupId: GROUP,
      entries: [entry],
      vendorPackingSlip: ' PS-889 ',
    });
    expect(stub.rpc).toHaveBeenCalledWith('receive_vendor_purchase_order', {
      p_id: 'po-1',
      p_receipt_group_id: GROUP,
      p_receipts: [entry],
      p_received_at: undefined,
      p_vendor_packing_slip: 'PS-889',
      p_notes: undefined,
    });
    expect(result.status).toBe('partially_received');
    expect(result.receipts[0]).toMatchObject({ receiptId: 'r-1', stockQuantity: 250, startedTracking: true });
    // Certs upload against these, after the write.
    expect(result.landedLots).toEqual([{ entryIndex: 0, lineId: 'line-1', lotId: 'lot-1', lotCode: 'L-0007', heatNumber: 'H123' }]);
    // Receiving touches no table directly — the RPC does the stock, the lot and the ledger.
    expect(stub.tables).toEqual([]);
    expect(stub.client.auth.getUser).not.toHaveBeenCalled();
  });

  it('a replay sends the SAME group id (idempotency lives in the database, keyed on it)', async () => {
    const reply = { vendor_purchase_order_id: 'po-1', receipt_group_id: GROUP, status: 'received', closed_line_ids: [], receipts: [receipt] };
    stub.rpc.mockResolvedValue({ data: reply, error: null });
    await receiveVendorPo('po-1', { receiptGroupId: GROUP, entries: [entry] });
    await receiveVendorPo('po-1', { receiptGroupId: GROUP, entries: [entry] });
    expect(stub.rpc.mock.calls.map((c) => c[1].p_receipt_group_id)).toEqual([GROUP, GROUP]);
  });

  it('refuses a missing delivery id or an empty delivery before the call', async () => {
    await expect(receiveVendorPo('po-1', { receiptGroupId: '', entries: [entry] })).rejects.toThrow(/^Failed to receive/);
    await expect(receiveVendorPo('po-1', { receiptGroupId: GROUP, entries: [] })).rejects.toThrow(/at least one line/);
    expect(stub.rpc).not.toHaveBeenCalled();
  });

  it('a draft refusal keeps its sentence ("mark it sent first") and is not reported', async () => {
    stub.rpc.mockResolvedValue({
      data: null,
      error: { code: 'P0001', message: 'PO-0042 is still a draft. Mark it sent first, then receive against it.' },
    });
    await expect(receiveVendorPo('po-1', { receiptGroupId: GROUP, entries: [entry] })).rejects.toThrow(
      'PO-0042 is still a draft. Mark it sent first, then receive against it.',
    );
    expect(mockCapture).not.toHaveBeenCalled();
  });

  it('mints a fresh uuid per delivery', () => {
    const a = newVendorPoReceiptGroupId();
    const b = newVendorPoReceiptGroupId();
    expect(a).toMatch(/^[0-9a-f-]{36}$/);
    expect(a).not.toBe(b);
  });
});

describe('voidVendorPoReceipt and relinkOutsideShipment', () => {
  it('void goes through its RPC and parses the result', async () => {
    stub.rpc.mockResolvedValue({
      data: { voided: true, receipt_id: 'r-1', void_transaction_id: 'txn-9', location_balance: 0, part_quantity: 650, status: 'sent' },
      error: null,
    });
    await expect(voidVendorPoReceipt('r-1', 'wrong heat')).resolves.toEqual({
      voided: true,
      receiptId: 'r-1',
      voidTransactionId: 'txn-9',
      locationBalance: 0,
      partQuantity: 650,
      status: 'sent',
    });
    expect(stub.rpc).toHaveBeenCalledWith('void_vendor_purchase_order_receipt', { p_receipt_id: 'r-1', p_reason: 'wrong heat' });
  });

  it('relink names the line; unlink leaves the argument out (NULL)', async () => {
    stub.rpc.mockResolvedValue({
      data: { outside_shipment_id: 's-1', slip_number: 'VPS-0141-2', vendor_purchase_order_line_id: 'line-7' },
      error: null,
    });
    await relinkOutsideShipment('s-1', 'line-7');
    expect(stub.rpc).toHaveBeenLastCalledWith('set_outside_shipment_vendor_purchase_order_line', {
      p_outside_shipment_id: 's-1',
      p_vendor_purchase_order_line_id: 'line-7',
    });
    stub.rpc.mockResolvedValue({
      data: { outside_shipment_id: 's-1', slip_number: 'VPS-0141-2', vendor_purchase_order_line_id: null },
      error: null,
    });
    const unlinked = await relinkOutsideShipment('s-1', null);
    expect(stub.rpc.mock.calls.at(-1)?.[1]).toEqual({ p_outside_shipment_id: 's-1', p_vendor_purchase_order_line_id: undefined });
    expect(unlinked.vendorPurchaseOrderLineId).toBeNull();
  });
});

describe('listUnlinkedOutsideSlips — what "Link a slip…" offers', () => {
  it("reads the step's LIVE slips to this vendor that ship against no line, company-scoped, oldest first", async () => {
    stub.queue('outside_shipments', {
      data: [
        {
          id: 's-2',
          slip_number: 'VPS-0141-2',
          vendor_purchase_order_line_id: null,
          job_id: 'job-1',
          job_operation_id: 'op-30',
          quantity: 20,
          shipped_at: '2026-11-05T09:00:00+00:00',
          due_back_on: null,
          closed_at: null,
          voided_at: null,
          outside_shipment_receipts: [
            { quantity_good: 5, voided_at: null },
            { quantity_good: 7, voided_at: '2026-11-06T00:00:00Z' },
          ],
        },
      ],
    });
    const slips = await listUnlinkedOutsideSlips('co-1', 'op-30', 'v-1');

    expect(stub.callsOf('outside_shipments', 'eq')).toEqual([
      ['company_id', 'co-1'],
      ['job_operation_id', 'op-30'],
      ['vendor_id', 'v-1'],
    ]);
    // Voided slips are never offered (the relink refuses them), nor slips already on a line.
    expect(stub.callsOf('outside_shipments', 'is')).toEqual([
      ['voided_at', null],
      ['vendor_purchase_order_line_id', null],
    ]);
    expect(stub.callsOf('outside_shipments', 'order')[0]).toEqual(['shipped_at', { ascending: true }]);
    // A voided receipt does not count as back.
    expect(slips).toEqual([
      {
        id: 's-2',
        slipNumber: 'VPS-0141-2',
        jobId: 'job-1',
        jobOperationId: 'op-30',
        quantity: 20,
        shippedAt: '2026-11-05T09:00:00+00:00',
        dueBackOn: null,
        closedAt: null,
        voidedAt: null,
        receivedQuantity: 5,
        outstandingQuantity: 15,
      },
    ]);
    expectNoPurchasingTableWrites();
  });

  it('THROWS on a failed read: an empty list would say there is nothing to link', async () => {
    stub.queue('outside_shipments', { error: { code: '08006', message: 'connection failure' } });
    await expect(listUnlinkedOutsideSlips('co-1', 'op-30', 'v-1')).rejects.toThrow('Failed to load the slips to link.');
  });
});

describe('RPC failures', () => {
  it('reports anything but a P0001 by hand, and words our own failure "Failed to …"', async () => {
    stub.rpc.mockResolvedValue({ data: null, error: { code: 'XX000', message: 'Unknown key(s) in a receipt entry: bogus' } });
    await expect(markVendorPoSent('po-1', TODAY)).rejects.toThrow('Failed to mark the purchase order sent.');
    expect(mockCapture).toHaveBeenCalledTimes(1);
    expect(mockCapture.mock.calls[0][1]).toMatchObject({ tags: { area: 'purchasing', op: 'mark the purchase order sent' } });
  });

  it('an operator refusal (42501) still reports: the UI never offers them the button', async () => {
    stub.rpc.mockResolvedValue({
      data: null,
      error: { code: '42501', message: "This is an office task: operators can't change purchasing records." },
    });
    await expect(archiveVendorPo('po-1')).rejects.toThrow();
    expect(mockCapture).toHaveBeenCalledTimes(1);
  });

  it('a lapsed subscription is not reported, and says so', async () => {
    stub.rpc.mockResolvedValue({
      data: null,
      error: { code: '42501', message: 'Your subscription is not active (billing_gate_update)' },
    });
    await expect(archiveVendorPo('po-1')).rejects.toThrow(/subscription isn't active/);
    expect(mockCapture).not.toHaveBeenCalled();
  });

  it('parses every jsonb result: one that does not fit is reported and thrown as ours', async () => {
    stub.rpc.mockResolvedValue({ data: { id: 'po-1', po_number: 'PO-0042', status: 'teleported' }, error: null });
    await expect(setVendorPoInternalNotes('po-1', 'x', TODAY)).rejects.toThrow(/^Failed to read the reply/);
    expect(mockCapture).toHaveBeenCalledTimes(1);
  });
});

describe('duplicateVendorPo', () => {
  it('re-creates the header and the part and other lines; drops outside lines, job links and dates', async () => {
    stub.queue('vendor_purchase_orders', {
      data: [
        {
          id: 'po-1',
          po_number: 'PO-0042',
          vendor_id: 'v-1',
          vendor_contact_id: 'contact-1',
          vendor_address_id: null,
          ship_to_kind: 'shop',
          ship_to_vendor_id: null,
          ship_to_vendor_address_id: null,
          ship_to_customer_id: null,
          ship_to_customer_address_id: null,
          need_by_on: '2026-11-30',
          payment_terms: null,
          ship_via: 'Our truck',
          notes_to_vendor: 'Certs please',
        },
      ],
    });
    stub.queue('vendor_purchase_order_lines', {
      data: [
        { line_number: 1, line_kind: 'part', part_id: 'part-bar', description: 'Bar', vendor_part_number: 'A-1', quantity: 3, unit: 'bar', unit_price: 12.5, price_source: 'price_sheet', need_by_on: '2026-11-20', promised_on: null, cert_required: true, expects_receipt: true, job_id: 'job-1', work_center_id: null },
        { line_number: 2, line_kind: 'outside_service', part_id: 'part-x', description: 'Anodize', vendor_part_number: null, quantity: 50, unit: 'each', unit_price: 1.2, price_source: 'vendor_service', need_by_on: null, promised_on: null, cert_required: false, expects_receipt: true, job_id: 'job-1', work_center_id: null },
        { line_number: 3, line_kind: 'other', part_id: null, description: 'Spindle rebuild', vendor_part_number: null, quantity: 1, unit: 'each', unit_price: null, price_source: null, need_by_on: null, promised_on: '2026-11-25', cert_required: false, expects_receipt: true, job_id: null, work_center_id: 'wc-1' },
      ],
    });
    queueParts([BAR]);
    stub.rpc.mockResolvedValue({ data: [{ id: 'po-2', po_number: 'PO-0043' }], error: null });

    const result = await duplicateVendorPo('po-1', TODAY);

    expect(result).toEqual({ id: 'po-2', poNumber: 'PO-0043', droppedOutsideLineCount: 1, droppedJobLinkCount: 1, droppedDateCount: 3 });
    const [name, args] = stub.rpc.mock.calls[0];
    expect(name).toBe('create_vendor_purchase_order');
    expect(args.p_ordered_on).toBe(TODAY);
    expect(args.p_header).toEqual({
      vendor_contact_id: 'contact-1',
      ship_to: { kind: 'shop' },
      payment_terms: null,
      ship_via: 'Our truck',
      notes_to_vendor: 'Certs please',
    });
    expect(args.p_lines).toEqual([
      { line_kind: 'part', part_id: 'part-bar', description: 'Bar', vendor_part_number: 'A-1', quantity: 3, unit: 'bar', unit_price: 12.5, price_source: 'price_sheet', cert_required: true },
      { line_kind: 'other', description: 'Spindle rebuild', vendor_part_number: null, quantity: 1, unit: 'each', unit_price: null, price_source: null, cert_required: false, expects_receipt: true, work_center_id: 'wc-1' },
    ]);
    expectNoPurchasingTableWrites();
  });

  it('says why when only outside lines would be copied', async () => {
    stub.queue('vendor_purchase_orders', { data: [{ id: 'po-1', po_number: 'PO-0042', vendor_id: 'v-1', ship_to_kind: 'shop', need_by_on: null }] });
    stub.queue('vendor_purchase_order_lines', { data: [{ line_kind: 'outside_service', quantity: 5 }] });
    await expect(duplicateVendorPo('po-1', TODAY)).rejects.toThrow(/only outside-service lines/);
    expect(stub.rpc).not.toHaveBeenCalled();
  });
});

// ------------------------------------------------------------------------------------------------
// Reads
// ------------------------------------------------------------------------------------------------

function listRow(over: Record<string, unknown> = {}) {
  return {
    id: 'po-1',
    company_id: 'co-1',
    po_number: 'PO-0042',
    vendor_id: 'v-1',
    vendor_name: 'Acme Steel',
    status: 'sent',
    ordered_on: '2026-11-01',
    need_by_on: '2026-11-08',
    next_expected_on: '2026-11-08',
    revision: 0,
    sent_revision: 0,
    has_unsent_changes: false,
    issued_at: '2026-11-01T15:00:00+00:00',
    last_sent_at: '2026-11-01T15:00:00+00:00',
    closed_at: null,
    line_count: 2,
    outstanding_line_count: 1,
    ordered_amount: 150.25,
    open_amount: 75,
    has_unpriced_lines: false,
    quickbooks_state: 'not_sent',
    job_ids: ['job-1'],
    job_numbers: ['J-1042'],
    vendor_rfq_id: null,
    created_at: '2026-11-01T14:00:00+00:00',
    updated_at: '2026-11-01T15:00:00.123456+00:00',
    is_archived: false,
    ...over,
  };
}

describe('listVendorPos', () => {
  it('reads the status view for live POs of the company, filtered and sorted on the server', async () => {
    stub.queue('vendor_purchase_order_status', { data: [listRow()], count: 1 });
    const result = await listVendorPos('co-1', {
      today: TODAY,
      statuses: ['draft', 'sent', 'partially_received'],
      vendorId: 'v-1',
      jobId: 'job-1',
      search: '50%_off',
      quickbooksStates: ['out_of_date'],
    });

    expect(stub.callsOf('vendor_purchase_order_status', 'is')).toContainEqual(['deleted_at', null]);
    expect(stub.callsOf('vendor_purchase_order_status', 'eq')).toEqual([
      ['company_id', 'co-1'],
      ['vendor_id', 'v-1'],
    ]);
    expect(stub.callsOf('vendor_purchase_order_status', 'in')).toEqual([
      ['status', ['draft', 'sent', 'partially_received']],
      ['quickbooks_state', ['out_of_date']],
    ]);
    expect(stub.callsOf('vendor_purchase_order_status', 'contains')).toEqual([['job_ids', ['job-1']]]);
    // The search's wildcards are escaped.
    expect(stub.callsOf('vendor_purchase_order_status', 'ilike')).toEqual([['search_text', '%50\\%\\_off%']]);
    // Default sort: next due, soonest first, never-expected last; id breaks ties.
    expect(stub.callsOf('vendor_purchase_order_status', 'order')).toEqual([
      ['next_expected_on', { ascending: true, nullsFirst: false }],
      ['id', { ascending: true }],
    ]);
    expect(stub.callsOf('vendor_purchase_order_status', 'range')).toEqual([[0, 499]]);

    expect(result.total).toBe(1);
    expect(result.truncated).toBe(false);
    // Due yesterday by the CALLER's date, still owed: late.
    expect(result.rows[0]).toMatchObject({ poNumber: 'PO-0042', status: 'sent', isLate: true, openAmount: 75 });
    expect(result.rows[0].updatedAt).toBe('2026-11-01T15:00:00.123456+00:00');
  });

  it('overdue only: the late predicate as a filter, against the caller\'s date', async () => {
    stub.queue('vendor_purchase_order_status', { data: [], count: 0 });
    await listVendorPos('co-1', { today: TODAY, overdueOnly: true, statuses: ['draft', 'sent'] });
    // A draft was never promised, so the status list narrows to what can be late.
    expect(stub.callsOf('vendor_purchase_order_status', 'in')).toEqual([['status', ['sent']]]);
    expect(stub.callsOf('vendor_purchase_order_status', 'lt')).toEqual([['next_expected_on', TODAY]]);
  });

  it('overdue only over statuses that cannot be late returns nothing, without a read', async () => {
    const result = await listVendorPos('co-1', { today: TODAY, overdueOnly: true, statuses: ['draft', 'closed'] });
    expect(result).toEqual({ rows: [], total: 0, truncated: false });
    expect(stub.tables).toEqual([]);
  });

  it('says when it is capped', async () => {
    stub.queue('vendor_purchase_order_status', { data: [listRow(), listRow({ id: 'po-2' })], count: 742 });
    const result = await listVendorPos('co-1', { today: TODAY, limit: 2, sort: { field: 'po_number', direction: 'desc' } });
    expect(result).toMatchObject({ total: 742, truncated: true });
    expect(stub.callsOf('vendor_purchase_order_status', 'order')[0]).toEqual(['po_number', { ascending: false, nullsFirst: false }]);
  });

  it('throws on a failed read — never an empty list', async () => {
    stub.queue('vendor_purchase_order_status', { error: { code: '57014', message: 'canceling statement due to statement timeout' } });
    await expect(listVendorPos('co-1', { today: TODAY })).rejects.toThrow('Failed to load purchase orders.');
  });

  it("a vendor's POs: that vendor, live, newest first", async () => {
    stub.queue('vendor_purchase_order_status', { data: [listRow()], count: 1 });
    await listVendorPosForVendor('v-1', { today: TODAY });
    expect(stub.callsOf('vendor_purchase_order_status', 'eq')).toEqual([['vendor_id', 'v-1']]);
    expect(stub.callsOf('vendor_purchase_order_status', 'is')).toContainEqual(['deleted_at', null]);
    expect(stub.callsOf('vendor_purchase_order_status', 'order')[0]).toEqual(['created_at', { ascending: false, nullsFirst: false }]);
  });
});

function headerRow(over: Record<string, unknown> = {}) {
  return {
    id: 'po-1',
    company_id: 'co-1',
    po_number: 'PO-0042',
    vendor_id: 'v-1',
    vendor_name: 'Acme Steel (as frozen)',
    vendor_address_id: 'va-1',
    vendor_address: { address_line1: '1 Mill Rd', address_line2: null, city: 'Warren', state: 'MI', postal_code: '48089', country: 'US', attention_to: null },
    vendor_contact_id: 'vc-1',
    vendor_contact: { name: 'Jane', email: 'jane@acme.test', phone: null },
    ship_to_kind: 'shop',
    ship_to_vendor_id: null,
    ship_to_vendor_address_id: null,
    ship_to_customer_id: null,
    ship_to_customer_address_id: null,
    ship_to_name: 'Our Shop',
    ship_to_address: null,
    ordered_on: '2026-11-01',
    need_by_on: '2026-11-08',
    payment_terms: 'Net 30',
    ship_via: 'UPS',
    notes_to_vendor: null,
    internal_notes: 'chase Friday',
    terms_and_conditions: 'T&C',
    revision: 1,
    sent_revision: 0,
    issued_at: '2026-11-01T15:00:00+00:00',
    last_sent_at: '2026-11-01T15:00:00+00:00',
    content_version: 3,
    closed_at: null,
    closed_reason: null,
    vendor_rfq_id: null,
    created_at: '2026-11-01T14:00:00+00:00',
    updated_at: STALE_TOKEN,
    deleted_at: '2026-11-05T10:00:00+00:00',
    ...over,
  };
}

function lineRow(over: Record<string, unknown> = {}) {
  return {
    id: 'line-1',
    vendor_purchase_order_id: 'po-1',
    po_number: 'PO-0042',
    vendor_id: 'v-1',
    line_number: 1,
    line_kind: 'part',
    part_id: 'part-bar',
    part_name: 'BAR-6061',
    description: '6061 bar',
    vendor_part_number: 'A-1',
    quantity: 3,
    unit: 'bar',
    stock_unit: 'inches',
    stock_factor: 144,
    unit_price: 50,
    price_source: 'price_sheet',
    amount: 150,
    open_amount: 50,
    need_by_on: '2026-11-08',
    promised_on: null,
    expected_on: '2026-11-08',
    cert_required: true,
    expects_receipt: true,
    job_id: null,
    job_number: null,
    job_part_id: null,
    job_operation_id: null,
    operation_label: null,
    vendor_service_id: null,
    service_name: null,
    work_center_id: null,
    work_center_name: null,
    closed_at: null,
    status: 'partially_received',
    ordered_stock_quantity: 432,
    received_quantity: 2,
    received_stock_quantity: 288,
    remaining_quantity: 1,
    remaining_stock_quantity: 144,
    open_quantity: 1,
    open_stock_quantity: 144,
    over_received_quantity: 0,
    sent_quantity: null,
    at_vendor_quantity: null,
    linked_slip_count: 0,
    created_at: '2026-11-01T14:00:00+00:00',
    updated_at: '2026-11-01T14:00:00+00:00',
    is_archived: true,
    ...over,
  };
}

describe('getVendorPo', () => {
  function queueDetail() {
    stub.queue('vendor_purchase_orders', { data: [headerRow()] });
    stub.queue('vendor_purchase_order_status', {
      data: [{ id: 'po-1', status: 'partially_received', next_expected_on: '2026-11-08', line_count: 2, outstanding_line_count: 2, ordered_amount: 210, open_amount: 110, has_unpriced_lines: false, has_unsent_changes: true, quickbooks_state: 'out_of_date', job_ids: ['job-1'], job_numbers: ['J-1042'] }],
    });
    stub.queue('vendor_purchase_order_line_status', {
      data: [
        lineRow(),
        lineRow({ id: 'line-2', line_number: 2, line_kind: 'outside_service', part_id: 'part-x', part_name: 'X-1', description: 'Anodize', quantity: 60, unit: 'each', stock_unit: null, stock_factor: null, unit_price: 1, amount: 60, open_amount: 60, status: 'open', received_quantity: 0, received_stock_quantity: null, ordered_stock_quantity: null, remaining_quantity: 60, remaining_stock_quantity: null, open_quantity: 60, open_stock_quantity: null, sent_quantity: 60, at_vendor_quantity: 60, linked_slip_count: 1, job_operation_id: 'op-30', expected_on: '2026-11-12' }),
      ],
    });
    stub.queue('vendor_purchase_order_receipts', {
      data: [
        { id: 'r-2', vendor_purchase_order_id: 'po-1', vendor_purchase_order_line_id: 'line-1', line_kind: 'part', receipt_group_id: GROUP, entry_index: 0, quantity: 2, unit: 'bar', stock_quantity: 288, stock_unit: 'inches', part_id: 'part-bar', location_id: 'loc-1', location_name: 'Rack A', lot_id: null, lot_code: null, heat_number: null, started_tracking: false, inventory_transaction_id: 'txn-1', void_transaction_id: null, vendor_packing_slip: 'PS-1', notes: null, received_at: '2026-11-04T10:00:00+00:00', received_by: 'user-1', voided_at: null, void_reason: null },
      ],
    });
    stub.queue('vendor_purchase_order_revisions', { data: [], count: 1 });
    stub.queue('quickbooks_purchase_order_links', {
      data: [{ id: 'link-1', provider: 'qbo', status: 'created', qb_doc_number: '1042', qb_url: 'https://qbo.test/po/9', qb_closed: false, pushed_revision: 0, pushed_at: '2026-11-02T10:00:00+00:00', updated_at: '2026-11-02T10:00:00+00:00' }],
    });
    stub.queue('outside_shipments', {
      data: [{ id: 's-1', slip_number: 'VPS-0141-1', vendor_purchase_order_line_id: 'line-2', job_id: 'job-1', job_operation_id: 'op-30', quantity: 60, shipped_at: '2026-11-03T09:00:00+00:00', due_back_on: '2026-11-12', closed_at: null, voided_at: null, outside_shipment_receipts: [{ quantity_good: 10, voided_at: '2026-11-04T00:00:00Z' }] }],
    });
    stub.queue('user_company_access', { data: [{ user_id: 'user-1', name: 'Pat' }] });
  }

  it('reads BY ID with no deleted_at filter, so an archived PO still opens', async () => {
    queueDetail();
    const po = await getVendorPo('po-1', { today: TODAY });
    expect(stub.callsOf('vendor_purchase_orders', 'is')).toEqual([]);
    expect(po?.header.isArchived).toBe(true);
    // The staleness token, untouched.
    expect(po?.header.updatedAt).toBe(STALE_TOKEN);
    // The parties are the FROZEN copies.
    expect(po?.header.vendorName).toBe('Acme Steel (as frozen)');
    expect(po?.header.vendorContact).toEqual({ name: 'Jane', email: 'jane@acme.test', phone: null });
    expect(po?.summary).toMatchObject({ status: 'partially_received', isLate: true, hasUnsentChanges: true, quickbooksState: 'out_of_date' });
    expect(po?.revisionCount).toBe(1);
    expect(po?.quickbooks).toMatchObject({ docNumber: '1042', provider: 'qbo', linkStatus: 'created', url: 'https://qbo.test/po/9' });
  });

  it('maps lines with their progress, and says which can be removed', async () => {
    queueDetail();
    const po = await getVendorPo('po-1', { today: TODAY });
    const [part, outside] = po!.lines;
    expect(part).toMatchObject({ lineKind: 'part', stockFactor: 144, receivedStockQuantity: 288, openStockQuantity: 144, hasLiveReceipts: true, removable: false, isLate: true });
    expect(outside).toMatchObject({ lineKind: 'outside_service', sentQuantity: 60, atVendorQuantity: 60, hasLiveReceipts: false, removable: true, isLate: false });
    expect(po!.receipts[0]).toMatchObject({ lineNumber: 1, receivedByName: 'Pat', stockQuantity: 288 });
    // A voided slip receipt does not count as back.
    expect(po!.outsideSlips[0]).toMatchObject({ slipNumber: 'VPS-0141-1', receivedQuantity: 0, outstandingQuantity: 60 });
    expect(stub.callsOf('outside_shipments', 'in')).toEqual([['vendor_purchase_order_line_id', ['line-2']]]);
  });

  it('is null when the caller cannot see it, and reads nothing else', async () => {
    stub.queue('vendor_purchase_orders', { data: [] });
    await expect(getVendorPo('po-x', { today: TODAY })).resolves.toBeNull();
    expect(stub.tables).toEqual(['vendor_purchase_orders']);
  });

  it('throws when a read fails', async () => {
    stub.queue('vendor_purchase_orders', { error: { code: '08006', message: 'connection failure' } });
    await expect(getVendorPo('po-1', { today: TODAY })).rejects.toThrow('Failed to load the purchase order.');
  });
});

describe('getVendorPoArchiveImpact', () => {
  it('counts live receipts and linked slips, and names the QuickBooks copy', async () => {
    stub.queue('vendor_purchase_orders', { data: [{ po_number: 'PO-0042', vendor_name: 'Acme', issued_at: '2026-11-01T00:00:00Z', deleted_at: null }] });
    stub.queue('vendor_purchase_order_receipts', { data: [], count: 3 });
    stub.queue('vendor_purchase_order_lines', { data: [{ id: 'line-2' }] });
    stub.queue('quickbooks_purchase_order_links', { data: [{ id: 'link-1', status: 'created', qb_doc_number: '1042', qb_closed: false }] });
    stub.queue('outside_shipments', { data: [], count: 2 });
    await expect(getVendorPoArchiveImpact('po-1')).resolves.toEqual({
      poNumber: 'PO-0042',
      vendorName: 'Acme',
      wasSent: true,
      issuedAt: '2026-11-01T00:00:00Z',
      receiptCount: 3,
      linkedSlipCount: 2,
      inQuickBooks: true,
      quickbooksDocNumber: '1042',
      closedInQuickBooks: false,
      isArchived: false,
    });
    expect(stub.callsOf('vendor_purchase_order_receipts', 'is')).toEqual([['voided_at', null]]);
  });
});

describe('listVendorPoLinesForJob', () => {
  it("lists the job's lines on LIVE POs with each PO's vendor and status", async () => {
    stub.queue('vendor_purchase_order_line_status', { data: [lineRow({ job_id: 'job-1', job_part_id: 'jp-1', is_archived: false })] });
    stub.queue('vendor_purchase_order_status', { data: [{ id: 'po-1', status: 'partially_received', vendor_name: 'Acme Steel' }] });
    const lines = await listVendorPoLinesForJob('job-1', { today: TODAY });
    expect(stub.callsOf('vendor_purchase_order_line_status', 'eq')).toEqual([
      ['job_id', 'job-1'],
      ['is_archived', false],
    ]);
    expect(lines[0]).toMatchObject({ poNumber: 'PO-0042', vendorName: 'Acme Steel', poStatus: 'partially_received', jobPartId: 'jp-1', receivedQuantity: 2, quantity: 3 });
  });

  /** The send dialog prefills Due back from it; `expectedOn` is a slip's promise once one is out. */
  it("carries the line's own need-by date beside its expected date", async () => {
    stub.queue('vendor_purchase_order_line_status', {
      data: [lineRow({ job_id: 'job-1', line_kind: 'outside_service', need_by_on: '2026-11-20', expected_on: '2026-11-12', is_archived: false })],
    });
    stub.queue('vendor_purchase_order_status', { data: [{ id: 'po-1', status: 'sent', vendor_name: 'Plater Co' }] });
    const [line] = await listVendorPoLinesForJob('job-1', { today: TODAY });
    expect(line).toMatchObject({ needByOn: '2026-11-20', expectedOn: '2026-11-12' });
  });
});

describe('listVendorPoLinesForPart', () => {
  it("lists the part's lines on LIVE POs in every status, newest first, with each PO's vendor and date", async () => {
    stub.queue('vendor_purchase_order_line_status', {
      data: [
        lineRow({ id: 'line-9', vendor_purchase_order_id: 'po-9', po_number: 'PO-0049', status: 'received', received_quantity: 3, open_quantity: 0, is_archived: false, job_number: 'J-1042' }),
        lineRow({ id: 'line-1', status: 'open', is_archived: false }),
      ],
      count: 2,
    });
    stub.queue('vendor_purchase_order_status', {
      data: [
        { id: 'po-9', status: 'received', vendor_name: 'Acme Steel', ordered_on: '2026-11-05' },
        { id: 'po-1', status: 'sent', vendor_name: 'Beta Metals', ordered_on: '2026-10-01' },
      ],
    });
    const result = await listVendorPoLinesForPart('part-bar', { today: TODAY });

    expect(stub.callsOf('vendor_purchase_order_line_status', 'eq')).toEqual([
      ['part_id', 'part-bar'],
      ['line_kind', 'part'],
      ['is_archived', false],
    ]);
    // Every status unless asked: no status filter at all.
    expect(stub.callsOf('vendor_purchase_order_line_status', 'in')).toEqual([]);
    expect(stub.callsOf('vendor_purchase_order_line_status', 'order')[0]).toEqual(['created_at', { ascending: false }]);
    expect(stub.callsOf('vendor_purchase_order_line_status', 'limit')).toEqual([[25]]);
    expect(stub.callsOf('vendor_purchase_order_status', 'in')).toEqual([['id', ['po-9', 'po-1']]]);
    expect(result.rows.map((l) => [l.poNumber, l.status, l.vendorName, l.orderedOn])).toEqual([
      ['PO-0049', 'received', 'Acme Steel', '2026-11-05'],
      ['PO-0042', 'open', 'Beta Metals', '2026-10-01'],
    ]);
    expect(result.rows[0]).toMatchObject({ lineId: 'line-9', quantity: 3, unit: 'bar', receivedQuantity: 3, jobNumber: 'J-1042', poStatus: 'received' });
    expect(result).toMatchObject({ total: 2, truncated: false });
  });

  it('narrows to the statuses asked for, and says when there are more than the limit', async () => {
    stub.queue('vendor_purchase_order_line_status', { data: [lineRow({ status: 'closed', is_archived: false })], count: 7 });
    stub.queue('vendor_purchase_order_status', { data: [{ id: 'po-1', status: 'closed', vendor_name: 'Acme Steel', ordered_on: '2026-09-01' }] });
    const result = await listVendorPoLinesForPart('part-bar', { today: TODAY, limit: 1, statuses: ['received', 'closed'] });
    expect(stub.callsOf('vendor_purchase_order_line_status', 'in')).toEqual([['status', ['received', 'closed']]]);
    expect(stub.callsOf('vendor_purchase_order_line_status', 'limit')).toEqual([[1]]);
    expect(result).toMatchObject({ total: 7, truncated: true });
  });

  it('reads no POs when the part has no lines', async () => {
    stub.queue('vendor_purchase_order_line_status', { data: [], count: 0 });
    await expect(listVendorPoLinesForPart('part-bar', { today: TODAY })).resolves.toEqual({ rows: [], total: 0, truncated: false });
    expect(stub.tables).toEqual(['vendor_purchase_order_line_status']);
  });

  it('THROWS on a failed read: an empty history would say "never bought"', async () => {
    stub.queue('vendor_purchase_order_line_status', { error: { code: '08006', message: 'connection failure' } });
    await expect(listVendorPoLinesForPart('part-bar', { today: TODAY })).rejects.toThrow("Failed to load the part's purchase orders.");
  });
});

describe('listOpenOutsideOpsForVendor', () => {
  it("lists this vendor's unfinished steps on live jobs, with what is left to send and any open line", async () => {
    stub.queue('job_operations', {
      data: [
        {
          id: 'op-30',
          job_id: 'job-1',
          job_part_id: 'jp-1',
          sequence: 30,
          operation_name: 'Anodize',
          status: 'sent',
          external_unit_price_snapshot: 1.1,
          vendor_services: { id: 'vs-1', name: 'Anodize', unit_price: 1.25, vendor_id: 'v-1', vendors: { name: 'Plater Co' } },
          jobs: { id: 'job-1', job_number: 'J-1042', due_date: '2026-11-20', company_id: 'co-1', production_status: 'in_progress', deleted_at: null },
          job_parts: { id: 'jp-1', quantity: 100, parts: { id: 'part-x', part_name: '1234-A', primary_unit: 'each' } },
          outside_shipments: [
            { id: 's-1', quantity: 60, closed_at: null, voided_at: null, outside_shipment_receipts: [{ quantity_good: 50, voided_at: null }] },
            { id: 's-2', quantity: 10, closed_at: null, voided_at: '2026-11-02T00:00:00Z', outside_shipment_receipts: [] },
          ],
          vendor_purchase_order_lines: [
            { id: 'line-9', line_number: 2, line_kind: 'outside_service', closed_at: null, vendor_purchase_orders: { id: 'po-7', po_number: 'PO-0007', vendor_id: 'v-1', closed_at: null, deleted_at: null } },
          ],
        },
      ],
    });
    const ops = await listOpenOutsideOpsForVendor('co-1', 'v-1');
    expect(stub.callsOf('job_operations', 'eq')).toEqual([
      ['vendor_services.vendor_id', 'v-1'],
      ['jobs.company_id', 'co-1'],
    ]);
    expect(stub.callsOf('job_operations', 'is')).toEqual([['jobs.deleted_at', null]]);
    expect(stub.callsOf('job_operations', 'neq')).toEqual([
      ['jobs.production_status', 'cancelled'],
      ['status', 'completed'],
    ]);
    expect(ops[0]).toMatchObject({
      jobNumber: 'J-1042',
      partName: '1234-A',
      orderedQuantity: 100,
      sentQuantity: 60,
      goodQuantity: 50,
      atVendorQuantity: 10,
      leftToSendQuantity: 40,
      openLine: { vendorPurchaseOrderId: 'po-7', poNumber: 'PO-0007', lineId: 'line-9', lineNumber: 2 },
      defaultDescription: 'Anodize — 1234-A — Job J-1042, Op 30',
    });
    expect(ops[0].priceDefault).toMatchObject({ unitPrice: 1.25, priceSource: 'vendor_service' });
    expect(ops[0].priceDefault.caption).toMatch(/Job costed at/);
  });

  it('THROWS on a failed read: an empty picker would say "nothing to send"', async () => {
    stub.queue('job_operations', { error: { code: '08006', message: 'connection failure' } });
    await expect(listOpenOutsideOpsForVendor('co-1', 'v-1')).rejects.toThrow("Failed to load the vendor's outside steps.");
  });
});

describe('getOnOrderForParts', () => {
  it('splits on order (sent) from on draft, from the part_on_order view, with the POs behind them', async () => {
    stub.queue('part_on_order', {
      data: [{ part_id: 'part-bar', stock_unit: 'inches', on_order_quantity: 144, on_draft_quantity: 288, next_expected_on: '2026-11-12', open_line_count: 1, draft_line_count: 1, unit_mismatch_line_count: 1 }],
    });
    stub.queue('vendor_purchase_order_line_status', {
      data: [
        { id: 'l-1', vendor_purchase_order_id: 'po-1', po_number: 'PO-0042', vendor_id: 'v-1', line_number: 1, part_id: 'part-bar', status: 'partially_received', quantity: 3, stock_unit: 'inches', stock_factor: 144, open_stock_quantity: 144, expected_on: '2026-11-12' },
        { id: 'l-2', vendor_purchase_order_id: 'po-2', po_number: 'PO-0043', vendor_id: 'v-1', line_number: 1, part_id: 'part-bar', status: 'draft', quantity: 2, stock_unit: 'inches', stock_factor: 144, open_stock_quantity: 0, expected_on: null },
        // Its frozen stock unit no longer matches the part's: in neither total, nor the refs.
        { id: 'l-3', vendor_purchase_order_id: 'po-3', po_number: 'PO-0044', vendor_id: 'v-1', line_number: 1, part_id: 'part-bar', status: 'open', quantity: 1, stock_unit: 'feet', stock_factor: 1, open_stock_quantity: 1, expected_on: null },
      ],
    });
    const map = await getOnOrderForParts('co-1', ['part-bar', 'part-bar']);
    const bar = map.get('part-bar')!;
    expect(bar).toMatchObject({ onOrder: 144, onDraft: 288, unitMismatchLineCount: 1 });
    expect(bar.refs.map((r) => [r.poNumber, r.isDraft, r.stockQuantity])).toEqual([
      ['PO-0042', false, 144],
      ['PO-0043', true, 288],
    ]);
    // Archived POs never count, and only the three live statuses are read.
    expect(stub.callsOf('vendor_purchase_order_line_status', 'eq')).toEqual([
      ['company_id', 'co-1'],
      ['line_kind', 'part'],
      ['is_archived', false],
    ]);
    expect(stub.callsOf('vendor_purchase_order_line_status', 'in')).toContainEqual(['status', ['draft', 'open', 'partially_received']]);
    expect(stub.callsOf('part_on_order', 'in')).toEqual([['part_id', ['part-bar']]]);
  });

  it('reads nothing for no parts, and throws on a failed read', async () => {
    await expect(getOnOrderForParts('co-1', [])).resolves.toEqual(new Map());
    expect(stub.tables).toEqual([]);
    stub.queue('part_on_order', { error: { code: '08006', message: 'connection failure' } });
    await expect(getOnOrderForParts('co-1', ['part-bar'])).rejects.toThrow('Failed to load what is on order.');
  });
});

describe('listVendorPoReceipts', () => {
  it('lists receipts on LIVE POs (through the line, the only key a receipt has), newest first', async () => {
    stub.queue('vendor_purchase_order_receipts', {
      data: [
        { id: 'r-1', vendor_purchase_order_id: 'po-1', vendor_purchase_order_line_id: 'line-1', line_kind: 'part', receipt_group_id: GROUP, entry_index: 0, quantity: 2, unit: 'bar', stock_quantity: 288, stock_unit: 'inches', part_id: 'part-bar', location_id: 'loc-1', location_name: 'Rack A', lot_id: null, lot_code: null, heat_number: null, started_tracking: false, inventory_transaction_id: 'txn-1', void_transaction_id: null, vendor_packing_slip: 'PS-1', notes: null, received_at: '2026-11-04T10:00:00+00:00', received_by: 'user-1', voided_at: null, void_reason: null, vendor_purchase_order_lines: { line_number: 1, part_name: 'BAR-6061', description: '6061 bar', vendor_purchase_orders: { id: 'po-1', po_number: 'PO-0042', vendor_id: 'v-1', vendor_name: 'Acme', deleted_at: null } } },
      ],
      count: 1,
    });
    const result = await listVendorPoReceipts('co-1', { vendorId: 'v-1', packingSlip: 'PS', receivedFrom: '2026-11-01T05:00:00.000Z' });
    expect(stub.callsOf('vendor_purchase_order_receipts', 'is')).toEqual([
      ['vendor_purchase_order_lines.vendor_purchase_orders.deleted_at', null],
      ['voided_at', null],
    ]);
    expect(stub.callsOf('vendor_purchase_order_receipts', 'eq')).toContainEqual(['vendor_purchase_order_lines.vendor_purchase_orders.vendor_id', 'v-1']);
    expect(stub.callsOf('vendor_purchase_order_receipts', 'gte')).toEqual([['received_at', '2026-11-01T05:00:00.000Z']]);
    expect(result.rows[0]).toMatchObject({ poNumber: 'PO-0042', vendorName: 'Acme', lineNumber: 1, partName: 'BAR-6061', vendorPackingSlip: 'PS-1' });
    // Person fields stay out of the list.
    expect(result.rows[0].receivedByName).toBeNull();
  });
});

describe('getRecentNoPoReceipts', () => {
  it('lists stock added without a PO in the last 14 days, leaving PO receipts and transfers out', async () => {
    stub.queue('inventory_transactions', {
      data: [
        { id: 'txn-po', created_at: '2026-11-08T10:00:00Z', quantity: 2, unit: 'bar', converted_quantity: 288, location_name: 'Rack A', heat_number: null, notes: 'Received on PO-0042 line 1' },
        { id: 'txn-adhoc', created_at: '2026-11-07T10:00:00Z', quantity: 3, unit: 'bar', converted_quantity: 432, location_name: 'Rack A', heat_number: 'H9', notes: null },
      ],
    });
    stub.queue('vendor_purchase_order_receipts', { data: [{ inventory_transaction_id: 'txn-po' }] });
    const rows = await getRecentNoPoReceipts('part-bar');
    expect(rows.map((r) => r.transactionId)).toEqual(['txn-adhoc']);
    expect(stub.callsOf('inventory_transactions', 'eq')).toEqual([
      ['part_id', 'part-bar'],
      ['type', 'addition'],
    ]);
    expect(stub.callsOf('inventory_transactions', 'is')).toEqual([['transfer_group_id', null]]);
    const since = stub.callsOf('inventory_transactions', 'gte')[0][1] as string;
    const days = (Date.now() - Date.parse(since)) / 86_400_000;
    expect(days).toBeGreaterThan(13.99);
    expect(days).toBeLessThan(14.01);
  });
});

describe('price defaults', () => {
  function queueInputs(over: { validUntil?: string | null } = {}) {
    stub.queue('parts', {
      data: [{ id: 'part-bar', company_id: 'co-1', part_name: 'BAR-6061', source: 'bought', primary_unit: 'inches', parts_unit_conversions: [{ from_unit: 'bar', to_primary_factor: 144 }], part_pricing_tiers: [{ quantity: 1, cost_per_unit: 0.4 }] }],
    });
    stub.queue('vendors', { data: [{ id: 'v-1', company_id: 'co-1', name: 'Acme' }] });
    stub.queue('part_vendors', {
      data: [{ id: 'pv-1', status: 'conditional', status_note: 'late twice', vendor_part_number: 'A-1', purchase_unit: 'bar', lead_time_days: 5, minimum_order_quantity: 2, valid_until: over.validUntil === undefined ? '2027-03-01' : over.validUntil, part_vendor_price_breaks: [{ min_quantity: 1, unit_price: 60 }, { min_quantity: 10, unit_price: 50 }] }],
    });
    stub.queue('part_vendor_last_purchase', {
      data: [{ vendor_id: 'v-1', po_number: 'PO-0040', ordered_on: '2026-10-01', unit: 'bar', unit_price: 55, stock_factor: 144 }],
    });
  }

  it("feeds the one price default: this vendor's valid sheet first, with its caption", async () => {
    queueInputs();
    const inputs = await getPriceDefaultInputs('co-1', 'v-1', 'part-bar');
    expect(inputs.sheet).toMatchObject({ purchaseUnit: 'bar', stockFactor: 144, validUntil: '2027-03-01' });
    expect(inputs.lastOrderedUnit).toBe('bar');
    const resolved = resolveLinePriceDefault(inputs, { quantity: 12, today: TODAY });
    expect(resolved.unit).toBe('bar');
    expect(resolved.price).toMatchObject({ unitPrice: 50, priceSource: 'price_sheet' });
    expect(resolved.notice).toMatchObject({ tone: 'warning' });
    expect(resolved.vendorPartNumber).toBe('A-1');
    // Reads only.
    expect(stub.writes()).toEqual([]);
  });

  it('an expired sheet is named and skipped: the Last PO price applies', async () => {
    queueInputs({ validUntil: '2026-10-31' });
    const inputs = await getPriceDefaultInputs('co-1', 'v-1', 'part-bar');
    const resolved = resolveLinePriceDefault(inputs, { quantity: 12, today: TODAY });
    expect(resolved.price).toMatchObject({ unitPrice: 55, priceSource: 'last_po' });
    expect(resolved.price.warnings.join(' ')).toMatch(/expired/);
  });
});
