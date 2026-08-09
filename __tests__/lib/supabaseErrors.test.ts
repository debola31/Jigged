import { describe, it, expect, beforeEach } from 'vitest';
import {
  isAuthError,
  redirectToSessionExpiry,
  consumeSessionExpiry,
  friendlyErrorMessage,
  isBillingWriteBlocked,
  isFriendlyError,
  isTransientAbortError,
  isNetworkFailureError,
  shouldReportSupabaseError,
  toError,
  isIndeterminateSingleError,
  toFriendlyError,
} from '@/lib/supabaseErrors';

/**
 * The exact payloads Postgres produces for a billing-gate denial. Hard-coded rather than built by
 * a helper: these strings are a contract with the DB, and the integration tests
 * (`test_blocked_insert_names_the_billing_policy`) assert the same shapes from the other side.
 */
const BLOCKED_INSERT = {
  code: '42501',
  details: null,
  hint: null,
  message:
    'new row violates row-level security policy "billing_gate_insert" for table "parts"',
};
const BLOCKED_UPDATE = {
  code: '42501',
  details: null,
  hint: null,
  message:
    'new row violates row-level security policy "billing_gate_update" for table "parts"',
};
const BLOCKED_RPC = {
  code: '42501',
  details: null,
  hint: null,
  message: 'company 0f3ab1e2-1111-4222-8333-444455556666 has no active subscription',
};
/** A membership failure: permissive policies OR-fold into ONE nameless WithCheckOption. */
const NAMELESS_DENIAL = {
  code: '42501',
  details: null,
  hint: null,
  message: 'new row violates row-level security policy for table "parts"',
};

describe('isIndeterminateSingleError — "couldn\'t check" is never "denied"', () => {
  it('is false with no error: the check completed', () => {
    // The happy path. `data` decides; there is nothing indeterminate.
    expect(isIndeterminateSingleError(null)).toBe(false);
    expect(isIndeterminateSingleError(undefined)).toBe(false);
  });

  it('is false for PGRST116 — "no rows" is a real answer, not a failure', () => {
    // A caller SHOULD act on this: the membership row genuinely is not there.
    expect(isIndeterminateSingleError({ code: 'PGRST116', message: 'no rows' })).toBe(false);
  });

  it('is true for the failures that used to read as "not a member"', () => {
    // Every one of these arrived as `data: null` alongside a discarded error, and
    // the operator layout responded by clearing the station, signing the user out
    // and bouncing to login. On a phone on shop wifi, the first of these is not
    // an edge case — it is Tuesday.
    expect(isIndeterminateSingleError({ message: 'Failed to fetch' })).toBe(true);
    expect(isIndeterminateSingleError({ code: '500', message: 'server error' })).toBe(true);
    expect(isIndeterminateSingleError({ code: 'PGRST301', message: 'JWT expired' })).toBe(true);
    expect(isIndeterminateSingleError({ code: '42501', message: 'permission denied' })).toBe(true);
  });

  it('treats a near-miss code as indeterminate rather than guessing', () => {
    // Fails safe: an unrecognised code must not be mistaken for "no rows", because
    // the negative branch signs people out.
    expect(isIndeterminateSingleError({ code: 'PGRST117' })).toBe(true);
    expect(isIndeterminateSingleError({ code: 'pgrst116' })).toBe(true);
  });
});

