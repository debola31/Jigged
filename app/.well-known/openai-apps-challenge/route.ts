/**
 * OpenAI's domain verification for the ChatGPT directory: the challenge token, as plain text and
 * nothing else, at /.well-known/openai-apps-challenge on the MCP server's host
 * (developers.openai.com/plugins/deploy/submission).
 *
 * The token comes from the OpenAI platform when the plugin is submitted and lives in the
 * OPENAI_APPS_CHALLENGE environment variable (Vercel, Production). Unset, the path is a 404, so
 * nothing claims a verification that isn't configured.
 */
export const dynamic = 'force-dynamic';

export function GET(): Response {
  const token = process.env.OPENAI_APPS_CHALLENGE?.trim();
  if (!token) return new Response('Not found', { status: 404 });
  return new Response(token, {
    status: 200,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
