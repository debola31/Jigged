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

// ---------------------------------------------------------------------------
// User-facing error translation
// ---------------------------------------------------------------------------

// Postgres SQLSTATE codes we translate into plain-language copy. Raw DB strings
// like "violates foreign key constraint quotes_billing_address_id_fkey" must
// never reach a user.
const PG_FOREIGN_KEY_VIOLATION = '23503';
const PG_UNIQUE_VIOLATION = '23505';
const PG_INSUFFICIENT_PRIVILEGE = '42501';
/**
 * `raise_exception` — what a bare `RAISE EXCEPTION` in one of our own SECURITY DEFINER
 * functions produces. Unlike a constraint code, this means *we* wrote the message deliberately
 * for a human ("Insufficient stock at location (have 0, need 999)"), so passing it through beats
 * replacing it with a generic apology.
 */
const PG_RAISED_BY_US = 'P0001';

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

  return options.fallback ?? 'Something went wrong. Please try again.';
}
