import { NextResponse } from 'next/server';
import { z } from 'zod';

import { CHAT_CLIENT_NAME, verifyChatToken } from '@/lib/mcp/auth';
import { chatTool, chatToolManifest } from '@/lib/mcp/chatCatalog';
// Registers the per-request client resolver with getSupabase(). Imported for its side effect.
import '@/lib/mcp/requestClient';

/**
 * Jigged chat's door to the MCP tools. The chat's model runs in the FastAPI backend; when it asks
 * for a Jigged tool, the backend calls here, AS THE PERSON who asked (their own session token),
 * and the tool runs through the exact call path `/mcp` uses (lib/mcp/defineTool.ts): company and
 * role, the rate limit, RLS and the billing gate, one `mcp_tool_calls` row as "Jigged chat".
 *
 * Approval is NOT decided here. The backend holds a proposed change until the person approves it
 * or has chosen "Always allow" (public.chat_action_grants), and only then calls. A person calling
 * this directly could do nothing their own session cannot already do in the browser.
 *
 *   GET   the manifest: every chat tool's name, description, access and input schema
 *   POST  { company_id, tool, arguments } -> the tool's CallToolResult
 *
 * Lives at `/chat-tools`, not under `/api`: vercel.json rewrites `/api/*` to the FastAPI function.
 */
export const runtime = 'nodejs';
export const maxDuration = 60;

function bearerOf(request: Request): string | null {
  const match = request.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

const NOT_SIGNED_IN = { error: 'not_signed_in', message: 'You are not signed in to Jigged.' };

export async function GET(request: Request) {
  const caller = await verifyChatToken(bearerOf(request));
  if (!caller) return NextResponse.json(NOT_SIGNED_IN, { status: 401 });
  return NextResponse.json({ tools: chatToolManifest() });
}

const CallBody = z.object({
  company_id: z.guid(),
  tool: z.string().min(1).max(64),
  arguments: z.record(z.string(), z.unknown()).default({}),
});

export async function POST(request: Request) {
  const caller = await verifyChatToken(bearerOf(request));
  if (!caller) return NextResponse.json(NOT_SIGNED_IN, { status: 401 });

  const body = CallBody.safeParse(await request.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: 'bad_request' }, { status: 400 });

  const tool = chatTool(body.data.tool);
  if (!tool) return NextResponse.json({ error: 'unknown_tool' }, { status: 404 });

  // A CallToolResult either way: a refusal or failure is `isError: true` with a sentence for the
  // person, never an HTTP error, so the model can tell them what happened.
  const result = await tool.call(body.data.arguments, {
    caller,
    clientName: CHAT_CLIENT_NAME,
    origin: new URL(request.url).origin,
    companyId: body.data.company_id,
  });
  return NextResponse.json(result);
}
