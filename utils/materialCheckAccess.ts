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
 */
import { getSupabase } from '@/lib/supabase';
import { ID_CHUNK } from '@/lib/queryLimits';

import { buildRequirement } from '@/lib/materialRequirements';
import type { MaterialRequirement, MaterialStockFacts } from '@/types/materialCheck';

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
  consume_whole_units: boolean;
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
        .select('id, parent_part_id, child_part_id, quantity, unit, consume_whole_units')
        .in('parent_part_id', ids)
        .order('sequence', { ascending: true });
      if (error) {
        console.error('Error loading BOM lines for material check:', error);
        throw error;
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
        throw error;
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
        throw error;
      }
      return data ?? [];
    }),
  );

  for (const row of pages.flat()) {
    map.set(`${row.part_id}:${row.from_unit}`, Number(row.to_primary_factor));
  }
  return map;
}

/**
 * Q5 — what these jobs have already taken, per (job, part).
 *
 * `inventory_transactions` has no `job_part_id`, so this is job-level: a job with two parts
 * drawing the same material sees one shared figure. Surfaced as "issued to this job".
 */
async function loadIssued(
  companyId: string,
  jobIds: string[],
): Promise<Map<string, { quantity: number; hasDiscrepancy: boolean }>> {
  const out = new Map<string, { quantity: number; hasDiscrepancy: boolean }>();
  if (jobIds.length === 0) return out;
  const supabase = getSupabase();

  const pages = await Promise.all(
    chunk(jobIds, CHUNK_IDS).map(async (ids) => {
      const { data, error } = await supabase
        .from('inventory_transactions')
        .select('job_id, part_id, converted_quantity, has_discrepancy')
        .eq('company_id', companyId)
        .eq('type', 'depletion')
        .in('job_id', ids);
      if (error) {
        console.error('Error loading job consumption:', error);
        throw error;
      }
      return data ?? [];
    }),
  );

  for (const row of pages.flat()) {
    if (!row.job_id || !row.part_id) continue;
    const key = `${row.job_id}:${row.part_id}`;
    const prev = out.get(key) ?? { quantity: 0, hasDiscrepancy: false };
    out.set(key, {
      quantity: prev.quantity + (Number(row.converted_quantity) || 0),
      hasDiscrepancy: prev.hasDiscrepancy || Boolean(row.has_discrepancy),
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
): Promise<Array<{ jobPart: JobPartRow; requirements: MaterialRequirement[] }>> {
  if (jobParts.length === 0) return [];

  const madePartIds = [...new Set(jobParts.map((jp) => jp.madePartId))];
  const bomLines = await loadBomLines(madePartIds);
  if (bomLines.length === 0) return jobParts.map((jp) => ({ jobPart: jp, requirements: [] }));

  const childIds = [...new Set(bomLines.map((b) => b.child_part_id))];
  const jobIds = [...new Set(jobParts.map((jp) => jp.jobId))];

  // Wave 2: everything below depends only on the BOM, so it all goes at once.
  const [stockByPart, issued] = await Promise.all([
    loadStockFacts(childIds),
    loadIssued(companyId, jobIds),
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
          consumeWholeUnits: Boolean(line.consume_whole_units),
          orderQuantity: jobPart.orderQuantity,
          stock,
          customFactor: conversions.get(`${line.child_part_id}:${line.unit}`) ?? null,
          issued: seen?.quantity ?? 0,
          hasDiscrepancy: seen?.hasDiscrepancy ?? false,
        }),
      ];
    }),
  }));
}

/** J4 for one job part — the job page card. */
export async function getJobPartMaterialCheck(args: {
  companyId: string;
  jobId: string;
  jobPartId: string;
  madePartId: string;
  orderQuantity: number;
}): Promise<MaterialRequirement[]> {
  const built = await buildRequirementsFor(args.companyId, [{
    jobPartId: args.jobPartId,
    jobId: args.jobId,
    madePartId: args.madePartId,
    orderQuantity: args.orderQuantity,
  }]);
  return built[0]?.requirements ?? [];
}
