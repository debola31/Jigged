import * as Sentry from '@sentry/nextjs';
import type { ErrorEvent, EventHint } from '@sentry/nextjs';
import { shouldReportSupabaseError, toError } from '@/lib/supabaseErrors';

/**
 * What the Supabase integration's automatic captures are allowed to become issues.
 *
 * The integration (installed in `lib/supabase.ts`) is the error-reporting net for every table
 * read and write — see issue #708 for the failure it exists to prevent. It exposes no per-call
 * configuration: it captures EVERY `{ error }` response, at error level, marked unhandled. So
 * every judgement about what is worth reporting has to be made here, from `beforeSend`.
 *
 * Shared by `instrumentation-client.ts` and `sentry.server.config.ts` so the two cannot drift.
 */

/**
 * The integration's two mechanism types — database operations and auth operations. Events
 * carrying neither are somebody else's (a React render error, a manual `captureException`) and
 * pass through untouched.
 */
const AUTO_MECHANISM_TYPES = new Set(['auto.db.supabase.postgres', 'auto.db.supabase.auth']);

/**
 * Span attribute stamped by the Supabase client's own `fetch` when the request path is
 * `/rest/v1/rpc/…`. Exported so `lib/supabase.ts` sets the same key this reads.
 *
 * WHY A SPAN ATTRIBUTE, and not a list of function names: the integration's span carries
 * `db.table`, which for an rpc is the function name and for a table op is the table name — the
 * two are indistinguishable without knowing which names are functions. That list is not
 * available at runtime (`types/database.ts` is types-only; its `Constants` export carries enums
 * and nothing else), and hand-maintaining one would rot. The request URL says it outright, and
 * the db span is still active when the client's `fetch` runs, so the fetch can just mark it.
 */
export const RPC_SPAN_ATTRIBUTE = 'jigged.rpc';

/**
 * Decide whether one automatically-captured Supabase event survives, and clean it up if it does.
 *
 * Returns `null` to drop, or the event to keep.
 */
export function applySupabaseEventPolicy(
  event: ErrorEvent,
  hint: EventHint,
): ErrorEvent | null {
  const mechanism = event.exception?.values?.[0]?.mechanism;
  if (!AUTO_MECHANISM_TYPES.has(mechanism?.type ?? '')) return event;

  // Expected negatives: a `.single()` that matched nothing, a cancelled request, an expired
  // session. Not failures, and an issue queue containing them is one nobody reads.
  if (!shouldReportSupabaseError(hint.originalException)) return null;

  const span = Sentry.getActiveSpan();
  const spanData = span ? Sentry.spanToJSON(span).data : undefined;

  /**
   * `.rpc()` belongs to the access layer, not to the net.
   *
   * The net reaches rpc calls incidentally — the integration classifies by HTTP method, so an
   * rpc POST looks like an `insert` — but only once a `.from()` query has run and lazily patched
   * the shared builder prototype. An rpc that happens to be the first Supabase call on a page
   * load is never captured. Coverage that depends on call ordering is not coverage.
   *
   * More importantly, only the call site can tell a `P0001` raised deliberately FOR the user
   * ("Insufficient stock at location (have 0, need 999)") from a `P0001` that is a bug — and the
   * incident behind #708 was itself a `P0001`, so no rule here could separate them. Dropping rpc
   * leaves the access layer as its sole reporter, with the domain context to make that call.
   */
  if (spanData?.[RPC_SPAN_ATTRIBUTE] === true) return null;

  /**
   * These are handled. The integration hard-codes `handled: false`, which would count every
   * failed query against crash-free sessions and match any alert rule scoped to unhandled
   * errors — but the app caught this, rendered an error state, and carried on.
   */
  if (mechanism) mechanism.handled = true;

  /**
   * Tag with the table so alert rules and searches can be scoped to one.
   * The integration puts the table in a *context*, and contexts are not searchable; tags are.
   */
  const table = spanData?.['db.table'];
  if (typeof table === 'string' && table) {
    event.tags = { ...event.tags, 'db.table': table };
  }

  return event;
}

// ---------------------------------------------------------------------------
// The other half: reporting what the net cannot see
// ---------------------------------------------------------------------------

/**
 * The `area` tag vocabulary, as a union rather than a doc.
 *
 * #708 asked for "a short agreed list rather than ad-hoc strings" so alert rules stay
 * filterable. A union is the version of that which cannot rot: adding a value is a deliberate
 * edit here, and a typo is a compile error rather than a tag nobody notices is orphaned.
 *
 * Seeded from the tags already in use before this existed, plus one per access module that
 * reports. Keep it coarse — this is for routing an alert, not for describing a call site.
 */
export type SentryArea =
  | 'billing'
  | 'bom'
  | 'customers'
  | 'demo'
  | 'inventory'
  | 'jobs'
  | 'machine_maintenance'
  | 'note_reactions'
  | 'note_views'
  | 'operator'
  | 'operator_events'
  | 'parts'
  | 'pricing'
  | 'quotes'
  | 'routings'
  | 'shipments'
  | 'storage_upload'
  | 'vendors'
  | 'work_centers';

interface ReportOptions {
  /** The function that failed, e.g. 'transferStock'. Becomes the Sentry message prefix. */
  op: string;
  area: SentryArea;
  /** Ids and arguments worth having while reading the issue. Keep it small. */
  extra?: Record<string, unknown>;
  /**
   * `warning` for fire-and-forget telemetry whose failure costs the user nothing —
   * `logOperatorEvent`, view logging. Default `error`.
   */
  level?: 'error' | 'warning';
  /**
   * SQLSTATEs this particular RPC raises ON PURPOSE, to say something to the user.
   *
   * Our stock RPCs `RAISE EXCEPTION` with `P0001`/`23514` to produce sentences like
   * *"Insufficient stock at source location (have 5, need 10)"*. That is the database telling
   * an operator they typed too big a number — a normal outcome of a normal action, not a defect,
   * and filing it would recreate exactly the alert fatigue documented in docs/observability.md.
   *
   * This is per-call and not a global rule because the same code means the opposite elsewhere:
   * the incident behind #708 was a `P0001` raised by a trigger, and it was a real bug. Only the
   * caller knows which of the two its RPC does.
   */
  expectedCodes?: readonly string[];
}

/**
 * Report a failure the Supabase integration does not see: an `.rpc()`, a storage operation, or
 * a thrown JS error.
 *
 * Does NOT throw or swallow — it reports and returns, so the caller keeps full control of its
 * own control flow (several of them deliberately continue, and the stock RPCs need to throw a
 * *translated* error rather than whatever this was handed).
 *
 * Skips the expected negatives via the same predicate the net uses, so the two layers agree on
 * what counts as a failure. It does NOT skip deliberate user-facing raises — the caller decides
 * that, because only the caller knows whether its `P0001` is a message for the user or a bug.
 * That judgement is the entire reason rpc is reported here instead of by the net.
 */
export function reportWriteFailure(error: unknown, opts: ReportOptions): void {
  if (!shouldReportSupabaseError(error)) return;

  const code = (error && typeof error === 'object'
    ? (error as Record<string, unknown>).code
    : undefined);
  if (typeof code === 'string' && opts.expectedCodes?.includes(code)) return;

  Sentry.captureException(toError(error, `${opts.op} failed`), {
    level: opts.level ?? 'error',
    tags: { area: opts.area },
    extra: { op: opts.op, ...opts.extra },
  });
}
