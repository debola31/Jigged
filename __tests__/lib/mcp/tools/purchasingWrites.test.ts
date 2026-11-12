import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';

import {
  awardVendorRfqTool,
  closeVendorPoTool,
  createVendorPoTool,
  markVendorPoSentTool,
  markVendorRfqSentTool,
  receiveVendorPoTool,
  recordVendorRfqResponseTool,
  reopenVendorPoTool,
  saveVendorRfqTool,
  updateVendorPoTool,
  vendorPoReceiptGroupId,
  voidVendorPoReceiptTool,
} from '@/lib/mcp/tools/purchasingWrites';
import type { VendorPoReceiveResult } from '@/types/vendorPo';

import {
  CO,
  INVITE1,
  INVITE2,
  JOB_ID,
  LINE1,
  LINE2,
  LOC_RACK,
  LOC_SHELF,
  OP_ID,
  PART_ID,
  PO2_ID,
  PO_ID,
  RECEIPT_ID,
  RESP1,
  RESP2,
  RFQ_ID,
  RFQ_LINE1,
  TODAY,
  VENDOR2_ID,
  VENDOR_ID,
  WC_ID,
  envAs,
  expectContract,
  kit,
  openOp,
  otherLine,
  outsideLine,
  poDetail,
  poHeader,
  poLine,
  poQuickBooks,
  poSummary,
  poUrl,
  priceInputs,
  rfqDetail,
  rfqUrl,
} from './purchasingTestKit';

/**
 * The purchasing WRITE tools for POs and RFQs, run directly (plan §5.4, M2). For every tool: the
 * access function the PO page, receive dialog or RFQ page calls, with the arguments it passes; a
 * company-scoped lookup before any id-only call; the PO (or RFQ) read back in get_vendor_po's (or
 * get_vendor_rfq's) shape, parsing and naming nobody; non-blocking conditions as `warnings`; and
 * the exact refusal sentences, with nothing written.
 */

vi.mock('@/lib/supabase', async () => (await import('./purchasingTestKit')).kit.supabaseModule());
vi.mock('@/utils/vendorPoAccess', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/vendorPoAccess')>()),
  ...(await import('./purchasingTestKit')).kit.wrap([
    'getVendorPo',
    'createVendorPo',
    'updateVendorPo',
    'markVendorPoSent',
    'receiveVendorPo',
    'voidVendorPoReceipt',
    'closeVendorPoLines',
    'reopenVendorPoLines',
    'getPriceDefaultInputs',
    'listOpenOutsideOpsForVendor',
  ]),
}));
vi.mock('@/utils/vendorRfqAccess', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/vendorRfqAccess')>()),
  ...(await import('./purchasingTestKit')).kit.wrap([
    'getVendorRfq',
    'createVendorRfq',
    'saveVendorRfq',
    'setVendorRfqInvitationState',
    'saveVendorRfqResponses',
    'awardVendorRfq',
  ]),
}));
vi.mock('@/utils/inventoryLocationsAccess', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/inventoryLocationsAccess')>()),
  ...(await import('./purchasingTestKit')).kit.wrap(['getLocations']),
}));

const env = envAs('user');

const ACME = { id: VENDOR_ID, name: 'Acme Metals', created_at: '2026-01-01T00:00:00Z', deleted_at: null };
const BAY = { id: VENDOR2_ID, name: 'Bay Steel', created_at: '2026-01-01T00:00:00Z', deleted_at: null };
const BAR = { id: PART_ID, part_name: 'BAR-6061', source: 'bought', primary_unit: 'inches', deleted_at: null };
const LIVE_PO = { id: PO_ID, po_number: 'PO-1042', deleted_at: null };

const LOCATIONS = [
  { id: LOC_RACK, company_id: CO, parent_id: null, name: 'Rack A', kind: null, sort_order: 0, created_at: '', updated_at: '' },
  { id: LOC_SHELF, company_id: CO, parent_id: LOC_RACK, name: 'Shelf 2', kind: null, sort_order: 0, created_at: '', updated_at: '' },
];

beforeEach(() => {
  kit.reset();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(`${TODAY}T18:00:00Z`));
  kit.fn('getVendorPo').mockResolvedValue(poDetail());
  kit.fn('getLocations').mockResolvedValue(LOCATIONS);
});

afterEach(() => {
  vi.useRealTimers();
});

/** Nothing reached the database's write doors. */
function expectNoWrite(...names: string[]) {
  for (const name of names) expect(kit.calls(name), name).toEqual([]);
}

// ================================================================================================
// create_vendor_po
// ================================================================================================

