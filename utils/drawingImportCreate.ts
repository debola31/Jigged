/**
 * Reviewed rows → parts, reference rows, attachments.
 *
 * THE ORDER MATTERS AND IS NOT NEGOTIABLE. A part row first, because the
 * attachment's storage path and its FK both need an id; then the customer
 * reference, because this import is the only moment the attribution reliably
 * exists; then the files. A row that dies partway leaves a real part with fewer
 * files, which a user can fix, rather than orphaned bytes in a bucket, which they
 * cannot see.
 *
 * ONE ROW'S FAILURE IS NOT THE PACKAGE'S. Thirty-one drawings mean thirty-one
 * chances to fail, and a user who watched twenty-eight succeed should keep them.
 * Every row reports its own outcome and the caller shows the ones that need a
 * second look.
 */

import { createPart } from '@/utils/partsAccess';
import { getRoutingForPart, saveRoutingWithOperations } from '@/utils/routingsAccess';
import { ensureStarterPricingTier, getPriceablePartIds } from '@/utils/partPricingTiersAccess';
import type { OperationRowData } from '@/components/routings/RoutingOperationRow';
import { addBomLine } from '@/utils/bomAccess';
import { getSupabase } from '@/lib/supabase';
/** A material line, resolved to something writable. */
export interface ResolvedMaterial {
  /** An existing part the user picked. */
  partId: string | null;
  /** A new material's name, when they typed one. */
  name: string;
  quantity: number;
  unit: string;
  /** Only used when the material is created here. */
  costPerUnit: number | null;
}
import { uploadPartAttachment } from '@/utils/partAttachmentsAccess';
import { upsertPartCustomerReference } from '@/utils/partCustomerReferencesAccess';
import { valueOf, type DrawingRow, type DrawingRowValues } from '@/types/drawingImport';

export interface CreatedRow {
  stem: string;
  partId: string | null;
  partName: string;
  /** Operations written for this part. 0 when the user skipped the work step. */
  operationsAdded: number;
  /** BOM lines written from this drawing's cut list. */
  componentsLinked: number;
  /** True once the part has both a cost basis and a markup — i.e. it can be quoted. */
  quotable: boolean;
  /** What we did, so the summary can say it rather than implying everything was new. */
  action: 'created' | 'updated' | 'skipped' | 'failed';
  filesAttached: number;
  /** Files that could not be attached. The part still exists; these are addable later. */
  fileErrors: string[];
  error?: string;
}

export interface CreateOptions {
  companyId: string;
  /** Null when the user did not say whose drawings these are. */
  customerId: string | null;
  /** Shop default, because a drawing never states one and `primary_unit` is NOT NULL. */
  defaultUnit: string;
  /**
   * The operations to give each part, by stem. Empty means "no routing" — a
   * legitimate choice that leaves the part incomplete rather than blocking it.
   */
  operationsByStem?: Map<string, OperationRowData[]>;
  /**
   * What each part is made of, as the user entered it. Keyed by stem.
   *
   * Not derived from the drawing any more: a cut list only exists on the odd
   * weldment, so inferring left most parts with nothing to offer. What a shop
   * knows it buys is a better source than what a sheet happens to tabulate.
   */
  materialsByStem?: Map<string, ResolvedMaterial[]>;
  onProgress?: (done: number, total: number) => void;
}

/**
 * `part_attachments.kind` is stored so the Files tab can dispatch a viewer without
 * re-parsing filenames, so it has to agree with the file's extension.
 */
const ATTACHABLE = new Set(['pdf', 'dxf', 'step']);

/**
 * The name this row will actually be created under.
 *
 * The grid seeds the suggested name into the row's edits, so what the user reads
 * in the Part name column is what gets written — a row that says `1003308` while
 * creating `1003308-2` is worse than either name on its own.
 *
 * The collision names are then a BACKSTOP, not the mechanism: if the user types
 * the taken name back in, we do not write it. Reusing a name in this repo revives
 * or merges, and for `name_taken` that means writing onto ANOTHER CUSTOMER'S part
 * with all of its quotes and jobs still pointing at it. That is the incident this
 * whole guard exists to prevent, so it does not get to happen by typing.
 */
