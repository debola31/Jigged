/**
 * The RFQ comparison matrix and the award (plan §3.9, criterion Q3).
 *
 * Rows are line × quantity; columns are vendors. Each response is priced per the RFQ line's own
 * unit, so a row compares like with like. "Lowest" is a word on the cell, never a colour alone;
 * an expired quote is never Lowest; a tie goes to the shorter lead time; a no-bid is out.
 */
import { describe, it, expect } from 'vitest';
import {
  LOWEST_LABEL,
  compareVendorRfq,
  planVendorRfqAward,
  type RfqCompareLine,
  type RfqCompareResponse,
  type RfqCompareVendor,
} from '@/lib/purchasing/rfqCompare';

const TODAY = '2026-11-09';

const lines: RfqCompareLine[] = [
  { lineId: 'L1', lineNumber: 1, label: 'BAR-6061', unit: 'bar', quantities: [10, 50] },
  { lineId: 'L2', lineNumber: 2, label: 'Anodize fixture', unit: 'each', quantities: [1] },
];

const vendors: RfqCompareVendor[] = [
  { invitationId: 'iA', vendorId: 'A', vendorName: 'Acme' },
  { invitationId: 'iB', vendorId: 'B', vendorName: 'Beta' },
  { invitationId: 'iC', vendorId: 'C', vendorName: 'Cobalt', declined: true },
];

const response = (over: Partial<RfqCompareResponse> & { responseId: string }): RfqCompareResponse => ({
  invitationId: 'iA',
  lineId: 'L1',
  quantity: 10,
  unitPrice: 36,
  noBid: false,
  leadTimeDays: 10,
  validUntil: null,
  awarded: false,
  ...over,
});

const responses: RfqCompareResponse[] = [
  response({ responseId: 'a10', invitationId: 'iA', quantity: 10, unitPrice: 36, leadTimeDays: 10, validUntil: '2026-12-31' }),
  response({ responseId: 'b10', invitationId: 'iB', quantity: 10, unitPrice: 35, leadTimeDays: 14 }),
  response({ responseId: 'a50', invitationId: 'iA', quantity: 50, unitPrice: 33, leadTimeDays: 10 }),
  response({ responseId: 'b50', invitationId: 'iB', quantity: 50, unitPrice: 33, leadTimeDays: 7 }),
  response({ responseId: 'aL2', invitationId: 'iA', lineId: 'L2', quantity: 1, unitPrice: 100, validUntil: '2026-11-01' }),
  response({ responseId: 'bL2', invitationId: 'iB', lineId: 'L2', quantity: 1, unitPrice: null, noBid: true }),
];

const compare = (rs: RfqCompareResponse[] = responses) => compareVendorRfq({ lines, vendors, responses: rs, today: TODAY });

