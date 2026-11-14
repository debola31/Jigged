/**
 * The RFQ comparison matrix and the award plan (plan §3.9 "RFQs").
 *
 * Rows are line × quantity; columns are the invited vendors. A response's unit price is per the RFQ
 * line's own unit, so every cell in a row compares like with like. "Lowest" is a WORD on the cell,
 * never colour alone. An expired quote is never Lowest; a no-bid or a blank price is not a quote;
 * a declined vendor is out; on a price tie the shorter lead time wins, and a full tie marks every
 * tied cell rather than silently picking one.
 *
 * The award itself is one atomic `award_vendor_rfq` call by response id, which creates one draft
 * PO per vendor; `planVendorRfqAward` only checks the picks and counts the drafts for the button.
 */
import { vendorPoLineAmount, roundUnitPrice } from '@/lib/purchasing/amount';
import { formatShortDate } from '@/lib/purchasing/priceDefault';

export const LOWEST_LABEL = 'Lowest';

export interface RfqCompareLine {
  lineId: string;
  lineNumber: number;
  /** The part or the ad-hoc description. */
  label: string;
  unit: string;
  /** Up to four quantities, all in `unit`. */
  quantities: readonly number[];
}

/** One invitation — a column. */
export interface RfqCompareVendor {
  invitationId: string;
  vendorId: string;
  vendorName: string;
  declined?: boolean;
}

/** `vendor_rfq_responses`, one per (invitation, line, quantity). */
export interface RfqCompareResponse {
  responseId: string;
  invitationId: string;
  lineId: string;
  quantity: number;
  /** Per the RFQ line's unit; `null` when there is no price. */
  unitPrice: number | null;
  noBid: boolean;
  leadTimeDays: number | null;
  validUntil: string | null;
  awarded?: boolean;
}

export type RfqCellState = 'priced' | 'expired' | 'no_bid' | 'no_response' | 'declined';

export interface RfqCompareCell {
  invitationId: string;
  vendorId: string;
  vendorName: string;
  responseId: string | null;
  state: RfqCellState;
  unitPrice: number | null;
  /** The quote at this quantity: round(quantity × price, 2). */
  amount: number | null;
  leadTimeDays: number | null;
  validUntil: string | null;
  isLowest: boolean;
}

export interface RfqCompareRow {
  lineId: string;
  lineNumber: number;
  label: string;
  unit: string;
  quantity: number;
  cells: RfqCompareCell[];
  /** The Lowest cells' responses — several only on a full tie; empty when nothing qualifies. */
  lowestResponseIds: string[];
}

export interface RfqComparison {
  vendors: RfqCompareVendor[];
  rows: RfqCompareRow[];
}

function cellFor(
  vendor: RfqCompareVendor,
  response: RfqCompareResponse | undefined,
  quantity: number,
  today: string,
): RfqCompareCell {
  const cell: RfqCompareCell = {
    invitationId: vendor.invitationId,
    vendorId: vendor.vendorId,
    vendorName: vendor.vendorName,
    responseId: response?.responseId ?? null,
    state: 'no_response',
    unitPrice: null,
    amount: null,
    leadTimeDays: response?.leadTimeDays ?? null,
    validUntil: response?.validUntil ?? null,
    isLowest: false,
  };
  if (vendor.declined) return { ...cell, state: 'declined' };
  if (!response) return cell;
  if (response.noBid) return { ...cell, state: 'no_bid' };
  if (response.unitPrice === null || !Number.isFinite(response.unitPrice)) return cell; // a blank price is no quote
  const expired = response.validUntil !== null && response.validUntil < today;
  return {
    ...cell,
    state: expired ? 'expired' : 'priced',
    unitPrice: response.unitPrice,
    amount: vendorPoLineAmount(quantity, response.unitPrice),
  };
}

/** Lead time for a tie-break: unknown loses to any known lead time. */
function leadRank(days: number | null): number {
  return days === null || !Number.isFinite(days) ? Number.POSITIVE_INFINITY : days;
}

