/**
 * "To buy" — the shapes `utils/buyListAccess.ts` returns (plan §3.10).
 *
 * The rule itself is `lib/purchasing/buyList.ts` (pinned by `__tests__/fixtures/buyListCases.json`);
 * its types are re-exported here. This file adds what the access layer brings: a price for every
 * row (lib/purchasing/priceDefault.ts, the same default the PO form shows), the price of each
 * "Buy from" choice, and which reads hit their row cap — a capped list says so, never silently.
 */
import type {
  BuyList,
  BuyListDemand,
  BuyListDraftRef,
  BuyListGroup,
  BuyListIncomparable,
  BuyListPart,
  BuyListRow,
  BuyListVendorChoice,
  BuyListVendorOption,
} from '@/lib/purchasing/buyList';
import type { CostTier, LastPurchaseCandidate, PriceDefault, PriceSheet } from '@/lib/purchasing/priceDefault';

export type {
  BuyList,
  BuyListDemand,
  BuyListDraftRef,
  BuyListGroup,
  BuyListIncomparable,
  BuyListPart,
  BuyListRow,
  BuyListVendorChoice,
  BuyListVendorOption,
};

/** The reads behind the list. Each is capped at one PostgREST page; a capped one is named. */
export type BuyListSource = 'job_parts' | 'parts' | 'issued' | 'on_order' | 'drafts' | 'last_purchases';

/** How many rows one buy-list read takes (PostgREST's `max_rows`). */
export const BUY_LIST_READ_CAP = 1000;

/** What the price default needs for one part, for every vendor that could supply it. */
export interface BuyListPriceInputs {
  /** Each live approved vendor's sheet, by vendor id (only rows with breaks and a usable unit). */
  sheetsByVendor: Record<string, PriceSheet>;
  lastPurchases: LastPurchaseCandidate[];
  costTiers: CostTier[];
}

/** Everything the list is built from, so "Buy from" re-prices without another read. */
export interface BuyListSnapshot {
  parts: BuyListPart[];
  demand: BuyListDemand[];
  /** The newest live draft PO to each vendor: "Add to draft PO-1043". */
  draftsByVendor: Record<string, BuyListDraftRef>;
  priceInputsByPart: Record<string, BuyListPriceInputs>;
  /** Reads that hit BUY_LIST_READ_CAP: the list is incomplete and must say so. */
  truncatedSources: BuyListSource[];
}

/** One "Buy from" choice for a row, priced at the quantity it would suggest. */
export interface BuyListVendorPrice {
  vendorId: string;
  vendorName: string;
  /** `null` for a vendor not on the part's list. */
  partVendorId: string | null;
  status: BuyListVendorOption['status'];
  purchaseUnit: string;
  suggestedQuantity: number;
  price: PriceDefault;
  /** round(quantity × price, 2); null while to be confirmed. */
  amount: number | null;
}

export interface BuyListPricedRow extends BuyListRow {
  /** The price for `suggestedQuantity` in `purchaseUnit`, with the caption naming its source. */
  price: PriceDefault;
  amount: number | null;
  /** The part's usable listed vendors (Approved first), each priced — the "Buy from" picker. */
  vendorPrices: BuyListVendorPrice[];
}

export interface BuyListPricedGroup extends Omit<BuyListGroup, 'rows'> {
  rows: BuyListPricedRow[];
  /** Sum of the rows' amounts (TBC rows add nothing). */
  total: number;
}

export interface BuyListResult extends Omit<BuyList, 'groups'> {
  groups: BuyListPricedGroup[];
  /** Any read hit its cap: show "This list may be incomplete". */
  truncated: boolean;
  truncatedSources: BuyListSource[];
  /** The inputs, for re-pricing a "Buy from" change without another read. */
  snapshot: BuyListSnapshot;
}
