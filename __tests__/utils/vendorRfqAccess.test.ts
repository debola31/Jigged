/**
 * Vendor RFQs — access layer (criteria Q1–Q3).
 *
 * Every write names its RPC and nothing writes a table; lists drop archived RFQs and a by-id read
 * does not; award goes by RESPONSE id with the price-sheet flag passed through; the comparison is
 * the pure rfqCompare fed with the caller's date.
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
  awardVendorRfq,
  compareVendorRfq,
  createVendorRfq,
  getVendorRfq,
  listVendorRfqs,
  saveVendorRfq,
  saveVendorRfqResponses,
  setVendorRfqInvitationState,
  setVendorRfqState,
} from '@/utils/vendorRfqAccess';

const TODAY = '2026-11-09';

beforeEach(() => {
  vi.clearAllMocks();
  stub.reset();
});

function expectNoPurchasingTableWrites() {
  expect(stub.writes().filter((w) => PURCHASING_TABLES.includes(w.table))).toEqual([]);
}

describe('listVendorRfqs', () => {
  it('lists live RFQs of the company with who was asked', async () => {
    stub.queue('vendor_rfq_status', {
      data: [{ id: 'rfq-1', rfq_number: 'RFQ-0003', title: 'Bar stock', status: 'quoted', needed_by_on: null, respond_by_on: '2026-11-15', closed_at: null, line_count: 2, awarded_line_count: 0, invited_count: 2, sent_count: 2, declined_count: 0, responded_count: 1, created_at: 'c', updated_at: 'u' }],
      count: 1,
    });
    stub.queue('vendor_rfq_invitations', { data: [{ vendor_rfq_id: 'rfq-1', vendor_name: 'Acme' }, { vendor_rfq_id: 'rfq-1', vendor_name: 'Beta' }] });
    const result = await listVendorRfqs('co-1', { statuses: ['sent', 'quoted'], search: 'bar' });
    expect(stub.callsOf('vendor_rfq_status', 'eq')).toEqual([['company_id', 'co-1']]);
    expect(stub.callsOf('vendor_rfq_status', 'is')).toEqual([['deleted_at', null]]);
    expect(stub.callsOf('vendor_rfq_status', 'in')).toEqual([['status', ['sent', 'quoted']]]);
    expect(stub.callsOf('vendor_rfq_status', 'or')[0][0]).toMatch(/^rfq_number\.ilike\..*,title\.ilike\./);
    expect(result.rows[0]).toMatchObject({ rfqNumber: 'RFQ-0003', status: 'quoted', respondedCount: 1, invitedCount: 2, vendorNames: ['Acme', 'Beta'] });
    expect(result).toMatchObject({ total: 1, truncated: false });
  });

  it('throws on a failed read', async () => {
    stub.queue('vendor_rfq_status', { error: { code: '08006', message: 'connection failure' } });
    await expect(listVendorRfqs('co-1')).rejects.toThrow('Failed to load the RFQs.');
  });
});

describe('listVendorRfqs — one vendor’s RFQs', () => {
  const statusRow = (id: string, createdAt: string) => ({
    id, rfq_number: `RFQ-${id}`, title: null, status: 'sent', needed_by_on: null, respond_by_on: null, closed_at: null,
    line_count: 1, awarded_line_count: 0, invited_count: 2, sent_count: 2, declined_count: 0, responded_count: 0,
    created_at: createdAt, updated_at: createdAt,
  });

  /** By id, through the invitations: an invitation's NAME is the copy taken when it was sent. */
  it('finds them by the vendor’s invitations, and still names everyone asked on each', async () => {
    stub.queue('vendor_rfq_invitations', { data: [{ vendor_rfq_id: 'rfq-1' }, { vendor_rfq_id: 'rfq-2' }, { vendor_rfq_id: 'rfq-1' }] });
    stub.queue('vendor_rfq_status', { data: [statusRow('rfq-2', '2026-11-08T00:00:00+00:00'), statusRow('rfq-1', '2026-11-01T00:00:00+00:00')], count: 2 });
    stub.queue('vendor_rfq_invitations', {
      data: [
        { vendor_rfq_id: 'rfq-1', vendor_name: 'Acme (old name)' },
        { vendor_rfq_id: 'rfq-1', vendor_name: 'Beta' },
        { vendor_rfq_id: 'rfq-2', vendor_name: 'Acme Steel' },
      ],
    });
    const result = await listVendorRfqs('co-1', { vendorId: 'v-acme', limit: 10 });

    expect(stub.callsOf('vendor_rfq_invitations', 'eq')).toEqual([
      ['company_id', 'co-1'],
      ['vendor_id', 'v-acme'],
    ]);
    expect(stub.callsOf('vendor_rfq_status', 'in')).toEqual([['id', ['rfq-1', 'rfq-2']]]);
    expect(stub.callsOf('vendor_rfq_status', 'is')).toEqual([['deleted_at', null]]);
    expect(stub.callsOf('vendor_rfq_status', 'limit')).toEqual([[10]]);
    expect(result.rows.map((r) => [r.id, r.vendorNames])).toEqual([
      ['rfq-2', ['Acme Steel']],
      ['rfq-1', ['Acme (old name)', 'Beta']],
    ]);
    expect(result).toMatchObject({ total: 2, truncated: false });
  });

  it('is empty, without reading the list, for a vendor never invited', async () => {
    stub.queue('vendor_rfq_invitations', { data: [] });
    await expect(listVendorRfqs('co-1', { vendorId: 'v-new' })).resolves.toEqual({ rows: [], total: 0, truncated: false });
    expect(stub.tables).toEqual(['vendor_rfq_invitations']);
  });

  it('reads more ids than one request holds a chunk at a time, newest first, the counts added', async () => {
    const ids = Array.from({ length: 130 }, (_, i) => `rfq-${String(i).padStart(3, '0')}`);
    stub.queue('vendor_rfq_invitations', { data: ids.map((id) => ({ vendor_rfq_id: id })) });
    stub.queue(
      'vendor_rfq_status',
      { data: [statusRow('rfq-005', '2026-11-05T00:00:00+00:00'), statusRow('rfq-001', '2026-11-01T00:00:00+00:00')], count: 120 },
      { data: [statusRow('rfq-129', '2026-11-09T00:00:00+00:00'), statusRow('rfq-120', '2026-11-03T00:00:00+00:00')], count: 10 },
    );
    const result = await listVendorRfqs('co-1', { vendorId: 'v-acme', limit: 3 });

    const chunks = stub.callsOf('vendor_rfq_status', 'in').map(([, value]) => (value as string[]).length);
    expect(chunks).toEqual([120, 10]);
    expect(result.rows.map((r) => r.id)).toEqual(['rfq-129', 'rfq-005', 'rfq-120']);
    expect(result).toMatchObject({ total: 130, truncated: true });
  });

  it('throws when the invitations cannot be read', async () => {
    stub.queue('vendor_rfq_invitations', { error: { code: '08006', message: 'connection failure' } });
    await expect(listVendorRfqs('co-1', { vendorId: 'v-acme' })).rejects.toThrow('Failed to load the RFQs.');
  });
});

