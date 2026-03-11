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
