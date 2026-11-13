import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import type { ToolTarget } from '@/lib/mcp/defineTool';
import { BAD_CURSOR_MESSAGE } from '@/lib/mcp/tools/shared';
import {
  PURCHASING_TOOLS,
  getBuyListTool,
  getVendorPoTool,
  getVendorRfqTool,
  listVendorPosTool,
  listVendorRfqsTool,
  registerPurchasingTools,
} from '@/lib/mcp/tools/purchasing';
import { PURCHASING_WRITE_TOOLS, registerPurchasingWriteTools } from '@/lib/mcp/tools/purchasingWrites';
import { registerJiggedTools } from '@/lib/mcp/server';

import {
  CO,
  INVITE1,
  INVITE2,
  JOB_ID,
  LINE1,
  ORIGIN,
  PART_ID,
  PO2_ID,
  PO_ID,
  RESP1,
  RESP2,
  RFQ_ID,
  RFQ_LINE1,
  TODAY,
  VENDOR2_ID,
  VENDOR_ID,
  buyList,
  envAs,
  expectContract,
  kit,
  listRow,
  outsideLine,
  poDetail,
  poDetailAllNull,
  poHeader,
  poQuickBooks,
  poReceipt,
  poSlip,
  poSummary,
  poUrl,
  rfqDetail,
  rfqListRow,
  rfqUrl,
} from './purchasingTestKit';

/**
 * The purchasing READ tools, run directly (the wrapper's guards are covered in defineTool.test.ts),
 * plan §5.4 / M1–M3. For every tool: the access function the Purchasing hub calls, with the
 * arguments it passes; a company-scoped lookup before any call that takes only an id; an output
 * that parses (also when every nullable field is null), carries a url to a real page and names
 * nobody; and the exact refusal sentences. Plus the hints of all 23 purchasing tools.
 */

vi.mock('@/lib/supabase', async () => (await import('./purchasingTestKit')).kit.supabaseModule());
vi.mock('@/utils/vendorPoAccess', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/vendorPoAccess')>()),
  ...(await import('./purchasingTestKit')).kit.wrap(['listVendorPos', 'getVendorPo']),
}));
vi.mock('@/utils/vendorRfqAccess', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/vendorRfqAccess')>()),
  ...(await import('./purchasingTestKit')).kit.wrap(['listVendorRfqs', 'getVendorRfq']),
}));
vi.mock('@/utils/buyListAccess', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/buyListAccess')>()),
  ...(await import('./purchasingTestKit')).kit.wrap(['getBuyList']),
}));

const env = envAs('user');