describe('getVendorRfq', () => {
  function queueDetail() {
    stub.queue('vendor_rfqs', {
      data: [{ id: 'rfq-1', company_id: 'co-1', rfq_number: 'RFQ-0003', title: null, needed_by_on: null, respond_by_on: null, notes_to_vendors: null, internal_notes: null, terms_and_conditions: null, ship_to_name: 'Our Shop', ship_to_address: null, closed_at: null, closed_reason: null, created_at: 'c', updated_at: '2026-11-09T10:00:00.123456+00:00', deleted_at: '2026-11-09T11:00:00+00:00' }],
    });
    stub.queue('vendor_rfq_status', { data: [{ status: 'quoted', line_count: 1, awarded_line_count: 0, invited_count: 2, sent_count: 2, declined_count: 1, responded_count: 2 }] });
    stub.queue('vendor_rfq_lines', { data: [{ id: 'ln-1', line_number: 1, part_id: 'part-bar', part_name: 'BAR-6061', description: 'Bar', unit: 'bar', quantities: [10, 50], job_id: null, job_number: null, cert_required: true, notes: null }] });
    stub.queue('vendor_rfq_invitations', {
      data: [
        { id: 'inv-a', vendor_id: 'v-a', vendor_name: 'Acme', vendor_contact_id: 'c-1', vendor_contact: { name: 'Jane', email: 'j@a.test', phone: null }, sent_at: 's', declined_at: null, declined_reason: null, vendor_quote_reference: 'Q-77', quoted_on: '2026-11-08' },
        { id: 'inv-b', vendor_id: 'v-b', vendor_name: 'Beta', vendor_contact_id: null, vendor_contact: null, sent_at: 's', declined_at: null, declined_reason: null, vendor_quote_reference: null, quoted_on: null },
      ],
    });
    stub.queue('vendor_rfq_responses', {
      data: [
        { id: 'r-a10', vendor_rfq_invitation_id: 'inv-a', vendor_rfq_line_id: 'ln-1', quantity: 10, unit_price: 60, no_bid: false, lead_time_days: 5, minimum_order_quantity: null, valid_until: null, vendor_part_number: 'A-1', notes: null, awarded_at: null, vendor_purchase_order_line_id: null },
        { id: 'r-b10', vendor_rfq_invitation_id: 'inv-b', vendor_rfq_line_id: 'ln-1', quantity: 10, unit_price: 55, no_bid: false, lead_time_days: 9, minimum_order_quantity: null, valid_until: '2026-11-01', vendor_part_number: null, notes: null, awarded_at: null, vendor_purchase_order_line_id: null },
        { id: 'r-b50', vendor_rfq_invitation_id: 'inv-b', vendor_rfq_line_id: 'ln-1', quantity: 50, unit_price: null, no_bid: true, lead_time_days: null, minimum_order_quantity: null, valid_until: null, vendor_part_number: null, notes: null, awarded_at: null, vendor_purchase_order_line_id: null },
      ],
    });
  }

  it('reads by id (an archived RFQ still opens) and builds the comparison by the caller\'s date', async () => {
    queueDetail();
    const rfq = await getVendorRfq('rfq-1', { today: TODAY });
    expect(stub.callsOf('vendor_rfqs', 'is')).toEqual([]);
    expect(rfq?.header).toMatchObject({ isArchived: true, updatedAt: '2026-11-09T10:00:00.123456+00:00' });
    expect(rfq?.invitations[0].vendorContact).toEqual({ name: 'Jane', email: 'j@a.test', phone: null });
    const row10 = rfq!.comparison.rows.find((r) => r.quantity === 10)!;
    // Beta is cheaper but its quote expired, so Acme is Lowest.
    expect(row10.lowestResponseIds).toEqual(['r-a10']);
    expect(row10.cells.find((c) => c.vendorName === 'Beta')?.state).toBe('expired');
    const row50 = rfq!.comparison.rows.find((r) => r.quantity === 50)!;
    expect(row50.cells.find((c) => c.vendorName === 'Beta')?.state).toBe('no_bid');
  });

  it('is null when the caller cannot see it', async () => {
    stub.queue('vendor_rfqs', { data: [] });
    await expect(getVendorRfq('rfq-x', { today: TODAY })).resolves.toBeNull();
  });

  it('the comparison helper is the pure rfqCompare over a loaded RFQ', () => {
    const comparison = compareVendorRfq(
      {
        lines: [{ id: 'ln-1', lineNumber: 1, partId: null, partName: null, description: 'Fixture plate', unit: 'each', quantities: [1], jobId: null, jobNumber: null, certRequired: false, notes: null }],
        invitations: [{ id: 'inv-a', vendorId: 'v-a', vendorName: 'Acme', vendorContactId: null, vendorContact: null, sentAt: null, declinedAt: null, declinedReason: null, vendorQuoteReference: null, quotedOn: null }],
        responses: [{ id: 'r-1', invitationId: 'inv-a', lineId: 'ln-1', quantity: 1, unitPrice: 300, noBid: false, leadTimeDays: null, minimumOrderQuantity: null, validUntil: null, vendorPartNumber: null, notes: null, awardedAt: null, vendorPurchaseOrderLineId: null }],
      },
      TODAY,
    );
    expect(comparison.rows[0]).toMatchObject({ label: 'Fixture plate', lowestResponseIds: ['r-1'] });
  });
});

