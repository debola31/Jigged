/**
 * Which routes the re-acceptance gate may interrupt, and how hard.
 *
 * Pure and path-derived, so it is testable without mounting anything, and so
 * the answer does not depend on a role lookup finishing first.
 */

/**
 * Routes the gate must NEVER cover.
 *
 * The legal documents lead this list and it is not a nicety: a modal covering
 * the document you are being asked to agree to is a clickwrap that does not
 * survive contact with a court. The auth and recovery paths follow, because
 * someone whose session is expiring has to be able to sign back in without
 * first agreeing to anything, and /accept-invite owns its own checkbox.
 */
const EXEMPT_PREFIXES = [
  // The documents themselves, and their archives.
  '/terms',
  '/privacy',
  '/cookies',
  '/legal',
  // Auth and recovery.
  '/login',
  '/signup',
  '/forgot-password',
  '/reset-password',
  '/change-password',
  '/auth/',
  '/accept-invite',
  // Transient scan stubs: they read nothing and immediately replace() onward,
  // so a modal here would flash over a screen nobody is looking at.
  '/T/',
  '/L/',
  // Marketing and third-party return paths.
  '/invite',
  '/coming-soon',
  '/quickbooks',
  '/pricing',
] as const;

export function isTermsExempt(pathname: string | null): boolean {
  // A null pathname means we do not know where we are. Do not block.
  if (!pathname) return true;
  if (pathname === '/') return true;
  if (/^\/operator\/[^/]+\/login$/.test(pathname)) return true;
  return EXEMPT_PREFIXES.some((p) => pathname === p || pathname.startsWith(p));
}

/**
 * Which surface presented the documents. Recorded as `accepted_via` and sent as
 * the `surface` property, so the two always agree.
 *
 * This used to decide how HARD to block -- `/dashboard` blocking, everything
 * else deferrable. That distinction is gone: the prompt is universal and
 * blocking for everyone. "Remind me later" did not reduce shop-floor
 * interruption, it MULTIPLIED it -- an operator met the same prompt up to six
 * times instead of once, and still ended up blocked. One checkbox, once per
 * version, is strictly less friction than a grace window.
 */
export function termsSurface(pathname: string | null): 'reacceptance_operator' | 'reacceptance_dashboard' {
  return pathname?.startsWith('/operator/') ? 'reacceptance_operator' : 'reacceptance_dashboard';
}
