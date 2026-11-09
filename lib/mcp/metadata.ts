/**
 * Where an assistant learns how to sign in to the Jigged MCP server (RFC 9728).
 *
 * The MCP endpoint is `/mcp`. Its protected-resource metadata lives at the path-suffixed
 * `/.well-known/oauth-protected-resource/mcp`, which is the URL `withMcpAuth` advertises in every
 * 401 challenge, and also at the bare `/.well-known/oauth-protected-resource` for clients that
 * look there first. Both name Supabase Auth as the one authorization server: Claude uses only the
 * first entry, so there must be exactly one.
 */
export const MCP_PATH = '/mcp';
export const PROTECTED_RESOURCE_METADATA_PATH = '/.well-known/oauth-protected-resource/mcp';

/**
 * Supabase Auth's issuer, which is what `authorization_servers` must name: clients fetch
 * `/.well-known/oauth-authorization-server/auth/v1` on the Supabase host from it.
 *
 * Read per request rather than at module load, so a build without the variable fails at the
 * first request instead of baking `undefined/auth/v1` into a static document.
 */
export function authorizationServerUrl(): string {
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!base) throw new Error('NEXT_PUBLIC_SUPABASE_URL is not configured');
  return `${base.replace(/\/+$/, '')}/auth/v1`;
}
