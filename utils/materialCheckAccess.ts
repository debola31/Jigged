/**
 * Job material check — access layer (journey J4 in docs/modules/inventory.md).
 *
 * A thin driver over `lib/materialRequirements`, mirroring the
 * `inventoryCountAccess` ↔ `inventoryCountPlan` split. No new tables: required comes from the
 * live BOM, on-hand from `parts.quantity`, issued from `depletion` rows carrying the job.
 *
 * **Batched, never per-item.** A job part's materials cost a fixed number of requests
 * regardless of how many BOM lines it has — batched `.in()` reads in two dependent waves, and
 * the test asserts the count. Written this way because it was originally also feeding a
 * shop-wide roll-up over every open job, where a loop would have been an N+1 (issue #68); the
 * shape is worth keeping now that it isn't.
 *
 * **Top-level BOM only** — one level of `parts_bom`, matching J4's spec and the card that
 * exists today. A pump job reads "needs 1 pump core", not the aluminium inside it. The card
 * says so on screen.
 *
 * **On order rides alongside** (plan §3.10, criterion B4): each material carries what is on SENT
 * purchase orders and, apart, what is on drafts, with the POs behind them — read from
 * `part_on_order` through `getOnOrderForParts`, the same figures the buy list and MCP use.
 * "Short by" is untouched by it: stock on a PO is not on the shelf.
 *
 * **A failed read THROWS**, every one of them, as a real Error. An empty list renders "No
 * materials on this part's BOM", which is the one thing a failure must never say.
 */
import { getSupabase } from '@/lib/supabase';
import { ID_CHUNK } from '@/lib/queryLimits';
import { toFriendlyError } from '@/lib/supabaseErrors';

import { buildRequirement, type MaterialOnOrderRef } from '@/lib/materialRequirements';
import type { MaterialCheckRow, MaterialStockFacts } from '@/types/materialCheck';
import type { PartOnOrder } from '@/types/vendorPo';
import { getOnOrderForParts } from '@/utils/vendorPoAccess';

/** Every read failure here: translated, and worded as our failure — never an empty list. */
function loadFailure(error: unknown): Error {
  return toFriendlyError(error, { entity: 'material', fallback: 'Failed to load the materials for this part.' });
}

const CHUNK_PARENTS = 200;
const CHUNK_IDS = ID_CHUNK;

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

interface BomRow {
  id: string;
  parent_part_id: string;
  child_part_id: string;
  quantity: number;
  unit: string;
}

interface JobPartRow {
  jobPartId: string;
  jobId: string;
  madePartId: string;
  orderQuantity: number;
}

/** Q2 — BOM lines for a set of made parts. No child embed; the child read is Q3. */
async function loadBomLines(madePartIds: string[]): Promise<BomRow[]> {
  if (madePartIds.length === 0) return [];
  const supabase = getSupabase();
  const pages = await Promise.all(
    chunk(madePartIds, CHUNK_PARENTS).map(async (ids) => {
      const { data, error } = await supabase
        .from('parts_bom')
        .select('id, parent_part_id, child_part_id, quantity, unit')
        .in('parent_part_id', ids)
        .order('sequence', { ascending: true });
      if (error) {
        console.error('Error loading BOM lines for material check:', error);
        throw loadFailure(error);
      }
      return (data ?? []) as BomRow[];
    }),
  );
  return pages.flat();
}

/** Q3 — stock facts for the BOM children. Archived rows are kept, and labelled by the UI. */
async function loadStockFacts(childIds: string[]): Promise<Map<string, MaterialStockFacts>> {
  const out = new Map<string, MaterialStockFacts>();
  if (childIds.length === 0) return out;
  const supabase = getSupabase();

  const pages = await Promise.all(
    chunk(childIds, CHUNK_IDS).map(async (ids) => {
      const { data, error } = await supabase
        .from('parts')
        .select('id, part_name, primary_unit, quantity, deleted_at')
        .in('id', ids);
      if (error) {
        console.error('Error loading material stock facts:', error);
        throw loadFailure(error);
      }
      return data ?? [];
    }),
  );

  for (const row of pages.flat()) {
    out.set(row.id, {
      partId: row.id,
      partName: row.part_name,
      primaryUnit: row.primary_unit,
      onHand: Number(row.quantity) || 0,
      // Archived materials stay on the list, flagged. A BOM line silently vanishing from a
      // job's material list is worse than one shown as odd.
      isArchived: row.deleted_at !== null,
    });
  }
  return out;
}