describe('create_vendor_po', () => {
  beforeEach(() => {
    kit.answer('vendors', ACME);
    kit.answer('parts', [BAR]);
    kit.fn('getPriceDefaultInputs').mockResolvedValue(priceInputs());
    kit.fn('listOpenOutsideOpsForVendor').mockResolvedValue([openOp()]);
    kit.fn('createVendorPo').mockResolvedValue({ id: PO_ID, poNumber: 'PO-1042' });
    kit.fn('getVendorPo').mockResolvedValue(poDetail({ summary: poSummary({ status: 'draft' }), header: poHeader({ issuedAt: null, sentRevision: null }) }));
  });

  it('creates a draft the way the PO form does: the database defaults the vendor fields, the price default fills an omitted price', async () => {
    const res = await createVendorPoTool.run({ vendor_name: ' acme metals ', lines: [{ kind: 'part', part_name: 'BAR-6061', quantity: 10 }] }, env);
    if (!res.ok) throw new Error(res.message);

    expect(kit.calls('getPriceDefaultInputs')).toEqual([[CO, VENDOR_ID, PART_ID]]);
    expect(kit.calls('createVendorPo')).toEqual([
      [
        {
          vendorId: VENDOR_ID,
          orderedOn: TODAY,
          today: TODAY,
          header: {},
          lines: [{ lineKind: 'part', partId: PART_ID, quantity: 10, unit: 'bar', unitPrice: 42.5, priceSource: 'price_sheet' }],
        },
      ],
    ]);
    expect(kit.companyScopedBefore('getPriceDefaultInputs')).toBe(true);
    expect(kit.calls('getVendorPo')).toEqual([[PO_ID, { today: TODAY }]]);
    expect(res.data.warnings).toEqual(['Line 1 (BAR-6061): Acme Metals price sheet · 10+ bar · valid to 3/1/27.']);
    expect(res.data).toMatchObject({ vendor_po_id: PO_ID, po_number: 'PO-1042', status: 'draft', url: poUrl() });
    expectContract(createVendorPoTool, res.data);
  });

  it('sends the header and every line kind the form offers, with a typed price winning and a cleared one TBC', async () => {
    kit.queue('vendors', { data: ACME }, { data: BAY });
    kit.answer('jobs', { id: JOB_ID, job_number: 'J-1042', deleted_at: null });
    kit.answer('work_centers', { id: WC_ID, name: 'Haas VF-2', deleted_at: null });
    const res = await createVendorPoTool.run(
      {
        vendor_id: VENDOR_ID,
        ordered_on: '2026-11-08',
        need_by_on: '2026-11-30',
        payment_terms: 'Net 45',
        ship_via: 'Our truck',
        notes_to_vendor: 'Certs with the shipment.',
        internal_notes: 'Rush',
        ship_to: { kind: 'vendor', vendor_id: VENDOR2_ID },
        lines: [
          { kind: 'part', part_id: PART_ID, quantity: 12, unit: 'bar', unit_price: 41, cert_required: true, promised_on: '2026-11-20' },
          { kind: 'outside_service', job_number: 'J-1042' },
          { kind: 'other', description: 'Spindle rebuild', quantity: 1, work_center_id: WC_ID, unit_price: null },
          { kind: 'other', description: 'Freight', quantity: 1, unit_price: 50, expects_receipt: false },
        ],
      },
      env,
    );
    if (!res.ok) throw new Error(res.message);
    expect(kit.calls('listOpenOutsideOpsForVendor')).toEqual([[CO, VENDOR_ID]]);
    expect(kit.calls('createVendorPo')[0][0]).toEqual({
      vendorId: VENDOR_ID,
      orderedOn: '2026-11-08',
      today: TODAY,
      header: {
        needByOn: '2026-11-30',
        paymentTerms: 'Net 45',
        shipVia: 'Our truck',
        notesToVendor: 'Certs with the shipment.',
        internalNotes: 'Rush',
        shipTo: { kind: 'vendor', vendorId: VENDOR2_ID },
      },
      lines: [
        { lineKind: 'part', partId: PART_ID, quantity: 12, unit: 'bar', unitPrice: 41, priceSource: 'manual', certRequired: true, promisedOn: '2026-11-20' },
        // The PO form's outside-line picker: what is left to send, at the vendor's service price.
        { lineKind: 'outside_service', jobOperationId: OP_ID, quantity: 40, unitPrice: 1.25, priceSource: 'vendor_service' },
        { lineKind: 'other', description: 'Spindle rebuild', quantity: 1, workCenterId: WC_ID, unitPrice: null, priceSource: null },
        { lineKind: 'other', description: 'Freight', quantity: 1, unitPrice: 50, priceSource: 'manual', expectsReceipt: false },
      ],
    });
    expect(res.data.warnings).toEqual([
      "Line 2 (Op 30 Anodize on J-1042): Acme Metals's price for Anodize · Job costed at $1.10.",
      "Line 3 (Spindle rebuild) has no price yet: it prints as TBC and can't go to QuickBooks until it is priced.",
    ]);
  });

  it('stores "another unit" with its factor, and prices it from the sheet through that factor', async () => {
    kit.fn('getPriceDefaultInputs').mockResolvedValue(priceInputs({ conversions: [], sheet: null, partVendor: null, lastOrderedUnit: null }));
    const res = await createVendorPoTool.run(
      { vendor_id: VENDOR_ID, lines: [{ kind: 'part', part_name: 'BAR-6061', quantity: 2, unit: 'drop', unit_factor: 72 }] },
      env,
    );
    if (!res.ok) throw new Error(res.message);
    // The estimate (0.30 per inch) at 72 in per drop.
    expect(kit.calls('createVendorPo')[0][0].lines).toEqual([
      { lineKind: 'part', partId: PART_ID, quantity: 2, unit: 'drop', unitFactor: 72, unitPrice: 21.6, priceSource: 'estimate' },
    ]);
    expect(res.data.warnings).toEqual([
      'Line 1 (BAR-6061): Part cost estimate.',
      "Line 1 (BAR-6061): Acme Metals isn't on this part's approved vendor list.",
    ]);
  });

  it("warns about an Other line on a job whose outside step this vendor does: it wouldn't follow the slips", async () => {
    kit.answer('jobs', { id: JOB_ID, job_number: 'J-1042', deleted_at: null });
    const res = await createVendorPoTool.run(
      { vendor_id: VENDOR_ID, lines: [{ kind: 'other', description: 'Anodize', quantity: 40, job_number: 'J-1042', unit_price: 1.25 }] },
      env,
    );
    if (!res.ok) throw new Error(res.message);
    expect(res.data.warnings).toEqual([
      'Line 1 is an Other line on J-1042, which has an outside step Acme Metals does (Op 30 Anodize). An outside-service line would follow the vendor slips.',
    ]);
    expect(kit.calls('createVendorPo')[0][0].lines[0]).toMatchObject({ lineKind: 'other', jobId: JOB_ID });
  });

  it('refuses what the form or the database would refuse, before anything is written', async () => {
    const run = (args: Record<string, unknown>) => createVendorPoTool.run({ vendor_id: VENDOR_ID, ...args } as never, env);

    expect(await createVendorPoTool.run({ lines: [{ kind: 'other', description: 'x', quantity: 1 }] } as never, env)).toEqual({
      ok: false,
      message: 'Give a vendor_id or a vendor_name.',
    });

    kit.answer('vendors', { ...ACME, deleted_at: '2026-10-01T00:00:00Z' });
    expect(await run({ lines: [{ kind: 'other', description: 'x', quantity: 1 }] })).toEqual({
      ok: false,
      message: 'Acme Metals is archived in Jigged, so no PO was created.',
    });
    kit.answer('vendors', ACME);

    expect(await run({ lines: [{ kind: 'part', quantity: 1 }] })).toEqual({
      ok: false,
      message: 'Line 1 is a part line: give part_id or part_name.',
    });
    kit.answer('parts', []);
    expect(await run({ lines: [{ kind: 'part', part_name: 'NOPE-1', quantity: 1 }] })).toEqual({
      ok: false,
      message: 'There is no part named NOPE-1 in Acme Machining.',
    });
    kit.answer('parts', [{ ...BAR, deleted_at: '2026-10-01T00:00:00Z' }]);
    expect(await run({ lines: [{ kind: 'part', part_name: 'BAR-6061', quantity: 1 }] })).toEqual({
      ok: false,
      message: "BAR-6061 is archived in Jigged, so it can't go on a PO.",
    });
    kit.answer('parts', [BAR]);
    expect(await run({ lines: [{ kind: 'part', part_name: 'BAR-6061' }] })).toEqual({ ok: false, message: 'Line 1 needs a quantity.' });

    kit.fn('getPriceDefaultInputs').mockResolvedValue(priceInputs({ conversions: [], sheet: null }));
    expect(await run({ lines: [{ kind: 'part', part_name: 'BAR-6061', quantity: 1, unit: 'bar' }] })).toEqual({
      ok: false,
      message: 'BAR-6061 is stocked in inches and has no conversion for "bar". Give unit_factor (how many inches in one bar), or order in inches.',
    });

    const blocked = priceInputs();
    kit.fn('getPriceDefaultInputs').mockResolvedValue({ ...blocked, partVendor: { ...blocked.partVendor!, status: 'disapproved' } });
    expect(await run({ lines: [{ kind: 'part', part_name: 'BAR-6061', quantity: 1 }] })).toEqual({
      ok: false,
      message: "Line 1 (BAR-6061): Acme Metals is marked Do not use for this part, so it can't go on this PO.",
    });

    expect(await run({ lines: [{ kind: 'other', quantity: 1 }] })).toEqual({
      ok: false,
      message: 'Line 1 is an Other line: give its description.',
    });
    expect(await run({ lines: [{ kind: 'outside_service' }] })).toEqual({
      ok: false,
      message: 'Line 1 is an outside-service line: give the job (job_id or job_number) whose step Acme Metals does.',
    });

    kit.answer('jobs', { id: JOB_ID, job_number: 'J-1042', deleted_at: null });
    kit.fn('listOpenOutsideOpsForVendor').mockResolvedValue([]);
    expect(await run({ lines: [{ kind: 'outside_service', job_number: 'J-1042' }] })).toEqual({
      ok: false,
      message: 'Job J-1042 has no unfinished outside step that Acme Metals does.',
    });
    kit.fn('listOpenOutsideOpsForVendor').mockResolvedValue([
      openOp({ openLine: { vendorPurchaseOrderId: PO2_ID, poNumber: 'PO-1040', lineId: 'l-9', lineNumber: 2 } }),
    ]);
    expect(await run({ lines: [{ kind: 'outside_service', job_number: 'J-1042' }] })).toEqual({
      ok: false,
      message: 'Op 30 on J-1042 is already on PO-1040 line 2 to Acme Metals. Change that line with update_vendor_po instead.',
    });
    kit.fn('listOpenOutsideOpsForVendor').mockResolvedValue([
      openOp(),
      openOp({ jobOperationId: 'op-50', sequence: 50, operationName: 'Plate', serviceName: 'Plate' }),
    ]);
    expect(await run({ lines: [{ kind: 'outside_service', job_number: 'J-1042' }] })).toEqual({
      ok: false,
      message: 'Job J-1042 has more than one outside step that Acme Metals does: Op 30 Anodize, Op 50 Plate. Name one with operation_sequence.',
    });
    kit.fn('listOpenOutsideOpsForVendor').mockResolvedValue([openOp({ leftToSendQuantity: 0 })]);
    expect(await run({ lines: [{ kind: 'outside_service', job_number: 'J-1042' }] })).toEqual({
      ok: false,
      message: 'Nothing is left to send on Op 30 of J-1042, so give the quantity for line 1.',
    });

    expect(await run({ ship_to: { kind: 'customer' }, lines: [{ kind: 'other', description: 'x', quantity: 1 }] })).toEqual({
      ok: false,
      message: 'A ship-to of kind customer needs the customer_id it ships to.',
    });
    expectNoWrite('createVendorPo');

    const input = z.object(createVendorPoTool.input);
    expect(input.safeParse({ vendor_id: VENDOR_ID, lines: [] }).success).toBe(false);
    expect(input.safeParse({ vendor_id: VENDOR_ID, lines: [{ kind: 'part', part_id: PART_ID, quantity: 0 }] }).success).toBe(false);
  });
});