describe('isAuthError', () => {
  it('returns true for PGRST301 (JWT expired)', () => {
    expect(isAuthError({ code: 'PGRST301', message: 'JWT expired' })).toBe(true);
  });

  it('returns true for PGRST302 (JWT role claim mismatch)', () => {
    expect(isAuthError({ code: 'PGRST302', message: 'role claim mismatch' })).toBe(true);
  });

  it('returns true for status 401', () => {
    expect(isAuthError({ status: 401, message: 'Unauthorized' })).toBe(true);
  });

  it('returns true for status 403', () => {
    expect(isAuthError({ status: 403, message: 'Forbidden' })).toBe(true);
  });

  it('returns true for "jwt expired" message', () => {
    expect(isAuthError({ message: 'JWT expired' })).toBe(true);
  });

  it('returns true for "token is expired" message', () => {
    expect(isAuthError({ message: 'Token is expired or invalid' })).toBe(true);
  });

  it('returns true for "invalid jwt" message', () => {
    expect(isAuthError({ message: 'invalid jwt: token has expired' })).toBe(true);
  });

  it('returns true for "not authenticated" message', () => {
    expect(isAuthError({ message: 'not authenticated' })).toBe(true);
  });

  it('returns true for "refresh_token_not_found" message', () => {
    expect(isAuthError({ message: 'refresh_token_not_found' })).toBe(true);
  });

  it('returns false for non-auth errors', () => {
    expect(isAuthError({ code: 'PGRST116', message: 'No rows found' })).toBe(false);
  });

  it('returns false for network errors', () => {
    expect(isAuthError({ message: 'Failed to fetch' })).toBe(false);
  });

  it('returns false for null/undefined', () => {
    expect(isAuthError(null)).toBe(false);
    expect(isAuthError(undefined)).toBe(false);
  });

  it('returns false for non-object types', () => {
    expect(isAuthError('error string')).toBe(false);
    expect(isAuthError(42)).toBe(false);
  });

  it('returns false for FK constraint errors', () => {
    expect(isAuthError({ code: '23503', message: 'foreign key violation' })).toBe(false);
  });
});

describe('redirectToSessionExpiry / consumeSessionExpiry', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it('stores expiry info in sessionStorage', () => {
    // Simulate being on a dashboard page
    Object.defineProperty(window, 'location', {
      value: { pathname: '/dashboard/company-1/parts', search: '', origin: 'http://localhost:3000' },
      writable: true,
    });

    redirectToSessionExpiry();

    const result = consumeSessionExpiry();
    expect(result).toEqual({
      expired: true,
      returnTo: '/dashboard/company-1/parts',
    });
  });

  it('consumeSessionExpiry clears sessionStorage after reading', () => {
    Object.defineProperty(window, 'location', {
      value: { pathname: '/dashboard/company-1', search: '', origin: 'http://localhost:3000' },
      writable: true,
    });

    redirectToSessionExpiry();

    // First read should return data
    const first = consumeSessionExpiry();
    expect(first).not.toBeNull();

    // Second read should return null (cleared)
    const second = consumeSessionExpiry();
    expect(second).toBeNull();
  });

  it('preserves search params in returnTo', () => {
    Object.defineProperty(window, 'location', {
      value: { pathname: '/dashboard/company-1/jobs', search: '?status=active', origin: 'http://localhost:3000' },
      writable: true,
    });

    redirectToSessionExpiry();

    const result = consumeSessionExpiry();
    expect(result?.returnTo).toBe('/dashboard/company-1/jobs?status=active');
  });

  it('skips storage when on /login', () => {
    Object.defineProperty(window, 'location', {
      value: { pathname: '/login', search: '', origin: 'http://localhost:3000' },
      writable: true,
    });

    redirectToSessionExpiry();

    expect(consumeSessionExpiry()).toBeNull();
  });

  it('skips storage when on /signup', () => {
    Object.defineProperty(window, 'location', {
      value: { pathname: '/signup', search: '', origin: 'http://localhost:3000' },
      writable: true,
    });

    redirectToSessionExpiry();

    expect(consumeSessionExpiry()).toBeNull();
  });

  it('skips storage when on /', () => {
    Object.defineProperty(window, 'location', {
      value: { pathname: '/', search: '', origin: 'http://localhost:3000' },
      writable: true,
    });

    redirectToSessionExpiry();

    expect(consumeSessionExpiry()).toBeNull();
  });

  it('consumeSessionExpiry returns null when nothing stored', () => {
    expect(consumeSessionExpiry()).toBeNull();
  });
});

