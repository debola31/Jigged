/**
 * The optional AI pass over rows the deterministic reader left thin.
 *
 * NEVER CALLED ON MOUNT. CLAUDE.md is explicit: an Anthropic call needs a user
 * action, because a header badge once fired five of them per dashboard load and
 * burned the credits in days. This is invoked from a button, and it says what it
 * will cost before it runs.
 *
 * It also only asks about rows worth asking about. A row whose material and finish
 * are already read costs nothing to skip, and a row with no text at all — a scan —
 * has nothing to send.
 */

import { getSupabase } from '@/lib/supabase';
import { API_BASE_URL } from '@/lib/api';
import type { BuiltRow } from '@/lib/drawingImportExtract';
import { titleBlockRegion } from '@/lib/drawingText';
import type { ExtractedFields, FieldRole } from '@/lib/drawingText';

/** Roles the AI arm measurably improves. Identity is deterministic's job. */
const ASSISTED_ROLES: FieldRole[] = ['material', 'finish', 'description'];

interface AssistResponse {
  fields: Record<string, { value: string | null; caption: string | null }>;
  fields_available: boolean;
  dropped: string[];
}

export interface AssistOutcome {
  /** Rows the call actually improved, by stem. */
  filled: Map<string, ExtractedFields>;
  askedAbout: number;
  skipped: number;
  failed: number;
  /** Values the server refused because they were not on the drawing. */
  dropped: string[];
}

/** Worth asking about: it has text to send, and at least one assisted role is blank. */
export function needsAssist(row: BuiltRow): boolean {
  if (row.readSource === 'none') return false;
  return ASSISTED_ROLES.some((role) => !row.fields[role]?.value);
}

/**
 * Ask the server to assign title-block roles for the rows that need it.
 *
 * One request per drawing. That is deliberate: a package-wide request would be a
 * single point of failure over 31 sheets and would push the payload toward
 * Vercel's body ceiling, while a per-sheet request fails only its own row.
 *
 * They go out CONCURRENTLY. One at a time meant 31 sequential round trips of a
 * couple of seconds each — a minute and a half of watching a counter tick, for
 * work that has no ordering between sheets. A fixed pool keeps that bounded well
 * under the route's own 200-per-10-minutes limiter, which a package of this size
 * never approaches.
 */
const ASSIST_CONCURRENCY = 6;

export async function assistRows(
  companyId: string,
  rows: BuiltRow[],
  onProgress?: (done: number, total: number) => void,
): Promise<AssistOutcome> {
  const outcome: AssistOutcome = {
    filled: new Map(),
    askedAbout: 0,
    skipped: 0,
    failed: 0,
    dropped: [],
  };

  const candidates = rows.filter(needsAssist);
  outcome.skipped = rows.length - candidates.length;

  const supabase = getSupabase();
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) {
    // Not a silent no-op: the caller shows this, because "nothing happened" and
    // "you are not signed in" look identical on screen otherwise.
    throw new Error('Your session expired. Sign in again and retry.');
  }

  let done = 0;
  let cursor = 0;
  /**
   * A rejected SESSION is not a drawing that could not be read.
   *
   * Every row failing individually reported "29 of 29 could not be read", which
   * sends someone to look at their drawings when the answer is that their token
   * is stale — the commonest cause locally being a database reset, which drops
   * `auth.sessions` while the browser still holds a perfectly well-formed JWT.
   *
   * So a 401/403 stops the batch: the remaining requests are aborted rather than
   * fired to fail the same way, and the caller is told the one true thing.
   */
  const abort = new AbortController();
  let rejected: 401 | 403 | null = null;

  const readOne = async (row: BuiltRow) => {
    outcome.askedAbout += 1;
    try {
      const response = await fetch(`${API_BASE_URL}/api/drawings/fields`, {
        method: 'POST',
        signal: abort.signal,
        headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          company_id: companyId,
          // The title-block region only, capped — the exact input the published
          // 90%/89% was measured on. Sending every string on the sheet would be a
          // different experiment, and would 413 on a drawing with 1,396 of them.
          strings: titleBlockRegion(row.items).map((i) => ({
            text: i.text,
            x: i.x,
            y: i.y,
            height: i.height,
          })),
        }),
      });
      if (response.status === 401 || response.status === 403) {
        rejected = response.status;
        abort.abort();
        return;
      }
      if (!response.ok) throw new Error(String(response.status));
      const body = (await response.json()) as AssistResponse;
      outcome.dropped.push(...(body.dropped ?? []));

      // Merge, never overwrite. A value the deterministic pass read from an
      // attribute tag is stronger evidence than an assignment, and the user may
      // already have edited the row.
      const merged: ExtractedFields = {};
      for (const role of ASSISTED_ROLES) {
        if (row.fields[role]?.value) continue;
        const value = body.fields?.[role]?.value;
        if (!value) continue;
        merged[role] = {
          value,
          source: 'geometry',
          caption: body.fields[role]?.caption ?? undefined,
        };
      }
      if (Object.keys(merged).length > 0) outcome.filled.set(row.stem, merged);
    } catch (err) {
      // An abort means a sibling already found the real answer — not this row's
      // failure, and counting it would inflate the tally we then show.
      if ((err as { name?: string })?.name === 'AbortError') return;
      // One drawing failing must not abandon the other thirty.
      outcome.failed += 1;
    }
    done += 1;
    onProgress?.(done, candidates.length);
  };

  // Workers pull from a shared cursor, so a slow sheet holds up only itself.
  await Promise.all(
    Array.from({ length: Math.min(ASSIST_CONCURRENCY, candidates.length) }, async () => {
      for (;;) {
        if (rejected) return;
        const index = cursor;
        cursor += 1;
        if (index >= candidates.length) return;
        await readOne(candidates[index]);
      }
    }),
  );

  if (rejected) {
    throw new Error(
      rejected === 401
        ? 'Your session has expired. Sign out and back in, then read the drawings again — the parts on screen are unaffected.'
        : 'This account cannot read drawings for this company. The parts on screen are unaffected.',
    );
  }

  return outcome;
}