beforeEach(() => {
  kit.reset();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(`${TODAY}T18:00:00Z`));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('list_vendor_pos', () => {
  it('lists live POs to vendors the way the Orders tab asks for them, one page at a time', async () => {
    kit.fn('listVendorPos').mockResolvedValue({ rows: [listRow()], total: 1, truncated: false });
    const res = await listVendorPosTool.run({}, env);
    if (!res.ok) throw new Error(res.message);

    // The hub's default: what is still open, next due first; the caller's date judges "late".
    expect(kit.calls('listVendorPos')).toEqual([
      [
        CO,
        {
          today: TODAY,
          statuses: ['draft', 'sent', 'partially_received'],
          overdueOnly: false,
          sort: { field: 'next_expected_on', direction: 'asc' },
          limit: 25,
          offset: 0,
        },
      ],
    ]);
    expect(res.data).toEqual({
      vendor_pos: [
        {
          vendor_po_id: PO_ID,
          po_number: 'PO-1042',
          status: 'sent',
          overdue: true,
          vendor: { vendor_id: VENDOR_ID, name: 'Acme Metals', url: `${ORIGIN}/dashboard/${CO}/vendors/${VENDOR_ID}` },
          ordered_on: '2026-11-02',
          need_by_on: '2026-11-20',
          next_expected_on: '2026-11-05',
          revision: 1,
          unsent_changes: true,
          first_sent_at: '2026-11-02T15:00:00Z',
          line_count: 2,
          outstanding_line_count: 2,
          total: 475,
          open_value: 475,
          has_unpriced_lines: false,
          job_numbers: ['J-1042'],
          quickbooks_state: 'out_of_date',
          url: poUrl(),
        },
      ],
      total: 1,
      next_cursor: null,
    });
    expectContract(listVendorPosTool, res.data);
  });

  it('passes every filter through, finding the job in this company first', async () => {
    kit.answer('jobs', { id: JOB_ID, job_number: 'J-1042' });
    kit.fn('listVendorPos').mockResolvedValue({ rows: [], total: 0, truncated: false });
    const res = await listVendorPosTool.run(
      {
        statuses: ['received', 'closed'],
        vendor_id: VENDOR_ID,
        job_number: ' J-1042 ',
        overdue: true,
        search: 'bar',
        quickbooks_states: ['out_of_date'],
        sort: 'newest',
      },
      env,
    );
    expect(res).toEqual({ ok: true, data: { vendor_pos: [], total: 0, next_cursor: null } });
    expect(kit.calls('listVendorPos')[0][1]).toEqual({
      today: TODAY,
      statuses: ['received', 'closed'],
      vendorId: VENDOR_ID,
      jobId: JOB_ID,
      overdueOnly: true,
      search: 'bar',
      quickbooksStates: ['out_of_date'],
      sort: { field: 'created_at', direction: 'desc' },
      limit: 25,
      offset: 0,
    });
    const jobQuery = kit.queries('jobs');
    expect(jobQuery).toContainEqual(expect.objectContaining({ method: 'eq', args: ['company_id', CO] }));
    expect(jobQuery).toContainEqual(expect.objectContaining({ method: 'eq', args: ['job_number', 'J-1042'] }));
    expect(jobQuery).toContainEqual(expect.objectContaining({ method: 'is', args: ['deleted_at', null] }));
    expect(kit.companyScopedBefore('listVendorPos')).toBe(true);
  });

  it('pages on the server, at most 50, and refuses a cursor it did not issue', async () => {
    kit.fn('listVendorPos').mockResolvedValue({
      rows: Array.from({ length: 10 }, (_, i) => listRow({ id: `po-${i}`, poNumber: `PO-${1050 + i}` })),
      total: 61,
      truncated: true,
    });
    const res = await listVendorPosTool.run({ limit: 10, cursor: '25' }, env);
    if (!res.ok) throw new Error(res.message);
    expect(kit.calls('listVendorPos')[0][1]).toMatchObject({ limit: 10, offset: 25 });
    expect(res.data.total).toBe(61);
    expect(res.data.next_cursor).toBe('35');

    expect(await listVendorPosTool.run({ cursor: 'abc' }, env)).toEqual({ ok: false, message: BAD_CURSOR_MESSAGE });
    expect(kit.calls('listVendorPos')).toHaveLength(1);
  });

  it('says so when the job named is not in this company', async () => {
    expect(await listVendorPosTool.run({ job_number: 'J-404' }, env)).toEqual({
      ok: false,
      message: 'There is no job J-404 in Acme Machining.',
    });
    expect(kit.calls('listVendorPos')).toEqual([]);
  });
});

describe('get_vendor_po', () => {
  it('reads one PO by number, after finding it in this company, with its lines, receipts and QuickBooks state', async () => {
    kit.answer('vendor_purchase_orders', { id: PO_ID, po_number: 'PO-1042', deleted_at: null });
    kit.fn('getVendorPo').mockResolvedValue(
      poDetail({
        lines: [poDetail().lines[0], outsideLine()],
        outsideSlips: [poSlip()],
        quickbooks: poQuickBooks({
          state: 'in_quickbooks',
          linkId: 'link-1',
          provider: 'qbo',
          linkStatus: 'created',
          docNumber: '1042',
          url: 'https://app.qbo.intuit.com/app/purchaseorder?txnId=7',
          pushedRevision: 0,
          pushedAt: '2026-11-03T10:00:00Z',
        }),
      }),
    );
    const res = await getVendorPoTool.run({ po_number: ' PO-1042 ' }, env);
    if (!res.ok) throw new Error(res.message);

    expect(kit.calls('getVendorPo')).toEqual([[PO_ID, { today: TODAY }]]);
    expect(kit.companyScopedBefore('getVendorPo')).toBe(true);
    expect(kit.queries('vendor_purchase_orders')).toContainEqual(
      expect.objectContaining({ method: 'eq', args: ['po_number', 'PO-1042'] }),
    );

    const d = res.data;
    expect(d).toMatchObject({
      vendor_po_id: PO_ID,
      po_number: 'PO-1042',
      status: 'partially_received',
      overdue: false,
      archived: false,
      revision: 0,
      sent_revision: 0,
      unsent_changes: false,
      vendor: { vendor_id: VENDOR_ID, name: 'Acme Metals', url: `${ORIGIN}/dashboard/${CO}/vendors/${VENDOR_ID}` },
      vendor_contact: { name: 'Lee Sales', email: 'lee@acme.test', phone: '555-0100' },
      ship_to: { kind: 'shop', name: 'Acme Machining' },
      ordered_on: '2026-11-02',
      need_by_on: '2026-11-20',
      payment_terms: 'Net 30',
      ship_via: 'UPS Ground',
      notes_to_vendor: 'Certs with the shipment.',
      internal_notes: 'Ask Lee about the mill cert.',
      total: 475,
      open_value: 255,
      job_numbers: ['J-1042'],
      quickbooks: {
        state: 'in_quickbooks',
        quickbooks: 'online',
        number: '1042',
        quickbooks_url: 'https://app.qbo.intuit.com/app/purchaseorder?txnId=7',
        closed_in_quickbooks: false,
        pushed_revision: 0,
        last_pushed_at: '2026-11-03T10:00:00Z',
      },
      url: poUrl(),
    });
    expect(d.lines[0]).toEqual({
      vendor_po_line_id: LINE1,
      line_number: 1,
      kind: 'part',
      part: { part_id: PART_ID, part_name: 'BAR-6061', url: `${ORIGIN}/dashboard/${CO}/parts/${PART_ID}` },
      description: '6061-T6 bar, 1in round',
      vendor_part_number: 'AL-6061-1',
      quantity: 10,
      unit: 'bar',
      stock_unit: 'inches',
      units_per_purchase_unit: 144,
      unit_price: 42.5,
      price_source: 'price_sheet',
      amount: 425,
      open_value: 255,
      need_by_on: '2026-11-20',
      promised_on: '2026-11-18',
      expected_on: '2026-11-18',
      overdue: false,
      cert_required: true,
      expects_receipt: true,
      job: { job_id: JOB_ID, job_number: 'J-1042', url: `${ORIGIN}/dashboard/${CO}/jobs/${JOB_ID}` },
      operation: null,
      service: null,
      machine: null,
      status: 'partially_received',
      received_quantity: 4,
      open_quantity: 6,
      over_received_quantity: 0,
      ordered_stock_quantity: 1440,
      received_stock_quantity: 576,
      open_stock_quantity: 864,
      sent_quantity: null,
      at_vendor_quantity: null,
      closed_at: null,
      removable: false,
    });
    expect(d.lines[1]).toMatchObject({ kind: 'outside_service', operation: 'Op 30 Anodize', service: 'Anodize', sent_quantity: 40, at_vendor_quantity: 20 });
    expect(d.receipts).toEqual([
      {
        receipt_id: poReceipt().id,
        line_number: 1,
        received_at: '2026-11-05T16:00:00Z',
        quantity: 4,
        unit: 'bar',
        stock_quantity: 576,
        stock_unit: 'inches',
        location: 'Shelf 2',
        lot_code: 'H4471',
        heat_number: 'H4471',
        started_lot_tracking: true,
        vendor_packing_slip: 'PS-88',
        notes: 'Two bars scratched.',
        voided: false,
        voided_at: null,
        void_reason: null,
      },
    ]);
    expect(d.outside_slips).toEqual([
      {
        outside_shipment_id: 'os-1',
        slip_number: 'VPS-1042-1',
        line_number: 3,
        quantity_sent: 40,
        quantity_received: 20,
        quantity_outstanding: 20,
        sent_at: '2026-11-03T09:00:00Z',
        expected_back: '2026-11-15',
        status: 'open',
        url: `${ORIGIN}/dashboard/${CO}/jobs/${JOB_ID}`,
      },
    ]);
    // Who received it is resolved by the access layer for the page; it never leaves Jigged.
    expect(JSON.stringify(d)).not.toContain('Pat Receiver');
    expectContract(getVendorPoTool, d);
  });

  it('finds an archived PO by id and says so, with no deleted_at filter on the lookup', async () => {
    kit.answer('vendor_purchase_orders', { id: PO_ID, po_number: 'PO-1042', deleted_at: '2026-11-08T00:00:00Z' });
    kit.fn('getVendorPo').mockResolvedValue(
      poDetail({ header: poHeader({ deletedAt: '2026-11-08T00:00:00Z', isArchived: true }) }),
    );
    const res = await getVendorPoTool.run({ vendor_po_id: PO_ID }, env);
    if (!res.ok) throw new Error(res.message);
    expect(res.data.archived).toBe(true);
    expect(kit.queries('vendor_purchase_orders')).toContainEqual(expect.objectContaining({ method: 'eq', args: ['id', PO_ID] }));
    expect(kit.queries('vendor_purchase_orders').some((q) => q.method === 'is')).toBe(false);
  });

  it('parses when every nullable field is null', async () => {
    kit.answer('vendor_purchase_orders', { id: PO_ID, po_number: 'PO-1042', deleted_at: null });
    kit.fn('getVendorPo').mockResolvedValue(poDetailAllNull());
    const res = await getVendorPoTool.run({ vendor_po_id: PO_ID }, env);
    if (!res.ok) throw new Error(res.message);
    expect(res.data).toMatchObject({ status: 'draft', vendor_contact: null, vendor_address: null, need_by_on: null, first_sent_at: null });
    expect(res.data.lines[0]).toMatchObject({ part: null, job: null, unit_price: null, price_source: null, amount: null });
    expect(res.data.receipts[0]).toMatchObject({ location: null, heat_number: null, line_number: null });
    expectContract(getVendorPoTool, res.data);
  });

  it('says so when the PO is not in this company, or none was named', async () => {
    expect(await getVendorPoTool.run({ po_number: 'PO-9999' }, env)).toEqual({
      ok: false,
      message: 'There is no vendor PO PO-9999 in Acme Machining.',
    });
    expect(await getVendorPoTool.run({ vendor_po_id: PO_ID }, env)).toEqual({
      ok: false,
      message: 'There is no vendor PO with that id in Acme Machining.',
    });
    expect(await getVendorPoTool.run({}, env)).toEqual({ ok: false, message: 'Give a vendor_po_id or a po_number.' });
    expect(kit.calls('getVendorPo')).toEqual([]);
  });

  it('treats a PO the access layer cannot read as not there', async () => {
    kit.answer('vendor_purchase_orders', { id: PO_ID, po_number: 'PO-1042', deleted_at: null });
    kit.fn('getVendorPo').mockResolvedValue(null);
    expect(await getVendorPoTool.run({ vendor_po_id: PO_ID }, env)).toEqual({
      ok: false,
      message: 'There is no vendor PO with that id in Acme Machining.',
    });
  });

  it('gives a user (not only an admin) every price', async () => {
    kit.answer('vendor_purchase_orders', { id: PO_ID, po_number: 'PO-1042', deleted_at: null });
    kit.fn('getVendorPo').mockResolvedValue(poDetail({ summary: poSummary({ orderedAmount: 475, openAmount: 255 }) }));
    const res = await getVendorPoTool.run({ vendor_po_id: PO_ID }, envAs('user'));
    if (!res.ok) throw new Error(res.message);
    expect(res.data.total).toBe(475);
    expect(res.data.open_value).toBe(255);
    expect(res.data.lines.map((l) => l.unit_price)).toEqual([42.5, 50]);
  });
});

describe('get_buy_list', () => {
  it("reads the Shortages list the hub builds, flattened by vendor, with each row's price and the draft it can join", async () => {
    kit.fn('getBuyList').mockResolvedValue(buyList());
    const res = await getBuyListTool.run({}, env);
    if (!res.ok) throw new Error(res.message);
    expect(kit.calls('getBuyList')).toEqual([[CO, { today: TODAY }]]);
    expect(res.data.rows).toEqual([
      {
        part: { part_id: PART_ID, part_name: 'BAR-6061', url: `${ORIGIN}/dashboard/${CO}/parts/${PART_ID}` },
        stock_unit: 'inches',
        reason: 'job_shortage',
        need_by: '2026-11-25',
        on_hand: 100,
        on_order: 0,
        on_draft: 0,
        demand: 1500,
        position: -1400,
        reorder_point: null,
        jobs: [{ job_id: JOB_ID, job_number: 'J-1042', due_date: '2026-11-25', need: 1500, url: `${ORIGIN}/dashboard/${CO}/jobs/${JOB_ID}` }],
        vendor: { vendor_id: VENDOR_ID, name: 'Acme Metals', url: `${ORIGIN}/dashboard/${CO}/vendors/${VENDOR_ID}` },
        vendor_basis: 'preferred',
        suggested_quantity: 10,
        purchase_unit: 'bar',
        suggested_stock_quantity: 1440,
        minimum_order_quantity: 2,
        unit_price: 42.5,
        price_source: 'price_sheet',
        price_note: 'Acme Metals price sheet · 10+ bar · valid to 3/1/27',
        amount: 425,
        draft_vendor_po: { vendor_po_id: PO2_ID, po_number: 'PO-1043', url: poUrl(PO2_ID) },
        vendor_options: [
          {
            vendor: { vendor_id: VENDOR_ID, name: 'Acme Metals', url: `${ORIGIN}/dashboard/${CO}/vendors/${VENDOR_ID}` },
            status: 'approved',
            purchase_unit: 'bar',
            suggested_quantity: 10,
            unit_price: 42.5,
            price_source: 'price_sheet',
            amount: 425,
          },
        ],
        url: `${ORIGIN}/dashboard/${CO}/purchasing?view=shortages`,
      },
    ]);
    expect(res.data).toMatchObject({
      total: 1,
      next_cursor: null,
      job_row_count: 1,
      reorder_row_count: 0,
      no_vendor_row_count: 0,
      truncated: false,
      url: `${ORIGIN}/dashboard/${CO}/purchasing?view=shortages`,
    });
    expect(res.data.incomparable).toEqual([
      { part: { part_id: expect.any(String), part_name: 'SHIM-2', url: expect.stringContaining('/parts/') }, stock_unit: 'each', job_numbers: ['J-1042'] },
    ]);
    expectContract(getBuyListTool, res.data);
  });

  it('narrows to one vendor or a part number, and says when a read hit its cap', async () => {
    kit.fn('getBuyList').mockResolvedValue(buyList({ truncated: true, truncatedSources: ['job_parts'] }));
    const other = await getBuyListTool.run({ vendor_id: VENDOR2_ID }, env);
    if (!other.ok) throw new Error(other.message);
    expect(other.data.rows).toEqual([]);
    expect(other.data.truncated).toBe(true);
    const named = await getBuyListTool.run({ search: 'bar-6' }, env);
    if (!named.ok) throw new Error(named.message);
    expect(named.data.rows.map((r) => r.part.part_name)).toEqual(['BAR-6061']);
  });
});

describe('list_vendor_rfqs', () => {
  it('lists live RFQs newest first, as the RFQs tab reads them, and pages them', async () => {
    kit.fn('listVendorRfqs').mockResolvedValue({ rows: [rfqListRow()], total: 1, truncated: false });
    const res = await listVendorRfqsTool.run({ statuses: ['quoted'], search: 'bar' }, env);
    if (!res.ok) throw new Error(res.message);
    expect(kit.calls('listVendorRfqs')).toEqual([[CO, { statuses: ['quoted'], search: 'bar', limit: 1000 }]]);
    expect(res.data).toEqual({
      rfqs: [
        {
          vendor_rfq_id: RFQ_ID,
          rfq_number: 'RFQ-0004',
          title: 'Bar stock for November',
          status: 'quoted',
          needed_by_on: '2026-11-30',
          respond_by_on: '2026-11-16',
          line_count: 1,
          awarded_line_count: 0,
          invited_count: 2,
          sent_count: 2,
          declined_count: 0,
          responded_count: 2,
          vendors: ['Acme Metals', 'Bay Steel'],
          created_at: '2026-11-04T00:00:00Z',
          url: rfqUrl(),
        },
      ],
      total: 1,
      next_cursor: null,
    });
    expectContract(listVendorRfqsTool, res.data);
    expect(await listVendorRfqsTool.run({ cursor: 'x' }, env)).toEqual({ ok: false, message: BAD_CURSOR_MESSAGE });
  });
});

describe('get_vendor_rfq', () => {
  it('reads one RFQ after finding it in this company, with the comparison by line and quantity', async () => {
    kit.answer('vendor_rfqs', { id: RFQ_ID, rfq_number: 'RFQ-0004', deleted_at: null });
    kit.fn('getVendorRfq').mockResolvedValue(rfqDetail());
    const res = await getVendorRfqTool.run({ rfq_number: 'RFQ-0004' }, env);
    if (!res.ok) throw new Error(res.message);
    expect(kit.calls('getVendorRfq')).toEqual([[RFQ_ID, { today: TODAY }]]);
    expect(kit.companyScopedBefore('getVendorRfq')).toBe(true);

    expect(res.data).toMatchObject({
      vendor_rfq_id: RFQ_ID,
      rfq_number: 'RFQ-0004',
      status: 'quoted',
      archived: false,
      needed_by_on: '2026-11-30',
      respond_by_on: '2026-11-16',
      url: rfqUrl(),
    });
    expect(res.data.lines).toEqual([
      {
        vendor_rfq_line_id: RFQ_LINE1,
        line_number: 1,
        part: { part_id: PART_ID, part_name: 'BAR-6061', url: `${ORIGIN}/dashboard/${CO}/parts/${PART_ID}` },
        description: '6061-T6 bar, 1in round',
        unit: 'bar',
        quantities: [10, 25],
        job: null,
        cert_required: true,
        notes: null,
      },
    ]);
    expect(res.data.vendors.map((v) => [v.invitation_id, v.vendor.name, v.contact?.email ?? null])).toEqual([
      [INVITE1, 'Acme Metals', 'lee@acme.test'],
      [INVITE2, 'Bay Steel', null],
    ]);
    expect(res.data.comparison[0]).toEqual({
      vendor_rfq_line_id: RFQ_LINE1,
      line_number: 1,
      item: 'BAR-6061',
      unit: 'bar',
      quantity: 10,
      lowest_response_ids: [RESP1],
      offers: [
        {
          response_id: RESP1,
          vendor_id: VENDOR_ID,
          vendor_name: 'Acme Metals',
          state: 'priced',
          unit_price: 42.5,
          amount: 425,
          lead_time_days: 5,
          valid_until: '2027-01-31',
          minimum_order_quantity: 2,
          vendor_part_number: 'AL-6061-1',
          lowest: true,
          awarded: false,
        },
        {
          response_id: RESP2,
          vendor_id: VENDOR2_ID,
          vendor_name: 'Bay Steel',
          state: 'priced',
          unit_price: 44,
          amount: 440,
          lead_time_days: 3,
          valid_until: null,
          minimum_order_quantity: null,
          vendor_part_number: null,
          lowest: false,
          awarded: false,
        },
      ],
    });
    expect(res.data.comparison[1].offers.map((o) => o.state)).toEqual(['no_response', 'no_response']);
    expectContract(getVendorRfqTool, res.data);
  });

  it('finds an archived RFQ by id and says so; says so when there is none', async () => {
    kit.answer('vendor_rfqs', { id: RFQ_ID, rfq_number: 'RFQ-0004', deleted_at: '2026-11-08T00:00:00Z' });
    const base = rfqDetail();
    kit.fn('getVendorRfq').mockResolvedValue({ ...base, header: { ...base.header, deletedAt: '2026-11-08T00:00:00Z', isArchived: true } });
    const res = await getVendorRfqTool.run({ vendor_rfq_id: RFQ_ID }, env);
    expect(res.ok && res.data.archived).toBe(true);

    kit.reset();
    expect(await getVendorRfqTool.run({ rfq_number: 'RFQ-0404' }, env)).toEqual({
      ok: false,
      message: 'There is no RFQ RFQ-0404 in Acme Machining.',
    });
    expect(await getVendorRfqTool.run({ vendor_rfq_id: RFQ_ID }, env)).toEqual({
      ok: false,
      message: 'There is no RFQ with that id in Acme Machining.',
    });
    expect(await getVendorRfqTool.run({}, env)).toEqual({ ok: false, message: 'Give a vendor_rfq_id or an rfq_number.' });
    expect(kit.calls('getVendorRfq')).toEqual([]);
  });
});

describe('the purchasing catalogue', () => {
  const ALL = [...PURCHASING_TOOLS, ...PURCHASING_WRITE_TOOLS];

  it('declares the hints the design sets, [access, destructive, idempotent, openWorld], for all 23', () => {
    const hints = Object.fromEntries(
      ALL.map((t) => [t.name, [t.access, Boolean(t.destructive), Boolean(t.idempotent), Boolean(t.openWorld)]]),
    );
    expect(hints).toEqual({
      list_vendor_pos: ['read', false, false, false],
      get_vendor_po: ['read', false, false, false],
      get_buy_list: ['read', false, false, false],
      get_part_vendors: ['read', false, false, false],
      list_vendor_rfqs: ['read', false, false, false],
      get_vendor_rfq: ['read', false, false, false],
      preview_part_cost_from_vendor: ['read', false, false, false],
      preview_vendor_po_push: ['read', false, false, true],
      create_vendor_po: ['write', false, false, false],
      update_vendor_po: ['write', false, false, false],
      mark_vendor_po_sent: ['write', false, true, false],
      receive_vendor_po: ['write', false, false, false],
      void_vendor_po_receipt: ['write', true, true, false],
      close_vendor_po: ['write', true, true, false],
      reopen_vendor_po: ['write', false, true, false],
      save_part_vendor: ['write', false, true, false],
      set_part_cost_from_vendor: ['write', true, true, false],
      save_vendor_rfq: ['write', false, false, false],
      mark_vendor_rfq_sent: ['write', false, true, false],
      record_vendor_rfq_response: ['write', false, true, false],
      award_vendor_rfq: ['write', true, false, false],
      push_vendor_po_to_quickbooks: ['write', true, true, true],
      verify_vendor_po_push: ['write', false, true, true],
    });
  });

  it('registers exactly those, and the server serves them', () => {
    const names: string[] = [];
    const server = { registerTool: (name: string) => void names.push(name) } as unknown as ToolTarget;
    registerPurchasingTools(server);
    registerPurchasingWriteTools(server);
    expect(names).toEqual(ALL.map((t) => t.name));

    const served: string[] = [];
    registerJiggedTools({ registerTool: (name: string) => void served.push(name) } as unknown as ToolTarget);
    for (const name of names) expect(served).toContain(name);
  });

  it('says "to a vendor" in every vendor PO tool, so nothing reads as the customer\'s PO', () => {
    for (const tool of ALL.filter((t) => t.name.includes('vendor_po'))) {
      expect(tool.description, tool.name).toMatch(/to a vendor/);
      expect(tool.name).not.toMatch(/(^|_)purchase_order/);
    }
  });
});