describe('friendlyErrorMessage', () => {
  it('translates a FK violation, naming the referencing table from the message', () => {
    const error = {
      code: '23503',
      message:
        'update or delete on table "customer_addresses" violates foreign key constraint "quotes_billing_address_id_fkey" on table "quotes"',
    };
    expect(friendlyErrorMessage(error, { entity: 'address' })).toBe(
      "This address can't be deleted because it's still referenced by quotes. Remove or reassign those first.",
    );
  });

  it('honors an explicit references override', () => {
    const error = { code: '23503', message: 'fk violation' };
    expect(friendlyErrorMessage(error, { entity: 'part', references: 'quotes or jobs' })).toBe(
      "This part can't be deleted because it's still referenced by quotes or jobs. Remove or reassign those first.",
    );
  });

  it('translates a unique violation', () => {
    expect(friendlyErrorMessage({ code: '23505' }, { entity: 'unit' })).toBe(
      'That unit already exists — use a different value.',
    );
  });

  it('translates a permission/RLS error', () => {
    expect(friendlyErrorMessage({ code: '42501', message: 'permission denied' })).toBe(
      "You don't have permission to do that.",
    );
    expect(
      friendlyErrorMessage({ message: 'new row violates row-level security policy' }),
    ).toBe("You don't have permission to do that.");
  });

  it('maps auth errors to a session-expired message', () => {
    expect(friendlyErrorMessage({ code: 'PGRST301', message: 'JWT expired' })).toBe(
      'Your session has expired. Please sign in again.',
    );
  });

  it('uses the fallback (or a generic) for unknown errors — never raw DB text', () => {
    expect(friendlyErrorMessage({ code: 'XX999', message: 'boom' }, { fallback: 'Failed to delete address' })).toBe(
      'Failed to delete address',
    );
    expect(friendlyErrorMessage(new Error('weird'))).toBe('Something went wrong. Please try again.');
    expect(friendlyErrorMessage(null)).toBe('Something went wrong. Please try again.');
  });
});

/**
 * `check_violation` from our own RPCs.
 *
 * The stock RPCs raise their user-facing messages with `ERRCODE = 'check_violation'`, not `P0001`
 * — so before this every one of them was replaced by a generic fallback. An operator moving more
 * than a shelf holds was told "Failed to update stock" instead of how much was actually there.
 *
 * It can't be a blanket pass-through, because a real table CHECK raises the same code with raw
 * Postgres wording that must never reach a user.
 */