// ================================================================================================
// update_vendor_po
// ================================================================================================

describe('update_vendor_po', () => {
  beforeEach(() => {
    kit.answer('vendor_purchase_orders', LIVE_PO);
    kit.fn('updateVendorPo').mockResolvedValue({
      id: PO_ID,
      poNumber: 'PO-1042',
      status: 'partially_received',
      lineIds: [LINE1],
      linkedOutsideShipmentIds: [],
      unlinkedOutsideShipmentIds: [],
      revision: 1,
      sentRevision: 0,
      revisionBumped: true,
      contentVersion: 4,
      contentChanged: true,
      updatedAt: '2026-11-09T18:00:00.000001+00:00',
    });
  });

  it('saves header and line changes as one patch, passing the staleness token exactly as read', async () => {
    const res = await updateVendorPoTool.run(
      {
        po_number: 'PO-1042',
        need_by_on: '2026-11-25',
        notes_to_vendor: 'Call before delivery.',
        lines: [
          { line_number: 1, quantity: 12, unit_price: 41, promised_on: null },
          { line_number: 2, remove: true },
        ],
      },
      env,
    );
    if (!res.ok) throw new Error(res.message);
    expect(kit.calls('updateVendorPo')).toEqual([
      [
        PO_ID,
        {
          today: TODAY,
          changes: { needByOn: '2026-11-25', notesToVendor: 'Call before delivery.' },
          lines: [{ id: LINE1, quantity: 12, unitPrice: 41, priceSource: 'manual', promisedOn: null }],
          removedLineIds: [LINE2],
          expectedUpdatedAt: '2026-11-02T15:00:00.123456+00:00',
        },
      ],
    ]);
    expect(kit.companyScopedBefore('getVendorPo')).toBe(true);
    expect(res.data.revision_opened).toBe(true);
    expect(res.data.warnings).toEqual([
      'PO-1042 is now Rev 1: send Acme Metals the new PDF and mark it sent with mark_vendor_po_sent.',
    ]);
    expectContract(updateVendorPoTool, res.data);
  });

  it('adds new lines with the same defaults create_vendor_po uses, and says when QuickBooks is now behind', async () => {
    kit.answer('parts', [BAR]);
    kit.fn('getPriceDefaultInputs').mockResolvedValue(priceInputs());
    kit.fn('updateVendorPo').mockResolvedValue({ ...(await kit.fn('updateVendorPo')()), revisionBumped: false });
    kit.fn('getVendorPo').mockResolvedValue(poDetail({ quickbooks: poQuickBooks({ state: 'out_of_date', linkId: 'link-1', linkStatus: 'created', provider: 'qbd', docNumber: 'PO-1042' }) }));
    const res = await updateVendorPoTool.run({ vendor_po_id: PO_ID, add_lines: [{ kind: 'part', part_name: 'BAR-6061', quantity: 1 }] }, env);
    if (!res.ok) throw new Error(res.message);
    expect(kit.calls('getPriceDefaultInputs')).toEqual([[CO, VENDOR_ID, PART_ID]]);
    expect(kit.calls('updateVendorPo')[0][1]).toMatchObject({
      lines: [{ lineKind: 'part', partId: PART_ID, quantity: 1, unit: 'bar', unitPrice: 45, priceSource: 'price_sheet' }],
      removedLineIds: [],
    });
    expect(res.data.revision_opened).toBe(false);
    // "New line": the PO already has a line 1, so an added line is never called that.
    expect(res.data.warnings).toEqual([
      'New line 1 (BAR-6061): Acme Metals price sheet · 1+ bar · valid to 3/1/27.',
      'PO-1042 has changed since it went to QuickBooks; push_vendor_po_to_quickbooks updates it there.',
    ]);
  });

  it('lets a closed PO take internal notes and promised dates, and nothing else', async () => {
    kit.fn('getVendorPo').mockResolvedValue(poDetail({ header: poHeader({ closedAt: '2026-11-08T00:00:00Z' }), summary: poSummary({ status: 'closed' }) }));
    const ok = await updateVendorPoTool.run({ vendor_po_id: PO_ID, internal_notes: 'Paid in full.', lines: [{ line_number: 1, promised_on: '2026-11-21' }] }, env);
    expect(ok.ok).toBe(true);
    expect(kit.calls('updateVendorPo')[0][1]).toMatchObject({
      changes: { internalNotes: 'Paid in full.' },
      lines: [{ id: LINE1, promisedOn: '2026-11-21' }],
    });

    expect(await updateVendorPoTool.run({ vendor_po_id: PO_ID, ship_via: 'FedEx' }, env)).toEqual({
      ok: false,
      message: 'PO-1042 is closed. Reopen it with reopen_vendor_po before changing it.',
    });
    expect(kit.calls('updateVendorPo')).toHaveLength(1);
  });

  it('refuses a removal or quantity the PO cannot take, a line it does not have, and an empty change', async () => {
    expect(await updateVendorPoTool.run({ vendor_po_id: PO_ID, lines: [{ line_number: 1, remove: true }] }, env)).toEqual({
      ok: false,
      message: "Line 1 of PO-1042 has receipts, so it can't be removed. Close it short with close_vendor_po instead.",
    });
    expect(await updateVendorPoTool.run({ vendor_po_id: PO_ID, lines: [{ line_number: 1, quantity: 3 }] }, env)).toEqual({
      ok: false,
      message: "Can't order less than has arrived: 4 bar received on line 1 of PO-1042.",
    });
    expect(await updateVendorPoTool.run({ vendor_po_id: PO_ID, lines: [{ line_number: 7, quantity: 3 }] }, env)).toEqual({
      ok: false,
      message: 'PO-1042 has no line 7. Its lines: 1, 2.',
    });
    expect(await updateVendorPoTool.run({ vendor_po_id: PO_ID, lines: [{ quantity: 3 }] }, env)).toEqual({
      ok: false,
      message: 'Name each line by line_number or vendor_po_line_id.',
    });
    expect(await updateVendorPoTool.run({ vendor_po_id: PO_ID }, env)).toEqual({
      ok: false,
      message: 'Give something to change: a header field, lines or add_lines.',
    });
    kit.answer('vendor_purchase_orders', { ...LIVE_PO, deleted_at: '2026-11-08T00:00:00Z' });
    expect(await updateVendorPoTool.run({ vendor_po_id: PO_ID, ship_via: 'FedEx' }, env)).toEqual({
      ok: false,
      message: 'PO-1042 is archived in Jigged, so nothing was changed.',
    });
    expectNoWrite('updateVendorPo');
  });
});

