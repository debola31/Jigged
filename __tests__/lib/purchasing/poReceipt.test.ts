/**
 * The receive dialog's row rules (plan §3.7, criteria R3 and R6).
 *
 * The dialog sends one atomic `receive_vendor_purchase_order` call. These rules decide what goes
 * in it: a cleared row is skipped, a zero is refused with a sentence, a part row needs a place,
 * and split rows add up per line before the over/short captions are worked out. Quantities go to
 * the database exactly as typed, in whichever unit was typed — never pre-converted, so there is
 * no round-trip drift.
 */
import { describe, it, expect } from 'vitest';
import {
  HEAT_STARTS_TRACKING_CAPTION,
  defaultReceiptLocationId,
  planVendorPoReceipt,
  prefillVendorPoReceiptRows,
  receiptOutstanding,
  type ReceiptLine,
  type ReceiptRow,
} from '@/lib/purchasing/poReceipt';

const barLine = (over: Partial<ReceiptLine> = {}): ReceiptLine => ({
  lineId: 'l1',
  lineNumber: 1,
  lineKind: 'part',
  orderedQuantity: 3,
  unit: 'bar',
  stockUnit: 'inches',
  stockFactor: 144,
  receivedStockQuantity: 0,
  closed: false,
  ...over,
});

const freightLine = (over: Partial<ReceiptLine> = {}): ReceiptLine => ({
  lineId: 'l2',
  lineNumber: 2,
  lineKind: 'other',
  orderedQuantity: 1,
  unit: 'each',
  stockUnit: null,
  stockFactor: null,
  receivedQuantity: 0,
  closed: false,
  ...over,
});

const outsideLine = (over: Partial<ReceiptLine> = {}): ReceiptLine => ({
  lineId: 'l3',
  lineNumber: 3,
  lineKind: 'outside_service',
  orderedQuantity: 50,
  unit: 'each',
  stockUnit: null,
  stockFactor: null,
  closed: false,
  jobNumber: 'J-1042',
  ...over,
});

const row = (over: Partial<ReceiptRow> = {}): ReceiptRow => ({
  rowKey: 'r1',
  lineId: 'l1',
  quantity: '2',
  quantityUnit: 'purchase',
  locationId: 'shelf-a',
  ...over,
});

