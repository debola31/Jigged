import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const getSession = vi.fn();
vi.mock('@/lib/supabase', () => ({
  getSupabase: () => ({ auth: { getSession } }),
}));

import { assistRows } from '@/utils/drawingFieldsAssist';
import type { BuiltRow } from '@/lib/drawingImportExtract';

/**
 * A rejected session is not a drawing that could not be read.
 *
 * Locally the commonest cause is a `supabase db reset`, which drops
 * `auth.sessions` while the browser keeps a well-formed JWT. Every row then 401s
 * on its own and the batch reported "29 of 29 could not be read" — which sends
 * someone to look at their drawings when the problem is their token.
 */
const row = (stem: string): BuiltRow =>
  ({
    stem,
    readSource: 'dxf',
    fields: {},
    items: [{ text: 'MATERIAL', x: 1, y: 1, height: 2 }],
  }) as unknown as BuiltRow;

describe('assistRows', () => {
  beforeEach(() => {
    getSession.mockResolvedValue({ data: { session: { access_token: 'tok' } } });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('says the session expired, rather than blaming the drawings', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 401 })),
    );

    await expect(assistRows('co', [row('a'), row('b'), row('c')])).rejects.toThrow(
      /session has expired/i,
    );
  });

  it('stops the batch instead of firing every remaining drawing at the same 401', async () => {
    // Thirty-one drawings against a stale token used to be thirty-one requests,
    // thirty-one log lines and one useless message.
    const fetchMock = vi.fn(async () => new Response('', { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);

    const rows = Array.from({ length: 31 }, (_, i) => row(`s${i}`));
    await assistRows('co', rows).catch(() => undefined);

    // The pool is 6 wide, so the in-flight ones finish; nothing beyond that goes.
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(6);
  });

  it('still reports an ordinary failure per drawing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 500 })),
    );

    const outcome = await assistRows('co', [row('a'), row('b')]);
    expect(outcome.failed).toBe(2);
    expect(outcome.filled.size).toBe(0);
  });

  it('fills what the server returns', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ fields: { material: { value: 'AL 6061' } }, dropped: [] }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
      ),
    );

    const outcome = await assistRows('co', [row('a')]);
    expect(outcome.filled.get('a')?.material?.value).toBe('AL 6061');
    expect(outcome.failed).toBe(0);
  });
});
