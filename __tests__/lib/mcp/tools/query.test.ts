import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';

import { RefusalError, type CompanyToolEnv } from '@/lib/mcp/defineTool';
import {
  MAX_SQL_CHARS,
  QUERY_TOOLS,
  ROW_CAP,
  getDataSchema,
  queryShopData,
  registerQueryTools,
} from '@/lib/mcp/tools/query';

vi.mock('@/lib/supabase', () => ({ getSupabase: () => ({}), registerScopedClientResolver: () => {} }));

/**
 * get_data_schema and query_shop_data, run directly over a stubbed fetch, so the real callBackend
 * builds the request and parses the answer. What matters: each reaches the backend route it
 * should, with the person's token and the gateway key; the statement is sent as written; the cap
 * is said out loud; the backend's refusal reaches the person as its own sentence; and both are
 * reads that reach nothing outside Jigged.
 */

const env: CompanyToolEnv = {
  caller: { token: 'oauth-token', clientId: 'c', userId: 'u', email: null, expiresAt: 0 },
  company: { id: 'co-1', name: 'Acme Machining', role: 'user', isDemo: false, governingCompanyId: 'co-1' },
  origin: 'https://jigged.app',
  link: (path) => `https://jigged.app${path}`,
};

function reply(status: number, body: unknown) {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
}

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

function sent(): { url: string; init: RequestInit & { headers: Record<string, string> } } {
  const [url, init] = fetchMock.mock.calls[0];
  return { url, init };
}

const LATE =
  'SELECT COUNT(*) AS late FROM jobs WHERE company_id = $1 ' +
  'AND public.is_job_late(due_date, production_status, fulfillment_status, $2)';

describe('query_shop_data', () => {
  it('sends the statement and today to the backend sandbox, as the person, and returns the rows', async () => {
    fetchMock.mockReturnValue(
      reply(200, { columns: ['late'], rows: [{ late: 4 }], row_count: 1, row_cap: ROW_CAP, capped: false }),
    );
    const res = await queryShopData.run({ sql: LATE, today: '2026-11-09' }, env);
    if (!res.ok) throw new Error(res.message);

    const { url, init } = sent();
    expect(url).toBe('https://jigged.app/api/insights/co-1/query');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer oauth-token', 'x-jigged-mcp': 'gateway-key' });
    expect(JSON.parse(String(init.body))).toEqual({ sql: LATE, today: '2026-11-09' });

    expect(res.data).toEqual({ columns: ['late'], rows: [{ late: 4 }], row_count: 1, capped: false, note: null });
    expect(() => z.object(queryShopData.output).parse(res.data)).not.toThrow();
  });

  it('sends no date when none was given, and the backend decides whether one was needed', async () => {
    fetchMock.mockReturnValue(reply(200, { columns: [], rows: [], row_count: 0, row_cap: ROW_CAP, capped: false }));
    await queryShopData.run({ sql: 'SELECT COUNT(*) FROM customers WHERE company_id = $1' }, env);
    expect(JSON.parse(String(sent().init.body))).toEqual({ sql: 'SELECT COUNT(*) FROM customers WHERE company_id = $1' });
  });

  it('says so when the cap may have cut rows', async () => {
    const rows = Array.from({ length: ROW_CAP }, (_, i) => ({ n: i }));
    fetchMock.mockReturnValue(reply(200, { columns: ['n'], rows, row_count: ROW_CAP, row_cap: ROW_CAP, capped: true }));
    const res = await queryShopData.run({ sql: 'SELECT n FROM x WHERE company_id = $1' }, env);
    if (!res.ok) throw new Error(res.message);
    expect(res.data.capped).toBe(true);
    expect(res.data.row_count).toBe(ROW_CAP);
    expect(res.data.note).toContain(`first ${ROW_CAP} rows`);
  });

  it("passes the backend's refusal through as its own sentence", async () => {
    fetchMock.mockReturnValue(reply(400, { detail: 'Query must start with SELECT or WITH. Got: DELETE' }));
    const call = queryShopData.run({ sql: 'DELETE FROM customers WHERE company_id = $1' }, env);
    await expect(call).rejects.toBeInstanceOf(RefusalError);
    fetchMock.mockReturnValue(reply(400, { detail: 'Query must start with SELECT or WITH. Got: DELETE' }));
    await expect(queryShopData.run({ sql: 'DELETE FROM customers WHERE company_id = $1' }, env)).rejects.toThrow(
      'Query must start with SELECT or WITH. Got: DELETE',
    );
  });

  it("refuses the person-column rule's way: the backend's sentence, no rows", async () => {
    const detail = "Jigged doesn't give assistants who did a piece of work, so completed_by can't be queried.";
    fetchMock.mockReturnValue(reply(400, { detail }));
    await expect(
      queryShopData.run({ sql: 'SELECT completed_by FROM job_operations WHERE company_id = $1' }, env),
    ).rejects.toThrow(detail);
  });

  it('validates its input before anything is sent', () => {
    const input = z.object(queryShopData.input);
    expect(input.safeParse({ sql: '' }).success).toBe(false);
    expect(input.safeParse({ sql: 'x'.repeat(MAX_SQL_CHARS + 1) }).success).toBe(false);
    expect(input.safeParse({ sql: 'SELECT 1', today: '11/09/2026' }).success).toBe(false);
    expect(input.safeParse({ sql: 'SELECT 1', today: '2026-11-09' }).success).toBe(true);
  });

  it('says in its description that it is read-only and how many rows it returns', () => {
    expect(queryShopData.description).toMatch(/read-only/);
    expect(queryShopData.description).toContain(`at most ${ROW_CAP} rows`);
    expect(queryShopData.description).toMatch(/AI is not used/);
  });
});