export function resolveName(row: DrawingRow): string {
  // What the USER typed, not `valueOf` — that merges in extraction and falls back
  // to the filename stem, and neither is a decision about a name we already know
  // is unavailable.
  const typed = (row.edits.part_name ?? '').trim();
  const renamed = (taken: string, suggested: string) =>
    !typed || typed.toLowerCase() === taken.trim().toLowerCase() ? suggested : typed;

  if (row.identity.kind === 'name_taken') {
    return renamed(row.identity.partName, row.identity.suggestedName);
  }
  return valueOf(row, 'part_name');
}

async function attachFiles(
  companyId: string,
  partId: string,
  row: DrawingRow,
): Promise<{ attached: number; errors: string[] }> {
  const errors: string[] = [];
  const files = row.group.files.filter((f) => ATTACHABLE.has(f.kind));

  // A part's own files go up together — there are at most three or four, they are
  // independent, and doing them one at a time was most of the wall clock on a
  // 31-part package (93 round trips in a row). Concurrency ACROSS parts is bounded
  // separately, so shop wifi never sees ninety at once.
  const results = await Promise.all(
    files.map(async (entry) => {
      try {
        await uploadPartAttachment(companyId, partId, entry.file);
        return null;
      } catch (err) {
        return `${entry.name}: ${err instanceof Error ? err.message : 'upload failed'}`;
      }
    }),
  );

  for (const failure of results) if (failure) errors.push(failure);
  return { attached: files.length - errors.length, errors };
}

/**
 * How many rows are in flight at once.
 *
 * Not unbounded: a 31-part package would open ~90 uploads simultaneously and shop
 * wifi finishes none of them. Not one, either — that was the original shape and it
 * made a package take minutes, almost all of it waiting on uploads that have
 * nothing to do with each other.
 */
const ROW_CONCURRENCY = 8;

/**
 * Create everything the user approved.
 *
 * NOTHING IS SERIALISED ANY MORE, and the reason it used to be is gone. The part
 * insert queued behind a lock because `createPart` resolved a name collision by
 * REVIVING an archived row — two rows racing on one name could both believe they
 * had created it, and both would be updating the same revived row. Reuse now
 * RECLAIMS instead: the archived holder is renamed and the insert retried, so a
 * genuine race ends in a clean 23505 on one side rather than a silent merge.
 *
 * That lock cost 31 sequential round trips for a package that needs none — names
 * are unique within a package by construction (the identity guard's `taken` set),
 * so the writes have nothing to contend over.
 */
