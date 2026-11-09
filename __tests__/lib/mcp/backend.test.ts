import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';

import { BACKEND_UNREACHABLE_MESSAGE, callBackend } from '@/lib/mcp/backend';
import { RefusalError, UpstreamError, type ToolEnv } from '@/lib/mcp/defineTool';

vi.mock('@/lib/supabase', () => ({ getSupabase: () => ({}), registerScopedClientResolver: () => {} }));

/**
 * The backend call an assistant's tool makes: the person's token and this server's gateway key,
 * the right base URL, and the backend's answer turned into a sentence or a parsed value.
 */

const env: ToolEnv = {
  caller: { token: 'oauth-token', clientId: 'c', userId: 'u', email: null, expiresAt: 0 },
  origin: 'https://jigged.app',
  link: () => null,
};

const ok = z.object({ invoice_number: z.string() });

function reply(status: number, body: unknown) {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
}

describe('callBackend', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('MCP_GATEWAY_KEY', 'gateway-key');
    vi.stubEnv('NEXT_PUBLIC_API_URL', '');
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("sends the person's token and the gateway key to the origin the assistant called", async () => {
    fetchMock.mockReturnValue(reply(200, { invoice_number: '1042' }));
    await expect(callBackend(env, '/api/quickbooks/co/jobs/j/push', ok, { body: { lines: [] } })).resolves.toEqual({
      invoice_number: '1042',
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://jigged.app/api/quickbooks/co/jobs/j/push');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer oauth-token', 'x-jigged-mcp': 'gateway-key' });
    expect(JSON.parse(init.body)).toEqual({ lines: [] });
  });

  it('uses NEXT_PUBLIC_API_URL when set (local FastAPI)', async () => {
    vi.stubEnv('NEXT_PUBLIC_API_URL', 'http://localhost:8000/');
    fetchMock.mockReturnValue(reply(200, { invoice_number: '1' }));
    await callBackend(env, '/api/x', ok);
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:8000/api/x');
  });

  it("turns a 4xx into the backend's own sentence, as a refusal", async () => {
    fetchMock.mockReturnValue(reply(403, { detail: 'QuickBooks is not connected for this company.' }));
    const call = callBackend(env, '/api/x', ok);
    await expect(call).rejects.toBeInstanceOf(RefusalError);
    await expect(callBackend(env, '/api/x', ok)).rejects.toThrow(/./);
    fetchMock.mockReturnValue(reply(409, { detail: { message: 'Already invoiced.', code: 'dup' } }));
    await expect(callBackend(env, '/api/x', ok)).rejects.toThrow('Already invoiced.');
  });

  it('treats a 5xx as our failure, not a sentence for the person', async () => {
    fetchMock.mockReturnValue(reply(500, { detail: 'Internal Server Error' }));
    const err = await callBackend(env, '/api/x', ok).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(RefusalError);
    expect((err as Error).message).toMatch(/^backend \/api\/x answered 500/);
  });

  it("passes an outage behind the backend through as an upstream error", async () => {
    fetchMock.mockReturnValue(reply(503, { detail: "QuickBooks isn't answering right now. Try again shortly." }));
    const err = await callBackend(env, '/api/x', ok).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UpstreamError);
    expect((err as Error).message).toBe("QuickBooks isn't answering right now. Try again shortly.");
  });

  it('says plainly when the backend did not answer in time', async () => {
    fetchMock.mockRejectedValue(Object.assign(new Error('timed out'), { name: 'TimeoutError' }));
    await expect(callBackend(env, '/api/x', ok)).rejects.toThrow(BACKEND_UNREACHABLE_MESSAGE);
  });

  it('refuses an answer that is not the shape the tool expects', async () => {
    fetchMock.mockReturnValue(reply(200, { something: 'else' }));
    await expect(callBackend(env, '/api/x', ok)).rejects.toBeInstanceOf(z.ZodError);
  });
});
