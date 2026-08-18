/**
 * Which routes the re-acceptance gate may interrupt, and how hard.
 *
 * Pure and path-derived, so it is testable without mounting anything, and so
 * the answer does not depend on a role lookup finishing first.
 */

export type TermsGateMode = 'blocking' | 'deferrable';

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
 * BLOCKING ONLY ON /dashboard. Everything else is deferrable, and the default
 * direction matters.
 *
 * The contract binds the shop, and the shop is bound by its admin's acceptance,
 * so the load-bearing block belongs where owners and office staff work. A hard
 * legal modal on a shop-floor phone mid-shift is friction on the surface where
 * engagement is most fragile — and defaulting the other way would hard-block an
 * operator on /launch, /select-company, /no-access and the scan stubs, which is
 * exactly the interruption the deferral exists to prevent.
 *
 * Path-derived rather than role-derived deliberately: the rule is written in
 * terms of surfaces, and it saves a round trip before the gate can decide.
 * /admin gets the blocking prompt — a system admin is a person using Jigged.
 */
export function termsGateMode(pathname: string | null): TermsGateMode {
  if (pathname && (pathname.startsWith('/dashboard/') || pathname.startsWith('/admin'))) {
    return 'blocking';
  }
  return 'deferrable';
}