// ================================================================================================
// mark_vendor_po_sent
// ================================================================================================

describe('mark_vendor_po_sent', () => {
  beforeEach(() => kit.answer('vendor_purchase_orders', LIVE_PO));

  it('records the send the way "Mark as sent" does, and gives the contact to email the PDF to', async () => {
    kit.fn('markVendorPoSent').mockResolvedValue({ id: PO_ID, poNumber: 'PO-1042', action: 'mark_sent' });
    const res = await markVendorPoSentTool.run({ po_number: 'PO-1042' }, env);
    if (!res.ok) throw new Error(res.message);
    expect(kit.calls('markVendorPoSent')).toEqual([[PO_ID, TODAY]]);
    expect(kit.companyScopedBefore('markVendorPoSent')).toBe(true);
    expect(res.data.vendor_email).toBe('lee@acme.test');
    expectContract(markVendorPoSentTool, res.data);
  });

  it('refuses an archived or closed PO, and one with no lines', async () => {
    kit.fn('getVendorPo').mockResolvedValue(poDetail({ header: poHeader({ closedAt: '2026-11-08T00:00:00Z' }) }));
    expect(await markVendorPoSentTool.run({ vendor_po_id: PO_ID }, env)).toEqual({
      ok: false,
      message: 'PO-1042 is closed. Reopen it with reopen_vendor_po before sending it again.',
    });
    kit.fn('getVendorPo').mockResolvedValue(poDetail({ lines: [] }));
    expect(await markVendorPoSentTool.run({ vendor_po_id: PO_ID }, env)).toEqual({
      ok: false,
      message: 'Add at least one line before sending PO-1042.',
    });
    kit.answer('vendor_purchase_orders', { ...LIVE_PO, deleted_at: '2026-11-08T00:00:00Z' });
    expect(await markVendorPoSentTool.run({ vendor_po_id: PO_ID }, env)).toEqual({
      ok: false,
      message: 'PO-1042 is archived in Jigged, so nothing was changed.',
    });
    expectNoWrite('markVendorPoSent');
  });
});

// ================================================================================================
// receive_vendor_po
// ================================================================================================

function receiveResult(o: Partial<VendorPoReceiveResult> = {}): VendorPoReceiveResult {
  return {
    vendorPurchaseOrderId: PO_ID,
    receiptGroupId: 'g',
    status: 'received',
    closedLineIds: [],
    receipts: [
      {
        receiptId: 'rc-9',
        entryIndex: 0,
        lineId: LINE1,
        lineNumber: 1,
        lineKind: 'part',
        quantity: 6,
        unit: 'bar',
        stockQuantity: 864,
        stockUnit: 'inches',
        partId: PART_ID,
        locationId: LOC_SHELF,
        locationName: 'Shelf 2',
        lotId: 'lot-9',
        lotCode: 'H4471',
        heatNumber: 'H4471',
        startedTracking: false,
        transactionId: 'txn-9',
        voided: false,
        locationBalance: 864,
        partQuantity: 1000,
        lineStatus: 'received',
        overReceived: false,
        overReceivedQuantity: 0,
      },
    ],
    landedLots: [{ entryIndex: 0, lineId: LINE1, lotId: 'lot-9', lotCode: 'H4471', heatNumber: 'H4471' }],
    ...o,
  };
}

