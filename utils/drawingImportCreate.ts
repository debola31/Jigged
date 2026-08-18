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
import { saveRoutingWithOperations } from '@/utils/routingsAccess';
import { ensureStarterPricingTier } from '@/utils/partPricingTiersAccess';
import type { OperationRowData } from '@/components/routings/RoutingOperationRow';
import { uploadPartAttachment } from '@/utils/partAttachmentsAccess';
import { upsertPartCustomerReference } from '@/utils/partCustomerReferencesAccess';
import { valueOf, type DrawingRow, type DrawingRowValues } from '@/types/drawingImport';

export interface CreatedRow {
  stem: string;
  partId: string | null;
  partName: string;
  /** Operations written for this part. 0 when the user skipped the work step. */
  operationsAdded: number;
  /** True once the part has both a cost basis and a markup — i.e. it can be quoted. */
  quotable: boolean;
  /** What we did, so the summary can say it rather than implying everything was new. */
  action: 'created' | 'revived' | 'updated' | 'skipped' | 'failed';
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
  onProgress?: (done: number, total: number) => void;
}

/**
 * `part_attachments.kind` is stored so the Files tab can dispatch a viewer without
 * re-parsing filenames, so it has to agree with the file's extension.
 */
const ATTACHABLE = new Set(['pdf', 'dxf', 'step']);

function resolveName(row: DrawingRow): string {
  // An identity decision the user made overrides everything, including extraction:
  // it is the answer to a question we asked them.
  if (row.identity.kind === 'name_taken') return row.identity.suggestedName;
  if (row.identity.kind === 'archived' && row.identity.choice === 'create_new') {
    return row.identity.suggestedName;
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
  const { companyId, customerId, defaultUnit, operationsByStem, onProgress } = options;
  const included = rows.filter((r) => !r.excluded);
  const out: CreatedRow[] = new Array(included.length);

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
        // Report what HAPPENED, not what was intended: if the id came back as the
        // archived row we found, it was revived.
        result.action =
          row.identity.kind === 'archived' && created.id === row.identity.partId
            ? 'revived'
            : 'created';
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
            await saveRoutingWithOperations(
              companyId,
              partId,
              null,
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
        result.quotable = await ensureStarterPricingTier(companyId, partId, source).catch(
          () => false,
        );
      }
    } catch (err) {
      result.error = err instanceof Error ? err.message : 'Failed to create this part';
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

  return out;
}

/** A one-line summary that never claims more than happened. */
export function summarise(results: CreatedRow[]): string {
  const counts = results.reduce<Record<string, number>>((acc, r) => {
    acc[r.action] = (acc[r.action] ?? 0) + 1;
    return acc;
  }, {});
  const parts: string[] = [];
  if (counts.created) parts.push(`${counts.created} created`);
  if (counts.revived) parts.push(`${counts.revived} restored`);
  if (counts.updated) parts.push(`${counts.updated} updated`);
  if (counts.failed) parts.push(`${counts.failed} failed`);
  const files = results.reduce((n, r) => n + r.filesAttached, 0);
  const fileErrors = results.reduce((n, r) => n + r.fileErrors.length, 0);
  const quotable = results.filter((r) => r.quotable).length;
  const tail = fileErrors > 0 ? `, ${fileErrors} file(s) not attached` : '';
  // Ready-to-quote leads, because it is the thing the whole flow is aimed at.
  const ready = quotable > 0 ? `${quotable} ready to quote · ` : '';
  return `${ready}${parts.join(', ') || 'nothing to do'} · ${files} file(s) attached${tail}`;
}
