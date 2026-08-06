import { createServerClient } from '@supabase/ssr';
import * as Sentry from '@sentry/nextjs';
import { cookies } from 'next/headers';
import type { Database } from '@/types/database';

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

  // `<Database>`-generic, matching `getSupabase()` on the browser side (see
  // CLAUDE.md "Typed Supabase client"). Without it the select-string parser can't know
  // a relation's cardinality and types every embed as an array, so `companies(is_demo)`
  // came back as `{ is_demo }[]` for what is a many-to-one FK.
  const client = createServerClient<Database>(
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

  // Same net as the browser client — see the long comment in lib/supabase.ts.
  // A route handler that ignores an `{ error }` is exactly as silent as a
  // component that does, and this client is created per request, so the
  // integration's own `isInstrumented` guard is doing real work here.
  Sentry.instrumentSupabaseClient(client);

  return client;
}
