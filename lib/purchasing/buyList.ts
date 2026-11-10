/**
 * The "To buy" list — the pure core (plan §3.10). It only PROPOSES: nothing here writes, and the
 * access layer (`utils/buyListAccess.ts`) feeds it and turns a group into a draft PO.
 *
 * A hand port of 87df208's `rollUpShortages` (the shop-wide shortage view that was cut for having
 * no next step). Kept from it: on hand counted ONCE per part however many jobs want it — two jobs
 * each needing 10 against 15 on hand are each "fine" and together 5 short — issued stock counted
 * once per (job, part), incomparable units kept out of the "fine" pile, archived parts skipped.
 * Dropped: `is_hot` / `is_stocked` (both columns are gone) and the date window (the "this week"
 * default usually reported nothing; rows are sorted by need date instead).
 *
 * Per part, in stock units:
 *   demand   = top-level BOM material on open jobs still to issue (issued counted once per job and
 *              part, never letting one over-issued job hide another's need)
 *            + bought parts on jobs still to ship (they are `completed` the moment a job is created,
 *              so without this a job waiting on a part nobody ordered would read "nothing to buy")
 *   position = on hand + on order + on draft − demand        (drafts netted: never drafted twice)
 *   listed   ⇔ position ≤ reorder point, or position < 0 when the part has no reorder point
 *   suggest  = max(reorder point − position (or −position), minimum order), rounded up to whole
 *              purchase units, and at least one purchase unit
 * Pinned by `__tests__/fixtures/buyListCases.json`.
 *
 * Grouping: the preferred vendor unless it is marked Do not use or archived, else the only
 * Approved vendor, else "No vendor chosen". "Buy from" overrides it per part.
 */
import { roundDecimal } from '@/lib/money';
import { STOCK_QUANTITY_PLACES, toStockQuantity, wholePurchaseUnits } from '@/lib/purchasing/purchaseUnits';
import type { PartVendorStatus } from '@/lib/purchasing/vendorPoStatus';

// ------------------------------------------------------------------------------------------------
// Inputs
// ------------------------------------------------------------------------------------------------

/** One live `part_vendors` row for the part, as the buy list needs it. */
export interface BuyListVendorOption {
  /** `null` for a vendor picked in "Buy from" that is not on the part's list. */
  partVendorId: string | null;
  vendorId: string;
  vendorName: string;
  /** `null` for a vendor that is not on the part's list. */
  status: PartVendorStatus | null;
  /** The vendor itself is archived. */
  vendorArchived?: boolean;
  purchaseUnit: string;
  /** Stock units per purchase unit; `null` when the unit no longer relates to the stock unit. */
  purchaseFactor: number | null;
  /** In purchase units. */
  minimumOrderQuantity: number | null;
  leadTimeDays?: number | null;
}

export interface BuyListPart {
  partId: string;
  partName: string;
  /** `parts.source`; only bought parts are proposed — a made part is made, not bought. */
  source: string;
  /** `parts.primary_unit`. */
  stockUnit: string | null;
  /** `parts.quantity` — counted once. */
  onHand: number;
  /** `part_on_order.on_order_quantity` (sent, open lines), in stock units. */
  onOrder: number;
  /** `part_on_order.on_draft_quantity`, in stock units. */
  onDraft: number;
  reorderPoint: number | null;
  isArchived: boolean;
  preferredVendorId: string | null;
  vendors: readonly BuyListVendorOption[];
}

/** One BOM line of one open job part, drawing this material. */
export interface BuyListMaterialDemand {
  kind: 'material';
  /** The material. */
  partId: string;
  jobId: string;
  jobNumber: string;
  /** The made job part whose BOM draws it. */
  jobPartId: string;
  madePartName?: string | null;
  dueDate: string | null;
  /** The whole job part's draw in stock units; `null` when the units cannot be compared. */
  requiredInStockUnit: number | null;
  /** Σ depletions issued to this JOB for this material — the same figure on each of its lines. */
  issued: number;
}

/** A bought part on an open job that is still to ship. */
export interface BuyListBoughtPartDemand {
  kind: 'bought_part';
  partId: string;
  jobId: string;
  jobNumber: string;
  jobPartId: string;
  dueDate: string | null;
  /** In stock units. */
  stillToShip: number;
}

