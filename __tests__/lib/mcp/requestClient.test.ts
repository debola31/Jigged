import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';

/**
 * The per-request client: inside `runAsCaller`, `getSupabase()` — the getter every access-layer
 * function uses — acts as the MCP caller, and only inside it.
 *
 * The isolation test is the one that matters. Two assistants calling at the same moment must
 * each see their own user; a leak here would be one shop's assistant reading another's data.
 */

beforeAll(() => {
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://project.supabase.test');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'anon-key');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const caller = (userId: string, token: string) => ({
  token,
  clientId: 'client-1',
  userId,
  email: `${userId}@shop.test`,
  expiresAt: Math.floor(Date.now() / 1000) + 600,
});

describe('runAsCaller', () => {
  it('scopes getSupabase() to the caller and restores the default afterwards', async () => {
    const { getSupabase } = await import('@/lib/supabase');
    const { runAsCaller, inCallerScope } = await import('@/lib/mcp/requestClient');

    const outside = getSupabase();
    expect(inCallerScope()).toBe(false);

    await runAsCaller(caller('user-a', 'token-a'), async () => {
      expect(inCallerScope()).toBe(true);
      expect(getSupabase()).not.toBe(outside);
      const { data } = await getSupabase().auth.getSession();
      expect(data.session?.access_token).toBe('token-a');
      expect(data.session?.user.id).toBe('user-a');
    });

    expect(inCallerScope()).toBe(false);
    expect(getSupabase()).toBe(outside);
  });

  it('keeps two concurrent callers apart', async () => {
    const { getSupabase } = await import('@/lib/supabase');
    const { runAsCaller } = await import('@/lib/mcp/requestClient');

    const seen = await Promise.all(
      ['user-a', 'user-b'].map((id, i) =>
        runAsCaller(caller(id, `token-${id}`), async () => {
          // Interleave: each run yields before reading, so the other is mid-flight.
          await new Promise((r) => setTimeout(r, 10 - i * 5));
          const { data } = await getSupabase().auth.getSession();
          return data.session?.user.id;
        }),
      ),
    );
    expect(seen).toEqual(['user-a', 'user-b']);
  });

  it("sends the caller's token on database requests", async () => {
    const fetchMock = vi.fn(
      async () => new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { getSupabase } = await import('@/lib/supabase');
    const { runAsCaller } = await import('@/lib/mcp/requestClient');

    await runAsCaller(caller('user-a', 'token-a'), async () => {
      await getSupabase().from('companies').select('id');
    });

    const rest = fetchMock.mock.calls.find(([input]) => String(input).includes('/rest/v1/companies'));
    expect(rest).toBeDefined();
    const headers = new Headers((rest?.[1] as RequestInit | undefined)?.headers);
    expect(headers.get('Authorization')).toBe('Bearer token-a');
  });
});
