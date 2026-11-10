/**
 * The approved vendor list (AVL), price sheets and "Use as part cost" — the shapes
 * `utils/partVendorsAccess.ts` reads and writes (plan §3.2, §3.8).
 *
 * `parts.preferred_vendor_id` stays the ONLY preferred marker; `ensure_preferred_vendor_is_listed`
 * keeps a live AVL row for it. A sheet's factor lives in `parts_unit_conversions`, never on the
 * row, so one unit name means one amount of a part. Quoted and valid-until dates are per SHEET.
 */
import type { Json } from '@/types/database';
import type { PartVendorStatus } from '@/lib/purchasing/vendorPoStatus';
import type { UnitConversionRow } from '@/lib/purchasing/purchaseUnits';

export type { PartVendorStatus };

export interface PartVendorPriceBreak {
  id: string;
  /** In the sheet's purchase unit. */
  minQuantity: number;
  /** Per the sheet's purchase unit. */
  unitPrice: number;
  source: 'manual' | 'rfq';
  vendorRfqResponseId: string | null;
}

/** "Last PO price": the newest priced line on a sent, unarchived PO to this vendor. */
export interface PartVendorLastPurchase {
  vendorPurchaseOrderId: string;
  poNumber: string;
  orderedOn: string | null;
  lineId: string;
  quantity: number;
  unit: string;
  unitPrice: number;
  unitPricePerStockUnit: number | null;
  stockUnit: string | null;
  stockFactor: number | null;
}

/** One vendor on a part's list. */
export interface PartVendorRow {
  id: string;
  partId: string;
  vendorId: string;
  vendorName: string;
  status: PartVendorStatus;
  statusNote: string | null;
  vendorPartNumber: string | null;
  purchaseUnit: string;
  /** Stock units per purchase unit; null when the unit no longer relates to the stock unit. */
  purchaseFactor: number | null;
  /** "1 bar = 144 in"; null for the stock unit itself. */
  factorLabel: string | null;
  leadTimeDays: number | null;
  /** In purchase units. */
  minimumOrderQuantity: number | null;
  quotedOn: string | null;
  validUntil: string | null;
  /** valid_until is before the caller's date: named, never used as a price. */
  isExpired: boolean;
  notes: string | null;
  /** This is `parts.preferred_vendor_id`. */
  isPreferred: boolean;
  /** Ascending by quantity. */
  breaks: PartVendorPriceBreak[];
  lastPurchase: PartVendorLastPurchase | null;
  createdAt: string;
  updatedAt: string;
}

export interface PartVendorList {
  part: {
    id: string;
    partName: string;
    /** `made` or `bought`; "Use as part cost" is for bought parts only. */
    source: string;
    stockUnit: string | null;
    preferredVendorId: string | null;
    conversions: UnitConversionRow[];
  };
  /** Live rows whose vendor is live, preferred first, then by vendor name. */
  rows: PartVendorRow[];
  /**
   * The preferred vendor is not among `rows` — its vendor is archived (the trigger keeps a live
   * row otherwise). The tab shows "Preferred · not on the list".
   */
  preferredVendorMissing: boolean;
}

/** One part a vendor supplies — the vendor page's "Parts supplied" card. */
export interface VendorPartRow {
  partVendorId: string;
  partId: string;
  partName: string;
  description: string | null;
  partSource: string;
  status: PartVendorStatus;
  vendorPartNumber: string | null;
  purchaseUnit: string;
  leadTimeDays: number | null;
  minimumOrderQuantity: number | null;
  quotedOn: string | null;
  validUntil: string | null;
  isExpired: boolean;
  isPreferred: boolean;
}

/** `save_part_vendor`'s change keys. `undefined` = unchanged, `null` = cleared. */
export interface PartVendorChanges {
  status?: PartVendorStatus;
  statusNote?: string | null;
  vendorPartNumber?: string | null;
  purchaseUnit?: string | null;
  leadTimeDays?: number | null;
  minimumOrderQuantity?: number | null;
  quotedOn?: string | null;
  validUntil?: string | null;
  notes?: string | null;
}

export interface SavePartVendorInput {
  partId: string;
  vendorId: string;
  changes?: PartVendorChanges;
  /** "Another unit…": stock units in one `changes.purchaseUnit`, stored as a conversion first. */
  purchaseUnitFactor?: number | null;
  /** Given (even empty), it REPLACES the whole sheet. Left out, the sheet is untouched. */
  priceBreaks?: Array<{ minQuantity: number; unitPrice: number }> | null;
  /** Also make this the part's preferred vendor. */
  makePreferred?: boolean;
}

export interface SavePartVendorResult {
  partVendorId: string;
  created: boolean;
  /** The same vendor was on the list before and archived: the same row came back. */
  revived: boolean;
  /** It is the part's preferred vendor after the save. */
  preferred: boolean;
}

export interface ArchivePartVendorResult {
  partVendorId: string;
  /** False when it was already archived. */
  archived: boolean;
  /** It was the preferred vendor, so the preference was cleared too. */
  clearedPreferred: boolean;
}

/** One existing cost tier, as "Use as part cost" would change it. */
export interface PartCostPreviewTier {
  tierId: string;
  /** In the part's stock unit. */
  quantity: number;
  /** Unchanged by the apply. */
  markupPercent: number | null;
  currentCost: number | null;
  proposedCost: number;
  currentPrice: number | null;
  proposedPrice: number | null;
  vendorMinQuantity: number | null;
  vendorUnitPrice: number | null;
  /** The tier's quantity is below the vendor's smallest break; the lowest break was used. */
  belowVendorMinimum: boolean;
}

/** A tier the apply would insert (the part has none yet), at the 0% starter markup. */
export interface PartCostPreviewInsert {
  quantity: number;
  proposedCost: number;
  markupPercent: number;
  vendorMinQuantity: number | null;
  vendorUnitPrice: number | null;
}

export interface PartCostPreview {
  partVendorId: string;
  partId: string;
  partName: string;
  vendorId: string;
  vendorName: string;
  purchaseUnit: string;
  stockUnit: string | null;
  stockFactor: number;
  quotedOn: string | null;
  validUntil: string | null;
  tiers: PartCostPreviewTier[];
  inserts: PartCostPreviewInsert[];
  /** Open quotes with the part, directly or through an assembly above it. */
  openQuoteCount: number;
  /** Live parts above it in a BOM — they re-cost. */
  bomParentPartCount: number;
  /** `starter_tiers_inserted`, `below_vendor_minimum`. */
  warnings: string[];
  /**
   * The preview EXACTLY as the database returned it. Pass it back to `applyPartCostFromVendor`
   * unchanged: the apply refuses unless what it would write is still what was previewed.
   */
  expected: Json;
}

export interface ApplyPartCostResult {
  partId: string;
  partVendorId: string;
  updatedTierIds: string[];
  insertedTierIds: string[];
}
