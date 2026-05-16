/**
 * Shared origin/redirect-URL helper for Edge Functions.
 *
 * Resolves the base URL for redirect links sent in transactional emails
 * (password recovery, invitations, etc.). MUST validate any value derived
 * from request headers against an allowlist — otherwise an attacker can
 * craft a request whose Host/Origin header points at a domain they control,
 * causing Supabase to mint a recovery token whose confirmation URL phishes
 * the user. (OWASP "Host header injection" on password reset.)
 */

const ALLOWED_ORIGIN_PATTERNS = [
  /^https:\/\/.*\.jigged\.app$/,
  /^https:\/\/.*\.vercel\.app$/,
  /^https?:\/\/localhost(:\d+)?$/,
  /^https?:\/\/127\.0\.0\.1(:\d+)?$/,
];

/**
 * Resolve the base origin for a redirect link. Order of precedence:
 *
 *   1. The request's Origin / Referer header, if it matches the allowlist.
 *   2. SITE_URL env var (set per environment in the Supabase dashboard).
 *   3. NEXT_PUBLIC_APP_URL env var (legacy fallback).
 *   4. http://localhost:3000 (local dev default).
 *
 * The allowlist is the security boundary; the env fallback is the default.
 * Never return a raw header value.
 */
export function getOriginUrl(req: Request): string {
  const origin = req.headers.get('origin') || req.headers.get('referer');
  if (origin) {
    try {
      const parsed = new URL(origin);
      const originBase = parsed.origin;
      if (ALLOWED_ORIGIN_PATTERNS.some((p) => p.test(originBase))) {
        return originBase;
      }
    } catch {
      // Invalid URL — fall through to env default.
    }
  }
  return (
    Deno.env.get('SITE_URL') ||
    Deno.env.get('NEXT_PUBLIC_APP_URL') ||
    'http://localhost:3000'
  );
}
