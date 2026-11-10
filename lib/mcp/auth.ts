import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { AuthInfo } from '@modelcontextprotocol/server';

/**
 * Who is calling the MCP server, as proven by the bearer token their AI assistant presented.
 *
 * The token is an ordinary Supabase access token that Supabase Auth's OAuth 2.1 server issued to
 * that assistant (Claude, ChatGPT, …) after the user approved it on `/oauth/consent`. It carries
 * the user's own identity, so RLS and the billing write-gate apply to it exactly as they do to the
 * same user's browser session.
 */
export interface McpCaller {
  token: string;
  /** The OAuth client the token was issued to. A browser session has none. */
  clientId: string;
  userId: string;
  email: string | null;
  /** Seconds since the epoch. */
  expiresAt: number;
}

type Claims = Record<string, unknown>;

function hasAudience(aud: unknown, wanted: string): boolean {
  return aud === wanted || (Array.isArray(aud) && aud.includes(wanted));
}

/**
 * The caller these claims describe, or null when the token must not be accepted here.
 *
 * **A `client_id` claim is required.** Supabase stamps it only on tokens its OAuth server issued,
 * so this refuses a browser session token that someone copied into an assistant's config: that
 * token was never granted to an assistant, does not appear in the user's connected apps, and
 * cannot be revoked from there. It is the nearest thing this auth server offers to the audience
 * check the MCP spec asks for (Supabase does not bind tokens to a resource, RFC 8707).
 */
export function callerFromClaims(token: string, claims: Claims, nowSeconds: number): McpCaller | null {
  const { sub, role, aud, client_id: clientId, exp, email, is_anonymous: isAnonymous } = claims;
  if (typeof sub !== 'string' || sub.length === 0) return null;
  if (role !== 'authenticated' || !hasAudience(aud, 'authenticated')) return null;
  if (isAnonymous === true) return null;
  if (typeof clientId !== 'string' || clientId.length === 0) return null;
  if (typeof exp !== 'number' || exp <= nowSeconds) return null;
  return {
    token,
    clientId,
    userId: sub,
    email: typeof email === 'string' && email.length > 0 ? email : null,
    expiresAt: exp,
  };
}

/** The client id Jigged chat's calls are logged under in mcp_tool_calls. Not an OAuth client. */
export const CHAT_CLIENT_ID = 'jigged-chat';
export const CHAT_CLIENT_NAME = 'Jigged chat';

/**
 * The person behind a Jigged chat tool call, from their own browser session token -- the
 * mirror image of `callerFromClaims`.
 *
 * **A `client_id` claim is refused.** That token belongs to an AI assistant, whose only door is
 * `/mcp`: accepting it here would let an assistant run tools outside the gateway binding and the
 * connected-apps list. A browser session carries no client_id.
 */
export function chatCallerFromClaims(token: string, claims: Claims, nowSeconds: number): McpCaller | null {
  const { sub, role, aud, client_id: clientId, exp, email, is_anonymous: isAnonymous } = claims;
  if (typeof sub !== 'string' || sub.length === 0) return null;
  if (role !== 'authenticated' || !hasAudience(aud, 'authenticated')) return null;
  if (isAnonymous === true) return null;
  if (clientId !== undefined && clientId !== null) return null;
  if (typeof exp !== 'number' || exp <= nowSeconds) return null;
  return {
    token,
    clientId: CHAT_CLIENT_ID,
    userId: sub,
    email: typeof email === 'string' && email.length > 0 ? email : null,
    expiresAt: exp,
  };
}

let verifier: SupabaseClient | null = null;

/** A sessionless client used only to check signatures. It never holds anyone's session. */
function verifierClient(): SupabaseClient {
  if (!verifier) {
    verifier = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } },
    );
  }
  return verifier;
}

/**
 * `verifyToken` for `withMcpAuth`. Returning undefined makes the wrapper answer 401 with a
 * `WWW-Authenticate` challenge pointing at the protected-resource metadata, which is what starts
 * an assistant's sign-in flow.
 *
 * `getClaims` checks the signature against the project's JWKS when it signs with asymmetric keys,
 * and falls back to asking Auth (`/user`) when it does not. Either way an expired, forged or
 * revoked-session token comes back as an error.
 */
export async function verifyMcpToken(_req: Request, bearerToken?: string): Promise<AuthInfo | undefined> {
  if (!bearerToken) return undefined;
  const { data, error } = await verifierClient().auth.getClaims(bearerToken);
  if (error || !data) return undefined;
  const caller = callerFromClaims(bearerToken, data.claims, Math.floor(Date.now() / 1000));
  if (!caller) return undefined;
  return {
    token: caller.token,
    clientId: caller.clientId,
    // Supabase's OAuth scopes describe OIDC profile data, not database access, so they carry
    // nothing this server can act on. Read vs write is the company's setting, checked per call.
    scopes: [],
    expiresAt: caller.expiresAt,
    extra: { userId: caller.userId, email: caller.email },
  };
}

/** The person behind a Jigged chat tool request, or null to answer 401. */
export async function verifyChatToken(bearerToken: string | null): Promise<McpCaller | null> {
  if (!bearerToken) return null;
  const { data, error } = await verifierClient().auth.getClaims(bearerToken);
  if (error || !data) return null;
  return chatCallerFromClaims(bearerToken, data.claims, Math.floor(Date.now() / 1000));
}

/** The caller behind a verified request, rebuilt from what `verifyMcpToken` attached. */
export function callerOf(authInfo: AuthInfo | undefined): McpCaller | null {
  if (!authInfo?.token || !authInfo.clientId || typeof authInfo.expiresAt !== 'number') return null;
  const userId = authInfo.extra?.userId;
  const email = authInfo.extra?.email;
  if (typeof userId !== 'string' || userId.length === 0) return null;
  return {
    token: authInfo.token,
    clientId: authInfo.clientId,
    userId,
    email: typeof email === 'string' ? email : null,
    expiresAt: authInfo.expiresAt,
  };
}