export type BuyListDemand = BuyListMaterialDemand | BuyListBoughtPartDemand;

/** A vendor picked in "Buy from". */
export interface BuyListVendorChoice {
  vendorId: string;
  vendorName: string;
}

// ------------------------------------------------------------------------------------------------
// Outputs
// ------------------------------------------------------------------------------------------------

/** What one job needs of the part. */
export interface BuyListJobNeed {
  jobId: string;
  jobNumber: string;
  /** The earliest due date among this job's lines for the part. */
  dueDate: string | null;
  materialStillToIssue: number;
  boughtStillToShip: number;
  need: number;
  jobPartIds: string[];
  madePartNames: string[];
  incomparableLineCount: number;
}

export type BuyListReason = 'job_shortage' | 'below_reorder_point' | 'both' | 'below_zero';
export type BuyListVendorBasis = 'chosen' | 'preferred' | 'only_approved';

export interface BuyListRow {
  /** `${partId}:${vendorId|none}` — edited quantities are kept under this across refreshes. */
  key: string;
  partId: string;
  partName: string;
  stockUnit: string | null;
  onHand: number;
  onOrder: number;
  onDraft: number;
  demand: number;
  position: number;
  reorderPoint: number | null;
  reason: BuyListReason;
  /** The earliest due date among the jobs that need it; `null` for a reorder-only row. */
  needBy: string | null;
  /** The jobs that need it (or could not be compared), in need order. */
  jobs: BuyListJobNeed[];
  /** Job numbers of the jobs that need it, in need order — "For J-1042, J-1050". */
  jobNumbers: string[];
  /** Set only when exactly one job needs it; the PO line links that job (and its bought job part). */
  jobLink: { jobId: string; jobNumber: string; jobPartId: string | null } | null;
  incomparableJobCount: number;
  vendor: BuyListVendorOption | null;
  vendorBasis: BuyListVendorBasis | null;
  purchaseUnit: string;
  purchaseFactor: number;
  /** The vendor's unit could not be related to the stock unit, so the stock unit is used. */
  purchaseUnitFallback: boolean;
  minimumOrderQuantity: number | null;
  /** The gap to close, in stock units. */
  shortfall: number;
  /** Whole purchase units, at least one. */
  suggestedQuantity: number;
  suggestedStockQuantity: number;
}

export interface BuyListGroup {
  vendorId: string | null;
  vendorName: string | null;
  rows: BuyListRow[];
  /** An existing draft PO to this vendor, so the action reads "Add to draft PO-1043". */
  draft: BuyListDraftRef | null;
}

export interface BuyListDraftRef {
  vendorPurchaseOrderId: string;
  poNumber: string;
}

/** A part whose need cannot be measured — never folded into "fine". */
export interface BuyListIncomparable {
  partId: string;
  partName: string;
  stockUnit: string | null;
  incomparableJobCount: number;
  jobs: Array<{ jobId: string; jobNumber: string; dueDate: string | null }>;
}

export interface BuyListEvaluation {
  partId: string;
  /** False for archived and made parts, which the list never proposes. */
  considered: boolean;
  demand: number;
  position: number;
  listed: boolean;
  /** Not listed, and some of its need could not be measured: it goes in the incomparable bucket. */
  incomparable: boolean;
  incomparableJobCount: number;
  row: BuyListRow | null;
  bucket: BuyListIncomparable | null;
}

export interface BuyList {
  groups: BuyListGroup[];
  incomparable: BuyListIncomparable[];
  rowCount: number;
  /** Rows a job needs (reason `job_shortage` or `both`). */
  jobRowCount: number;
  /** Rows at or under their reorder point (reason `below_reorder_point` or `both`). */
  reorderRowCount: number;
  noVendorRowCount: number;
  incomparableCount: number;
}

// ------------------------------------------------------------------------------------------------
// The rule
// ------------------------------------------------------------------------------------------------

const TOLERANCE = 1e-9;
const round6 = (n: number) => roundDecimal(n, STOCK_QUANTITY_PLACES);

function compareDue(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1; // undated last
  if (b === null) return -1;
  return a < b ? -1 : 1;
}

/**
 * Whole purchase units for a shortfall: max(gap, minimum order) rounded up, at least one.
 * `shortfall` is in stock units; the minimum order is in purchase units.
 */
