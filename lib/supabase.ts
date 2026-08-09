import { createBrowserClient } from '@supabase/ssr';
import * as Sentry from '@sentry/nextjs';
import { RPC_SPAN_ATTRIBUTE } from '@/lib/sentryEventPolicy';
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
  const client = createBrowserClient<Database>(supabaseUrl, supabaseAnonKey, {
    global: {
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        // Extract URL for endpoint detection
        const url = typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
        const isAuthEndpoint = url.includes('/auth/');

        /**
         * Mark the Supabase integration's db span when this request is an `.rpc()`, so
         * `beforeSend` can drop the net's automatic capture and leave rpc reporting to the
         * access layer. See `applySupabaseEventPolicy` for why rpc is drawn out of the net.
         *
         * This is the one place the distinction is unambiguous — the span itself only records
         * `db.table`, which for an rpc holds the *function* name and is otherwise
         * indistinguishable from a table name. The integration starts its span around the whole
         * request, so the span is still active here.
         *
         * STAMPED BEFORE THE FETCH, and the order is load-bearing: when the network fails the
         * `await` below throws, so anything after it never runs. Stamping afterwards left exactly
         * the network-failure case unmarked, `beforeSend` unable to recognise the rpc, and the
         * one failure filed twice — once by the net, once by the access layer's own capture.
         */
        if (url.includes('/rest/v1/rpc/')) {
          Sentry.getActiveSpan()?.setAttribute(RPC_SPAN_ATTRIBUTE, true);
        }

        const response = await fetch(input, init);

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

  /**
   * THIS IS THE ERROR-REPORTING NET, and it is the whole of it for table reads and
   * writes (issue #708).
   *
   * Supabase returns failures as `{ data, error }` rather than throwing, so a
   * caller that puts `error` into component state and stops — which is most of
   * them — leaves no trace anywhere. That is how a cross-company bug made every
   * maintenance-note save fail for a day with nothing in Sentry to find.
   *
   * The integration patches `SupabaseClient.prototype.from`, so every
   * select/insert/upsert/update/delete captures its own `{ error }` with the
   * query and body attached, whether or not the call site remembers to. Nothing
   * per-call-site means nothing to forget — which is the point, since the
   * alternative was a rule across ~174 call sites with no enforcement.
   *
   * It patches a shared prototype, so calling it per client is free after the
   * first (the integration carries its own `isInstrumented` guard), and capture
   * is a no-op wherever the SDK is disabled — i.e. everywhere but a production
   * build.
   *
   * `.rpc()` is deliberately NOT covered here even though it partly reaches this
   * same code path: see the rpc branch in `beforeSend`
   * (instrumentation-client.ts), which suppresses it so the access layer stays
   * its sole reporter.
   */
  Sentry.instrumentSupabaseClient(client);

  return client;
}

// The client's shape with the `Database` generic honored. `createClient()`
// has always built with that generic — see `createBrowserClient<Database>` above.
export type TypedSupabaseClient = ReturnType<typeof createClient>;

let supabaseInstance: TypedSupabaseClient | null = null;

/**
 * THE Supabase browser client. One getter, always typed: every
 * `.from('quotes').select('…')` chain is validated against types/database.ts at
 * compile time, which is what would have caught the May 2026 `jobs.status`
 * incident and the `part_procurement_tiers.vendor_id` one after it.
 *
 * **There used to be two getters** — this one returning an untyped view, plus a
 * `getTypedSupabase()` returning the typed one — over a single shared instance.
 * They were never two clients: `getSupabase()` returned the same singleton with
 * `as unknown as UntypedSupabaseClient` applied, purely so the typed rollout
 * could proceed file by file instead of landing ~250 errors at once (#573).
 *
 * That scaffolding outlived its job. By the time it came down the whole access
 * layer was already typed, and deleting the cast surfaced exactly **one** type
 * error in the entire project. The lesson worth keeping: the split cost real
 * safety for two months after it stopped buying anything, because an
 * exemption list is easy to keep and hard to notice. Don't reintroduce an
 * untyped view of this client — if a query won't type-check, the query is
 * wrong. Never paper over it with `as any` or `as unknown as`.
 */
export function getSupabase(): TypedSupabaseClient {
  if (!supabaseInstance) {
    supabaseInstance = createClient();
  }
  return supabaseInstance;
}

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
