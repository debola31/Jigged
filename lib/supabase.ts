import { createBrowserClient } from '@supabase/ssr';
import { redirectToSessionExpiry } from '@/lib/supabaseErrors';
import type { Database } from '@/types/database';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

// Deduplication: only one refresh in-flight at a time
let refreshPromise: Promise<string | null> | null = null;

const RETRY_HEADER = 'x-supabase-retry';

/**
 * Attempt a deduplicated token refresh. Returns the new access token
 * if successful, null if refresh failed.
 */
async function deduplicatedRefresh(): Promise<string | null> {
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    try {
      const supabase = getSupabase();
      const { data, error } = await supabase.auth.refreshSession();
      if (error || !data.session) {
        redirectToSessionExpiry();
        return null;
      }
      return data.session.access_token;
    } catch {
      redirectToSessionExpiry();
      return null;
    } finally {
      refreshPromise = null;
    }
  })();

  return refreshPromise;
}

export function createClient() {
  return createBrowserClient<Database>(supabaseUrl, supabaseAnonKey, {
    global: {
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const response = await fetch(input, init);

        // Extract URL for endpoint detection
        const url = typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
        const isAuthEndpoint = url.includes('/auth/');

        // Check if this is already a retry to prevent infinite loops
        const headers = new Headers(init?.headers);
        const isRetry = headers.has(RETRY_HEADER);

        if (response.status === 401 && !isAuthEndpoint && !isRetry) {
          // Only attempt refresh if user had a session (was previously authenticated).
          // This prevents redirect-to-login for genuinely unauthenticated requests
          // (e.g., landing page waitlist form).
          const supabaseClient = getSupabase();
          const { data: { session } } = await supabaseClient.auth.getSession();
          if (session) {
            const newAccessToken = await deduplicatedRefresh();
            if (newAccessToken) {
              // Retry with the new token — we must manually set the
              // Authorization header because Supabase's fetchWithAuth
              // already set the (now-expired) token before calling us.
              const retryHeaders = new Headers(init?.headers);
              retryHeaders.set('Authorization', `Bearer ${newAccessToken}`);
              retryHeaders.set(RETRY_HEADER, '1');
              return fetch(input, { ...init, headers: retryHeaders });
            }
          }
        }

        return response;
      },
    },
  });
}

// Typed shape of the client when the `Database` generic is honored —
// `createClient()` builds with this generic, but the runtime instance is
// the same regardless of which getter returns it.
export type TypedSupabaseClient = ReturnType<typeof createClient>;

// Untyped shape — what every existing access file currently consumes via
// `getSupabase()`. Cast at the boundary so adoption of typed mode can roll
// out per-file without forcing a 250-error refactor up front.
type UntypedSupabaseClient = ReturnType<typeof createBrowserClient>;

let supabaseInstance: TypedSupabaseClient | null = null;

/**
 * Returns the untyped Supabase client — preserves the legacy behavior
 * every `utils/*Access.ts` file currently relies on. Calls compile
 * regardless of whether the embed string matches the schema.
 *
 * Prefer `getTypedSupabase()` for new code. Per-file conversion to the
 * typed getter is the incremental adoption path — see comment above
 * `getTypedSupabase` for the contract and the May 2026 ADR in
 * docs/architecture.md for context.
 */
export function getSupabase(): UntypedSupabaseClient {
  if (!supabaseInstance) {
    supabaseInstance = createClient();
  }
  return supabaseInstance as unknown as UntypedSupabaseClient;
}

/**
 * Returns the Supabase client with the `Database` generic applied, so
 * every `.from('quotes').select('...')` chain is validated against
 * supabase/schema.prod.sql at compile time. This is the path that
 * would have caught the May 2026 jobs.status incident.
 *
 * Use for any new access function or while converting an existing one.
 * When you switch a file from `getSupabase()` to `getTypedSupabase()`,
 * expect `tsc` to surface real bugs — fix them in that PR, don't paper
 * over with `as any`.
 */
export function getTypedSupabase(): TypedSupabaseClient {
  if (!supabaseInstance) {
    supabaseInstance = createClient();
  }
  return supabaseInstance;
}

// Export a convenience alias. Stays untyped for back-compat with existing
// `import { supabase } from '@/lib/supabase'` consumers.
export const supabase = typeof window !== 'undefined' ? getSupabase() : null;

/**
 * Get the base URL for Supabase Edge Functions.
 * Edge Functions are deployed at: https://<project-ref>.supabase.co/functions/v1/<function-name>
 */
export function getEdgeFunctionUrl(functionName: string): string {
  const baseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!baseUrl) {
    throw new Error('NEXT_PUBLIC_SUPABASE_URL is not configured');
  }
  return `${baseUrl}/functions/v1/${functionName}`;
}
