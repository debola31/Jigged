import { AsyncLocalStorage } from 'node:async_hooks';
import { createClient, type Session, type SupportedStorage } from '@supabase/supabase-js';
import * as Sentry from '@sentry/nextjs';

import type { Database } from '@/types/database';
import { registerScopedClientResolver, type TypedSupabaseClient } from '@/lib/supabase';
import type { McpCaller } from '@/lib/mcp/auth';

/**
 * The per-request Supabase client for an MCP call, and the scope that makes the access layer use it.
 *
 * Every `utils/*Access.ts` function calls `getSupabase()`. Inside `runAsCaller`, that returns a
 * client acting as the caller, so the existing access layer runs unchanged on the server, with the
 * same RLS, the same billing gate and the same `deleted_at` filters as in the user's browser.
 * There is no second copy of any query.
 *
 * SERVER-ONLY: this module imports `node:async_hooks`. Import it from route handlers and
 * `lib/mcp/*`, never from a client component.
 */

const STORAGE_KEY = 'jigged-mcp-session';

/**
 * The header that proves a Data API request comes from this server. An AI assistant's token is
 * refused by the database unless it arrives with a key whose SHA-256 is registered in
 * private.mcp_gateway_keys (public.mcp_token_binding, migration 20261109163801), so a token an
 * assistant hands to anyone else is useless outside /mcp. The key is sent to Supabase only.
 */
export const MCP_GATEWAY_HEADER = 'x-jigged-mcp';
const scope = new AsyncLocalStorage<TypedSupabaseClient>();

registerScopedClientResolver(() => scope.getStore());

/**
 * A session object for the caller's token.
 *
 * The client needs a SESSION, not just an `Authorization` header: 18 access-layer call sites ask
 * `auth.getUser()` or `auth.getSession()` who is acting, to stamp `created_by` or to forward the
 * token to FastAPI (QuickBooks push). With a header alone both would say "nobody". There is no
 * refresh token, because the assistant holds that and refreshes on its own; the session lives
 * only as long as one request.
 */
function sessionFor(caller: McpCaller, nowSeconds: number): Session {
  return {
    access_token: caller.token,
    refresh_token: '',
    token_type: 'bearer',
    expires_at: caller.expiresAt,
    expires_in: Math.max(0, caller.expiresAt - nowSeconds),
    user: {
      id: caller.userId,
      aud: 'authenticated',
      role: 'authenticated',
      email: caller.email ?? undefined,
      app_metadata: {},
      user_metadata: {},
      created_at: '',
    },
  };
}

export function clientForCaller(caller: McpCaller): TypedSupabaseClient {
  const serialized = JSON.stringify(sessionFor(caller, Math.floor(Date.now() / 1000)));
  // Read-only storage holding exactly this caller's session. Writes are dropped: nothing in one
  // MCP request may change the session it was proven with.
  const storage: SupportedStorage = {
    getItem: (key) => (key === STORAGE_KEY ? serialized : null),
    setItem: () => {},
    removeItem: () => {},
  };
  const client = createClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      global: {
        headers: process.env.MCP_GATEWAY_KEY ? { [MCP_GATEWAY_HEADER]: process.env.MCP_GATEWAY_KEY } : {},
      },
      auth: {
        storage,
        storageKey: STORAGE_KEY,
        persistSession: true,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    },
  );
  // Same error net as the browser client (see lib/supabase.ts).
  Sentry.instrumentSupabaseClient(client);
  return client;
}

/** Run `fn` with `getSupabase()` acting as `caller`. */
export function runAsCaller<T>(caller: McpCaller, fn: () => Promise<T>): Promise<T> {
  return scope.run(clientForCaller(caller), fn);
}

/** True inside `runAsCaller`. The tool wrapper asserts it before touching the access layer. */
export function inCallerScope(): boolean {
  return scope.getStore() !== undefined;
}
