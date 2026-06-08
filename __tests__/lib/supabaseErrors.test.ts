import { describe, it, expect, beforeEach } from 'vitest';
import {
  isAuthError,
  redirectToSessionExpiry,
  consumeSessionExpiry,
  friendlyErrorMessage,
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
