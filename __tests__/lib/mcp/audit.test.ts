import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';

/**
 * The call log and the per-minute limits that count it. Neither may ever fail a call: a log that
 * cannot be written or a count that cannot be read goes to Sentry and the call goes ahead.
 */

let windowRows: { is_write: boolean }[] = [];
let readError: unknown = null;
let insertError: unknown = null;
const filters: [string, unknown][] = [];
const inserted: unknown[] = [];

function selectChain() {
  const chain = {
    gte: (c: string, v: unknown) => (filters.push([`gte:${c}`, v]), chain),
    eq: (c: string, v: unknown) => (filters.push([`eq:${c}`, v]), chain),
    is: (c: string, v: unknown) => (filters.push([`is:${c}`, v]), chain),
    limit: async (n: number) => {
      filters.push(['limit', n]);
      return { data: readError ? null : windowRows, error: readError };
    },
  };
  return chain;
}

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: () => ({
      select: () => selectChain(),
      insert: async (row: unknown) => {
        inserted.push(row);
        return { error: insertError };
      },
    }),
  }),
}));

const mockCapture = vi.fn();
vi.mock('@sentry/nextjs', () => ({
  captureException: (...a: unknown[]) => mockCapture(...a),
  instrumentSupabaseClient: () => {},
}));

beforeAll(() => {
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://project.supabase.test');
  vi.stubEnv('SUPABASE_SECRET_KEY', 'service-key');
});

const rows = (reads: number, writes: number) => [
  ...Array.from({ length: reads }, () => ({ is_write: false })),
  ...Array.from({ length: writes }, () => ({ is_write: true })),
];

describe('rateLimitRefusal', () => {
  beforeEach(() => {
    windowRows = [];
    readError = null;
    filters.length = 0;
    mockCapture.mockReset();
  });

  it('lets a quiet company through, counting only its own last minute', async () => {
    const { rateLimitRefusal } = await import('@/lib/mcp/audit');
    windowRows = rows(10, 2);
    expect(await rateLimitRefusal({ companyId: 'co-1', userId: 'u', isWrite: true })).toBeNull();
    expect(filters).toContainEqual(['eq:company_id', 'co-1']);
    expect(filters.find(([k]) => k === 'gte:created_at')).toBeDefined();
  });

  it('refuses once a company passes 120 calls a minute', async () => {
    const { rateLimitRefusal, RATE_LIMITS } = await import('@/lib/mcp/audit');
    windowRows = rows(RATE_LIMITS.companyCallsPerMinute + 1, 0);
    expect(await rateLimitRefusal({ companyId: 'co-1', userId: 'u', isWrite: false, placeName: 'Acme' })).toMatch(
      /more than 120 requests in Acme/,
    );
  });

  it('refuses the 31st change in a minute but still allows reads', async () => {
    const { rateLimitRefusal, RATE_LIMITS } = await import('@/lib/mcp/audit');
    windowRows = rows(5, RATE_LIMITS.companyWritesPerMinute);
    expect(await rateLimitRefusal({ companyId: 'co-1', userId: 'u', isWrite: true })).toMatch(/nothing was changed/);
    expect(await rateLimitRefusal({ companyId: 'co-1', userId: 'u', isWrite: false })).toBeNull();
  });

  it('limits calls that name no company per person', async () => {
    const { rateLimitRefusal, RATE_LIMITS } = await import('@/lib/mcp/audit');
    windowRows = rows(RATE_LIMITS.accountCallsPerMinute + 1, 0);
    expect(await rateLimitRefusal({ companyId: null, userId: 'u-7', isWrite: false })).not.toBeNull();
    expect(filters).toContainEqual(['eq:user_id', 'u-7']);
    expect(filters).toContainEqual(['is:company_id', null]);
  });

  it('goes ahead, and reports it, when the count cannot be read', async () => {
    const { rateLimitRefusal } = await import('@/lib/mcp/audit');
    readError = { message: 'timeout' };
    expect(await rateLimitRefusal({ companyId: 'co-1', userId: 'u', isWrite: true })).toBeNull();
    expect(mockCapture).toHaveBeenCalledTimes(1);
  });
});

describe('recordCall', () => {
  beforeEach(() => {
    inserted.length = 0;
    insertError = null;
    mockCapture.mockReset();
  });

  const call = {
    companyId: 'co-1',
    userId: 'u',
    clientId: 'client-9',
    clientName: '  Claude  ',
    tool: 'list_jobs',
    isWrite: false,
    outcome: 'ok' as const,
    durationMs: 41.6,
  };

  it('writes one row in the table’s own column names', async () => {
    const { recordCall } = await import('@/lib/mcp/audit');
    await recordCall(call);
    expect(inserted).toEqual([
      {
        company_id: 'co-1',
        user_id: 'u',
        client_id: 'client-9',
        client_name: 'Claude',
        tool: 'list_jobs',
        is_write: false,
        outcome: 'ok',
        duration_ms: 42,
      },
    ]);
  });

  it('stores a blank client name as none, which the table’s CHECK requires', async () => {
    const { recordCall } = await import('@/lib/mcp/audit');
    await recordCall({ ...call, clientName: '   ' });
    expect(inserted[0]).toMatchObject({ client_name: null });
  });

  it('never throws when the log cannot be written', async () => {
    const { recordCall } = await import('@/lib/mcp/audit');
    insertError = { message: 'permission denied' };
    await expect(recordCall(call)).resolves.toBeUndefined();
    expect(mockCapture).toHaveBeenCalledTimes(1);
  });
});