describe('planVendorPoReceipt — which rows are sent (R3, R6)', () => {
  it('skips a cleared row and sends the rest', () => {
    const plan = planVendorPoReceipt([barLine(), freightLine()], [
      row({ rowKey: 'r1', quantity: '' }),
      row({ rowKey: 'r2', lineId: 'l2', quantity: '1', locationId: null }),
    ]);
    expect(plan.ok).toBe(true);
    expect(plan.problems).toEqual([]);
    expect(plan.entries.map((e) => e.line_id)).toEqual(['l2']);
  });

  it('asks for something when every row is cleared', () => {
    const plan = planVendorPoReceipt([barLine()], [row({ quantity: '  ' })]);
    expect(plan.ok).toBe(false);
    expect(plan.entries).toEqual([]);
    expect(plan.problems).toEqual([{ rowKey: null, field: 'form', message: 'Enter what arrived on at least one line.' }]);
  });

  it('refuses 0 with a sentence instead of sending it', () => {
    const plan = planVendorPoReceipt([barLine()], [row({ quantity: '0' })]);
    expect(plan.ok).toBe(false);
    expect(plan.problems).toEqual([
      { rowKey: 'r1', field: 'quantity', message: 'Enter more than 0, or clear the row to skip it.' },
    ]);
    expect(plan.entries).toEqual([]);
  });

  it('refuses a negative or non-numeric quantity with a sentence', () => {
    expect(planVendorPoReceipt([barLine()], [row({ quantity: '-2' })]).problems[0].message).toBe(
      'Enter more than 0, or clear the row to skip it.',
    );
    expect(planVendorPoReceipt([barLine()], [row({ quantity: 'two' })]).problems[0].message).toBe(
      'Enter a number, or clear the row to skip it.',
    );
    expect(planVendorPoReceipt([barLine()], [row({ quantity: '1e3' })]).problems[0].field).toBe('quantity');
  });

  it('needs a place for a part row', () => {
    const plan = planVendorPoReceipt([barLine()], [row({ locationId: null })]);
    expect(plan.ok).toBe(false);
    expect(plan.problems).toEqual([{ rowKey: 'r1', field: 'location', message: 'Choose where it goes.' }]);
  });

  it('records an other line by quantity only, with no place, heat or lot', () => {
    const plan = planVendorPoReceipt([freightLine()], [
      row({ lineId: 'l2', quantity: '1', locationId: 'shelf-a', heatNumber: 'H1', lotId: 'lot-1', quantityUnit: 'stock' }),
    ]);
    expect(plan.entries).toEqual([
      {
        line_id: 'l2', quantity: 1, quantity_unit: 'purchase', location_id: null,
        heat_number: null, lot_id: null, notes: null, close_remaining: false,
      },
    ]);
  });

  it('refuses an outside line with the database\'s own sentence', () => {
    const plan = planVendorPoReceipt([outsideLine()], [row({ lineId: 'l3', quantity: '10' })]);
    expect(plan.ok).toBe(false);
    expect(plan.problems).toEqual([
      { rowKey: 'r1', field: 'line', message: 'Outside work is received on its vendor packing slip.' },
    ]);
  });

  it('refuses a closed line, and a line that is not on this PO', () => {
    expect(planVendorPoReceipt([barLine({ closed: true })], [row()]).problems[0]).toEqual({
      rowKey: 'r1', field: 'line', message: 'Line 1 is closed — reopen it to receive more.',
    });
    expect(planVendorPoReceipt([barLine()], [row({ lineId: 'nope' })]).problems[0]).toEqual({
      rowKey: 'r1', field: 'line', message: 'That line is not on this PO.',
    });
  });

  it('sends the quantity in the unit it was typed in — purchase or stock — never converted', () => {
    const plan = planVendorPoReceipt([barLine()], [row({ quantity: '288', quantityUnit: 'stock' })]);
    expect(plan.entries[0]).toMatchObject({ quantity: 288, quantity_unit: 'stock' });
    expect(plan.lines[0]).toMatchObject({ receivingQuantity: 2, receivingStockQuantity: 288 });
  });

  it('trims the text it sends and turns blanks into nothing', () => {
    const plan = planVendorPoReceipt([barLine()], [row({ heatNumber: ' ht-9 ', notes: '  ', lotId: 'lot-3' })]);
    expect(plan.entries[0]).toMatchObject({ heat_number: 'ht-9', notes: null, lot_id: 'lot-3', location_id: 'shelf-a' });
  });
});

describe('planVendorPoReceipt — per-line totals and captions (R3, R6)', () => {
  it('adds split rows up per line, keeping one entry per place or heat', () => {
    const plan = planVendorPoReceipt([barLine()], [
      row({ rowKey: 'r1', quantity: '2', locationId: 'shelf-a', heatNumber: 'H1' }),
      row({ rowKey: 'r2', quantity: '144', quantityUnit: 'stock', locationId: 'shelf-b', heatNumber: 'H2' }),
    ]);
    expect(plan.entries).toHaveLength(2);
    expect(plan.lines).toEqual([
      expect.objectContaining({
        lineId: 'l1', receivingQuantity: 3, receivingStockQuantity: 432,
        remainingAfter: 0, overQuantity: 0, overCaption: null, shortCaption: null, closesRemaining: false,
      }),
    ]);
  });

  it('flags an over-receipt in amber words and still records it', () => {
    const plan = planVendorPoReceipt([barLine()], [row({ quantity: '4' })]);
    expect(plan.ok).toBe(true);
    expect(plan.entries).toHaveLength(1);
    expect(plan.lines[0]).toMatchObject({
      overQuantity: 1,
      overCaption: '1 bar more than ordered — recorded as over-received',
    });
  });

  it('counts what already arrived toward over and short', () => {
    const plan = planVendorPoReceipt([barLine({ receivedStockQuantity: 288 })], [row({ quantity: '2' })]);
    expect(plan.lines[0].overCaption).toBe('1 bar more than ordered — recorded as over-received');
  });

  it('states an over-receipt in stock units when the purchase figure would be a long fraction', () => {
    const plan = planVendorPoReceipt([barLine({ orderedQuantity: 1 })], [row({ quantity: '200', quantityUnit: 'stock' })]);
    expect(plan.lines[0].overCaption).toBe('56 in more than ordered — recorded as over-received');
  });

  it('offers to close the rest only when the line is still short', () => {
    const short = planVendorPoReceipt([barLine()], [row({ quantity: '2' })]);
    expect(short.lines[0]).toMatchObject({
      remainingAfter: 1,
      shortCaption: 'That\'s everything — close the remaining 1 bar',
      closesRemaining: false,
    });
    const complete = planVendorPoReceipt([barLine()], [row({ quantity: '3' })]);
    expect(complete.lines[0].shortCaption).toBeNull();
  });

  it('closes the remainder on every entry of that line when asked, and only when short', () => {
    const asked = planVendorPoReceipt(
      [barLine(), freightLine()],
      [
        row({ rowKey: 'r1', quantity: '1', locationId: 'shelf-a' }),
        row({ rowKey: 'r2', quantity: '1', locationId: 'shelf-b' }),
        row({ rowKey: 'r3', lineId: 'l2', quantity: '1', locationId: null }),
      ],
      { closeRemainingLineIds: ['l1', 'l2'] },
    );
    expect(asked.entries.map((e) => [e.line_id, e.close_remaining])).toEqual([
      ['l1', true],
      ['l1', true],
      ['l2', false], // the freight line is complete, so there is nothing to close
    ]);
    expect(asked.lines.find((l) => l.lineId === 'l1')?.closesRemaining).toBe(true);
  });

  it('reports what is outstanding in both units', () => {
    expect(receiptOutstanding(barLine({ receivedStockQuantity: 100 }))).toEqual({ quantity: 2.305556, stockQuantity: 332 });
    expect(receiptOutstanding(barLine({ receivedStockQuantity: 500 }))).toEqual({ quantity: 0, stockQuantity: 0 });
    expect(receiptOutstanding(freightLine({ receivedQuantity: 0.25 }))).toEqual({ quantity: 0.75, stockQuantity: null });
  });
});