describe('receive_vendor_po', () => {
  beforeEach(() => {
    kit.answer('vendor_purchase_orders', LIVE_PO);
    kit.fn('receiveVendorPo').mockResolvedValue(receiveResult());
  });

  it("receives one delivery as the receive dialog does: its planner's entries, one id per delivery", async () => {
    const res = await receiveVendorPoTool.run(
      {
        po_number: 'PO-1042',
        lines: [{ line_number: 1, quantity: 6, location: 'Rack A › Shelf 2', heat_number: 'h4471' }],
        vendor_packing_slip: 'PS-91',
      },
      env,
    );
    if (!res.ok) throw new Error(res.message);
    const entries = [
      { line_id: LINE1, quantity: 6, quantity_unit: 'purchase', location_id: LOC_SHELF, heat_number: 'h4471', lot_id: null, notes: null, close_remaining: false },
    ];
    expect(kit.calls('getLocations')).toEqual([[CO]]);
    expect(kit.calls('receiveVendorPo')).toEqual([
      [PO_ID, { receiptGroupId: vendorPoReceiptGroupId(CO, PO_ID, entries, 'PS-91', TODAY), entries, vendorPackingSlip: 'PS-91' }],
    ]);
    expect(kit.companyScopedBefore('receiveVendorPo')).toBe(true);
    expect(res.data.received).toEqual([
      {
        receipt_id: 'rc-9',
        line_number: 1,
        quantity: 6,
        unit: 'bar',
        stock_quantity: 864,
        stock_unit: 'inches',
        location: 'Shelf 2',
        heat_number: 'H4471',
        lot_code: 'H4471',
        started_lot_tracking: false,
        over_received: false,
      },
    ]);
    expect(res.data.already_received).toBe(false);
    // Line 1 asks for certs; an assistant cannot upload one.
    expect(res.data.warnings).toEqual(['Line 1 needs a mill cert: attach it to lot H4471 of BAR-6061 in Jigged.']);
    expectContract(receiveVendorPoTool, res.data);
  });

  it('derives the same delivery id for the same call on the same day, and a new one otherwise', () => {
    const e = (quantity: number, heat: string | null = 'H1') => [
      { line_id: LINE1, quantity, quantity_unit: 'purchase' as const, location_id: LOC_SHELF, heat_number: heat, lot_id: null, notes: null, close_remaining: false },
    ];
    const base = vendorPoReceiptGroupId(CO, PO_ID, e(6), 'PS-91', TODAY);
    expect(base).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(vendorPoReceiptGroupId(CO, PO_ID, e(6, 'h1'), ' PS-91 ', TODAY)).toBe(base);
    expect(vendorPoReceiptGroupId(CO, PO_ID, e(7), 'PS-91', TODAY)).not.toBe(base);
    expect(vendorPoReceiptGroupId(CO, PO_ID, e(6), 'PS-92', TODAY)).not.toBe(base);
    expect(vendorPoReceiptGroupId(CO, PO_ID, e(6), 'PS-91', '2026-11-10')).not.toBe(base);
    expect(vendorPoReceiptGroupId(CO, PO2_ID, e(6), 'PS-91', TODAY)).not.toBe(base);
  });

  it('says when the call repeated a delivery already recorded, and closes the rest when asked', async () => {
    kit.answer('vendor_purchase_order_receipts', [], 1);
    const res = await receiveVendorPoTool.run(
      { vendor_po_id: PO_ID, lines: [{ line_number: 1, quantity: 288, unit: 'stock', location_id: LOC_SHELF, close_remaining: true }] },
      env,
    );
    if (!res.ok) throw new Error(res.message);
    expect(kit.calls('receiveVendorPo')[0][1].entries).toEqual([
      { line_id: LINE1, quantity: 288, quantity_unit: 'stock', location_id: LOC_SHELF, heat_number: null, lot_id: null, notes: null, close_remaining: true },
    ]);
    expect(kit.queries('vendor_purchase_order_receipts')).toContainEqual(
      expect.objectContaining({ method: 'eq', args: ['company_id', CO] }),
    );
    expect(res.data.already_received).toBe(true);
  });

  it('flags an over-receipt and a heat that started lot tracking, and still records them', async () => {
    kit.fn('receiveVendorPo').mockResolvedValue(
      receiveResult({
        receipts: [{ ...receiveResult().receipts[0], quantity: 7, stockQuantity: 1008, startedTracking: true, overReceived: true, overReceivedQuantity: 1 }],
      }),
    );
    const res = await receiveVendorPoTool.run(
      { vendor_po_id: PO_ID, lines: [{ line_number: 1, quantity: 7, location_id: LOC_SHELF, heat_number: 'H4471' }] },
      env,
    );
    if (!res.ok) throw new Error(res.message);
    expect(res.data.warnings).toEqual([
      'Line 1: 1 bar more than ordered — recorded as over-received.',
      'Line 1: recording heat H4471 started tracking BAR-6061 by heat, for good.',
      'Line 1 needs a mill cert: attach it to lot H4471 of BAR-6061 in Jigged.',
    ]);
    expect(res.data.received[0]).toMatchObject({ over_received: true, started_lot_tracking: true });
  });

  it('refuses what the receive dialog refuses, naming the tool that fixes it', async () => {
    const run = (lines: Array<Record<string, unknown>>) => receiveVendorPoTool.run({ vendor_po_id: PO_ID, lines } as never, env);

    kit.fn('getVendorPo').mockResolvedValue(poDetail({ summary: poSummary({ status: 'draft' }), header: poHeader({ issuedAt: null, sentRevision: null }) }));
    expect(await run([{ line_number: 1, quantity: 1, location_id: LOC_SHELF }])).toEqual({
      ok: false,
      message: "PO-1042 is a draft: it hasn't been sent to Acme Metals, so nothing can be received against it. Mark it sent with mark_vendor_po_sent first.",
    });

    kit.fn('getVendorPo').mockResolvedValue(poDetail({ lines: [poLine(), otherLine(), outsideLine()] }));
    expect(await run([{ line_number: 3, quantity: 1 }])).toEqual({
      ok: false,
      message: 'Line 3 of PO-1042 is an outside-service line: receive it with receive_outside, naming its vendor slip.',
    });
    expect(await run([{ line_number: 1, quantity: 1 }])).toEqual({
      ok: false,
      message: 'Line 1 of PO-1042 (BAR-6061) needs a location_id or location: where the stock went.',
    });
    expect(await run([{ line_number: 2, quantity: 1, location_id: LOC_SHELF }])).toEqual({
      ok: false,
      message: "Line 2 of PO-1042 isn't stocked, so it takes no location.",
    });
    expect(await run([{ line_number: 1, quantity: 1, location: 'Rack A' }])).toEqual({
      ok: false,
      message: 'Rack A has locations inside it, and stock goes in one of those rather than in it (for example Rack A › Shelf 2).',
    });
    expect(await run([{ line_number: 9, quantity: 1 }])).toEqual({ ok: false, message: 'PO-1042 has no line 9. Its lines: 1, 2, 3.' });

    kit.fn('getVendorPo').mockResolvedValue(poDetail({ lines: [poLine({ closedAt: '2026-11-08T00:00:00Z', status: 'closed' })] }));
    expect(await run([{ line_number: 1, quantity: 1, location_id: LOC_SHELF }])).toEqual({
      ok: false,
      message: 'Line 1 of PO-1042 is closed. Reopen it with reopen_vendor_po to receive more.',
    });
    expectNoWrite('receiveVendorPo');
  });
});

// ================================================================================================
// void_vendor_po_receipt
// ================================================================================================

