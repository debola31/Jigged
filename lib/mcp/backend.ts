import { z } from 'zod';

import { RefusalError, type ToolEnv } from '@/lib/mcp/defineTool';
import { MCP_GATEWAY_HEADER } from '@/lib/mcp/requestClient';

/**
 * Calls the FastAPI backend (`/api/...`) as the person behind an assistant: their OAuth token in
 * `Authorization`, and this server's gateway key in `x-jigged-mcp`, without which the backend
 * refuses an assistant token (`refuse_unbound_assistant`, api/routes/company_auth.py). For the
 * work only the backend does: the QuickBooks push, bulk import, the read-only data query.
 *
 * NOT the browser's helpers. `utils/quickbooksAccess.ts` and friends read the token from a
 * browser session and call a relative `/api/...`; on this server there is no session and no base
 * URL, so they would fail. This takes the token from the caller and the base from
 * `NEXT_PUBLIC_API_URL` (local: FastAPI on :8000) or else the origin the assistant called
 * (production: the same Vercel deployment, behind the `/api` rewrite).
 *
 * Every response is parsed with the caller's zod schema: no cast stands between the backend's
 * JSON and the tool's output.
 */

/** FastAPI's own time limit is 60s; give up just before it so the person hears why. */
const TIMEOUT_MS = 55_000;

export const BACKEND_UNREACHABLE_MESSAGE =
  "Jigged's server didn't answer in time, so it's not known whether that finished. Check in " +
  'Jigged before trying again.';

function detailOf(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const detail = (body as { detail?: unknown }).detail;
  if (typeof detail === 'string') return detail;
  if (detail && typeof detail === 'object') {
    const message = (detail as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return null;
}

export async function callBackend<S extends z.ZodType>(
  env: ToolEnv,
  path: string,
  schema: S,
  init: { method?: 'GET' | 'POST'; body?: unknown } = {},
): Promise<z.infer<S>> {
  const base = process.env.NEXT_PUBLIC_API_URL || env.origin;
  if (!base) throw new Error('backend call without a base URL: no NEXT_PUBLIC_API_URL and no request origin');

  let response: Response;
  try {
    response = await fetch(`${base.replace(/\/+$/, '')}${path}`, {
      method: init.method ?? 'POST',
      headers: {
        Authorization: `Bearer ${env.caller.token}`,
        [MCP_GATEWAY_HEADER]: process.env.MCP_GATEWAY_KEY ?? '',
        'Content-Type': 'application/json',
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw new RefusalError(BACKEND_UNREACHABLE_MESSAGE);
    }
    throw err;
  }

  const body: unknown = await response.json().catch(() => null);
  if (response.ok) return schema.parse(body);

  // 4xx: the backend's sentence for the person (no access, billing, a bad value, QuickBooks not
  // connected). 5xx: a failure of ours, reported by the wrapper with its generic sentence.
  const detail = detailOf(body);
  if (response.status < 500 && detail) throw new RefusalError(detail);
  throw new Error(`backend ${path} answered ${response.status}${detail ? `: ${detail}` : ''}`);
}