export function suggestPurchaseQuantity(args: {
  shortfall: number;
  purchaseFactor: number;
  minimumOrderQuantity: number | null;
}): number {
  const fromGap = wholePurchaseUnits(Math.max(0, args.shortfall), args.purchaseFactor);
  const minimum = args.minimumOrderQuantity;
  const fromMinimum = minimum !== null && minimum > 0 ? wholePurchaseUnits(minimum, 1) : 0;
  return Math.max(1, Number.isFinite(fromGap) ? fromGap : 0, fromMinimum);
}

function isUsableVendor(v: BuyListVendorOption): boolean {
  return v.status !== 'disapproved' && !v.vendorArchived;
}

/**
 * Which vendor a part is bought from: a "Buy from" choice (never a Do-not-use one), else the
 * preferred vendor unless it is Do not use or archived, else the only Approved vendor, else none.
 */
export function chooseBuyListVendor(
  part: BuyListPart,
  chosen?: BuyListVendorChoice | null,
): { vendor: BuyListVendorOption | null; basis: BuyListVendorBasis | null } {
  if (chosen) {
    const listed = part.vendors.find((v) => v.vendorId === chosen.vendorId);
    if (!listed) {
      // Not on the part's list: buy in the stock unit, with no minimum to honour.
      return {
        vendor: {
          partVendorId: null,
          vendorId: chosen.vendorId,
          vendorName: chosen.vendorName,
          status: null,
          vendorArchived: false,
          purchaseUnit: part.stockUnit ?? '',
          purchaseFactor: 1,
          minimumOrderQuantity: null,
        },
        basis: 'chosen',
      };
    }
    if (isUsableVendor(listed)) return { vendor: listed, basis: 'chosen' };
    // A Do-not-use or archived choice is ignored; the default rule decides.
  }
  if (part.preferredVendorId) {
    const preferred = part.vendors.find((v) => v.vendorId === part.preferredVendorId);
    if (preferred && isUsableVendor(preferred)) return { vendor: preferred, basis: 'preferred' };
  }
  const approved = part.vendors.filter((v) => v.status === 'approved' && !v.vendorArchived);
  if (approved.length === 1) return { vendor: approved[0], basis: 'only_approved' };
  return { vendor: null, basis: null };
}

interface JobAccumulator {
  jobId: string;
  jobNumber: string;
  dueDate: string | null;
  materialRequired: number;
  /** The job-level issued figure, taken once. */
  issued: number | null;
  boughtStillToShip: number;
  jobPartIds: string[];
  madePartNames: string[];
  incomparableLineCount: number;
}

function accumulateJobs(demand: readonly BuyListDemand[]): JobAccumulator[] {
  const jobs = new Map<string, JobAccumulator>();
  for (const d of demand) {
    let job = jobs.get(d.jobId);
    if (!job) {
      job = {
        jobId: d.jobId,
        jobNumber: d.jobNumber,
        dueDate: d.dueDate,
        materialRequired: 0,
        issued: null,
        boughtStillToShip: 0,
        jobPartIds: [],
        madePartNames: [],
        incomparableLineCount: 0,
      };
      jobs.set(d.jobId, job);
    } else if (compareDue(d.dueDate, job.dueDate) < 0) {
      job.dueDate = d.dueDate;
    }
    if (!job.jobPartIds.includes(d.jobPartId)) job.jobPartIds.push(d.jobPartId);

    if (d.kind === 'bought_part') {
      job.boughtStillToShip += Math.max(0, d.stillToShip || 0);
      continue;
    }
    if (d.madePartName && !job.madePartNames.includes(d.madePartName)) job.madePartNames.push(d.madePartName);
    // `issued` is per (job, part): the same figure rides on each of the job's lines, so add it once
    // or a job with two lines drawing the material would halve its apparent need.
    if (job.issued === null) job.issued = Math.max(0, d.issued || 0);
    if (d.requiredInStockUnit === null || !Number.isFinite(d.requiredInStockUnit)) {
      job.incomparableLineCount += 1;
      continue;
    }
    job.materialRequired += d.requiredInStockUnit;
  }
  return [...jobs.values()];
}

