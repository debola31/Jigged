import { describe, it, expect, beforeEach } from 'vitest';
import {
  isAuthError,
  redirectToSessionExpiry,
  consumeSessionExpiry,
  friendlyErrorMessage,
  isTransientAbortError,
  toError,
} from '@/lib/supabaseErrors';

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