describe('void_vendor_po_receipt', () => {
  it('voids a receipt of this company through the stock engine, and reads the PO back', async () => {
    kit.answer('vendor_purchase_order_receipts', { id: RECEIPT_ID, vendor_purchase_order_id: PO_ID, voided_at: null });
    kit.fn('voidVendorPoReceipt').mockResolvedValue({ voided: true, receiptId: RECEIPT_ID, voidTransactionId: 't', locationBalance: 0, partQuantity: 0, status: 'sent' });
    const res = await voidVendorPoReceiptTool.run({ receipt_id: RECEIPT_ID, reason: 'Wrong heat' }, env);
    if (!res.ok) throw new Error(res.message);
    expect(kit.calls('voidVendorPoReceipt')).toEqual([[RECEIPT_ID, 'Wrong heat']]);
    expect(kit.companyScopedBefore('voidVendorPoReceipt')).toBe(true);
    expect(kit.calls('getVendorPo')).toEqual([[PO_ID, { today: TODAY }]]);
    expect(res.data.voided_receipt_id).toBe(RECEIPT_ID);
    expectContract(voidVendorPoReceiptTool, res.data);
  });

  it('refuses a receipt that is not in this company, or is already voided', async () => {
    expect(await voidVendorPoReceiptTool.run({ receipt_id: RECEIPT_ID }, env)).toEqual({
      ok: false,
      message: 'There is no PO receipt with that id in Acme Machining.',
    });
    kit.answer('vendor_purchase_order_receipts', { id: RECEIPT_ID, vendor_purchase_order_id: PO_ID, voided_at: '2026-11-08T00:00:00Z' });
    expect(await voidVendorPoReceiptTool.run({ receipt_id: RECEIPT_ID }, env)).toEqual({
      ok: false,
      message: 'That receipt is already voided, so nothing was changed.',
    });
    expectNoWrite('voidVendorPoReceipt');
  });
});

// ================================================================================================
// close_vendor_po / reopen_vendor_po
// ================================================================================================

describe('close_vendor_po', () => {
  beforeEach(() => {
    kit.answer('vendor_purchase_orders', LIVE_PO);
    kit.fn('closeVendorPoLines').mockResolvedValue({ id: PO_ID, lineIds: [] });
  });

  it("closes the whole PO, or the lines named, and says it is still open in QuickBooks", async () => {
    kit.fn('getVendorPo').mockResolvedValue(poDetail({ quickbooks: poQuickBooks({ state: 'out_of_date', linkId: 'link-1', linkStatus: 'created', provider: 'qbo' }) }));
    const all = await closeVendorPoTool.run({ po_number: 'PO-1042', reason: 'Vendor short-shipped' }, env);
    if (!all.ok) throw new Error(all.message);
    expect(kit.calls('closeVendorPoLines')).toEqual([[PO_ID, 'all', 'Vendor short-shipped']]);
    expect(all.data.warnings).toEqual(['PO-1042 is still open in QuickBooks; push_vendor_po_to_quickbooks closes it there.']);
    expectContract(closeVendorPoTool, all.data);

    kit.fn('closeVendorPoLines').mockResolvedValue({ id: PO_ID, lineIds: [LINE1] });
    const some = await closeVendorPoTool.run({ vendor_po_id: PO_ID, line_numbers: [1] }, env);
    if (!some.ok) throw new Error(some.message);
    expect(kit.calls('closeVendorPoLines')[1]).toEqual([PO_ID, [LINE1], undefined]);
    expect(some.data.closed_line_numbers).toEqual([1]);
  });

  it('refuses a draft, a PO already closed, and lines it does not have or already closed', async () => {
    kit.fn('getVendorPo').mockResolvedValue(poDetail({ summary: poSummary({ status: 'draft' }), header: poHeader({ issuedAt: null, sentRevision: null }) }));
    expect(await closeVendorPoTool.run({ vendor_po_id: PO_ID }, env)).toEqual({
      ok: false,
      message: "PO-1042 hasn't been sent, so there is nothing to close. Archive it with archive_record instead.",
    });
    kit.fn('getVendorPo').mockResolvedValue(poDetail({ header: poHeader({ closedAt: '2026-11-08T00:00:00Z' }) }));
    expect(await closeVendorPoTool.run({ vendor_po_id: PO_ID }, env)).toEqual({
      ok: false,
      message: 'PO-1042 is already closed, so nothing was changed.',
    });
    kit.fn('getVendorPo').mockResolvedValue(poDetail({ lines: [poLine({ closedAt: '2026-11-08T00:00:00Z' }), otherLine()] }));
    expect(await closeVendorPoTool.run({ vendor_po_id: PO_ID, line_numbers: [1] }, env)).toEqual({
      ok: false,
      message: 'Line 1 of PO-1042 is already closed.',
    });
    expect(await closeVendorPoTool.run({ vendor_po_id: PO_ID, line_numbers: [4] }, env)).toEqual({
      ok: false,
      message: 'PO-1042 has no line 4. Its lines: 1, 2.',
    });
    expectNoWrite('closeVendorPoLines');
  });
});

describe('reopen_vendor_po', () => {
  beforeEach(() => {
    kit.answer('vendor_purchase_orders', LIVE_PO);
    kit.fn('reopenVendorPoLines').mockResolvedValue({ id: PO_ID, lineIds: [] });
  });

  it('reopens a closed PO, or closed lines, and says QuickBooks still has it closed', async () => {
    kit.fn('getVendorPo').mockResolvedValue(
      poDetail({
        header: poHeader({ closedAt: '2026-11-08T00:00:00Z' }),
        quickbooks: poQuickBooks({ state: 'out_of_date', linkId: 'link-1', linkStatus: 'created', closedInQuickBooks: true }),
      }),
    );
    const res = await reopenVendorPoTool.run({ vendor_po_id: PO_ID }, env);
    if (!res.ok) throw new Error(res.message);
    expect(kit.calls('reopenVendorPoLines')).toEqual([[PO_ID, 'all']]);
    expect(res.data.warnings).toEqual(['PO-1042 is still closed in QuickBooks; push_vendor_po_to_quickbooks reopens it there.']);
    expectContract(reopenVendorPoTool, res.data);

    kit.fn('getVendorPo').mockResolvedValue(poDetail({ lines: [poLine({ closedAt: '2026-11-08T00:00:00Z', status: 'closed' }), otherLine()] }));
    kit.fn('reopenVendorPoLines').mockResolvedValue({ id: PO_ID, lineIds: [LINE1] });
    const line = await reopenVendorPoTool.run({ vendor_po_id: PO_ID, line_numbers: [1] }, env);
    if (!line.ok) throw new Error(line.message);
    expect(kit.calls('reopenVendorPoLines')[1]).toEqual([PO_ID, [LINE1]]);
    expect(line.data.reopened_line_numbers).toEqual([1]);
  });

  it('refuses what is not closed, pointing at closed lines when the PO itself is open', async () => {
    expect(await reopenVendorPoTool.run({ vendor_po_id: PO_ID }, env)).toEqual({ ok: false, message: "PO-1042 isn't closed, so nothing was changed." });
    kit.fn('getVendorPo').mockResolvedValue(poDetail({ lines: [poLine({ closedAt: '2026-11-08T00:00:00Z' }), otherLine({ closedAt: '2026-11-08T00:00:00Z' })] }));
    expect(await reopenVendorPoTool.run({ vendor_po_id: PO_ID }, env)).toEqual({
      ok: false,
      message: "PO-1042 isn't closed as a whole; lines 1, 2 are closed short. Name them in line_numbers to reopen them.",
    });
    kit.fn('getVendorPo').mockResolvedValue(poDetail());
    expect(await reopenVendorPoTool.run({ vendor_po_id: PO_ID, line_numbers: [2] }, env)).toEqual({
      ok: false,
      message: "Line 2 of PO-1042 isn't closed.",
    });
    expectNoWrite('reopenVendorPoLines');
  });
});