/**
 * Q4 — custom unit conversions, only for lines whose BOM unit differs from the stock unit.
 * Same shape as the batched map in `routingCostCalculation`: key is `partId:fromUnit`.
 */
async function loadConversionFactors(
  lookups: Array<{ partId: string; fromUnit: string }>,
): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (lookups.length === 0) return map;

  const supabase = getSupabase();
  const partIds = [...new Set(lookups.map((l) => l.partId))];
  const fromUnits = [...new Set(lookups.map((l) => l.fromUnit))];

  const pages = await Promise.all(
    chunk(partIds, CHUNK_IDS).map(async (ids) => {
      const { data, error } = await supabase
        .from('parts_unit_conversions')
        .select('part_id, from_unit, to_primary_factor')
        .in('part_id', ids)
        .in('from_unit', fromUnits);
      if (error) {
        console.error('Error loading unit conversions for material check:', error);
        throw loadFailure(error);
      }
      return data ?? [];
    }),
  );

  for (const row of pages.flat()) {
    map.set(`${row.part_id}:${row.from_unit}`, Number(row.to_primary_factor));
  }
  return map;
}

interface IssuedFacts {
  quantity: number;
  hasDiscrepancy: boolean;
  /** Distinct mill heats on those takes, in first-seen order; empty when none was recorded. */
  heatNumbers: string[];
}

/**
 * Q5 — what these jobs have already taken, per (job, part), and which heats it carried.
 *
 * `inventory_transactions` has no `job_part_id`, so this is job-level: a job with two parts
 * drawing the same material sees one shared figure. Surfaced as "issued to this job". The heats
 * are the same rows read for a second fact — they are what the job's packing slip will print —
 * so the job page can show them without a second query.
 */
async function loadIssued(
  companyId: string,
  jobIds: string[],
): Promise<Map<string, IssuedFacts>> {
  const out = new Map<string, IssuedFacts>();
  if (jobIds.length === 0) return out;
  const supabase = getSupabase();

  const pages = await Promise.all(
    chunk(jobIds, CHUNK_IDS).map(async (ids) => {
      const { data, error } = await supabase
        .from('inventory_transactions')
        .select('job_id, part_id, converted_quantity, has_discrepancy, heat_number')
        .eq('company_id', companyId)
        .eq('type', 'depletion')
        .in('job_id', ids)
        .order('created_at', { ascending: true });
      if (error) {
        console.error('Error loading job consumption:', error);
        throw loadFailure(error);
      }
      return data ?? [];
    }),
  );

  for (const row of pages.flat()) {
    if (!row.job_id || !row.part_id) continue;
    const key = `${row.job_id}:${row.part_id}`;
    const prev = out.get(key) ?? { quantity: 0, hasDiscrepancy: false, heatNumbers: [] };
    const heatNumbers =
      row.heat_number && !prev.heatNumbers.includes(row.heat_number)
        ? [...prev.heatNumbers, row.heat_number]
        : prev.heatNumbers;
    out.set(key, {
      quantity: prev.quantity + (Number(row.converted_quantity) || 0),
      hasDiscrepancy: prev.hasDiscrepancy || Boolean(row.has_discrepancy),
      heatNumbers,
    });
  }
  return out;
}

/**
 * Turn job parts into material requirements. The shared middle of both entry points.
 *
 * Deliberately does NOT load bin balances. It did, for the operator traveler's take action —
 * that surface was removed (see docs/modules/inventory.md J7), and neither remaining consumer
 * renders where stock sits. Loading it cost a query plus a whole-location-tree read.
 */
