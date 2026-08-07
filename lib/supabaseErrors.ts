const SESSION_EXPIRY_KEY = 'jigged_session_expired';

/**
 * Store session expiry info in sessionStorage so AuthGuard can read it
 * when redirecting to /login. This avoids a hard window.location.href
 * navigation that would destroy the React tree and any unsaved input.
 */
export function redirectToSessionExpiry() {
  if (typeof window === 'undefined') return;

  const currentPath = window.location.pathname + window.location.search;
  // Don't store expiry info if already on login/signup/public pages
  if (
    currentPath.startsWith('/login') ||
    currentPath.startsWith('/signup') ||
    currentPath === '/'
  ) {
    return;
  }

  sessionStorage.setItem(
    SESSION_EXPIRY_KEY,
    JSON.stringify({ expired: true, returnTo: currentPath })
  );
}

/**
 * Read and clear session expiry info from sessionStorage.
 * Returns { expired, returnTo } if present, null otherwise.
 */
export function consumeSessionExpiry(): { expired: boolean; returnTo: string } | null {
  if (typeof window === 'undefined') return null;

  const raw = sessionStorage.getItem(SESSION_EXPIRY_KEY);
  if (!raw) return null;

  sessionStorage.removeItem(SESSION_EXPIRY_KEY);
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Check if a Supabase error indicates an authentication/authorization failure.
 */
export function isAuthError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;

  const err = error as Record<string, unknown>;

  // Supabase PostgREST auth error codes
  if (err.code === 'PGRST301' || err.code === 'PGRST302') return true;

  // HTTP status-based detection
  if (err.status === 401 || err.status === 403) return true;

  // Supabase error message patterns
  if (typeof err.message === 'string') {
    const msg = err.message.toLowerCase();
    if (
      msg.includes('jwt expired') ||
      msg.includes('token is expired') ||
      msg.includes('invalid jwt') ||
      msg.includes('not authenticated') ||
      msg.includes('refresh_token_not_found')
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Is this a *transient* abort rather than a real failure?
 *
 * `@supabase/auth-js` serialises token refreshes across tabs with the Web Locks API.
 * When two calls contend, the newer one takes the lock with `{ steal: true }` and the
 * loser's promise rejects with `AbortError: Lock was stolen by another request`. That
 * means "this attempt was superseded", NOT "the operation failed" — the newer holder
 * is completing the same work.
 *
 * Treating it as a failure is how a benign race became a user-visible lockout: AuthGuard
 * caught it and rendered "You don't have access to this company" to people who did.
 * Callers should retry or ignore these, never surface them as denial.
 */
export function isTransientAbortError(error: unknown): boolean {
  if (!error) return false;

  const err = asRecord(error);
  const name = typeof err.name === 'string' ? err.name : '';
  if (name === 'AbortError') return true;

  // The Supabase wrapper loses `name`, keeping the text in `message`/`hint`.
  const haystack = [err.message, err.hint, err.details]
    .filter((v): v is string => typeof v === 'string')
    .join(' ')
    .toLowerCase();

  return (
    haystack.includes('lock was stolen') ||
    haystack.includes('aborterror') ||
    haystack.includes('request was aborted') ||
    haystack.includes('acquiring an exclusive navigator lock')
  );
}

/**
 * `PGRST116` — PostgREST's "no rows returned" from `.single()`. A definitive answer, not a
 * failure: the row genuinely is not there. Callers branch on it deliberately.
 */
const PGRST_NO_ROWS = 'PGRST116';

/**
 * `insufficient_privilege` — every RLS denial, and every deliberate raise that borrows the code.
 *
 * Declared up here rather than with the other SQLSTATE constants below because
 * `isBillingWriteBlocked` needs it and `shouldReportSupabaseError` needs *that*. `const` is not
 * hoisted, so the order is load-bearing.
 */
const PG_INSUFFICIENT_PRIVILEGE = '42501';

/**
 * The two shapes a billing-gate denial arrives in — a lapsed or never-subscribed shop hitting the
 * write gate, as opposed to a member who genuinely lacks permission.
 *
 *  1. RLS. A RESTRICTIVE policy carries its OWN name into the message:
 *       new row violates row-level security policy "billing_gate_insert" for table "parts"
 *     Postgres emits one WithCheckOption per restrictive policy, each keeping its `polname`, while
 *     OR-folding all the permissive ones into a single NAMELESS entry. That is why `billing_gate`
 *     is a safe discriminator: a plain membership denial produces the nameless form and is never
 *     mistaken for a lapsed subscription. `test_permissive_denial_is_nameless` pins it in CI,
 *     because the whole Subscribe CTA rests on it.
 *  2. RPC. `inv_assert_can_write()` raises `insufficient_privilege` with
 *       company <uuid> has no active subscription
 *     (migration 20260801150944). The five SECURITY DEFINER stock RPCs bypass RLS by construction,
 *     so they assert the gate themselves.
 *
 * NOT covered, deliberately: a blocked Storage upload. Those policies are permissive with
 * `company_can_write` inlined, so the message carries no policy name and is indistinguishable by
 * shape from a real permission failure. `ErrorAlert` catches that case from SubscriptionProvider
 * context instead — see its classification order.
 *
 * Walks `cause` so it still answers correctly after `toFriendlyError` has replaced the message
 * with user-facing copy. Depth-capped, and tolerant of a self-referential chain.
 */
const BILLING_GATE_POLICY_PREFIX = 'billing_gate';
const BILLING_RPC_PHRASE = 'no active subscription';

export function isBillingWriteBlocked(value: unknown): boolean {
  let node: unknown = value;
  for (let depth = 0; node && depth < 4; depth++) {
    const record = asRecord(node);
    const code = typeof record.code === 'string' ? record.code : '';
    const message = typeof record.message === 'string' ? record.message : '';

    if (
      code === PG_INSUFFICIENT_PRIVILEGE &&
      (message.includes(BILLING_GATE_POLICY_PREFIX) || message.includes(BILLING_RPC_PHRASE))
    ) {
      return true;
    }

    const next = record.cause;
    if (next === node) return false;
    node = next;
  }
  return false;
}

/**
 * Is this Supabase failure worth an issue in the queue?
 *
 * The Supabase Sentry integration (installed in `lib/supabase.ts`) captures EVERY `{ error }`
 * response unconditionally — it exposes no per-call filter — so this is the only place the
 * expected failures get dropped, and it runs from `beforeSend` in the Sentry configs.
 *
 * Excluding these is not about quota, which has ample headroom. It is that an issue queue with
 * predictable non-failures in it is one people stop reading, which is the documented history of
 * this project's queue (docs/observability.md "Why any of this matters").
 */
export function shouldReportSupabaseError(error: unknown): boolean {
  if (!error) return false;

  const code = asRecord(error).code;

  // A `.single()` that matched nothing. The caller asked "is there one?" and got "no".
  if (code === PGRST_NO_ROWS) return false;

  /**
   * Superseded, not failed.
   *
   * LOAD-BEARING, and not obviously so: postgrest-js does NOT reject on a fetch failure. It
   * converts one into a resolved `{ error }` carrying `hint: 'Request was aborted (timeout or
   * manual cancellation)'` (PostgrestBuilder's `res.catch`), which the integration then captures
   * like any other database error. So every cancelled request — a component unmounting mid-query,
   * a navigation away — would otherwise arrive as an issue.
   *
   * `isTransientAbortError` already matches that exact hint text. That is currently a happy
   * coincidence rather than a designed contract, which is why the test pins it.
   */
  if (isTransientAbortError(error)) return false;

  // Session expiry is not a bug and is already handled: the custom fetch in lib/supabase.ts
  // refreshes and retries, and `redirectToSessionExpiry` covers the rest.
  if (isAuthError(error)) return false;

  /**
   * The billing write-gate doing its job. A shop whose subscription lapsed generates one of these
   * on every write it attempts, for as long as it stays lapsed — the single most predictable
   * non-failure this app can produce, and the queue would fill with it.
   *
   * Note this is NOT the same judgement as "don't tell the user": the user gets a clear message
   * and a Subscribe button (see `friendlyErrorMessage` and `ErrorAlert`). It only means nobody
   * needs to be paged about a system working exactly as designed.
   *
   * A genuine permission denial still reports — that one IS a bug, and it produces the nameless
   * form `isBillingWriteBlocked` deliberately does not match.
   */
  if (isBillingWriteBlocked(error)) return false;

  return true;
}

/**
 * Normalise anything throwable into a real `Error`, for `Sentry.captureException`.
 *
 * Supabase rejects with a plain object (`{ code, details, hint, message }`), not an
 * Error. Handing that straight to Sentry produces an issue titled `"e"` with the body
 * "Object captured as exception with keys: code, details, hint, message" — unreadable,
 * and ungroupable, because Sentry has no type or stack to fingerprint on. The real
 * message ends up buried in a `__serialized__` extra where nobody looks.
 *
 * Keeps `code`/`details`/`hint` as own properties so they still reach Sentry's context.
 */
export function toError(value: unknown, fallbackMessage = 'Unknown error'): Error {
  if (value instanceof Error) return value;

  const record = asRecord(value);
  const message =
    (typeof record.message === 'string' && record.message) ||
    (typeof record.hint === 'string' && record.hint) ||
    (typeof value === 'string' && value) ||
    fallbackMessage;

  const error = new Error(message);
  for (const key of ['code', 'details', 'hint'] as const) {
    if (record[key] !== undefined && record[key] !== '') {
      Object.assign(error, { [key]: record[key] });
    }
  }
  // Preserve an AbortError's name so isTransientAbortError still recognises it.
  if (typeof record.name === 'string' && record.name) error.name = record.name;

  return error;
}

/**
 * Brands an Error whose `.message` is already user-facing copy, so a second translation pass
 * knows to leave it alone. `Symbol.for` rather than a property: invisible to `JSON.stringify`,
 * to Sentry's serialiser, and to any `{ ...err }` spread.
 */
const FRIENDLY_ERROR = Symbol.for('jigged.friendlyError');

/** True for an Error produced by `toFriendlyError`. */
export function isFriendlyError(value: unknown): boolean {
  return (
    value instanceof Error &&
    (value as unknown as Record<symbol, unknown>)[FRIENDLY_ERROR] === true
  );
}

/**
 * The access layer's throw: a real `Error` whose message is already the sentence to show a user.
 *
 * WHY THIS EXISTS. Supabase does not reject with an Error on the `{ data, error }` path — the
 * builder does a bare `error = JSON.parse(body)` and hands back a plain object. (`PostgrestError`
 * IS an Error subclass, but it is only constructed on the `.throwOnError()` path, which this repo
 * does not use.) So `throw error` in an access function throws a non-Error, every
 * `err instanceof Error ? err.message : 'Failed to X'` catch site takes the fallback branch, and
 * the real reason is discarded — that is how a lapsed subscription rendered as "Failed to create
 * part". Throwing this instead fixes the copy at ~90 existing catch sites with no UI change.
 *
 * `cause` keeps the original so `isBillingWriteBlocked` still classifies it after the message has
 * been replaced; `code`/`details`/`hint` are copied as own properties so Sentry context survives.
 * Idempotent, because several UI sites call `friendlyErrorMessage` on whatever they caught.
 */
export function toFriendlyError(value: unknown, options: FriendlyErrorOptions = {}): Error {
  if (isFriendlyError(value)) return value as Error;

  const error = new Error(friendlyErrorMessage(value, options), { cause: value });

  const record = asRecord(value);
  for (const key of ['code', 'details', 'hint'] as const) {
    if (record[key] !== undefined && record[key] !== '') {
      Object.assign(error, { [key]: record[key] });
    }
  }
  Object.defineProperty(error, FRIENDLY_ERROR, { value: true, enumerable: false });

  return error;
}

// ---------------------------------------------------------------------------
// User-facing error translation
// ---------------------------------------------------------------------------

// Postgres SQLSTATE codes we translate into plain-language copy. Raw DB strings
// like "violates foreign key constraint quotes_billing_address_id_fkey" must
// never reach a user.
const PG_FOREIGN_KEY_VIOLATION = '23503';
const PG_UNIQUE_VIOLATION = '23505';
// PG_INSUFFICIENT_PRIVILEGE ('42501') is declared above, next to isBillingWriteBlocked.
/**
 * `raise_exception` — what a bare `RAISE EXCEPTION` in one of our own SECURITY DEFINER
 * functions produces. Unlike a constraint code, this means *we* wrote the message deliberately
 * for a human ("Insufficient stock at location (have 0, need 999)"), so passing it through beats
 * replacing it with a generic apology.
 */
const PG_RAISED_BY_US = 'P0001';
/**
 * `check_violation` — which our stock RPCs use for their *deliberate* user-facing raises
 * ("Insufficient stock at source location (have 5, need 10)", "Too many parts at once").
 *
 * Passing it through needs care, because a real table CHECK constraint raises the same code with
 * raw DB text ("new row for relation \"parts\" violates check constraint parts_requires_unit") that
 * must never reach a user. The two are told apart by that phrase — see `isRawConstraintText`.
 *
 * Without this, every one of those hand-written messages was replaced by a generic fallback: the
 * operator moving more than a shelf holds was told "Failed to update stock" instead of how much
 * was actually there.
 */
const PG_CHECK_VIOLATION = '23514';

/** True for Postgres' own constraint-failure wording, as opposed to a message we wrote. */
const isRawConstraintText = (message: string) =>
  /violates (check|not-null|exclusion) constraint/i.test(message);

export interface FriendlyErrorOptions {
  /** What the user was acting on, e.g. "address", "part", "job". Default "item". */
  entity?: string;
  /**
   * What typically references the entity (for FK-violation copy), e.g.
   * "quotes or jobs". When omitted we derive it from the DB error text.
   */
  references?: string;
  /** Message to use when no specific code mapping applies. */
  fallback?: string;
}

function asRecord(error: unknown): Record<string, unknown> {
  return error && typeof error === 'object' ? (error as Record<string, unknown>) : {};
}

/** "table_name" → "table name" for readable copy. */
function humanizeTable(table: string): string {
  return table.replace(/_/g, ' ').trim();
}

/**
 * Best-effort extraction of the *referencing* table from a Postgres FK-violation
 * message such as:
 *   delete on table "customer_addresses" violates foreign key constraint
 *   "quotes_billing_address_id_fkey" on table "quotes"
 *
 * The auto-named constraint prefix (`quotes_…_fkey`) is the reliable signal — the
 * first `on table` names the row being deleted, not what references it. We prefer
 * the constraint prefix, then fall back to the LAST `on table` clause.
 */
function referencingEntityFromMessage(message: string): string | null {
  const constraint = message.match(/constraint "([a-z0-9]+?)_/i);
  if (constraint) return humanizeTable(constraint[1]);
  const tables = [...message.matchAll(/on table "([^"]+)"/gi)];
  if (tables.length > 0) return humanizeTable(tables[tables.length - 1][1]);
  return null;
}

/**
 * Translate a raw Supabase/Postgres error into a single user-facing sentence.
 *
 * Access-layer functions should `throw new Error(friendlyErrorMessage(error, …))`
 * so the friendly text propagates to every caller's `err.message` — UIs then show
 * it directly instead of a raw SQLSTATE string. Use `options.entity` to name the
 * thing being acted on; FK-violation copy auto-detects what still references it.
 */
export function friendlyErrorMessage(
  error: unknown,
  options: FriendlyErrorOptions = {},
): string {
  // Already translated. Re-deriving from friendly text loses information rather than adding any:
  // the FK branch reads the *DB* clause to name what still references the row, so a second pass
  // over "…still referenced by quotes" degrades it to "…by other records".
  if (isFriendlyError(error)) return (error as Error).message;

  const err = asRecord(error);
  const code = typeof err.code === 'string' ? err.code : undefined;
  const message = typeof err.message === 'string' ? err.message : '';
  const entity = options.entity ?? 'item';

  if (code === PG_FOREIGN_KEY_VIOLATION) {
    const ref = options.references ?? referencingEntityFromMessage(message) ?? 'other records';
    return `This ${entity} can't be deleted because it's still referenced by ${ref}. Remove or reassign those first.`;
  }

  if (code === PG_UNIQUE_VIOLATION) {
    return `That ${entity} already exists — use a different value.`;
  }

  // Checked BEFORE the generic privilege branch below, which would otherwise answer a billing
  // question with a role diagnosis — sending the owner to ask their admin for access instead of
  // to the Subscribe button sitting at the top of the same page.
  //
  // Role-agnostic on purpose: this is the copy that appears wherever `ErrorAlert` is not used, so
  // it has to be true for an operator as well as an owner, while still naming the way out for the
  // one person who can take it. `ErrorAlert` replaces it with role-aware copy when it knows more.
  if (isBillingWriteBlocked(error)) {
    const noun = options.entity && options.entity !== 'item' ? options.entity : 'change';
    return `Your shop's subscription isn't active, so that ${noun} wasn't saved. An admin can start one in Settings.`;
  }

  if (
    code === PG_INSUFFICIENT_PRIVILEGE ||
    message.toLowerCase().includes('permission denied') ||
    message.toLowerCase().includes('row-level security')
  ) {
    return `You don't have permission to do that.`;
  }

  if (isAuthError(error)) {
    return 'Your session has expired. Please sign in again.';
  }

  // Checked last: permission and auth classes above are more actionable than whatever text
  // the function happened to raise.
  if (code === PG_RAISED_BY_US && message) {
    return message;
  }
  if (code === PG_CHECK_VIOLATION && message && !isRawConstraintText(message)) {
    return message;
  }

  return options.fallback ?? 'Something went wrong. Please try again.';
}
