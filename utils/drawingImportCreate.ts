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
import { uploadPartAttachment } from '@/utils/partAttachmentsAccess';
import { upsertPartCustomerReference } from '@/utils/partCustomerReferencesAccess';
import { valueOf, type DrawingRow, type DrawingRowValues } from '@/types/drawingImport';

export interface CreatedRow {
  stem: string;
  partId: string | null;
  partName: string;
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
  let attached = 0;
  const errors: string[] = [];

  // Sequential: each upload has its own size-derived timeout, and a browser that
  // opens 90 parallel uploads on shop wifi finishes none of them.
  for (const entry of row.group.files) {
    if (!ATTACHABLE.has(entry.kind)) continue;
    try {
      await uploadPartAttachment(companyId, partId, entry.file);
      attached += 1;
    } catch (err) {
      errors.push(`${entry.name}: ${err instanceof Error ? err.message : 'upload failed'}`);
    }
  }

  return { attached, errors };
}

/**
 * Create everything the user approved.
 *
 * Sequential by row on purpose. The identity guard already ran as one batched
 * pass, so what is left is writes — and a name collision between two rows of the
 * SAME package is only visible if they land one at a time.
 */
export async function createPartsFromRows(
  rows: DrawingRow[],
  options: CreateOptions,
): Promise<CreatedRow[]> {
  const { companyId, customerId, defaultUnit, onProgress } = options;
  const out: CreatedRow[] = [];
  const included = rows.filter((r) => !r.excluded);

  for (const [index, row] of included.entries()) {
    const partName = resolveName(row);
    const result: CreatedRow = {
      stem: row.stem,
      partId: null,
      partName,
      action: 'failed',
      filesAttached: 0,
      fileErrors: [],
    };

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
          source: (valueOf(row, 'source') || 'made') as DrawingRowValues['source'],
          is_stocked: false,
          primary_unit: valueOf(row, 'primary_unit') || defaultUnit,
          quantity: 0,
          reorder_point: null,
          preferred_vendor_id: null,
        });
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
        const { attached, errors } = await attachFiles(companyId, result.partId, row);
        result.filesAttached = attached;
        result.fileErrors = errors;
      }
    } catch (err) {
      result.error = err instanceof Error ? err.message : 'Failed to create this part';
    }

    out.push(result);
    onProgress?.(index + 1, included.length);
  }

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
  const tail = fileErrors > 0 ? `, ${fileErrors} file(s) not attached` : '';
  return `${parts.join(', ') || 'nothing to do'} · ${files} file(s) attached${tail}`;
}
