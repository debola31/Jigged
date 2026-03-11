import { describe, it, expect, beforeEach } from 'vitest';
import { isAuthError, redirectToSessionExpiry, consumeSessionExpiry } from '@/lib/supabaseErrors';

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