describe('get_data_schema', () => {
  it("serves the backend's schema notes and definitions, verbatim", async () => {
    fetchMock.mockReturnValue(
      reply(200, {
        schema_context: '### customers\n- id: UUID (PK)',
        semantics: '## Late job\n```sql\nSELECT 1\n```',
        query_rules: ['One SELECT or WITH statement, PostgreSQL.'],
        row_cap: ROW_CAP,
        timeout_seconds: 5,
      }),
    );
    const res = await getDataSchema.run({}, env);
    if (!res.ok) throw new Error(res.message);

    const { url, init } = sent();
    expect(url).toBe('https://jigged.app/api/insights/co-1/schema');
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
    expect(init.headers).toMatchObject({ Authorization: 'Bearer oauth-token', 'x-jigged-mcp': 'gateway-key' });

    expect(res.data).toEqual({
      schema: '### customers\n- id: UUID (PK)',
      definitions: '## Late job\n```sql\nSELECT 1\n```',
      rules: ['One SELECT or WITH statement, PostgreSQL.'],
      row_cap: ROW_CAP,
      timeout_seconds: 5,
    });
    expect(() => z.object(getDataSchema.output).parse(res.data)).not.toThrow();
  });

  it('refuses an answer that is not the shape it expects', async () => {
    fetchMock.mockReturnValue(reply(200, { schema: 'renamed' }));
    await expect(getDataSchema.run({}, env)).rejects.toBeInstanceOf(z.ZodError);
  });
});

describe('the query tools as an assistant sees them', () => {
  const registered: Array<{ name: string; annotations: Record<string, unknown> }> = [];
  registerQueryTools({
    registerTool: (name: string, config: { annotations: Record<string, unknown> }) => {
      registered.push({ name, annotations: config.annotations });
    },
  } as unknown as Parameters<typeof registerQueryTools>[0]);

  it('registers both, as reads that reach nothing outside Jigged', () => {
    expect(registered.map((t) => t.name)).toEqual(QUERY_TOOLS.map((t) => t.name));
    for (const tool of registered) {
      expect(tool.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });
    }
  });

  it('declares no output field that names a person', () => {
    for (const tool of QUERY_TOOLS) {
      const fields = Object.keys(tool.output);
      expect(fields.filter((f) => /_by$|^operator|^author|^user_(id|name)$/.test(f))).toEqual([]);
    }
  });
});
