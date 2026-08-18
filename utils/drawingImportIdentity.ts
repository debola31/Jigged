/**
 * Deciding what each drawing IS, before anything is created.
 *
 * THE INCIDENT THIS PREVENTS. Part names are unique per company, and reusing one
 * REVIVES an archived row rather than duplicating it. That is correct when a shop
 * re-imports its own catalogue. It is wrong here, because the number on a drawing
 * belongs to the customer who sent it, and two OEMs legitimately both use
 * "1003308". Keying this import on `part_name` would merge customer B's part onto
 * customer A's — or silently un-archive A's — with every historical quote and job
 * still pointing at the merged identity.
 *
 * So the import keys on `(customer_id, customer_part_number)` and never on the
 * name. The name is only ever used to DETECT a collision worth showing someone.
 *
 * THE ARCHIVED LOOKUP IS THE LOAD-BEARING PART. `checkPartNameExists` filters
 * `deleted_at IS NULL` on purpose — an archived name is free to reuse there. That
 * makes the dangerous case invisible through it, which is why this module queries
 * archived rows explicitly instead of reusing it.
 */

import { getSupabase } from '@/lib/supabase';
import { findPartsByCustomerNumbers } from '@/utils/partCustomerReferencesAccess';
import type { IdentityOutcome } from '@/types/drawingImport';

/** PostgREST `.in()` goes into the URL, so a 31-part package cannot be one query. */
const LOOKUP_CHUNK = 200;

export interface IdentityRequest {
  /** Row key — the file group's stem. */
  stem: string;
  /** The name the part would be created under. */
  partName: string;
  /** The number as the customer writes it. Empty when the drawing carried none. */
  customerPartNumber: string;
}

interface NameMatch {
  id: string;
  part_name: string;
  archived: boolean;
  /** The customer this part already answers to, when it answers to one. */
  ownedByCustomerId: string | null;
}

/**
 * Every part matching these names, ARCHIVED INCLUDED, with whichever customer
 * already claims it. Deliberately not `checkPartNameExists`, which hides archived
 * rows — those are exactly the ones that would be silently revived.
 */
async function fetchNameMatches(
  companyId: string,
  names: string[],
): Promise<Map<string, NameMatch>> {
  const supabase = getSupabase();
  const out = new Map<string, NameMatch>();
  const wanted = [...new Set(names.map((n) => n.trim()).filter(Boolean))];
  if (wanted.length === 0) return out;

  const found: Array<{ id: string; part_name: string; deleted_at: string | null }> = [];
  for (let i = 0; i < wanted.length; i += LOOKUP_CHUNK) {
    const { data, error } = await supabase
      .from('parts')
      .select('id, part_name, deleted_at')
      .eq('company_id', companyId)
      .in('part_name', wanted.slice(i, i + LOOKUP_CHUNK));
    // Throw rather than degrade. A name check that quietly returns "no match"
    // reads as "safe to create" and is how the merge happens.
    if (error) throw error;
    found.push(...(data ?? []));
  }
  if (found.length === 0) return out;

  // Who already claims each of these parts? One extra query beats N.
  const { data: refs, error: refErr } = await supabase
    .from('part_customer_references')
    .select('part_id, customer_id')
    .eq('company_id', companyId)
    .in('part_id', found.map((p) => p.id));
  if (refErr) throw refErr;

  const owner = new Map<string, string>();
  for (const r of refs ?? []) owner.set(r.part_id, r.customer_id);

  for (const p of found) {
    out.set(p.part_name.trim().toLowerCase(), {
      id: p.id,
      part_name: p.part_name,
      archived: p.deleted_at !== null,
      ownedByCustomerId: owner.get(p.id) ?? null,
    });
  }
  return out;
}

/**
 * A free name near the one that is taken. A numeric suffix rather than the
 * customer's name: encoding the customer into `part_name` is what
 * `part_customer_references` exists to make unnecessary, and it reads as identity
 * when it is only disambiguation.
 */