describe('createVendorRfq', () => {
  it('goes through create_vendor_rfq with lines, quantities and vendors', async () => {
    stub.queue('parts', { data: [{ id: 'part-bar', part_name: 'BAR', primary_unit: 'inches', parts_unit_conversions: [{ from_unit: 'bar', to_primary_factor: 144 }] }] });
    stub.rpc.mockResolvedValue({ data: [{ id: 'rfq-1', rfq_number: 'RFQ-0003' }], error: null });
    const result = await createVendorRfq('co-1', {
      header: { title: 'Bar stock', respondByOn: '2026-11-15' },
      lines: [
        { partId: 'part-bar', unit: 'Bar', quantities: [10, 50], certRequired: true },
        { description: 'Fixture plate', quantities: [1] },
      ],
      vendorIds: ['v-a', 'v-b', 'v-a'],
    });
    expect(result).toEqual({ id: 'rfq-1', rfqNumber: 'RFQ-0003' });
    expect(stub.rpc).toHaveBeenCalledWith('create_vendor_rfq', {
      p_company_id: 'co-1',
      p_header: { title: 'Bar stock', respond_by_on: '2026-11-15' },
      p_lines: [
        { part_id: 'part-bar', unit: 'bar', quantities: [10, 50], cert_required: true },
        { description: 'Fixture plate', quantities: [1] },
      ],
      p_vendor_ids: ['v-a', 'v-b'],
    });
    expectNoPurchasingTableWrites();
  });

  it('refuses more than four quantities, a zero, or a repeat, before the call', async () => {
    const tryLine = (quantities: number[]) => createVendorRfq('co-1', { lines: [{ description: 'x', quantities }], vendorIds: [] });
    await expect(tryLine([1, 2, 3, 4, 5])).rejects.toThrow(/one to four quantities/);
    await expect(tryLine([0])).rejects.toThrow(/greater than zero/);
    await expect(tryLine([5, 5])).rejects.toThrow(/once on a line/);
    await expect(createVendorRfq('co-1', { lines: [], vendorIds: [] })).rejects.toThrow(/at least one line/);
    expect(stub.rpc).not.toHaveBeenCalled();
  });
});

