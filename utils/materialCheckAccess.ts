/**
 * Job material check — access layer (journeys J4 and J7 in docs/modules/inventory.md).
 *
 * A thin driver over `lib/materialRequirements`, mirroring the
 * `inventoryCountAccess` ↔ `inventoryCountPlan` split. No new tables: required comes from the
 * live BOM, on-hand from `parts.quantity`, issued from `depletion` rows carrying the job.
 *
 * **The N+1 rule.** Both entry points are the SAME pipeline — the per-job check just runs it
 * with single-element inputs. Query count is CONSTANT in the number of jobs, parts and BOM
 * lines: two dependent waves of batched `.in()` reads, never a loop issuing one request per
 * job. `__tests__/utils/materialCheckAccess.test.ts` asserts the request count against a
 * 20-job fixture, because a comment saying "don't N+1 this" is not a guarantee (issue #68).
 *
 * **Top-level BOM only** — one level of `parts_bom`, matching J4's spec and the card that
 * exists today. A pump job reads "needs 1 pump core", not the aluminium inside it. Both
 * surfaces say so on screen.
 */
import { getTypedSupabase as getSupabase } from '@/lib/supabase';

import { buildRequirement, rollUpShortages, shortageWindowEnd } from '@/lib/materialRequirements';
import type {
  MaterialRequirement,
  MaterialStockFacts,
  PartShortage,
  ShortageContribution,
  ShortageWindow,
} from '@/types/materialCheck';

/** Job-part statuses that still need material. */
const OPEN_STATUSES = ['not_started', 'in_progress'] as const;

const CHUNK_PARENTS = 200;
const CHUNK_IDS = 500;

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
  jobNumber: string;
  madePartId: string;
  madePartName: string | null;
  orderQuantity: number;
  dueDate: string | null;
  isHot: boolean;
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
        .select('id, part_name, primary_unit, quantity, is_stocked, is_location_tracked, deleted_at')
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
      isStocked: Boolean(row.is_stocked),
      isLocationTracked: Boolean(row.is_location_tracked),
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
  jobNumber?: string;
  jobPartId: string;
  madePartId: string;
  madePartName?: string | null;
  orderQuantity: number;
}): Promise<MaterialRequirement[]> {
  const built = await buildRequirementsFor(
    args.companyId,
    [{
      jobPartId: args.jobPartId,
      jobId: args.jobId,
      jobNumber: args.jobNumber ?? '',
      madePartId: args.madePartId,
      madePartName: args.madePartName ?? null,
      orderQuantity: args.orderQuantity,
      dueDate: null,
      isHot: false,
    }],
  );
  return built[0]?.requirements ?? [];
}

/**
 * J4 shop-wide — every open job's claim on each material, aggregated.
 *
 * Window semantics: the window only ever *adds* jobs. Overdue, hot and undated open jobs are
 * always in scope, because a "this week" view that hides last week's late job, or the rush job
 * that is the whole reason for this feature, is worse than no view at all.
 */
export async function getShopMaterialShortages(
  companyId: string,
  window: ShortageWindow,
  today: Date = new Date(),
): Promise<{ shortages: PartShortage[]; rangeEnd: string | null; jobCount: number }> {
  const rangeEnd = shortageWindowEnd(window, today);
  const supabase = getSupabase();

  // Q1 — open job parts on live jobs. The window is applied in memory: it is a disjunction
  // over two tables (jobs.due_date / jobs.is_hot) and PostgREST's `.or()` across an embed is
  // fragile enough that filtering a small open-job set client-side is the safer trade.
  const { data, error } = await supabase
    .from('job_parts')
    .select(
      'id, job_id, part_id, quantity, production_status, ' +
        'part:parts!job_parts_part_id_fkey(id, part_name), ' +
        'job:jobs!inner(id, job_number, due_date, is_hot, production_status, company_id, deleted_at)',
    )
    .eq('job.company_id', companyId)
    .is('job.deleted_at', null)
    .in('production_status', [...OPEN_STATUSES])
    .range(0, 999);

  if (error) {
    console.error('Error loading open job parts for shortages:', error);
    throw error;
  }

  type Row = {
    id: string;
    job_id: string;
    part_id: string;
    quantity: number;
    part: { id: string; part_name: string } | { id: string; part_name: string }[] | null;
    job: {
      id: string; job_number: string; due_date: string | null;
      is_hot: boolean; production_status: string;
    } | Array<{
      id: string; job_number: string; due_date: string | null;
      is_hot: boolean; production_status: string;
    }> | null;
  };

  const todayIso = isoDate(today);

  const jobParts: JobPartRow[] = ((data ?? []) as unknown as Row[])
    .flatMap((row) => {
      const job = Array.isArray(row.job) ? row.job[0] : row.job;
      const part = Array.isArray(row.part) ? row.part[0] : row.part;
      if (!job || !OPEN_STATUSES.includes(job.production_status as (typeof OPEN_STATUSES)[number])) {
        return [];
      }
      // In scope when due inside the window, OR overdue, OR hot, OR undated — see the note above.
      const inWindow =
        rangeEnd === null ||
        job.due_date === null ||
        job.is_hot ||
        job.due_date <= rangeEnd ||
        (todayIso !== null && job.due_date < todayIso);
      if (!inWindow) return [];
      return [{
        jobPartId: row.id,
        jobId: row.job_id,
        jobNumber: job.job_number,
        madePartId: row.part_id,
        madePartName: part?.part_name ?? null,
        orderQuantity: Number(row.quantity) || 0,
        dueDate: job.due_date,
        isHot: Boolean(job.is_hot),
      }];
    });

  const built = await buildRequirementsFor(companyId, jobParts);

  const lines = built.flatMap(({ jobPart, requirements }) =>
    requirements.map((requirement) => ({
      requirement,
      contribution: {
        jobId: jobPart.jobId,
        jobNumber: jobPart.jobNumber,
        jobPartId: jobPart.jobPartId,
        madePartName: jobPart.madePartName,
        dueDate: jobPart.dueDate,
        isHot: jobPart.isHot,
        required: null,
      } satisfies ShortageContribution,
    })),
  );

  return {
    shortages: rollUpShortages(lines),
    rangeEnd,
    jobCount: new Set(jobParts.map((jp) => jp.jobId)).size,
  };
}

function isoDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
