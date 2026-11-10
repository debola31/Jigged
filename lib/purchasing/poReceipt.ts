/**
 * The office receive dialog's row rules (plan §3.7 "Receiving").
 *
 * The dialog sends ONE atomic `receive_vendor_purchase_order` call, and these rules decide its
 * entries: a cleared row is skipped, 0 is refused with a sentence, a part row needs a place, and
 * the rows of one line (split across places or heats) add up before the over and short captions
 * are worked out. Over-receipt is allowed — flagged in amber, still recorded.
 *
 * Each quantity goes to the database EXACTLY as typed, in the unit it was typed in (`purchase` or
 * `stock`); the RPC computes `stock_quantity` itself with the line's frozen factor. Nothing here
 * pre-converts what is sent, so there is no round-trip drift (100 in → bars → back is 99.999936).
 * The conversions below are for the captions only.
 *
 * Outside-service lines are never received here: their work comes back on the vendor packing slip,
 * and the dialog links out to `ReceiveFromVendorDialog` instead.
 */
import { roundDecimal } from '@/lib/money';
import {
  formatUnitQuantity,
  STOCK_QUANTITY_PLACES,
  toPurchaseQuantity,
  toStockQuantity,
  unitLabel,
} from '@/lib/purchasing/purchaseUnits';

export type ReceiptQuantityUnit = 'purchase' | 'stock';

/** One PO line, as the receive dialog sees it. */
export interface ReceiptLine {
  lineId: string;
  lineNumber: number;
  lineKind: 'part' | 'outside_service' | 'other';
  /** In the purchase unit. */
  orderedQuantity: number;
  /** The purchase unit. */
  unit: string;
  /** Part lines: the frozen stock unit and factor. */
  stockUnit: string | null;
  stockFactor: number | null;
  /** Part lines: Σ live receipts so far, in stock units (exact — progress is counted in stock). */
  receivedStockQuantity?: number;
  /** Other lines: Σ live receipts so far, in the purchase unit. */
  receivedQuantity?: number;
  /** The line (or its PO) is closed. */
  closed: boolean;
  /** Outside lines: where to receive them instead ("Receive on J-1042"). */
  jobNumber?: string | null;
}

/** One row of the dialog. A line may have several (another heat or place). */
export interface ReceiptRow {
  rowKey: string;
  lineId: string;
  /** Exactly what is in the box. */
  quantity: string;
  quantityUnit: ReceiptQuantityUnit;
  locationId: string | null;
  heatNumber?: string | null;
  lotId?: string | null;
  notes?: string | null;
}

/** One `p_receipts` entry for `receive_vendor_purchase_order`. */
export interface ReceiptEntry {
  line_id: string;
  quantity: number;
  quantity_unit: ReceiptQuantityUnit;
  location_id: string | null;
  heat_number: string | null;
  lot_id: string | null;
  notes: string | null;
  /**
   * A per-LINE flag, set on every entry of a line the user said is finished: the database closes
   * what is still outstanding after the whole batch is recorded.
   */
  close_remaining: boolean;
}

export interface ReceiptProblem {
  /** The row it belongs to; `null` for the form as a whole. */
  rowKey: string | null;
  field: 'quantity' | 'location' | 'line' | 'form';
  message: string;
}

/** What one line looks like once this delivery is counted. */
export interface ReceiptLineSummary {
  lineId: string;
  /** This delivery, in the purchase unit. */
  receivingQuantity: number;
  /** This delivery, in stock units; `null` for other lines. */
  receivingStockQuantity: number | null;
  /** Still outstanding after it, in the purchase unit (never negative). */
  remainingAfter: number;
  /** How much more than ordered, in the purchase unit; 0 when not over. */
  overQuantity: number;
  /** "1 bar more than ordered — recorded as over-received" (amber). */
  overCaption: string | null;
  /** "That's everything — close the remaining 1 bar", only while the line is still short. */
  shortCaption: string | null;
  /** The user asked to close the rest, and there is a rest to close. */
  closesRemaining: boolean;
}

export interface ReceiptPlan {
  ok: boolean;
  entries: ReceiptEntry[];
  problems: ReceiptProblem[];
  lines: ReceiptLineSummary[];
}

export const OUTSIDE_LINE_RECEIPT_MESSAGE = 'Outside work is received on its vendor packing slip.';
export const HEAT_STARTS_TRACKING_CAPTION = 'Recording a heat starts tracking this part by heat, for good.';