describe('friendlyErrorMessage — deliberate check violations', () => {
  it('passes through a message our own RPC wrote', () => {
    expect(
      friendlyErrorMessage(
        { code: '23514', message: 'Insufficient stock at source location (have 5, need 10)' },
        { entity: 'stock', fallback: 'Failed to update stock.' },
      ),
    ).toBe('Insufficient stock at source location (have 5, need 10)');
  });

  it('passes through the put-away cap message', () => {
    expect(
      friendlyErrorMessage(
        { code: '23514', message: 'Too many parts at once (1001 of a maximum 1000).' },
        { fallback: 'nope' },
      ),
    ).toMatch(/Too many parts at once/);
  });

  it('does NOT leak a real table CHECK constraint failure', () => {
    expect(
      friendlyErrorMessage(
        {
          code: '23514',
          message:
            'new row for relation "parts" violates check constraint "parts_requires_unit"',
        },
        { fallback: 'Could not save the part.' },
      ),
    ).toBe('Could not save the part.');
  });

  it('does not leak a not-null constraint failure either', () => {
    expect(
      friendlyErrorMessage(
        { code: '23514', message: 'null value violates not-null constraint' },
        { fallback: 'Could not save.' },
      ),
    ).toBe('Could not save.');
  });

  // Permission and auth are more actionable, so they still win.
  it('still prefers the permission message over a raised one', () => {
    expect(
      friendlyErrorMessage({ code: '23514', message: 'permission denied for table parts' }),
    ).toMatch(/don't have permission/);
  });
});

describe('isTransientAbortError', () => {
  // The exact shape @supabase/auth-js rejects with when another call steals the auth
  // lock. Recovered from the __serialized__ extra on Sentry JAVASCRIPT-NEXTJS-9.
  const lockStolen = {
    code: '',
    details: '',
    hint: 'Request was aborted (timeout or manual cancellation)',
    message: 'AbortError: Lock was stolen by another request',
  };

  it('recognises the Supabase lock-steal rejection', () => {
    expect(isTransientAbortError(lockStolen)).toBe(true);
  });

  it('recognises a real DOMException-style AbortError by name', () => {
    const err = new Error('The operation was aborted');
    err.name = 'AbortError';
    expect(isTransientAbortError(err)).toBe(true);
  });

  it('recognises the navigator-lock acquisition message', () => {
    expect(
      isTransientAbortError({ message: 'Acquiring an exclusive Navigator LockManager lock timed out' }),
    ).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isTransientAbortError({ message: 'LOCK WAS STOLEN by another request' })).toBe(true);
  });

  it('does NOT classify real failures as transient', () => {
    // The dangerous direction: a permission error wrongly treated as transient would be
    // silently retried and never reported.
    expect(isTransientAbortError({ code: '42501', message: 'permission denied for table parts' })).toBe(false);
    expect(isTransientAbortError(new Error('Database error'))).toBe(false);
    expect(isTransientAbortError({ code: 'PGRST301', message: 'JWT expired' })).toBe(false);
    expect(isTransientAbortError(null)).toBe(false);
    expect(isTransientAbortError(undefined)).toBe(false);
    expect(isTransientAbortError('a string')).toBe(false);
  });

  /**
   * Pins the branch that survives a dependency bump.
   *
   * Today an abort is recognised by postgrest-js's `hint: 'Request was aborted…'`, which
   * `PostgrestBuilder` sets only for `AbortError`. That hint is a convenience of the current
   * version, not a contract — but the `message` is, because the same `catch` always builds it as
   * `` `${fetchError.name}: ${fetchError.message}` ``. So the name is in the message regardless,
   * and the `aborterror` branch keeps working with no hint at all.
   */
  it('still recognises an abort when the hint is gone', () => {
    expect(
      isTransientAbortError({
        code: '',
        details: '',
        hint: '',
        message: 'AbortError: The user aborted a request.',
      }),
    ).toBe(true);
  });
});

describe('isNetworkFailureError', () => {
  /**
   * The exact shapes postgrest-js resolves with when the browser's fetch rejects — it does not
   * reject the promise, it converts the failure into an ordinary `{ error }` response. Recovered
   * from Sentry JAVASCRIPT-NEXTJS-2R (Safari) and the operator note-save issue (Chrome).
   */
  const safari = {
    code: '',
    details: 'TypeError: Load failed\n    at ...',
    hint: '',
    message: 'TypeError: Load failed (fgwwlinwvsfcdizkqfau.supabase.co)',
  };
  const chrome = {
    code: '',
    details: 'TypeError: Failed to fetch\n    at ...',
    hint: '',
    message: 'TypeError: Failed to fetch (umurkvuxkikfrjojkadv.supabase.co)',
  };
  const firefox = {
    code: '',
    details: '',
    hint: '',
    message: 'TypeError: NetworkError when attempting to fetch resource.',
  };

  it('recognises the browsers that matter', () => {
    expect(isNetworkFailureError(safari)).toBe(true);
    expect(isNetworkFailureError(chrome)).toBe(true);
    expect(isNetworkFailureError(firefox)).toBe(true);
  });

  /**
   * THE DANGEROUS DIRECTION, and the reason `code` is checked at all.
   *
   * The message on the network path is the browser's, so nothing stops a Postgres error raised
   * FOR the user from containing the same words. Classifying one of those as transient would drop
   * a real failure with no trace anywhere — the worst outcome this module can produce. A SQLSTATE
   * means PostgREST answered, and postgrest-js never sets one on a client-side failure.
   */
  it('does NOT drop a Postgres error whose message merely contains the words', () => {
    expect(
      isNetworkFailureError({
        code: 'P0001',
        details: '',
        hint: '',
        message: 'Failed to fetch the latest cost for this part',
      }),
    ).toBe(false);
    expect(
      isNetworkFailureError({ code: '42501', message: 'permission denied for table parts' }),
    ).toBe(false);
    expect(isNetworkFailureError({ code: 'PGRST116', message: 'no rows' })).toBe(false);
  });

  it('is not fooled by an unrelated failure with no code', () => {
    expect(isNetworkFailureError({ code: '', message: 'Something else went wrong' })).toBe(false);
    expect(isNetworkFailureError(null)).toBe(false);
    expect(isNetworkFailureError(undefined)).toBe(false);
    expect(isNetworkFailureError('a string')).toBe(false);
  });

  it('keeps these out of the issue queue', () => {
    // The whole point: JAVASCRIPT-NEXTJS-2R paged the founder for one Safari network blip.
    expect(shouldReportSupabaseError(safari)).toBe(false);
    expect(shouldReportSupabaseError(chrome)).toBe(false);
    expect(shouldReportSupabaseError(firefox)).toBe(false);
  });
});

