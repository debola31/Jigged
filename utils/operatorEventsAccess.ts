import * as Sentry from '@sentry/nextjs';
import { getTypedSupabase as getSupabase } from '@/lib/supabase';

/**
 * Capture-funnel instrumentation.
 *
 * WHY THIS EXISTS. The notes corpus starts empty — there is no seeded knowledge,
 * so view counts, the login banner and reactions are all structurally silent
 * until somebody writes something. For the first weeks of the pilot these events
 * are the ONLY readable signal, and they are what distinguishes the failure modes
 * from each other:
 *
 *   app_opened ~ 0                              -> deployment, not the product
 *   op_card_opened high, composer_focused ~ 0   -> container fit; they aren't reaching for it
 *   composer_focused high, note_saved low       -> capture friction; they tried and gave up
 *   notes written, prior_notes_opened low       -> discoverability in the READER flow
 *
 * Without them, "adoption was poor" is unreadable.
 *
 * WHAT IT MUST NEVER DO. Instrumentation cannot be allowed to break, block or
 * slow the interaction it is measuring. Every call here is fire-and-forget: never
 * awaited into a user-visible path, never surfaced to the operator, errors go to
 * Sentry only. The underlying RPC is SECURITY DEFINER and returns void, and it
 * returns silently for a non-member rather than raising.
 *
 * WHAT IT MUST NEVER RECORD. `context` carries ids and coarse counts only —
 * never note bodies, and never the ids of notes the actor READ. Read tracking is
 * note_views' job, and that table is deliberately unreadable by any browser or AI
 * role precisely so no per-operator reading report can be reconstructed. An
 * operator_events row that named which notes someone opened would reintroduce
 * exactly what note_views' RLS exists to prevent.
 */

/** Mirrors the operator_events_kind_check constraint. Adding one needs a migration. */
export type OperatorEventKind =
  | 'app_opened'
  | 'station_selected'
  | 'op_card_opened'
  | 'prior_notes_opened'
  | 'composer_focused'
  | 'composer_abandoned'
  | 'note_saved'
  | 'note_saved_with_photo'
  | 'photo_attached'
  | 'completion_recorded';

export type OperatorEventContext = Record<string, string | number | boolean | null>;

/**
 * Record one funnel event. Returns nothing and never rejects — callers must not
 * await it, and there is deliberately no success signal to branch on.
 */
export function logOperatorEvent(
  companyId: string,
  kind: OperatorEventKind,
  context: OperatorEventContext = {},
): void {
  if (!companyId) return;

  try {
    void getSupabase()
      .rpc('log_operator_event', {
        p_company_id: companyId,
        p_kind: kind,
        p_context: context,
      })
      .then(({ error }) => {
        if (error) {
          Sentry.captureException(error, {
            level: 'warning',
            tags: { area: 'operator_events', kind },
          });
        }
      });
  } catch (err) {
    // Belt and braces: a throw before the promise exists (no client, no session)
    // must still not reach the operator.
    Sentry.captureException(err, {
      level: 'warning',
      tags: { area: 'operator_events', kind },
    });
  }
}