/** The buy-list rule for one part. Only `demand` lines for this part are read. */
export function evaluateBuyListPart(
  part: BuyListPart,
  demand: readonly BuyListDemand[],
  chosen?: BuyListVendorChoice | null,
): BuyListEvaluation {
  const notConsidered: BuyListEvaluation = {
    partId: part.partId,
    considered: false,
    demand: 0,
    position: 0,
    listed: false,
    incomparable: false,
    incomparableJobCount: 0,
    row: null,
    bucket: null,
  };
  if (part.isArchived || part.source !== 'bought') return notConsidered;

  const accumulated = accumulateJobs(demand.filter((d) => d.partId === part.partId));
  const needs: BuyListJobNeed[] = accumulated
    .map((j) => {
      // Still to issue, per job: an over-issued job reads 0, never a negative that cancels
      // another job's real need.
      const materialStillToIssue = round6(Math.max(0, j.materialRequired - (j.issued ?? 0)));
      const boughtStillToShip = round6(j.boughtStillToShip);
      return {
        jobId: j.jobId,
        jobNumber: j.jobNumber,
        dueDate: j.dueDate,
        materialStillToIssue,
        boughtStillToShip,
        need: round6(materialStillToIssue + boughtStillToShip),
        jobPartIds: j.jobPartIds,
        madePartNames: j.madePartNames,
        incomparableLineCount: j.incomparableLineCount,
      };
    })
    .sort((a, b) => compareDue(a.dueDate, b.dueDate) || a.jobNumber.localeCompare(b.jobNumber));

  const demandTotal = round6(needs.reduce((sum, j) => sum + j.need, 0));
  const position = round6((part.onHand || 0) + (part.onOrder || 0) + (part.onDraft || 0) - demandTotal);
  const incomparableJobs = needs.filter((j) => j.incomparableLineCount > 0);
  const reorderPoint = part.reorderPoint !== null && Number.isFinite(part.reorderPoint) ? part.reorderPoint : null;
  const listed = reorderPoint !== null ? position <= reorderPoint : position < 0;

  const base = {
    partId: part.partId,
    considered: true,
    demand: demandTotal,
    position,
    incomparableJobCount: incomparableJobs.length,
  };

  if (!listed) {
    const incomparable = incomparableJobs.length > 0;
    return {
      ...base,
      listed: false,
      incomparable,
      row: null,
      bucket: incomparable
        ? {
            partId: part.partId,
            partName: part.partName,
            stockUnit: part.stockUnit,
            incomparableJobCount: incomparableJobs.length,
            jobs: incomparableJobs.map((j) => ({ jobId: j.jobId, jobNumber: j.jobNumber, dueDate: j.dueDate })),
          }
        : null,
    };
  }

  const shortfall = round6(Math.max(0, reorderPoint !== null ? reorderPoint - position : -position));
  const jobShort = demandTotal > TOLERANCE && position < 0;
  const belowReorder = reorderPoint !== null && position <= reorderPoint;
  const reason: BuyListReason = jobShort && belowReorder ? 'both' : jobShort ? 'job_shortage' : belowReorder ? 'below_reorder_point' : 'below_zero';

  const { vendor, basis } = chooseBuyListVendor(part, chosen);
  const vendorFactor = vendor?.purchaseFactor ?? null;
  const vendorUnitUsable = vendor !== null && vendorFactor !== null && Number.isFinite(vendorFactor) && vendorFactor > 0;
  const purchaseUnit = vendorUnitUsable && vendor ? vendor.purchaseUnit : (part.stockUnit ?? '');
  const purchaseFactor = vendorUnitUsable && vendorFactor !== null ? vendorFactor : 1;
  // A minimum is in the vendor's unit; it cannot be honoured in a unit it does not relate to.
  const minimumOrderQuantity = vendorUnitUsable ? (vendor?.minimumOrderQuantity ?? null) : null;
  const suggestedQuantity = suggestPurchaseQuantity({ shortfall, purchaseFactor, minimumOrderQuantity });

  const contributing = needs.filter((j) => j.need > TOLERANCE);
  let jobLink: BuyListRow['jobLink'] = null;
  if (contributing.length === 1) {
    const only = contributing[0];
    // The bought job part itself is linked only when it is the whole of the job's need.
    const boughtOnly = only.materialStillToIssue <= TOLERANCE && only.incomparableLineCount === 0;
    const boughtJobParts = demand.filter(
      (d) => d.partId === part.partId && d.kind === 'bought_part' && d.jobId === only.jobId,
    );
    jobLink = {
      jobId: only.jobId,
      jobNumber: only.jobNumber,
      jobPartId: boughtOnly && boughtJobParts.length === 1 ? boughtJobParts[0].jobPartId : null,
    };
  }

  const row: BuyListRow = {
    key: `${part.partId}:${vendor?.vendorId ?? 'none'}`,
    partId: part.partId,
    partName: part.partName,
    stockUnit: part.stockUnit,
    onHand: part.onHand,
    onOrder: part.onOrder,
    onDraft: part.onDraft,
    demand: demandTotal,
    position,
    reorderPoint,
    reason,
    needBy: contributing.reduce<string | null>((earliest, j) => (compareDue(j.dueDate, earliest) < 0 ? j.dueDate : earliest), null),
    jobs: needs.filter((j) => j.need > TOLERANCE || j.incomparableLineCount > 0),
    jobNumbers: contributing.map((j) => j.jobNumber),
    jobLink,
    incomparableJobCount: incomparableJobs.length,
    vendor,
    vendorBasis: basis,
    purchaseUnit,
    purchaseFactor,
    purchaseUnitFallback: vendor !== null && !vendorUnitUsable,
    minimumOrderQuantity,
    shortfall,
    suggestedQuantity,
    suggestedStockQuantity: toStockQuantity(suggestedQuantity, purchaseFactor),
  };
  return { ...base, listed: true, incomparable: false, row, bucket: null };
}

