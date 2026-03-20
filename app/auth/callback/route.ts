import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get('code');
  const next = searchParams.get('next') ?? '/';

  if (code) {
    const cookieStore = await cookies();
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll() {
            return cookieStore.getAll();
          },
          setAll(cookiesToSet) {
            for (const { name, value, options } of cookiesToSet) {
              cookieStore.set(name, value, options);
            }
          },
        },
      }
    );

    const { error } = await supabase.auth.exchangeCodeForSession(code);

    if (!error) {
      // If next param is default ('/'), check if this is an invitation flow.
      // The team-invites Edge Function stores invitation_id in user metadata
      // when calling inviteUserByEmail. This fallback ensures users reach the
      // accept-invite page even if Supabase strips query params from redirect_to.
      if (next === '/') {
        const { data: { user } } = await supabase.auth.getUser();
        const invitationId = user?.user_metadata?.invitation_id;
        if (invitationId) {
          return NextResponse.redirect(`${origin}/accept-invite/${invitationId}`);
        }
      }
      return NextResponse.redirect(`${origin}${next}`);
    }
  }

  // If code exchange failed or no code, redirect to login with error
  return NextResponse.redirect(`${origin}/login`);
}
