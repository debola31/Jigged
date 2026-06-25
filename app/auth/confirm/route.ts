import { NextRequest, NextResponse } from 'next/server';
import type { EmailOtpType } from '@supabase/supabase-js';
import { createClient } from '@/utils/supabase/server';

/**
 * First-party email-link confirmation.
 *
 * Invite (and, later, other) auth emails point here —
 * https://jigged.app/auth/confirm?token_hash=…&type=invite&next=/accept-invite/<id>
 * — instead of the raw Supabase verify endpoint, so the visible link is
 * first-party. We exchange the one-time `token_hash` for a session server-side
 * (setting the auth cookies the browser client reads), then forward to `next`.
 *
 * On anything unexpected (missing/invalid params, unknown type, or a consumed/
 * expired token — `verifyOtp` tokens are single-use) we fail closed to /login.
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

  return NextResponse.redirect(`${origin}/login`);
}