describe('compareVendorRfq — the matrix (Q3)', () => {
  it('has one row per line and quantity, in line then quantity order, and one column per vendor', () => {
    const matrix = compare();
    expect(matrix.rows.map((r) => [r.lineId, r.quantity])).toEqual([['L1', 10], ['L1', 50], ['L2', 1]]);
    expect(matrix.vendors.map((v) => v.vendorId)).toEqual(['A', 'B', 'C']);
    for (const row of matrix.rows) expect(row.cells.map((c) => c.vendorId)).toEqual(['A', 'B', 'C']);
  });

  it('marks the lowest price in each row', () => {
    const [row] = compare().rows;
    expect(row.lowestResponseIds).toEqual(['b10']);
    expect(row.cells.map((c) => c.isLowest)).toEqual([false, true, false]);
  });

  it('gives a tie to the shorter lead time', () => {
    expect(compare().rows[1].lowestResponseIds).toEqual(['b50']);
  });

  it('lets an unknown lead time lose a tie to a known one', () => {
    const rs = [
      response({ responseId: 'x', invitationId: 'iA', unitPrice: 20, leadTimeDays: null }),
      response({ responseId: 'y', invitationId: 'iB', unitPrice: 20, leadTimeDays: 30 }),
    ];
    expect(compare(rs).rows[0].lowestResponseIds).toEqual(['y']);
  });

  it('marks every cell of a full tie as lowest rather than picking one silently', () => {
    const rs = [
      response({ responseId: 'x', invitationId: 'iA', unitPrice: 20, leadTimeDays: 5 }),
      response({ responseId: 'y', invitationId: 'iB', unitPrice: 20, leadTimeDays: 5 }),
    ];
    expect(compare(rs).rows[0].lowestResponseIds).toEqual(['x', 'y']);
  });

  it('compares prices at the stored precision, so float noise is not a difference', () => {
    const rs = [
      response({ responseId: 'x', invitationId: 'iA', unitPrice: 0.1 + 0.2, leadTimeDays: 5 }),
      response({ responseId: 'y', invitationId: 'iB', unitPrice: 0.3, leadTimeDays: 9 }),
    ];
    expect(compare(rs).rows[0].lowestResponseIds).toEqual(['x']);
  });

  it('never calls an expired quote lowest, even when it is the only price', () => {
    const row = compare().rows[2];
    expect(row.cells[0]).toMatchObject({ state: 'expired', isLowest: false, responseId: 'aL2' });
    expect(row.lowestResponseIds).toEqual([]);
  });

  it('still counts a quote on its last valid day', () => {
    const rs = [response({ responseId: 'x', invitationId: 'iA', validUntil: TODAY })];
    expect(compare(rs).rows[0].cells[0]).toMatchObject({ state: 'priced', isLowest: true });
  });

  it('leaves a no-bid out of the comparison', () => {
    expect(compare().rows[2].cells[1]).toMatchObject({ state: 'no_bid', isLowest: false, amount: null });
  });

  it('reads a blank price as no quote', () => {
    const rs = [response({ responseId: 'x', invitationId: 'iA', unitPrice: null })];
    expect(compare(rs).rows[0].cells[0]).toMatchObject({ state: 'no_response', responseId: 'x', isLowest: false });
  });

  it('shows a declined vendor as declined, never lowest', () => {
    const rs = [response({ responseId: 'z', invitationId: 'iC', unitPrice: 1 })];
    const cell = compare(rs).rows[0].cells[2];
    expect(cell).toMatchObject({ state: 'declined', isLowest: false });
  });

  it('shows a vendor with nothing for that row as no response', () => {
    expect(compare([]).rows[0].cells[0]).toEqual({
      invitationId: 'iA', vendorId: 'A', vendorName: 'Acme', responseId: null, state: 'no_response',
      unitPrice: null, amount: null, leadTimeDays: null, validUntil: null, isLowest: false,
    });
  });

  it('carries the quote\'s amount at that quantity', () => {
    expect(compare().rows[0].cells[0]).toMatchObject({ unitPrice: 36, amount: 360, leadTimeDays: 10, validUntil: '2026-12-31' });
  });

  it('says "Lowest" in words', () => {
    expect(LOWEST_LABEL).toBe('Lowest');
  });
});

describe('planVendorRfqAward — one draft PO per vendor (Q3)', () => {
  const plan = (ids: string[], rs: RfqCompareResponse[] = responses) =>
    planVendorRfqAward(ids, { lines, vendors, responses: rs, today: TODAY });

  it('makes one draft per vendor chosen', () => {
    expect(plan(['a50'])).toEqual({
      poCount: 1,
      vendors: [{ vendorId: 'A', vendorName: 'Acme', responseIds: ['a50'] }],
      problems: [],
      warnings: [],
    });
  });

  it('counts two vendors as two drafts', () => {
    const awarded = plan(['b10', 'aL2']);
    expect(awarded.poCount).toBe(2);
    expect(awarded.vendors.map((v) => v.vendorId)).toEqual(['A', 'B']);
  });

  it('allows an expired quote to be awarded, but says so', () => {
    expect(plan(['aL2']).warnings).toEqual(['Acme\'s quote for line 2 expired 11/1/26.']);
  });

  it('takes one quote per line', () => {
    expect(plan(['a10', 'b50']).problems).toEqual(['Pick one quote for line 1.']);
  });

  it('refuses a no-bid, a blank price, a declined vendor and an unknown quote', () => {
    expect(plan(['bL2']).problems).toEqual(['Beta did not quote line 2.']);
    expect(plan(['x'], [response({ responseId: 'x', invitationId: 'iA', unitPrice: null })]).problems).toEqual([
      'Acme did not quote line 1.',
    ]);
    expect(plan(['z'], [response({ responseId: 'z', invitationId: 'iC' })]).problems).toEqual(['Cobalt declined this RFQ.']);
    expect(plan(['nope']).problems).toEqual(['That quote is not on this RFQ.']);
  });

  it('refuses a line that is already awarded', () => {
    const rs = responses.map((r) => (r.responseId === 'a10' ? { ...r, awarded: true } : r));
    expect(plan(['b10'], rs).problems).toEqual(['Line 1 is already awarded.']);
  });

  it('asks for a pick when nothing is chosen', () => {
    expect(plan([])).toMatchObject({ poCount: 0, problems: ['Pick a quote for at least one line.'] });
  });
});