describe('saveVendorRfq and the state RPCs', () => {
  it('saves with patch semantics and passes the staleness token through', async () => {
    stub.rpc.mockResolvedValue({ data: { id: 'rfq-1', rfq_number: 'RFQ-0003', status: 'draft', line_ids: ['ln-1'], invitation_ids: ['inv-c'], updated_at: 'u2' }, error: null });
    const result = await saveVendorRfq('rfq-1', {
      changes: { termsAndConditions: null },
      lines: [{ id: 'ln-1', quantities: [10, 25] }],
      addVendorIds: ['v-c'],
      removedInvitationIds: ['inv-b'],
      expectedUpdatedAt: '2026-11-09T10:00:00.123456+00:00',
    });
    expect(stub.rpc).toHaveBeenCalledWith('save_vendor_rfq', {
      p_id: 'rfq-1',
      p_changes: { terms_and_conditions: null },
      p_lines: [{ id: 'ln-1', quantities: [10, 25] }],
      p_removed_line_ids: [],
      p_add_vendor_ids: ['v-c'],
      p_removed_invitation_ids: ['inv-b'],
      p_expected_updated_at: '2026-11-09T10:00:00.123456+00:00',
    });
    expect(result).toMatchObject({ lineIds: ['ln-1'], invitationIds: ['inv-c'], updatedAt: 'u2' });
  });

  it('close / reopen / archive, and the invitation states, each go through their RPC', async () => {
    stub.rpc.mockResolvedValueOnce({ data: { id: 'rfq-1', rfq_number: 'RFQ-0003', action: 'archive', status: 'draft', deleted_at: 'd' }, error: null });
    await expect(setVendorRfqState('rfq-1', 'archive')).resolves.toMatchObject({ action: 'archive', deletedAt: 'd' });
    expect(stub.rpc).toHaveBeenLastCalledWith('set_vendor_rfq_state', { p_id: 'rfq-1', p_action: 'archive', p_reason: undefined });

    stub.rpc.mockResolvedValueOnce({ data: { id: 'inv-a', vendor_rfq_id: 'rfq-1', action: 'decline', status: 'sent' }, error: null });
    await expect(setVendorRfqInvitationState('inv-a', 'decline', 'too busy')).resolves.toMatchObject({ invitationId: 'inv-a', action: 'decline' });
    expect(stub.rpc).toHaveBeenLastCalledWith('set_vendor_rfq_invitation_state', { p_id: 'inv-a', p_action: 'decline', p_reason: 'too busy' });
    expectNoPurchasingTableWrites();
  });
});