export async function createPartsFromRows(
  rows: DrawingRow[],
  options: CreateOptions,
): Promise<CreatedRow[]> {
  const { companyId, customerId, defaultUnit, operationsByStem, materialsByStem, onProgress } =
    options;
  const included = rows.filter((r) => !r.excluded);
  const out: CreatedRow[] = new Array(included.length);

  let done = 0;

  async function runRow(row: DrawingRow, index: number): Promise<void> {
    const partName = resolveName(row);
    const result: CreatedRow = {
      stem: row.stem,
      partId: null,
      partName,
      action: 'failed',
      operationsAdded: 0,
      componentsLinked: 0,
      quotable: false,
      filesAttached: 0,
      fileErrors: [],
    };

    const source = (valueOf(row, 'source') || 'made') as DrawingRowValues['source'];

    try {
      // "Couldn't check" is not "clear to create": an unresolved identity means we
      // never established whether this name belongs to someone else, and creating
      // anyway is the merge the guard exists to prevent.
      if (row.identity.kind === 'unknown') {
        throw new Error(`Identity check failed: ${row.identity.reason}`);
      }

      if (row.identity.kind === 'known') {
        // The shop already has this part under this customer's number. Attach the
        // new drawings to it; do NOT overwrite fields a human may have curated
        // since, which is a different decision from importing a new part.
        result.partId = row.identity.partId;
        result.action = 'updated';
      } else {
        /**
         * `createPart` already implements revive: on a name collision it looks for
         * an ARCHIVED row and un-archives it with these field values, and throws
         * only when the collision is with a live part. That is exactly the
         * behaviour wanted here — and the reason it is safe now is that the
         * identity guard turned it into something the user chose rather than
         * something that happened to them.
         *
         * The `create_new` and `name_taken` branches arrive with a different name
         * already resolved by `resolveName`, so the same call covers all three.
         */
        const created = await createPart(companyId, {
          part_name: partName,
          description: valueOf(row, 'description'),
          source,
          primary_unit: valueOf(row, 'primary_unit') || defaultUnit,
          quantity: 0,
          reorder_point: null,
          preferred_vendor_id: null,
        });
        result.partId = created.id;
        result.action = 'created';
      }

      // The reference row, written in the same pass as the part. A row written
      // later is a row never written — after this screen closes, nothing knows
      // whose numbering this part answered to.
      const customerNumber = valueOf(row, 'customer_part_number');
      if (customerId && customerNumber && result.partId) {
        await upsertPartCustomerReference(companyId, {
          part_id: result.partId,
          customer_id: customerId,
          customer_part_number: customerNumber,
          customer_revision: valueOf(row, 'customer_revision') || null,
          customer_drawing_number: valueOf(row, 'customer_drawing_number') || null,
        });
      }

      if (result.partId) {
        const partId = result.partId;
        const operations = operationsByStem?.get(row.stem) ?? [];

        // Files and work are independent, so they overlap. The routing has to land
        // BEFORE the markup is seeded, though — see below.
        const [{ attached, errors }] = await Promise.all([
          attachFiles(companyId, partId, row),
          (async () => {
            if (operations.length === 0) return;

            /**
             * A part can hold only ONE routing (`routings_part_id_unique`), so
             * passing null here created a second one for any part that already had
             * it — re-importing a package raised 23505, the row's whole remaining
             * work was skipped, and it still reported as "updated".
             *
             * A routing that already has operations is left ALONE. It is the
             * shop's, possibly curated since, and quietly replacing it with the
             * one typed on this screen is the same overwrite the update path
             * already refuses for descriptions. An EMPTY routing row is reused.
             */
            const existing = await getRoutingForPart(partId);
            if ((existing?.operations?.length ?? 0) > 0) return;

            await saveRoutingWithOperations(
              companyId,
              partId,
              existing?.id ?? null,
              operations.map((o) => ({
                tempId: o.tempId,
                workCenterId: o.workCenterId,
                vendorServiceId: o.vendorServiceId,
                workCenterName: o.workCenterName,
                vendorName: o.vendorName,
                setupMinutes: o.setupMinutes,
                cycleMinutesPerUnit: o.cycleMinutesPerUnit,
                laborRateOverride: o.laborRateOverride,
                externalUnitPrice: o.externalUnitPrice,
                instructions: o.instructions,
              })),
              new Set<string>(),
            );
            result.operationsAdded = operations.length;
          })(),
        ]);
        result.filesAttached = attached;
        result.fileErrors = errors;

        /**
         * The markup, LAST and only now.
         *
         * `ensureStarterPricingTier` deliberately no-ops when there is nothing to
         * mark up — "is there a cost", not "is there a routing" — because a markup
         * over a zero cost makes a part quotable for nothing, which is worse than
         * not being quotable. So it has to run after the routing exists, and it
         * correctly does nothing when the user skipped the work step.
         *
         * Its return value is the honest answer to "can this be quoted now?".
         */
        // Materials before the markup: a BOM line changes what the cost IS, and
        // the tier seeder reads that cost to decide whether there is anything to
        // mark up.
        const materials = materialsByStem?.get(row.stem) ?? [];
        if (materials.length > 0) {
          result.componentsLinked = await attachMaterials(
            companyId,
            partId,
            materials,
            defaultUnit,
          );
        }

        // Seed a markup if there is now a cost to mark up. Its RETURN value is
        // "did I write a tier", which is not the same question as "can this be
        // quoted" — a part re-imported from a second package already has one, and
        // reading the write as the answer reported it unquotable. Priceability is
        // asked once, properly, after the batch.
        await ensureStarterPricingTier(companyId, partId, source).catch(() => false);
      }
    } catch (err) {
      result.error = err instanceof Error ? err.message : 'Failed to create this part';
      // A row that threw is FAILED, whatever it had managed before. Leaving the
      // action as "updated" reported a success and a error message at once, and
      // the summary counted it among the wins.
      result.action = 'failed';
    }

    // Written by index, so results keep the grid's order however they finish.
    out[index] = result;
    done += 1;
    onProgress?.(done, included.length);
  }

  // Fixed pool of workers pulling from a shared cursor — simpler than chunking,
  // and a slow row cannot stall the batch behind it.
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(ROW_CONCURRENCY, included.length) }, async () => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        if (index >= included.length) return;
        await runRow(included[index], index);
      }
    }),
  );

  /**
   * Ask the database which of these can actually be quoted, once, at the end.
   *
   * The same rule the parts list uses, so the summary and the list cannot
   * disagree — and it is the honest answer for a part that was already priceable
   * before this import touched it, which no per-row write result can give.
   */
  try {
    const priceable = await getPriceablePartIds(companyId);
    for (const result of out) {
      if (result.partId) result.quotable = priceable.has(result.partId);
    }
  } catch {
    // Never claim quotable on a failed check — the summary simply omits the
    // offer, and the parts list will show the truth either way.
  }

  return out;
}