const QUANTITY_TEXT = /^-?(\d+\.?\d*|\.\d+)$/;
const TOLERANCE = 1e-9;

function text(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed === '' ? null : trimmed;
}

function hasStock(line: ReceiptLine): line is ReceiptLine & { stockUnit: string; stockFactor: number } {
  return line.lineKind === 'part' && !!line.stockUnit && line.stockFactor !== null && line.stockFactor > 0;
}

/** What is still outstanding on a line, in both units (stock is `null` for other lines). */
export function receiptOutstanding(line: ReceiptLine): { quantity: number; stockQuantity: number | null } {
  if (hasStock(line)) {
    const ordered = toStockQuantity(line.orderedQuantity, line.stockFactor);
    const stock = Math.max(0, roundDecimal(ordered - (line.receivedStockQuantity ?? 0), STOCK_QUANTITY_PLACES));
    return { quantity: toPurchaseQuantity(stock, line.stockFactor), stockQuantity: stock };
  }
  const quantity = Math.max(0, roundDecimal(line.orderedQuantity - (line.receivedQuantity ?? 0), STOCK_QUANTITY_PLACES));
  return { quantity, stockQuantity: null };
}

/** A figure worth showing in the purchase unit: no more than four decimals once rounded. */
function isClean(n: number): boolean {
  return Math.abs(roundDecimal(n, 4) - n) < TOLERANCE;
}

/** A quantity in whichever unit reads cleanly: purchase units when tidy, else stock units. */
function describeQuantity(stockQuantity: number, line: ReceiptLine): string {
  if (hasStock(line)) {
    const purchase = toPurchaseQuantity(stockQuantity, line.stockFactor);
    if (isClean(purchase)) return `${formatUnitQuantity(purchase)} ${unitLabel(line.unit)}`;
    return `${formatUnitQuantity(stockQuantity)} ${unitLabel(line.stockUnit)}`;
  }
  return `${formatUnitQuantity(stockQuantity)} ${unitLabel(line.unit)}`;
}