describe('toError', () => {
  it('passes a real Error through untouched', () => {
    const original = new Error('boom');
    expect(toError(original)).toBe(original);
  });

  it('converts a raw Supabase error object into a grouppable Error', () => {
    // Without this, Sentry shows "Object captured as exception with keys: code,
    // details, hint, message" titled "e", with the real message buried in an extra.
    const result = toError({
      code: '42501',
      details: 'some detail',
      hint: 'some hint',
      message: 'permission denied for table parts',
    });

    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe('permission denied for table parts');
    expect((result as Error & { code?: string }).code).toBe('42501');
    expect((result as Error & { details?: string }).details).toBe('some detail');
    expect((result as Error & { hint?: string }).hint).toBe('some hint');
  });

  it('falls back to hint when message is absent', () => {
    expect(toError({ hint: 'Request was aborted' }).message).toBe('Request was aborted');
  });

  it('handles a thrown string', () => {
    expect(toError('just a string').message).toBe('just a string');
  });

  it('uses the fallback for a shapeless value, and never produces an empty message', () => {
    expect(toError({}, 'Failed to verify access').message).toBe('Failed to verify access');
    expect(toError(null, 'Failed to verify access').message).toBe('Failed to verify access');
    expect(toError({ message: '' }, 'Failed to verify access').message).toBe('Failed to verify access');
  });

  it('omits empty code/details/hint rather than attaching noise', () => {
    const result = toError({ code: '', details: '', hint: '', message: 'boom' });
    expect(result).not.toHaveProperty('code');
    expect(result).not.toHaveProperty('details');
  });

  it('preserves name so a normalised AbortError is still classified as transient', () => {
    // Round-trip guarantee: AuthGuard calls toError before reporting, and the retry
    // path checks isTransientAbortError. Losing `name` would break that pairing.
    const result = toError({
      hint: 'Request was aborted (timeout or manual cancellation)',
      message: 'AbortError: Lock was stolen by another request',
    });
    expect(isTransientAbortError(result)).toBe(true);
  });
});

