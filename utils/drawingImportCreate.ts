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
import { quantityFor, type ComponentPlan } from '@/lib/drawingComponents';
import { uploadPartAttachment } from '@/utils/partAttachmentsAccess';
import { upsertPartCustomerReference } from '@/utils/partCustomerReferencesAccess';
import { valueOf, type DrawingRow, type DrawingRowValues } from '@/types/drawingImport';

/** A component part as it exists in the database, with the unit it is measured in. */
interface MaterialPart {
  partId: string;
  unit: string;
  linkable: boolean;
}

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
  /** Cut-list components to create and link. Omit to skip components entirely. */
  components?: ComponentPlan;
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
const ROW_CONCURRENCY = 4;

/**
 * Create everything the user approved.
 *
 * THE PART WRITE IS SERIALISED; EVERYTHING ELSE IS NOT. `createPart` resolves a
 * name collision by reviving an archived row, so two rows racing on the same name
 * could both think they created it. The identity guard already made names unique
 * WITHIN a package, but it cannot see a part another tab created ten seconds ago —
 * so the insert takes a lock and the slow work (references, uploads) runs free.
 */
export async function createPartsFromRows(
  rows: DrawingRow[],
  options: CreateOptions,
): Promise<CreatedRow[]> {
  const { companyId, customerId, defaultUnit, operationsByStem, components, onProgress } = options;
  const included = rows.filter((r) => !r.excluded);
  const out: CreatedRow[] = new Array(included.length);

  // Shared materials exist before any parent references them, so two weldments
  // asking for the same tube get one part rather than racing to create two.
  const materialParts = components
    ? await createMaterials(companyId, components, defaultUnit)
    : new Map<string, MaterialPart>();

  let done = 0;
  // A promise chain the part-inserts queue behind, so they stay ordered while the
  // uploads around them overlap.
  let insertLock: Promise<unknown> = Promise.resolve();
  const serialise = <T>(work: () => Promise<T>): Promise<T> => {
    const next = insertLock.then(work, work);
    // Swallow on the CHAIN only — the caller still sees the rejection.
    insertLock = next.catch(() => undefined);
    return next;
  };

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
        const created = await serialise(() => createPart(companyId, {
          part_name: partName,
          description: valueOf(row, 'description'),
          source,
          is_stocked: false,
          primary_unit: valueOf(row, 'primary_unit') || defaultUnit,
          quantity: 0,
          reorder_point: null,
          preferred_vendor_id: null,
        }));
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
                workCenterName: o.workCenterName,
                workCenterKind: o.workCenterKind,
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
        // Components, before the markup: a BOM line changes what the cost IS, and
        // the tier seeder reads that cost to decide whether there is anything to
        // mark up.
        if (components) {
          result.componentsLinked = await linkComponents(
            companyId,
            partId,
            row,
            components,
            materialParts,
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
 * Attach one parent's components: its pooled materials, and the made parts named
 * on its own cut list.
 *
 * A material with no cost is deliberately NOT linked — see createMaterials. A MADE
 * component always is, and always blocks: it is a part we are creating from a name
 * on someone else's drawing, so it has no work and therefore no cost, and its
 * parent's cost genuinely is unknown until someone says how it is made. That is a
 * more honest answer than the parent quoting at a price that ignores it, but it is
 * a change the user is told about before they commit rather than after.
 */
async function linkComponents(
  companyId: string,
  parentId: string,
  row: DrawingRow,
  plan: ComponentPlan,
  materialParts: Map<string, MaterialPart>,
  defaultUnit: string,
): Promise<number> {
  if (!row.cutList) return 0;
  let linked = 0;

  /**
   * What is already attached, read once.
   *
   * A line that is already there IS attached — counting only the inserts reported
   * "0 components attached" on every re-import while the BOM sat there correctly,
   * which is the same mistake as reading a write result to answer a question about
   * state. Reading first also keeps a re-import from leaning on a caught 23505.
   */
  const supabase = getSupabase();
  const { data: existingLines } = await supabase
    .from('parts_bom')
    .select('child_part_id')
    .eq('parent_part_id', parentId);
  const alreadyAttached = new Set((existingLines ?? []).map((l) => l.child_part_id));

  // Materials FIRST, one line per material rather than one per cut-list row: four
  // rows of the same tube are one BOM line for the total length, and writing them
  // per row means the second insert hits the unique constraint and every cut
  // length after the first is silently lost.
  for (const material of plan.materials) {
    if (!material.include) continue;
    const needed = quantityFor(material, row.stem);
    if (needed <= 0) continue;
    const created = materialParts.get(material.key);
    // No cost means no link. The material still exists to be priced later.
    if (!created?.linkable) continue;
    if (alreadyAttached.has(created.partId)) {
      linked += 1;
      continue;
    }
    try {
      await addBomLine(parentId, {
        child_part_id: created.partId,
        quantity: String(needed),
        // The child's own unit. Anything else needs a conversion the shop has not
        // defined, and the cost rollup raises rather than assuming one.
        unit: created.unit,
        consume_whole_units: false,
        charge_basis: 'cost',
      });
      linked += 1;
    } catch {
      // One line that will not write costs this line, not the package.
    }
  }

  for (const line of row.cutList.rows) {
    const description = (line.description ?? '').trim();
    if (!description || !line.madePart) continue;
    const quantity = Number(line.quantity ?? '1') || 1;

    try {
      {
        const wanted = plan.made.find(
          (m) => m.parentStem === row.stem && m.description === description && m.include,
        );
        if (!wanted) continue;
        // Find-or-create for the same reason as the materials: on a re-import
        // this name already exists, and creating blindly loses the BOM line.
        const child = await findOrCreateComponent(companyId, description, 'made', defaultUnit);
        if (!child) continue;
        if (alreadyAttached.has(child.id)) {
          linked += 1;
          continue;
        }
        await addBomLine(parentId, {
          child_part_id: child.id,
          quantity: String(quantity),
          unit: child.unit,
          consume_whole_units: false,
          charge_basis: 'cost',
        });
        linked += 1;
      }
    } catch {
      // One line that will not write costs this line, not the package.
    }
  }

  return linked;
}

/**
 * Create the shared materials FIRST, once, before any parent needs them.
 *
 * FIND-or-create, and the difference is not cosmetic. A shop's second package from
 * the same customer reuses the same tube stock, so on that import every
 * `createPart` here raises 23505 — and when this function treated that as failure
 * the material dropped out of the map, every BOM line that referenced it was
 * skipped, and the weldment quietly went back to costing labour only. No error
 * surfaced; the cost was simply wrong. So the map is keyed on the part that EXISTS
 * afterwards, however it got there.
 *
 * `linkable` follows the same rule: it asks whether the material HAS a cost basis,
 * not whether this run wrote one. A material priced during the first import is
 * still priced during the second.
 *
 * A material with no cost at all is deliberately NOT linked — it has no cost basis,
 * and a BOM line to it would take its parent from quotable to not. It is still
 * created (it is a real thing the shop buys) and can be priced later; the weldment
 * keeps quoting in the meantime.
 */
async function createMaterials(
  companyId: string,
  plan: ComponentPlan,
  defaultUnit: string,
): Promise<Map<string, MaterialPart>> {
  const supabase = getSupabase();
  const out = new Map<string, MaterialPart>();

  for (const material of plan.materials) {
    if (!material.include) continue;
    try {
      // The unit the user declared for THIS material, because these sheets print
      // "1803.2" beside a tube described in inches and the cost is per that unit.
      const declaredUnit = material.unit || defaultUnit;
      const part = await findOrCreateComponent(
        companyId,
        material.description,
        'bought',
        declaredUnit,
      );
      if (!part) continue;

      // Does it have a cost basis already? Ask, rather than inferring it from
      // whether this run happened to be the one that wrote it.
      const { data: existingTiers, error: readError } = await supabase
        .from('part_procurement_tiers')
        .select('id')
        .eq('part_id', part.id)
        .limit(1);
      if (readError) throw readError;

      let linkable = (existingTiers ?? []).length > 0;

      if (!linkable && material.costPerUnit !== null) {
        // What the shop PAYS. Not a markup — a markup over an unknown cost is
        // still unknown, which is the whole reason this field exists.
        const { error } = await supabase.from('part_procurement_tiers').insert({
          part_id: part.id,
          min_quantity: 1,
          cost_per_unit: material.costPerUnit,
        });
        if (error) throw error;
        linkable = true;
      }

      /**
       * A part the shop already measures in inches, against a drawing in mm, is a
       * real disagreement and not ours to settle. The cost rollup refuses to guess
       * a conversion — it raises — so linking here would break the parent's cost
       * outright, and converting silently would scale it by 25.4. The material is
       * created either way; it simply is not attached.
       */
      if (part.unit !== declaredUnit) linkable = false;

      out.set(material.key, { partId: part.id, unit: part.unit, linkable });
    } catch {
      // A material that cannot be created must not take the whole package with it.
      // Its parents simply keep the cost they had.
    }
  }

  return out;
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

  const part = await createPart(companyId, {
    part_name: name,
    description: '',
    source,
    is_stocked: false,
    primary_unit: unit,
    quantity: 0,
    reorder_point: null,
    preferred_vendor_id: null,
  });
  return { id: part.id, unit };
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