// ================================================================================================
// RFQs
// ================================================================================================

const LIVE_RFQ = { id: RFQ_ID, rfq_number: 'RFQ-0004', deleted_at: null };

describe('save_vendor_rfq', () => {
  beforeEach(() => {
    kit.fn('getVendorRfq').mockResolvedValue(rfqDetail());
  });

  it('creates an RFQ in this company with its lines and invited vendors, as the RFQ form does', async () => {
    kit.answer('vendors', [ACME, BAY]);
    kit.answer('parts', [BAR]);
    kit.fn('createVendorRfq').mockResolvedValue({ id: RFQ_ID, rfqNumber: 'RFQ-0004' });
    const res = await saveVendorRfqTool.run(
      {
        title: 'Bar stock for November',
        respond_by_on: '2026-11-16',
        lines: [
          { part_name: 'BAR-6061', unit: 'bar', quantities: [10, 25], cert_required: true },
          { description: 'Fixture plate, 1/2in', quantities: [2] },
        ],
        invite_vendor_ids: [VENDOR_ID, VENDOR2_ID],
      },
      env,
    );
    if (!res.ok) throw new Error(res.message);
    expect(kit.calls('createVendorRfq')).toEqual([
      [
        CO,
        {
          header: { title: 'Bar stock for November', respondByOn: '2026-11-16' },
          lines: [
            { partId: PART_ID, unit: 'bar', quantities: [10, 25], certRequired: true },
            { description: 'Fixture plate, 1/2in', quantities: [2] },
          ],
          vendorIds: [VENDOR_ID, VENDOR2_ID],
        },
      ],
    ]);
    expect(kit.queries('vendors')).toContainEqual(expect.objectContaining({ method: 'eq', args: ['company_id', CO] }));
    expect(kit.calls('getVendorRfq')).toEqual([[RFQ_ID, { today: TODAY }]]);
    expect(res.data).toMatchObject({ created: true, vendor_rfq_id: RFQ_ID, url: rfqUrl() });
    expectContract(saveVendorRfqTool, res.data);
  });

  it('saves changes to an existing RFQ as one patch, with the staleness token as read', async () => {
    kit.answer('vendor_rfqs', LIVE_RFQ);
    kit.answer('vendors', [BAY]);
    kit.fn('saveVendorRfq').mockResolvedValue({ id: RFQ_ID, rfqNumber: 'RFQ-0004', status: 'sent', lineIds: [], invitationIds: [], updatedAt: 'x' });
    const res = await saveVendorRfqTool.run(
      {
        rfq_number: 'RFQ-0004',
        respond_by_on: '2026-11-18',
        line_changes: [{ line_number: 1, quantities: [10, 25, 50] }],
        remove_vendor_ids: [VENDOR2_ID],
      },
      env,
    );
    if (!res.ok) throw new Error(res.message);
    expect(kit.calls('saveVendorRfq')).toEqual([
      [
        RFQ_ID,
        {
          changes: { respondByOn: '2026-11-18' },
          lines: [{ id: RFQ_LINE1, quantities: [10, 25, 50] }],
          removedLineIds: [],
          addVendorIds: [],
          removedInvitationIds: [INVITE2],
          expectedUpdatedAt: '2026-11-04T00:00:00.123456+00:00',
        },
      ],
    ]);
    expect(kit.companyScopedBefore('getVendorRfq')).toBe(true);
    expect(res.data.created).toBe(false);
  });

  it('refuses an RFQ with no lines, a vendor of another company, an archived RFQ and an uninvited vendor', async () => {
    expect(await saveVendorRfqTool.run({ title: 'x' }, env)).toEqual({ ok: false, message: 'Add at least one line to the RFQ.' });
    kit.answer('vendors', []);
    expect(await saveVendorRfqTool.run({ lines: [{ description: 'x', quantities: [1] }], invite_vendor_ids: [VENDOR_ID] }, env)).toEqual({
      ok: false,
      message: 'There is no vendor with that id in Acme Machining.',
    });
    expect(await saveVendorRfqTool.run({ lines: [{ quantities: [1] }] }, env)).toEqual({
      ok: false,
      message: 'Line 1 needs a part (part_id or part_name) or a description.',
    });
    kit.answer('vendor_rfqs', { ...LIVE_RFQ, deleted_at: '2026-11-08T00:00:00Z' });
    expect(await saveVendorRfqTool.run({ vendor_rfq_id: RFQ_ID, title: 'y' }, env)).toEqual({
      ok: false,
      message: 'RFQ-0004 is archived in Jigged, so nothing was changed.',
    });
    kit.answer('vendor_rfqs', LIVE_RFQ);
    expect(await saveVendorRfqTool.run({ vendor_rfq_id: RFQ_ID, remove_vendor_ids: ['2b000000-0000-4000-8000-000000000009'] }, env)).toEqual({
      ok: false,
      message: "That vendor isn't invited to RFQ-0004.",
    });
    expectNoWrite('createVendorRfq', 'saveVendorRfq');
  });
});

describe('mark_vendor_rfq_sent', () => {
  beforeEach(() => kit.answer('vendor_rfqs', LIVE_RFQ));

  it('marks each invited vendor not yet sent, and gives the emails to send the RFQ to', async () => {
    const base = rfqDetail();
    kit.fn('getVendorRfq').mockResolvedValue({ ...base, invitations: base.invitations.map((i) => ({ ...i, sentAt: null })) });
    kit.fn('setVendorRfqInvitationState').mockResolvedValue({ invitationId: INVITE1, vendorRfqId: RFQ_ID, action: 'mark_sent', status: 'sent' });
    const res = await markVendorRfqSentTool.run({ rfq_number: 'RFQ-0004' }, env);
    if (!res.ok) throw new Error(res.message);
    expect(kit.calls('setVendorRfqInvitationState')).toEqual([
      [INVITE1, 'mark_sent'],
      [INVITE2, 'mark_sent'],
    ]);
    expect(kit.companyScopedBefore('getVendorRfq')).toBe(true);
    expect(res.data.vendor_emails).toEqual([
      { vendor_name: 'Acme Metals', contact_name: 'Lee Sales', email: 'lee@acme.test' },
      { vendor_name: 'Bay Steel', contact_name: null, email: null },
    ]);
    expectContract(markVendorRfqSentTool, res.data);
  });

  it('refuses when every invited vendor is already marked sent, or the vendor named is not invited', async () => {
    kit.fn('getVendorRfq').mockResolvedValue(rfqDetail());
    expect(await markVendorRfqSentTool.run({ vendor_rfq_id: RFQ_ID }, env)).toEqual({
      ok: false,
      message: 'Every vendor invited to RFQ-0004 is already marked sent.',
    });
    expect(await markVendorRfqSentTool.run({ vendor_rfq_id: RFQ_ID, vendor_ids: ['2b000000-0000-4000-8000-000000000009'] }, env)).toEqual({
      ok: false,
      message: "That vendor isn't invited to RFQ-0004.",
    });
    expectNoWrite('setVendorRfqInvitationState');
  });
});