describe('isBillingWriteBlocked', () => {
  it('matches a blocked INSERT by its restrictive policy name', () => {
    expect(isBillingWriteBlocked(BLOCKED_INSERT)).toBe(true);
  });

  it('matches a blocked UPDATE by its restrictive policy name', () => {
    expect(isBillingWriteBlocked(BLOCKED_UPDATE)).toBe(true);
  });

  it('matches the stock RPC raise from inv_assert_can_write', () => {
    expect(isBillingWriteBlocked(BLOCKED_RPC)).toBe(true);
  });

  it('does NOT match a nameless RLS denial', () => {
    // THE guard for the whole discriminator. Permissive policies OR-fold into a single
    // nameless WithCheckOption, so a plain membership failure looks like this. If this ever
    // flips to true, every non-member is shown a Subscribe button for a permission problem
    // that paying would not fix.
    expect(isBillingWriteBlocked(NAMELESS_DENIAL)).toBe(false);
  });

  it('does NOT match a nameless storage 403 (the documented gap ErrorAlert covers)', () => {
    expect(
      isBillingWriteBlocked({
        status: 403,
        message: 'new row violates row-level security policy',
      }),
    ).toBe(false);
  });

  it('does not match unrelated failures', () => {
    expect(isBillingWriteBlocked({ code: 'PGRST116', message: 'no rows' })).toBe(false);
    expect(isBillingWriteBlocked({ code: '23505', message: 'duplicate key' })).toBe(false);
    expect(isBillingWriteBlocked({ code: '23503', message: 'violates foreign key' })).toBe(false);
    expect(isBillingWriteBlocked(null)).toBe(false);
    expect(isBillingWriteBlocked(undefined)).toBe(false);
    expect(isBillingWriteBlocked('billing_gate_insert')).toBe(false);
  });

  it('does not match the right message under the wrong code', () => {
    expect(
      isBillingWriteBlocked({ code: '23514', message: 'billing_gate_insert' }),
    ).toBe(false);
  });

  it('sees through one cause hop, so toFriendlyError output still classifies', () => {
    expect(isBillingWriteBlocked(toFriendlyError(BLOCKED_INSERT, { entity: 'part' }))).toBe(true);
  });

  it('sees through two cause hops', () => {
    const wrapped = new Error('outer', { cause: new Error('inner', { cause: BLOCKED_INSERT }) });
    expect(isBillingWriteBlocked(wrapped)).toBe(true);
  });

  it('terminates on a self-referential cause chain', () => {
    const cyclic: Record<string, unknown> = { code: 'X', message: 'nope' };
    cyclic.cause = cyclic;
    expect(() => isBillingWriteBlocked(cyclic)).not.toThrow();
    expect(isBillingWriteBlocked(cyclic)).toBe(false);
  });

  it('gives up past the depth cap rather than walking forever', () => {
    let deep: unknown = BLOCKED_INSERT;
    for (let i = 0; i < 6; i++) deep = new Error(`layer ${i}`, { cause: deep });
    expect(isBillingWriteBlocked(deep)).toBe(false);
  });
});

describe('friendlyErrorMessage — billing write gate', () => {
  it('beats the generic privilege branch for a billing denial', () => {
    // Ordering guard. Both branches match 42501; the billing one must win, or a lapsed shop is
    // told to go ask their admin for permission instead of to subscribe.
    const message = friendlyErrorMessage(BLOCKED_INSERT, { entity: 'part' });
    expect(message).toContain("subscription isn't active");
    expect(message).not.toContain('permission');
  });

  it('names the entity', () => {
    expect(friendlyErrorMessage(BLOCKED_INSERT, { entity: 'part' })).toContain(
      "that part wasn't saved",
    );
  });

  it('says "change" when no entity is given', () => {
    expect(friendlyErrorMessage(BLOCKED_INSERT)).toContain("that change wasn't saved");
  });

  it('says "change" rather than the "item" default', () => {
    expect(friendlyErrorMessage(BLOCKED_INSERT, { entity: 'item' })).toContain(
      "that change wasn't saved",
    );
  });

  it('translates the RPC raise the same way', () => {
    expect(friendlyErrorMessage(BLOCKED_RPC, { entity: 'stock move' })).toContain(
      "subscription isn't active",
    );
  });

  it('still reports a nameless denial as a permission problem', () => {
    expect(friendlyErrorMessage(NAMELESS_DENIAL)).toBe("You don't have permission to do that.");
  });
});