/**
 * Write one parent's materials as BOM lines.
 *
 * A material with no cost basis is deliberately NOT linked: a BOM line to a child
 * nothing can price takes its parent from quotable to not, so attaching one would
 * STOP a part that was quoting. The material is still created — it is a real thing
 * the shop buys — and can be priced later.
 *
 * Units come from the CHILD PART, never from the line. `part_rollup_at_qty` raises
 * rather than guess a conversion, so a mismatch breaks the parent's cost outright.
 */
async function attachMaterials(
  companyId: string,
  parentId: string,
  materials: ResolvedMaterial[],
  defaultUnit: string,
): Promise<number> {
  const supabase = getSupabase();
  let linked = 0;

  // What is already attached, read once. Counting only the inserts reported
  // "0 materials" over a correct BOM on every re-import.
  const { data: existingLines } = await supabase
    .from('parts_bom')
    .select('child_part_id')
    .eq('parent_part_id', parentId);
  const alreadyAttached = new Set((existingLines ?? []).map((l) => l.child_part_id));

  for (const material of materials) {
    if (material.quantity <= 0) continue;
    try {
      let childId = material.partId;
      let childUnit = material.unit || defaultUnit;

      if (childId) {
        // An existing part is already measured in something.
        const { data: existing, error } = await supabase
          .from('parts')
          .select('primary_unit')
          .eq('id', childId)
          .single();
        if (error) throw error;
        childUnit = existing.primary_unit ?? childUnit;
      } else {
        const name = material.name.trim();
        if (!name) continue;
        const created = await findOrCreateComponent(companyId, name, 'bought', childUnit);
        if (!created) continue;
        childId = created.id;
        childUnit = created.unit;

        if (material.costPerUnit !== null) {
          // What the shop PAYS. Not a markup — a markup over an unknown cost is
          // still unknown, which is why this is asked for at all.
          const { error } = await supabase.from('part_procurement_tiers').insert({
            part_id: childId,
            min_quantity: 1,
            cost_per_unit: material.costPerUnit,
          });
          if (error) throw error;
        }
      }

      if (!childId) continue;
      if (alreadyAttached.has(childId)) {
        linked += 1;
        continue;
      }

      await addBomLine(parentId, {
        child_part_id: childId,
        quantity: String(material.quantity),
        unit: childUnit,
        charge_basis: 'cost',
      });
      linked += 1;
    } catch {
      // One line that will not write costs this line, not the package.
    }
  }

  return linked;
}