describe('prefillVendorPoReceiptRows — one row per open line, prefilled with what is outstanding (R6)', () => {
  it('prefills part and other lines, and leaves outside and closed lines out', () => {
    const rows = prefillVendorPoReceiptRows(
      [barLine(), freightLine(), outsideLine(), barLine({ lineId: 'l4', lineNumber: 4, closed: true })],
      { defaultLocationIds: { l1: 'shelf-a' } },
    );
    expect(rows).toEqual([
      { rowKey: 'l1', lineId: 'l1', quantity: '3', quantityUnit: 'purchase', locationId: 'shelf-a', heatNumber: '', lotId: null, notes: '' },
      { rowKey: 'l2', lineId: 'l2', quantity: '1', quantityUnit: 'purchase', locationId: null, heatNumber: '', lotId: null, notes: '' },
    ]);
  });

  it('prefills in stock units when the purchase figure would be a long fraction', () => {
    const [prefilled] = prefillVendorPoReceiptRows([barLine({ receivedStockQuantity: 100 })]);
    expect(prefilled).toMatchObject({ quantity: '332', quantityUnit: 'stock' });
  });

  it('leaves a fully received line out', () => {
    expect(prefillVendorPoReceiptRows([barLine({ receivedStockQuantity: 432 })])).toEqual([]);
  });
});

describe('defaultReceiptLocationId — the largest holding, else the last receipt place (R6)', () => {
  it('picks where the part already holds the most', () => {
    expect(
      defaultReceiptLocationId({
        holdings: [
          { locationId: 'a', quantity: 10 },
          { locationId: 'b', quantity: 90 },
          { locationId: 'c', quantity: 50 },
        ],
        lastReceiptLocationId: 'z',
      }),
    ).toBe('b');
  });

  it('ignores empty holdings and falls back to the last place received into', () => {
    expect(defaultReceiptLocationId({ holdings: [{ locationId: 'a', quantity: 0 }], lastReceiptLocationId: 'z' })).toBe('z');
  });

  it('starts empty — and so required — when neither exists', () => {
    expect(defaultReceiptLocationId({ holdings: [], lastReceiptLocationId: null })).toBeNull();
  });
});

describe('the heat caption (R2, R6)', () => {
  it('warns that a heat on an untracked part starts tracking for good', () => {
    expect(HEAT_STARTS_TRACKING_CAPTION).toBe('Recording a heat starts tracking this part by heat, for good.');
  });
});