/** Build the matrix. `today` is the caller's local date (validity is a date, compared as one). */
export function compareVendorRfq(args: {
  lines: readonly RfqCompareLine[];
  vendors: readonly RfqCompareVendor[];
  responses: readonly RfqCompareResponse[];
  today: string;
}): RfqComparison {
  const index = new Map<string, RfqCompareResponse>();
  for (const r of args.responses) index.set(`${r.invitationId}|${r.lineId}|${r.quantity}`, r);

  const rows: RfqCompareRow[] = [];
  for (const line of [...args.lines].sort((a, b) => a.lineNumber - b.lineNumber)) {
    for (const quantity of line.quantities) {
      const cells = args.vendors.map((v) => cellFor(v, index.get(`${v.invitationId}|${line.lineId}|${quantity}`), quantity, args.today));
      const priced = cells.filter((c) => c.state === 'priced' && c.unitPrice !== null);
      let lowest: RfqCompareCell[] = [];
      if (priced.length > 0) {
        // Compare at the stored precision, so float noise is never a difference.
        const best = Math.min(...priced.map((c) => roundUnitPrice(c.unitPrice as number)));
        const cheapest = priced.filter((c) => roundUnitPrice(c.unitPrice as number) === best);
        const fastest = Math.min(...cheapest.map((c) => leadRank(c.leadTimeDays)));
        lowest = cheapest.filter((c) => leadRank(c.leadTimeDays) === fastest);
      }
      for (const c of lowest) c.isLowest = true;
      rows.push({
        lineId: line.lineId,
        lineNumber: line.lineNumber,
        label: line.label,
        unit: line.unit,
        quantity,
        cells,
        lowestResponseIds: lowest.map((c) => c.responseId).filter((id): id is string => id !== null),
      });
    }
  }
  return { vendors: [...args.vendors], rows };
}

export interface RfqAwardPlan {
  /** Drafts the award will create — one per vendor: "Create draft POs (2)". */
  poCount: number;
  vendors: Array<{ vendorId: string; vendorName: string; responseIds: string[] }>;
  /** Sentences; the award cannot go ahead while any remain. */
  problems: string[];
  /** Worth saying, not blocking: an expired quote awarded anyway. */
  warnings: string[];
}

/** Check the award picks (one per line) and count the draft POs they make. */
export function planVendorRfqAward(
  selectedResponseIds: readonly string[],
  args: {
    lines: readonly RfqCompareLine[];
    vendors: readonly RfqCompareVendor[];
    responses: readonly RfqCompareResponse[];
    today: string;
  },
): RfqAwardPlan {
  const problems: string[] = [];
  const warnings: string[] = [];
  const responses = new Map(args.responses.map((r) => [r.responseId, r]));
  const vendors = new Map(args.vendors.map((v) => [v.invitationId, v]));
  const lines = new Map(args.lines.map((l) => [l.lineId, l]));
  const picked = new Map<string, string[]>(); // invitationId → responseIds
  const linesPicked = new Map<string, number>();

  if (selectedResponseIds.length === 0) {
    return { poCount: 0, vendors: [], problems: ['Pick a quote for at least one line.'], warnings };
  }

  for (const id of selectedResponseIds) {
    const response = responses.get(id);
    const vendor = response ? vendors.get(response.invitationId) : undefined;
    const line = response ? lines.get(response.lineId) : undefined;
    if (!response || !vendor || !line) {
      problems.push('That quote is not on this RFQ.');
      continue;
    }
    linesPicked.set(line.lineId, (linesPicked.get(line.lineId) ?? 0) + 1);
    if (args.responses.some((r) => r.lineId === line.lineId && r.awarded)) {
      problems.push(`Line ${line.lineNumber} is already awarded.`);
      continue;
    }
    if (vendor.declined) {
      problems.push(`${vendor.vendorName} declined this RFQ.`);
      continue;
    }
    if (response.noBid || response.unitPrice === null) {
      problems.push(`${vendor.vendorName} did not quote line ${line.lineNumber}.`);
      continue;
    }
    if (response.validUntil !== null && response.validUntil < args.today) {
      warnings.push(`${vendor.vendorName}'s quote for line ${line.lineNumber} expired ${formatShortDate(response.validUntil)}.`);
    }
    picked.set(vendor.invitationId, [...(picked.get(vendor.invitationId) ?? []), id]);
  }

  for (const [lineId, count] of linesPicked) {
    if (count > 1) problems.unshift(`Pick one quote for line ${lines.get(lineId)?.lineNumber}.`);
  }

  const awardVendors = args.vendors
    .filter((v) => picked.has(v.invitationId))
    .map((v) => ({ vendorId: v.vendorId, vendorName: v.vendorName, responseIds: picked.get(v.invitationId) ?? [] }));

  return { poCount: awardVendors.length, vendors: awardVendors, problems: [...new Set(problems)], warnings };
}