/**
 * The material this name refers to, creating it only if a LIVE one is not there.
 *
 * An archived namesake is deliberately not reused. It would arrive with whatever
 * costs, units and stock it was archived holding, and silently become part of this
 * weldment's price — `createPart` moves it aside instead and this import gets a
 * clean part. Same rule as everywhere else now.
 */
async function findOrCreateComponent(
  companyId: string,
  name: string,
  source: 'bought' | 'made',
  unit: string,
): Promise<{ id: string; unit: string } | null> {
  const supabase = getSupabase();

  const { data: found, error: findError } = await supabase
    .from('parts')
    .select('id, primary_unit')
    .eq('company_id', companyId)
    .eq('part_name', name)
    .is('deleted_at', null)
    .limit(1);
  if (findError) throw findError;

  const existing = (found ?? [])[0];
  if (existing) {
    // Its OWN unit, not the one we asked for — a part that already exists is
    // already measured in something, and the caller has to reckon with that.
    // `primary_unit` is NOT NULL by CHECK; the generated type is merely wider.
    return { id: existing.id, unit: existing.primary_unit ?? unit };
  }

  try {
    const part = await createPart(companyId, {
      part_name: name,
      description: '',
      source,
      primary_unit: unit,
      quantity: 0,
      reorder_point: null,
      preferred_vendor_id: null,
    });
    return { id: part.id, unit };
  } catch (err) {
    /**
     * Lost a race for this name, and that is the ONE thing raising the row
     * concurrency made possible: two parts made of the same new material both
     * look, both find nothing, and both insert. The winner's row is the answer —
     * re-read rather than treating it as this line's failure, which is how a
     * material would silently go missing from the second part that used it.
     */
    if ((err as { code?: string })?.code !== '23505') throw err;
    const { data: raced } = await supabase
      .from('parts')
      .select('id, primary_unit')
      .eq('company_id', companyId)
      .eq('part_name', name)
      .is('deleted_at', null)
      .limit(1);
    const winner = (raced ?? [])[0];
    return winner ? { id: winner.id, unit: winner.primary_unit ?? unit } : null;
  }
}

/** A one-line summary that never claims more than happened. */
export function summarise(results: CreatedRow[]): string {
  const counts = results.reduce<Record<string, number>>((acc, r) => {
    acc[r.action] = (acc[r.action] ?? 0) + 1;
    return acc;
  }, {});
  const parts: string[] = [];
  if (counts.created) parts.push(`${counts.created} created`);
  if (counts.updated) parts.push(`${counts.updated} updated`);
  if (counts.failed) parts.push(`${counts.failed} failed`);
  const files = results.reduce((n, r) => n + r.filesAttached, 0);
  const fileErrors = results.reduce((n, r) => n + r.fileErrors.length, 0);
  const quotable = results.filter((r) => r.quotable).length;
  const tail = fileErrors > 0 ? `, ${fileErrors} file(s) not attached` : '';
  // Say how many components were attached. It is the one part of this flow whose
  // failure is otherwise silent — a BOM line that does not get written changes the
  // part's cost and nothing on screen would have said so.
  const linked = results.reduce((n, r) => n + r.componentsLinked, 0);
  const components = linked > 0 ? ` · ${linked} component${linked === 1 ? '' : 's'} attached` : '';
  // Ready-to-quote leads, because it is the thing the whole flow is aimed at.
  const ready = quotable > 0 ? `${quotable} ready to quote · ` : '';
  return `${ready}${parts.join(', ') || 'nothing to do'} · ${files} file(s) attached${tail}${components}`;
}
