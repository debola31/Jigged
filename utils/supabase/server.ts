import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';

/**
 * Server-side Supabase client for Route Handlers / Server Components.
 *
 * Reads and writes the session cookies via the `next/headers` adapter, so a
 * session established here (e.g. `verifyOtp` in app/auth/confirm/route.ts) is
 * persisted as the `sb-<ref>-auth-token` cookie that the browser client
 * (`createBrowserClient` in lib/supabase.ts — cookie-based) then reads. This is
 * the shared version of the inline client in app/auth/callback/route.ts.
 */
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            for (const { name, value, options } of cookiesToSet) {
              cookieStore.set(name, value, options);
            }
          } catch {
            // `setAll` was called from a Server Component, where the cookie
            // store is read-only. Safe to ignore here — the confirm route runs
            // as a Route Handler and can write cookies.
          }
        },
      },
    }
  );
}
