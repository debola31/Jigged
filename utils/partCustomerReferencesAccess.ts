import { getSupabase } from '@/lib/supabase';
import { ID_CHUNK } from '@/lib/queryLimits';
import { toFriendlyError } from '@/lib/supabaseErrors';

/**
 * Access layer for `part_customer_references` — a part's identity in a
 * CUSTOMER'S own numbering (see the migration's header for why the table exists).
 *
 * The drawings import keys on `(customer_id, customer_part_number)` and never on
 * `parts.part_name`: two OEMs legitimately both use "1003308", and name reuse
 * revives an archived part rather than duplicating it, so a name-keyed import
 * would merge one customer's part onto another's with every historical quote and
 * job still pointing at the merged identity.
 *
 * The table has **no `deleted_at`** — a reference is a fact about a drawing, not
 * a user-facing entity — so nothing here filters one. Rows go away with their
 * part or their customer, by FK cascade.
 */

/**
 * One customer's number for one part. Spelled out rather than aliased to the
 * generated row so callers can read the shape here; every read below assigns the
 * typed query result straight into it, so a column this file names but the
 * schema no longer has fails the build rather than the import.
 */
export interface PartCustomerReference {
  id: string;
  company_id: string;
  part_id: string;
  customer_id: string;
  customer_part_number: string;
  customer_revision: string | null;
  customer_drawing_number: string | null;
  created_at: string;
  updated_at: string;
}

const REFERENCE_COLUMNS =
  'id, company_id, part_id, customer_id, customer_part_number, customer_revision, customer_drawing_number, created_at, updated_at';

/** The unique constraint the import upserts against, as PostgREST wants it named. */
const IDENTITY_CONFLICT_TARGET = 'company_id,customer_id,customer_part_number';

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Every customer number that resolves to this part, e.g. for the part page's
 * "whose numbers does this answer to?" panel. A by-part read, so an archived
 * part still resolves its references.
 */
export async function getReferencesForPart(partId: string): Promise<PartCustomerReference[]> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('part_customer_references')
    .select(REFERENCE_COLUMNS)
    .eq('part_id', partId)
    .order('customer_part_number', { ascending: true });

  if (error) {
    console.error('Error fetching part customer references:', error);
    throw toFriendlyError(error, {
      entity: 'customer part number',
      fallback: "Couldn't load this part's customer numbers. Please try again.",
    });
  }

  const rows: PartCustomerReference[] = data ?? [];
  return rows;
}

/**
 * "Has this customer sent us any of these numbers before?" — the import's hot
 * path, keyed by `customer_part_number` so the caller can look each drawing up
 * without a second pass.
 *
 * **Chunked, because a folder of drawings is not a small list.** A package of 31
 * is typical and a catalogue import is hundreds; one `.in()` holding all of them
 * blows past PostgREST's 8 KB URL ceiling and returns 414, which reads as "none
 * of these are known" — the exact wrong answer for a function whose negative
 * branch creates parts. `ID_CHUNK` is the measured limit (lib/queryLimits.ts),
 * not a guess.
 *
 * Numbers go over the wire **verbatim**. The column stores the number as the
 * customer writes it and is never normalised, so trimming or case-folding here
 * would look up something that cannot be in the table.
 *
 * Throws if any batch fails. A missing key must mean "the shop has not seen this
 * number", never "we couldn't ask" — see CLAUDE.md on failed checks.
 */
export async function findPartsByCustomerNumbers(
  companyId: string,
  customerId: string,
  numbers: string[],
): Promise<Map<string, PartCustomerReference>> {
  const found = new Map<string, PartCustomerReference>();

  // Deduped so a package that repeats a number spends URL budget once. Blanks are
  // dropped rather than sent: the table's CHECK forbids them, so they can only
  // ever match nothing.
  const wanted = [...new Set(numbers.filter((n) => n.trim().length > 0))];
  if (wanted.length === 0) return found;

  const supabase = getSupabase();
  const batches = await Promise.all(
    chunk(wanted, ID_CHUNK).map(async (batch) => {
      const { data, error } = await supabase
        .from('part_customer_references')
        .select(REFERENCE_COLUMNS)
        .eq('company_id', companyId)
        .eq('customer_id', customerId)
        .in('customer_part_number', batch);

      if (error) {
        console.error('Error looking up customer part numbers:', error);
        throw toFriendlyError(error, {
          entity: 'customer part number',
          fallback:
            "Couldn't check these numbers against what your shop already has. Please try again.",
        });
      }
      const rows: PartCustomerReference[] = data ?? [];
      return rows;
    }),
  );

  for (const row of batches.flat()) found.set(row.customer_part_number, row);
  return found;
}

/**
 * Record (or re-record) a part's number in one customer's numbering.
 *
 * Upserts on the identity constraint, so re-importing a package updates the
 * revision and drawing number instead of failing on 23505 — and, when the number
 * has been pointed at a different part, re-points it. That re-point is the
 * intended outcome of a user resolving the import's identity choice; the row is
 * a mapping, and the mapping is what changed.
 *
 * A missing revision or drawing number is written as NULL rather than left
 * alone: the drawing is the source of truth for both, and the review grid shows
 * the user the blank before they import it.
 */
export async function upsertPartCustomerReference(
  companyId: string,
  input: {
    part_id: string;
    customer_id: string;
    customer_part_number: string;
    customer_revision?: string | null;
    customer_drawing_number?: string | null;
  },
): Promise<PartCustomerReference> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('part_customer_references')
    .upsert(
      {
        company_id: companyId,
        part_id: input.part_id,
        customer_id: input.customer_id,
        customer_part_number: input.customer_part_number,
        customer_revision: input.customer_revision ?? null,
        customer_drawing_number: input.customer_drawing_number ?? null,
      },
      { onConflict: IDENTITY_CONFLICT_TARGET },
    )
    .select(REFERENCE_COLUMNS)
    .single();

  if (error) {
    console.error('Error saving part customer reference:', error);
    throw toFriendlyError(error, {
      entity: 'customer part number',
      fallback: "Couldn't save this customer's part number. Please try again.",
    });
  }

  const row: PartCustomerReference = data;
  return row;
}