describe('toFriendlyError', () => {
  it('returns a real Error, which is what the UI catch sites test for', () => {
    const result = toFriendlyError(BLOCKED_INSERT, { entity: 'part' });
    expect(result).toBeInstanceOf(Error);
    // The bug this whole helper exists to fix: Supabase's plain object fails this check, so
    // `err instanceof Error ? err.message : 'Failed to create part'` took the fallback.
    expect(BLOCKED_INSERT instanceof Error).toBe(false);
  });

  it('carries the friendly copy as its message', () => {
    const result = toFriendlyError(BLOCKED_INSERT, { entity: 'part' });
    expect(result.message).toBe(friendlyErrorMessage(BLOCKED_INSERT, { entity: 'part' }));
  });

  it('keeps code/details/hint as own properties for Sentry context', () => {
    const result = toFriendlyError({ code: '23505', hint: 'try again', message: 'dup' });
    expect(result).toHaveProperty('code', '23505');
    expect(result).toHaveProperty('hint', 'try again');
  });

  it('sets cause to the original error', () => {
    expect(toFriendlyError(BLOCKED_INSERT).cause).toBe(BLOCKED_INSERT);
  });

  it('is idempotent — re-wrapping returns the same instance', () => {
    const once = toFriendlyError(BLOCKED_INSERT, { entity: 'part' });
    expect(toFriendlyError(once, { entity: 'something else' })).toBe(once);
  });

  it('does not degrade FK copy when translated twice', () => {
    // The regression this brand prevents. The FK branch reads the DB clause to name what still
    // references the row; a second pass over friendly text would find nothing and fall back to
    // the vague "other records".
    const fkError = {
      code: '23503',
      message:
        'delete on table "customer_addresses" violates foreign key constraint "quotes_billing_address_id_fkey" on table "quotes"',
    };
    const once = toFriendlyError(fkError, { entity: 'address' });
    expect(once.message).toContain('quotes');
    expect(friendlyErrorMessage(once, { entity: 'address' })).toBe(once.message);
    expect(friendlyErrorMessage(once, { entity: 'address' })).not.toContain('other records');
  });

  it('brands invisibly, so serialisation is unaffected', () => {
    const result = toFriendlyError(BLOCKED_INSERT);
    expect(isFriendlyError(result)).toBe(true);
    expect(Object.keys(result)).not.toContain('jigged.friendlyError');
    expect(JSON.stringify({ ...result })).not.toContain('friendlyError');
  });

  it('isFriendlyError is false for anything it did not make', () => {
    expect(isFriendlyError(new Error('plain'))).toBe(false);
    expect(isFriendlyError(BLOCKED_INSERT)).toBe(false);
    expect(isFriendlyError(null)).toBe(false);
  });
});

describe('shouldReportSupabaseError — billing denials', () => {
  it('drops a blocked INSERT', () => {
    // The gate working as designed, once per attempted write for as long as the shop stays
    // lapsed. The user is still told (see friendlyErrorMessage); nobody needs paging.
    expect(shouldReportSupabaseError(BLOCKED_INSERT)).toBe(false);
  });

  it('drops a blocked UPDATE and the RPC raise', () => {
    expect(shouldReportSupabaseError(BLOCKED_UPDATE)).toBe(false);
    expect(shouldReportSupabaseError(BLOCKED_RPC)).toBe(false);
  });

  it('drops one that has already been wrapped by toFriendlyError', () => {
    expect(shouldReportSupabaseError(toFriendlyError(BLOCKED_INSERT))).toBe(false);
  });

  it('STILL reports a nameless privilege denial', () => {
    // A real permission failure is a bug — a missing policy or a broken membership row — and
    // must not be swept up by the billing exemption.
    expect(shouldReportSupabaseError(NAMELESS_DENIAL)).toBe(true);
  });

  it('still reports ordinary failures', () => {
    expect(shouldReportSupabaseError({ code: '23505', message: 'duplicate key' })).toBe(true);
    expect(shouldReportSupabaseError({ code: '23503', message: 'fk violation' })).toBe(true);
  });
});
