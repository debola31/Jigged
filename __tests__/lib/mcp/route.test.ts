import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

/**
 * `/mcp` end to end, minus the network: the real route module (mcp-handler + withMcpAuth + the
 * Jigged tools), a stubbed token check and a stubbed company read.
 *
 * Requests use the 2025-06-18 stateless form, the fallback mcp-handler serves to pre-2026
 * clients; the response is a one-event SSE stream.
 */

beforeAll(() => {
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://project.supabase.test');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'anon-key');
});

const mockVerify = vi.fn();
vi.mock('@/lib/mcp/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/mcp/auth')>();
  return { ...actual, verifyMcpToken: (...args: unknown[]) => mockVerify(...args) };
});

const mockGetUserCompanies = vi.fn();
vi.mock('@/utils/companyAccess', () => ({
  getUserCompanies: (...args: unknown[]) => mockGetUserCompanies(...args),
}));

// The call log and rate limit run as service role against a real table; here they only record.
const mockRecordCall = vi.fn();
vi.mock('@/lib/mcp/audit', () => ({
  rateLimitRefusal: async () => null,
  recordCall: (...args: unknown[]) => mockRecordCall(...args),
}));

const AUTH_INFO = {
  token: 'oauth-token',
  clientId: 'client-9',
  scopes: [],
  expiresAt: Math.floor(Date.now() / 1000) + 600,
  extra: { userId: 'user-1', email: 'owner@shop.test' },
};

async function call(body: object, token?: string) {
  const { POST } = await import('@/app/mcp/route');
  const res = await POST(
    new Request('https://jigged.test/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2025-06-18',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, ...body }),
    }),
  );
  return res;
}

async function result(res: Response) {
  const text = await res.text();
  const data = text.split('\n').find((l) => l.startsWith('data: '));
  return JSON.parse(data ? data.slice('data: '.length) : text);
}

describe('/mcp', () => {
  beforeEach(() => {
    mockVerify.mockReset();
    mockGetUserCompanies.mockReset();
    mockRecordCall.mockReset();
    mockVerify.mockImplementation(async (_req: Request, token?: string) =>
      token === 'oauth-token' ? AUTH_INFO : undefined,
    );
  });

  it('answers 401 with a challenge pointing at the protected-resource metadata', async () => {
    const res = await call({ method: 'tools/list', params: {} });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain(
      'resource_metadata="https://jigged.test/.well-known/oauth-protected-resource/mcp"',
    );
  });

  it('refuses a token the verifier rejects', async () => {
    const res = await call({ method: 'tools/list', params: {} }, 'browser-session-token');
    expect(res.status).toBe(401);
  });

  it('lists list_my_companies as a read-only, closed-world tool', async () => {
    const body = await result(await call({ method: 'tools/list', params: {} }, 'oauth-token'));
    const tool = body.result.tools.find((t: { name: string }) => t.name === 'list_my_companies');
    expect(tool).toBeDefined();
    expect(tool.title).toBe('List my companies');
    expect(tool.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    });
  });

  it('lists only the companies where the caller is an office user, read as that caller', async () => {
    const { inCallerScope } = await import('@/lib/mcp/requestClient');
    let scoped = false;
    mockGetUserCompanies.mockImplementation(async () => {
      scoped = inCallerScope();
      return [
        { company_id: 'co-admin', role: 'admin', companies: { id: 'co-admin', name: 'Acme Machining' } },
        { company_id: 'co-user', role: 'user', companies: { id: 'co-user', name: 'Beta Tool' } },
        { company_id: 'co-op', role: 'operator', companies: { id: 'co-op', name: 'Gamma Works' } },
      ];
    });

    const body = await result(
      await call({ method: 'tools/call', params: { name: 'list_my_companies', arguments: {} } }, 'oauth-token'),
    );

    expect(mockGetUserCompanies).toHaveBeenCalledWith('user-1');
    expect(scoped).toBe(true);
    expect(mockRecordCall).toHaveBeenCalledWith(
      expect.objectContaining({ tool: 'list_my_companies', companyId: null, clientId: 'client-9', outcome: 'ok' }),
    );
    expect(body.result.isError).toBeFalsy();
    expect(body.result.structuredContent.companies).toEqual([
      { company_id: 'co-admin', name: 'Acme Machining', role: 'admin', url: 'https://jigged.test/dashboard/co-admin', demo: null },
      { company_id: 'co-user', name: 'Beta Tool', role: 'user', url: 'https://jigged.test/dashboard/co-user', demo: null },
    ]);
  });

  it("offers a company's demo under that company, and never an operator company's", async () => {
    mockGetUserCompanies.mockResolvedValue([
      {
        company_id: 'co-admin',
        role: 'admin',
        companies: { id: 'co-admin', name: 'Acme Machining', demo_company_id: 'demo-acme' },
      },
      {
        company_id: 'co-op',
        role: 'operator',
        companies: { id: 'co-op', name: 'Gamma Works', demo_company_id: 'demo-gamma' },
      },
    ]);
    const body = await result(
      await call({ method: 'tools/call', params: { name: 'list_my_companies', arguments: {} } }, 'oauth-token'),
    );
    expect(body.result.structuredContent.companies).toEqual([
      {
        company_id: 'co-admin',
        name: 'Acme Machining',
        role: 'admin',
        url: 'https://jigged.test/dashboard/co-admin',
        demo: { company_id: 'demo-acme', url: 'https://jigged.test/dashboard/demo-acme' },
      },
    ]);
  });

  it('explains an operator-only login instead of returning an empty answer', async () => {
    mockGetUserCompanies.mockResolvedValue([
      { company_id: 'co-op', role: 'operator', companies: { id: 'co-op', name: 'Gamma Works' } },
    ]);
    const body = await result(
      await call({ method: 'tools/call', params: { name: 'list_my_companies', arguments: {} } }, 'oauth-token'),
    );
    expect(body.result.structuredContent.companies).toEqual([]);
    expect(body.result.content[0].text).toMatch(/office role/);
  });

  it('reports a failed read as a tool error, not a protocol failure', async () => {
    mockGetUserCompanies.mockRejectedValue(new Error('connection reset'));
    const body = await result(
      await call({ method: 'tools/call', params: { name: 'list_my_companies', arguments: {} } }, 'oauth-token'),
    );
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toMatch(/couldn't finish that just now/);
    expect(mockRecordCall).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'error' }));
  });
});