describe('record_vendor_rfq_response', () => {
  beforeEach(() => {
    kit.answer('vendor_rfqs', LIVE_RFQ);
    kit.fn('getVendorRfq').mockResolvedValue(rfqDetail());
    kit.fn('saveVendorRfqResponses').mockResolvedValue({ invitationId: INVITE1, vendorRfqId: RFQ_ID, responseIds: [RESP1], status: 'quoted' });
  });

  it("records a vendor's quote, keeping the answers it already gave that this call does not change", async () => {
    const res = await recordVendorRfqResponseTool.run(
      {
        vendor_rfq_id: RFQ_ID,
        vendor_name: 'acme metals',
        quotes: [{ line_number: 1, quantity: 25, unit_price: 40, lead_time_days: 7 }],
        vendor_quote_reference: 'Q-78',
      },
      env,
    );
    if (!res.ok) throw new Error(res.message);
    expect(kit.calls('saveVendorRfqResponses')).toEqual([
      [
        INVITE1,
        [
          { lineId: RFQ_LINE1, quantity: 10, unitPrice: 42.5, noBid: false, leadTimeDays: 5, minimumOrderQuantity: 2, validUntil: '2027-01-31', vendorPartNumber: 'AL-6061-1', notes: null },
          { lineId: RFQ_LINE1, quantity: 25, unitPrice: 40, noBid: false, leadTimeDays: 7 },
        ],
        { vendorQuoteReference: 'Q-78' },
      ],
    ]);
    expectContract(recordVendorRfqResponseTool, res.data);
  });

  it('refuses a quantity the line does not ask for, a price-less quote, an awarded answer and a declined vendor', async () => {
    const run = (quotes: Array<Record<string, unknown>>, vendor = VENDOR_ID) =>
      recordVendorRfqResponseTool.run({ vendor_rfq_id: RFQ_ID, vendor_id: vendor, quotes } as never, env);
    expect(await run([{ line_number: 1, quantity: 15, unit_price: 1 }])).toEqual({
      ok: false,
      message: 'Line 1 of RFQ-0004 asks for 10 and 25, not 15.',
    });
    expect(await run([{ line_number: 1, quantity: 10 }])).toEqual({
      ok: false,
      message: 'Give a unit_price, or no_bid: true, for line 1 at 10.',
    });
    expect(await run([{ line_number: 2, quantity: 10, unit_price: 1 }])).toEqual({ ok: false, message: 'RFQ-0004 has no line 2. Its lines: 1.' });

    const base = rfqDetail();
    kit.fn('getVendorRfq').mockResolvedValue({ ...base, responses: base.responses.map((r) => (r.id === RESP1 ? { ...r, awardedAt: '2026-11-08T00:00:00Z' } : r)) });
    expect(await run([{ line_number: 1, quantity: 10, unit_price: 41 }])).toEqual({
      ok: false,
      message: "Line 1 at 10 from Acme Metals is already awarded, so its quote can't change.",
    });
    kit.fn('getVendorRfq').mockResolvedValue({ ...base, invitations: base.invitations.map((i) => (i.id === INVITE2 ? { ...i, declinedAt: '2026-11-06T00:00:00Z' } : i)) });
    expect(await run([{ line_number: 1, quantity: 10, unit_price: 41 }], VENDOR2_ID)).toEqual({
      ok: false,
      message: 'Bay Steel declined RFQ-0004. Undo the decline in Jigged before recording its quote.',
    });
    expect(await run([{ line_number: 1, quantity: 10, unit_price: 41 }], '2b000000-0000-4000-8000-000000000009')).toEqual({
      ok: false,
      message: "That vendor isn't invited to RFQ-0004.",
    });
    expectNoWrite('saveVendorRfqResponses');
  });
});

describe('award_vendor_rfq', () => {
  beforeEach(() => {
    kit.answer('vendor_rfqs', LIVE_RFQ);
    kit.fn('getVendorRfq').mockResolvedValue(rfqDetail());
  });

  it('awards by response id in one call, making the draft POs, with price sheets only when asked', async () => {
    kit.fn('awardVendorRfq').mockResolvedValue({
      vendorRfqId: RFQ_ID,
      purchaseOrders: [{ id: PO2_ID, poNumber: 'PO-1043', vendorId: VENDOR_ID, vendorName: 'Acme Metals', lineIds: ['l-1'] }],
      awardedResponseIds: [RESP1],
      savedPartVendorIds: [],
      status: 'awarded',
    });
    const res = await awardVendorRfqTool.run({ rfq_number: 'RFQ-0004', response_ids: [RESP1] }, env);
    if (!res.ok) throw new Error(res.message);
    expect(kit.calls('awardVendorRfq')).toEqual([[RFQ_ID, [RESP1], { saveToPriceSheets: false, today: TODAY }]]);
    expect(kit.companyScopedBefore('awardVendorRfq')).toBe(true);
    expect(res.data).toMatchObject({
      vendor_rfq_id: RFQ_ID,
      rfq_number: 'RFQ-0004',
      status: 'awarded',
      vendor_pos: [{ vendor_po_id: PO2_ID, po_number: 'PO-1043', vendor: { vendor_id: VENDOR_ID, name: 'Acme Metals' }, line_count: 1, url: poUrl(PO2_ID) }],
      saved_to_price_sheets: 0,
      url: rfqUrl(),
    });
    expectContract(awardVendorRfqTool, res.data);
  });

  it("refuses the award picks the compare screen would: a quote not on this RFQ, two for one line", async () => {
    expect(await awardVendorRfqTool.run({ vendor_rfq_id: RFQ_ID, response_ids: ['5e000000-0000-4000-8000-0000000000ff'] }, env)).toEqual({
      ok: false,
      message: 'That quote is not on this RFQ.',
    });
    expect(await awardVendorRfqTool.run({ vendor_rfq_id: RFQ_ID, response_ids: [RESP1, RESP2] }, env)).toEqual({
      ok: false,
      message: 'Pick one quote for line 1.',
    });
    expectNoWrite('awardVendorRfq');
  });
});