async function buildRequirementsFor(
  companyId: string,
  jobParts: JobPartRow[],
): Promise<Array<{ jobPart: JobPartRow; requirements: MaterialCheckRow[] }>> {
  if (jobParts.length === 0) return [];

  const madePartIds = [...new Set(jobParts.map((jp) => jp.madePartId))];
  const bomLines = await loadBomLines(madePartIds);
  if (bomLines.length === 0) return jobParts.map((jp) => ({ jobPart: jp, requirements: [] }));

  const childIds = [...new Set(bomLines.map((b) => b.child_part_id))];
  const jobIds = [...new Set(jobParts.map((jp) => jp.jobId))];

  // Wave 2: everything below depends only on the BOM, so it all goes at once.
  const [stockByPart, issued, onOrder] = await Promise.all([
    loadStockFacts(childIds),
    loadIssued(companyId, jobIds),
    getOnOrderForParts(companyId, childIds),
  ]);

  const conversions = await loadConversionFactors(
    bomLines
      .map((b) => ({ partId: b.child_part_id, fromUnit: b.unit, stock: stockByPart.get(b.child_part_id) }))
      .filter((l) => l.stock?.primaryUnit && l.fromUnit && l.fromUnit !== l.stock.primaryUnit)
      .map(({ partId, fromUnit }) => ({ partId, fromUnit })),
  );

  const bomByParent = new Map<string, BomRow[]>();
  for (const line of bomLines) {
    const list = bomByParent.get(line.parent_part_id) ?? [];
    list.push(line);
    bomByParent.set(line.parent_part_id, list);
  }

  return jobParts.map((jobPart) => ({
    jobPart,
    requirements: (bomByParent.get(jobPart.madePartId) ?? []).flatMap((line) => {
      const stock = stockByPart.get(line.child_part_id);
      if (!stock) return []; // child row missing entirely — nothing truthful to render
      const seen = issued.get(`${jobPart.jobId}:${line.child_part_id}`);
      return [
        buildRequirement({
          bomLineId: line.id,
          bomQuantity: Number(line.quantity) || 0,
          bomUnit: line.unit,
          orderQuantity: jobPart.orderQuantity,
          stock,
          customFactor: conversions.get(`${line.child_part_id}:${line.unit}`) ?? null,
          issued: seen?.quantity ?? 0,
          hasDiscrepancy: seen?.hasDiscrepancy ?? false,
          heatNumbers: seen?.heatNumbers ?? [],
          // Loaded, so a material with nothing coming is a true 0 — never left null.
          onOrder: onOrder.get(line.child_part_id)?.onOrder ?? 0,
          onDraft: onOrder.get(line.child_part_id)?.onDraft ?? 0,
          onOrderRefs: onOrderRefsFor(onOrder.get(line.child_part_id)),
        }),
      ];
    }),
  }));
}

/**
 * The POs behind a material's on-order figures, one per PO (two lines of the same material on
 * one PO are one entry): sent ones first, by when they are due, then drafts.
 */
function onOrderRefsFor(entry: PartOnOrder | undefined): MaterialOnOrderRef[] {
  if (!entry) return [];
  const byPo = new Map<string, MaterialOnOrderRef>();
  for (const ref of entry.refs) {
    const key = `${ref.vendorPurchaseOrderId}:${ref.isDraft}`;
    const prior = byPo.get(key);
    if (!prior) {
      byPo.set(key, {
        vendorPurchaseOrderId: ref.vendorPurchaseOrderId,
        poNumber: ref.poNumber,
        stockQuantity: ref.stockQuantity,
        expectedOn: ref.expectedOn,
        isDraft: ref.isDraft,
      });
      continue;
    }
    prior.stockQuantity += ref.stockQuantity;
    if (ref.expectedOn && (!prior.expectedOn || ref.expectedOn < prior.expectedOn)) prior.expectedOn = ref.expectedOn;
  }
  return [...byPo.values()].sort((a, b) => {
    if (a.isDraft !== b.isDraft) return a.isDraft ? 1 : -1;
    if (a.expectedOn !== b.expectedOn) {
      if (a.expectedOn === null) return 1;
      if (b.expectedOn === null) return -1;
      return a.expectedOn < b.expectedOn ? -1 : 1;
    }
    return a.poNumber.localeCompare(b.poNumber);
  });
}

/** J4 for one job part — the job page card, with what is on order for each material. */
export async function getJobPartMaterialCheck(args: {
  companyId: string;
  jobId: string;
  jobPartId: string;
  madePartId: string;
  orderQuantity: number;
}): Promise<MaterialCheckRow[]> {
  const built = await buildRequirementsFor(args.companyId, [{
    jobPartId: args.jobPartId,
    jobId: args.jobId,
    madePartId: args.madePartId,
    orderQuantity: args.orderQuantity,
  }]);
  return built[0]?.requirements ?? [];
}
