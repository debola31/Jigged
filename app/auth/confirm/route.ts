import { NextRequest, NextResponse } from 'next/server';
import type { EmailOtpType } from '@supabase/supabase-js';
import { createClient } from '@/utils/supabase/server';

/**
 * First-party email-link confirmation.
 *
 * Invite (and, later, other) auth emails point here —
 * https://www.jigged.app/auth/confirm?token_hash=…&type=invite&next=/accept-invite/<id>
 * — instead of the raw Supabase verify endpoint, so the visible link is
 * first-party. We exchange the one-time `token_hash` for a session server-side
 * (setting the auth cookies the browser client reads), then forward to `next`.
 *
 * On anything unexpected (missing/invalid params, unknown type, or a consumed/
 * expired token — `verifyOtp` tokens are single-use) we still fail closed to
 * /login, but we say why and carry `next` with us.
 *
 * Failing closed *silently* is what made #722 look like a broken product: an
 * invitee whose link had aged out landed on an unexplained sign-in form and
 * typed credentials for an account that had never been given a password, so the
 * app answered "Invalid login credentials" — naming the wrong problem twice
 * over. The reason and the invitation id are what let /login explain itself and
 * offer a new link.
 */

// Token-hash types `verifyOtp` accepts. Reject anything else rather than passing
// arbitrary query input through to the auth call.
const VALID_TYPES: EmailOtpType[] = ['invite', 'magiclink', 'recovery', 'email', 'signup'];

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const tokenHash = searchParams.get('token_hash');
  const type = searchParams.get('type') as EmailOtpType | null;

  // Only honor same-origin relative redirects. Reject protocol-relative ('//')
  // and backslash-normalized ('/\') values to prevent open redirects.
  const rawNext = searchParams.get('next') ?? '/';
  const next =
    rawNext.startsWith('/') && !rawNext.startsWith('//') && !rawNext.startsWith('/\\')
      ? rawNext
      : '/';

  if (tokenHash && type && VALID_TYPES.includes(type)) {
    const supabase = await createClient();
    const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });
    if (!error) {
      return NextResponse.redirect(`${origin}${next}`);
    }
  }

  // `next` rides along already sanitised — /login reads the invitation id out of
  // it to offer a resend, and uses it as the post-sign-in destination.
  const failed = new URL('/login', origin);
  failed.searchParams.set('reason', type === 'recovery' ? 'reset-link-expired' : 'invite-link-expired');
  if (next !== '/') {
    failed.searchParams.set('returnTo', next);
  }
  return NextResponse.redirect(failed);
}
