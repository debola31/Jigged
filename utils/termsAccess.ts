import { getSupabase } from '@/lib/supabase';
import { toError } from '@/lib/supabaseErrors';
import {
  CURRENT_LEGAL_VERSIONS,
  LEGAL_DOCUMENT_TYPES,
  type LegalDocumentType,
  type LegalVersion,
} from '@/lib/legal/manifest';

/**
 * Reading a user's own acceptance rows.
 *
 * SUPABASE-FIRST, no endpoint: `authenticated` may SELECT its own rows, so the
 * gate's question is a plain typed client read. Only the WRITE side needs a
 * server, because only the write side has to stamp an IP the client must not
 * choose.
 */

export interface AcceptedVersion {
  document_type: LegalDocumentType;
  version: number;
}

/**
 * Every acceptance this user has, in one round trip.
 *
 * Deliberately not two `.limit(1)` reads: PostgREST cannot express DISTINCT ON,
 * so "latest per document" would be two round trips on a path that runs on
 * every page load. The row count is bounded by (versions published × 2) — two
 * today, about six after a couple of annual bumps — so reducing client-side is
 * cheaper than the extra request.
 *
 * THROWS on failure, and that is the contract. "Couldn't check" is never
 * "denied": a caller must not be able to render a blocking modal from a query
 * that did not complete.
 */
export async function fetchAcceptedVersions(userId: string): Promise<AcceptedVersion[]> {
  const { data, error } = await getSupabase()
    .from('terms_acceptances')
    .select('document_type, version')
    .eq('user_id', userId);

  if (error) throw toError(error, 'Could not read terms acceptances');

  return (data ?? []).filter(
    (r): r is AcceptedVersion =>
      (LEGAL_DOCUMENT_TYPES as readonly string[]).includes(r.document_type),
  );
}

/**
 * Which documents this user still has to accept.
 *
 * MATCHES ON THE (document_type, version) PAIR, NEVER ON VERSION ALONE. If both
 * documents are ever bumped to the same number — entirely likely, since they are
 * independent monotonic counters that both start at 1 — a version-only match
 * would let a privacy acceptance satisfy the ToS check, and the user would be
 * silently recorded as having agreed to a document they never opened. The test
 * for this is not decorative.
 *
 * EQUALITY against the current version, not "accepted < current". "Below" fails
 * OPEN on a rollback or a malformed value; "has not accepted the current one"
 * cannot.
 */
export function documentsNeedingAcceptance(
  accepted: AcceptedVersion[],
  current: Record<LegalDocumentType, LegalVersion> = CURRENT_LEGAL_VERSIONS,
): LegalDocumentType[] {
  const have = new Set(accepted.map((a) => `${a.document_type}@${a.version}`));

  return LEGAL_DOCUMENT_TYPES.filter((type) => {
    const target = current[type];
    if (have.has(`${type}@${target.version}`)) return false;
    // A version nobody has to re-accept is satisfied by any prior acceptance of
    // that document — the Termly privacy export regenerates on Termly's cadence,
    // and a sub-processor-list refresh must not push everyone through a modal.
    if (!target.requires_reacceptance && accepted.some((a) => a.document_type === type)) {
      return false;
    }
    return true;
  });
}