/** Turn the dialog's rows into the RPC's entries, the per-line captions, and any problems. */
export function planVendorPoReceipt(
  lines: readonly ReceiptLine[],
  rows: readonly ReceiptRow[],
  options: { closeRemainingLineIds?: Iterable<string> } = {},
): ReceiptPlan {
  const byId = new Map(lines.map((l) => [l.lineId, l]));
  const closeRequested = new Set(options.closeRemainingLineIds ?? []);
  const problems: ReceiptProblem[] = [];
  const accepted: Array<{ row: ReceiptRow; line: ReceiptLine; quantity: number; unit: ReceiptQuantityUnit }> = [];

  for (const row of rows) {
    const typed = row.quantity.trim();
    if (typed === '') continue; // a cleared row is skipped, not refused
    const line = byId.get(row.lineId);
    if (!line) {
      problems.push({ rowKey: row.rowKey, field: 'line', message: 'That line is not on this PO.' });
      continue;
    }
    if (line.lineKind === 'outside_service') {
      problems.push({ rowKey: row.rowKey, field: 'line', message: OUTSIDE_LINE_RECEIPT_MESSAGE });
      continue;
    }
    if (line.closed) {
      problems.push({
        rowKey: row.rowKey,
        field: 'line',
        message: `Line ${line.lineNumber} is closed — reopen it to receive more.`,
      });
      continue;
    }
    if (!QUANTITY_TEXT.test(typed)) {
      problems.push({ rowKey: row.rowKey, field: 'quantity', message: 'Enter a number, or clear the row to skip it.' });
      continue;
    }
    const quantity = Number(typed);
    if (!(quantity > 0)) {
      problems.push({ rowKey: row.rowKey, field: 'quantity', message: 'Enter more than 0, or clear the row to skip it.' });
      continue;
    }
    if (line.lineKind === 'part' && !row.locationId) {
      problems.push({ rowKey: row.rowKey, field: 'location', message: 'Choose where it goes.' });
      continue;
    }
    // An other line has one unit; a stock unit only exists on part lines.
    const unit: ReceiptQuantityUnit = hasStock(line) ? row.quantityUnit : 'purchase';
    accepted.push({ row, line, quantity, unit });
  }

  // Per line: what this delivery adds, in stock units for part lines (exact) and purchase units
  // for other lines.
  const receiving = new Map<string, number>();
  for (const { line, quantity, unit } of accepted) {
    const add = hasStock(line) && unit === 'purchase' ? toStockQuantity(quantity, line.stockFactor) : quantity;
    receiving.set(line.lineId, roundDecimal((receiving.get(line.lineId) ?? 0) + add, STOCK_QUANTITY_PLACES));
  }

  const summaries: ReceiptLineSummary[] = [];
  const closing = new Set<string>();
  for (const [lineId, amount] of receiving) {
    const line = byId.get(lineId);
    if (!line) continue;
    const before = receiptOutstanding(line);
    const outstanding = before.stockQuantity ?? before.quantity; // stock for part lines
    const after = roundDecimal(outstanding - amount, STOCK_QUANTITY_PLACES);
    const remaining = Math.max(0, after);
    const over = Math.max(0, -after);
    const toPurchase = (n: number) => (hasStock(line) ? toPurchaseQuantity(n, line.stockFactor) : n);
    const isShort = remaining > TOLERANCE;
    const closes = isShort && closeRequested.has(lineId);
    if (closes) closing.add(lineId);
    summaries.push({
      lineId,
      receivingQuantity: toPurchase(amount),
      receivingStockQuantity: hasStock(line) ? amount : null,
      remainingAfter: toPurchase(remaining),
      overQuantity: toPurchase(over),
      overCaption: over > TOLERANCE ? `${describeQuantity(over, line)} more than ordered — recorded as over-received` : null,
      shortCaption: isShort ? `That's everything — close the remaining ${describeQuantity(remaining, line)}` : null,
      closesRemaining: closes,
    });
  }

  const entries: ReceiptEntry[] = accepted.map(({ row, line, quantity, unit }) => {
    const isPart = line.lineKind === 'part';
    return {
      line_id: line.lineId,
      quantity,
      quantity_unit: unit,
      location_id: isPart ? row.locationId : null,
      heat_number: isPart ? text(row.heatNumber) : null,
      lot_id: isPart ? (row.lotId ?? null) : null,
      notes: text(row.notes),
      close_remaining: closing.has(line.lineId),
    };
  });

  if (entries.length === 0 && problems.length === 0) {
    problems.push({ rowKey: null, field: 'form', message: 'Enter what arrived on at least one line.' });
  }

  return { ok: problems.length === 0, entries, problems, lines: summaries };
}

/**
 * The dialog's starting rows: one per open part or other line, prefilled with what is
 * outstanding — in the purchase unit when that is a tidy number, else in stock units, so the
 * prefill is exact. Outside lines, closed lines and fully received lines get no row.
 */
export function prefillVendorPoReceiptRows(
  lines: readonly ReceiptLine[],
  options: { defaultLocationIds?: Record<string, string | null | undefined> } = {},
): ReceiptRow[] {
  const rows: ReceiptRow[] = [];
  for (const line of lines) {
    if (line.lineKind === 'outside_service' || line.closed) continue;
    const outstanding = receiptOutstanding(line);
    if (!(outstanding.quantity > TOLERANCE)) continue;
    const inStock = hasStock(line) && !isClean(outstanding.quantity) && outstanding.stockQuantity !== null;
    const quantity = inStock ? (outstanding.stockQuantity as number) : roundDecimal(outstanding.quantity, 4);
    rows.push({
      rowKey: line.lineId,
      lineId: line.lineId,
      quantity: String(quantity),
      quantityUnit: inStock ? 'stock' : 'purchase',
      locationId: line.lineKind === 'part' ? (options.defaultLocationIds?.[line.lineId] ?? null) : null,
      heatNumber: '',
      lotId: null,
      notes: '',
    });
  }
  return rows;
}

/**
 * Where a part's delivery goes by default: the place it already holds the most, else the last
 * place it was received into, else nowhere — and the field is then required.
 */
export function defaultReceiptLocationId(args: {
  holdings: ReadonlyArray<{ locationId: string; quantity: number }>;
  lastReceiptLocationId: string | null;
}): string | null {
  let best: { locationId: string; quantity: number } | null = null;
  for (const h of args.holdings) {
    if (!(h.quantity > 0)) continue;
    if (best === null || h.quantity > best.quantity) best = h;
  }
  return best?.locationId ?? args.lastReceiptLocationId ?? null;
}