function suggestFreeName(base: string, taken: Set<string>): string {
  for (let n = 2; n < 100; n += 1) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return `${base}-${Date.now()}`;
}

/**
 * Resolve every row's identity in a fixed number of queries.
 *
 * `customerId` may be null — a shop can import drawings without saying whose they
 * are. Attribution is then unavailable, so the reference lookup is skipped and
 * only name collisions are reported. That is a weaker guard, and the caller should
 * say so rather than implying the import is fully checked.
 */
export async function resolveIdentities(
  companyId: string,
  customerId: string | null,
  rows: IdentityRequest[],
): Promise<Map<string, IdentityOutcome>> {
  const out = new Map<string, IdentityOutcome>();
  if (rows.length === 0) return out;

  let byNumber: Map<string, { part_id: string }> = new Map();
  let nameMatches: Map<string, NameMatch>;

  try {
    if (customerId) {
      const numbers = rows.map((r) => r.customerPartNumber.trim()).filter(Boolean);
      if (numbers.length > 0) {
        byNumber = await findPartsByCustomerNumbers(companyId, customerId, numbers);
      }
    }
    nameMatches = await fetchNameMatches(companyId, rows.map((r) => r.partName));
  } catch (err) {
    // "Couldn't check" is never "clear to create". Every row reports the failure
    // and the UI gives the user a retry rather than a green light.
    const reason = err instanceof Error ? err.message : 'Lookup failed';
    for (const r of rows) out.set(r.stem, { kind: 'unknown', reason });
    return out;
  }

  // Names already spoken for, so two rows in ONE import cannot both be offered the
  // same disambiguated name.
  const taken = new Set<string>([...nameMatches.keys()]);

  for (const row of rows) {
    const number = row.customerPartNumber.trim();
    const name = row.partName.trim();

    // 1. Have we seen this customer's number before? That is the identity key,
    //    and a hit settles the row regardless of what the name says.
    const known = number ? byNumber.get(number) : undefined;
    if (known) {
      const match = nameMatches.get(name.toLowerCase());
      out.set(row.stem, {
        kind: 'known',
        partId: known.part_id,
        partName: match?.part_name ?? name,
      });
      continue;
    }

    // 2. Otherwise the name is only a collision detector.
    const match = nameMatches.get(name.toLowerCase());
    if (!match) {
      out.set(row.stem, { kind: 'new' });
      taken.add(name.toLowerCase());
      continue;
    }

    if (match.archived) {
      // Reviving is legitimate — this may well be the same part coming back. Doing
      // it silently is not, so it is a choice on the row. `create_new` needs a name
      // because the unique constraint covers archived rows too.
      const suggested = suggestFreeName(name, taken);
      taken.add(suggested.toLowerCase());
      out.set(row.stem, {
        kind: 'archived',
        partId: match.id,
        partName: match.part_name,
        suggestedName: suggested,
        choice: 'revive',
      });
      continue;
    }

    // 3. A LIVE part holds this name. If it already answers to a DIFFERENT
    //    customer, writing to it is the merge this module exists to prevent.
    if (match.ownedByCustomerId && match.ownedByCustomerId !== customerId) {
      const suggested = suggestFreeName(name, taken);
      taken.add(suggested.toLowerCase());
      out.set(row.stem, {
        kind: 'name_taken',
        partId: match.id,
        partName: match.part_name,
        suggestedName: suggested,
      });
      continue;
    }

    // A live part with no other claimant is the shop's own. Updating it and
    // attaching the reference is the ordinary re-import case.
    out.set(row.stem, { kind: 'known', partId: match.id, partName: match.part_name });
  }

  return out;
}

/** Does this outcome need a human before the import can proceed on that row? */
export function needsAttention(outcome: IdentityOutcome): boolean {
  return outcome.kind === 'archived' || outcome.kind === 'name_taken' || outcome.kind === 'unknown';
}