function compareRows(a: BuyListRow, b: BuyListRow): number {
  return (
    compareDue(a.needBy, b.needBy) ||
    b.shortfall - a.shortfall || // worst first
    a.partName.localeCompare(b.partName)
  );
}

/**
 * The whole list: every bought, live part evaluated, listed rows grouped by vendor (alphabetical,
 * "No vendor chosen" last) and sorted by need date then worst first, plus the incomparable bucket.
 */
export function buildBuyList(input: {
  parts: readonly BuyListPart[];
  demand: readonly BuyListDemand[];
  /** "Buy from" choices, by part id. */
  chosenVendors?: Record<string, BuyListVendorChoice | undefined>;
  /** Existing draft POs, by vendor id. */
  draftsByVendor?: Record<string, BuyListDraftRef | undefined>;
}): BuyList {
  const demandByPart = new Map<string, BuyListDemand[]>();
  for (const d of input.demand) {
    const list = demandByPart.get(d.partId);
    if (list) list.push(d);
    else demandByPart.set(d.partId, [d]);
  }

  const rows: BuyListRow[] = [];
  const incomparable: BuyListIncomparable[] = [];
  for (const part of input.parts) {
    const evaluation = evaluateBuyListPart(part, demandByPart.get(part.partId) ?? [], input.chosenVendors?.[part.partId]);
    if (evaluation.row) rows.push(evaluation.row);
    if (evaluation.bucket) incomparable.push(evaluation.bucket);
  }
  rows.sort(compareRows);
  incomparable.sort((a, b) => a.partName.localeCompare(b.partName));

  const groups = new Map<string, BuyListGroup>();
  for (const row of rows) {
    const vendorId = row.vendor?.vendorId ?? null;
    const key = vendorId ?? '';
    let group = groups.get(key);
    if (!group) {
      group = {
        vendorId,
        vendorName: row.vendor?.vendorName ?? null,
        rows: [],
        draft: vendorId ? (input.draftsByVendor?.[vendorId] ?? null) : null,
      };
      groups.set(key, group);
    }
    group.rows.push(row);
  }
  const ordered = [...groups.values()].sort((a, b) => {
    if (a.vendorName === null) return b.vendorName === null ? 0 : 1;
    if (b.vendorName === null) return -1;
    return a.vendorName.localeCompare(b.vendorName, undefined, { sensitivity: 'base' });
  });

  return {
    groups: ordered,
    incomparable,
    rowCount: rows.length,
    jobRowCount: rows.filter((r) => r.reason === 'job_shortage' || r.reason === 'both').length,
    reorderRowCount: rows.filter((r) => r.reason === 'below_reorder_point' || r.reason === 'both').length,
    noVendorRowCount: rows.filter((r) => r.vendor === null).length,
    incomparableCount: incomparable.length,
  };
}