describe('saveVendorRfqResponses', () => {
  it("sends the vendor's whole quote: prices per the line unit, and a No bid with no price", async () => {
    stub.rpc.mockResolvedValue({ data: { invitation_id: 'inv-a', vendor_rfq_id: 'rfq-1', response_ids: ['r-1', 'r-2'], status: 'quoted' }, error: null });
    await saveVendorRfqResponses(
      'inv-a',
      [
        { lineId: 'ln-1', quantity: 10, unitPrice: 60, leadTimeDays: 5, validUntil: '2026-12-31' },
        { lineId: 'ln-1', quantity: 50, noBid: true, unitPrice: 999 },
      ],
      { vendorQuoteReference: null, quotedOn: '2026-11-08' },
    );
    expect(stub.rpc).toHaveBeenCalledWith('save_vendor_rfq_responses', {
      p_invitation_id: 'inv-a',
      p_responses: [
        { line_id: 'ln-1', quantity: 10, no_bid: false, unit_price: 60, lead_time_days: 5, valid_until: '2026-12-31' },
        // A No bid carries no price, even if the form still held one.
        { line_id: 'ln-1', quantity: 50, no_bid: true },
      ],
      // null clears the reference: the RPC reads '' as "clear", absent as "keep".
      p_vendor_quote_reference: '',
      p_quoted_on: '2026-11-08',
    });
  });

  it('a declined vendor is refused with the sentence, unreported', async () => {
    stub.rpc.mockResolvedValue({ data: null, error: { code: 'P0001', message: 'Beta declined this RFQ. Undo the decline to record their quote.' } });
    await expect(saveVendorRfqResponses('inv-b', [])).rejects.toThrow(/Undo the decline/);
    expect(mockCapture).not.toHaveBeenCalled();
  });
});

describe('awardVendorRfq', () => {
  it('awards by response id and passes the price-sheet flag through', async () => {
    stub.rpc.mockResolvedValue({
      data: {
        vendor_rfq_id: 'rfq-1',
        purchase_orders: [
          { id: 'po-1', po_number: 'PO-0050', vendor_id: 'v-a', vendor_name: 'Acme', line_ids: ['l-1'] },
          { id: 'po-2', po_number: 'PO-0051', vendor_id: 'v-b', vendor_name: 'Beta', line_ids: ['l-2'] },
        ],
        awarded_response_ids: ['r-a10', 'r-b20'],
        saved_part_vendor_ids: [],
        status: 'awarded',
      },
      error: null,
    });
    const result = await awardVendorRfq('rfq-1', ['r-a10', 'r-b20', 'r-a10'], { saveToPriceSheets: false, today: TODAY });
    expect(stub.rpc).toHaveBeenCalledWith('award_vendor_rfq', {
      p_rfq_id: 'rfq-1',
      p_response_ids: ['r-a10', 'r-b20'],
      p_save_to_price_sheets: false,
      p_today: TODAY,
    });
    // One draft PO per vendor.
    expect(result.purchaseOrders.map((p) => p.poNumber)).toEqual(['PO-0050', 'PO-0051']);
    expect(result.status).toBe('awarded');
    expectNoPurchasingTableWrites();
  });

  it('refuses an empty award before the call, and reports a non-P0001 failure', async () => {
    await expect(awardVendorRfq('rfq-1', [], { saveToPriceSheets: true, today: TODAY })).rejects.toThrow(/at least one line/);
    stub.rpc.mockResolvedValue({ data: null, error: { code: 'XX000', message: 'p_today is required' } });
    await expect(awardVendorRfq('rfq-1', ['r-1'], { saveToPriceSheets: true, today: TODAY })).rejects.toThrow('Failed to award the RFQ.');
    expect(mockCapture).toHaveBeenCalledTimes(1);
  });
});
