import { createMcpHandler, withMcpAuth } from 'mcp-handler';

import { verifyMcpToken } from '@/lib/mcp/auth';
import { PROTECTED_RESOURCE_METADATA_PATH } from '@/lib/mcp/metadata';
import { registerJiggedTools } from '@/lib/mcp/server';
// Registers the per-request client resolver with getSupabase(). Imported for its side effect.
import '@/lib/mcp/requestClient';

/**
 * The Jigged MCP server: the endpoint a customer adds to Claude or ChatGPT as a connector.
 *
 * Lives at `/mcp`, not under `/api`: vercel.json rewrites `/api/*` to the FastAPI function.
 * Stateless (MCP 2026-07-28; mcp-handler falls back to stateless Streamable HTTP for older
 * clients), so every request carries its own bearer token and nothing is held between calls.
 */
export const runtime = 'nodejs';
export const maxDuration = 60;

const handler = createMcpHandler(registerJiggedTools, {
  serverInfo: { name: 'Jigged', version: '0.1.0' },
});

const authHandler = withMcpAuth(handler, verifyMcpToken, {
  required: true,
  resourceMetadataPath: PROTECTED_RESOURCE_METADATA_PATH,
});

/** The public page that explains this server: where a person pasting the URL into a browser lands. */
const HELP_PAGE_PATH = '/ai-assistants';

/**
 * A browser opening the server URL (to check it, or by mistake) gets the help page instead of an
 * authentication error. An MCP client never asks for HTML: it sends
 * `Accept: application/json, text/event-stream`, so it always reaches the server.
 */
function GET(req: Request): Promise<Response> | Response {
  const accept = req.headers.get('accept') ?? '';
  if (accept.includes('text/html') && !accept.includes('text/event-stream')) {
    return Response.redirect(new URL(HELP_PAGE_PATH, req.url), 307);
  }
  return authHandler(req);
}

export { GET, authHandler as POST, authHandler as DELETE };
