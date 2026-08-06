/**
 * The Supabase-integration contract that issue #708's fix rests on.
 *
 * These assert BEHAVIOUR OF THE SENTRY SDK, not of our code, which is exactly why they are
 * worth having: the whole design — a net for table operations, the access layer for `.rpc()` —
 * is only correct while the SDK keeps behaving this way, and an SDK upgrade would change it
 * silently. Every one of these was established by experiment before the code was written, and
 * one of them (rpc reaching the net at all) contradicted the first design.
 *
 * Two things cost real time to discover while writing these, worth knowing before editing:
 *   - `beforeSend` runs during `flush`, NOT when the query is awaited. Asserting straight after
 *     an `await` sees nothing.
 *   - Calling `Sentry.init` twice in one file routes events to the FIRST client's `beforeSend`.
 *     Hence one `init` per test file, and separate files where a fresh module registry matters.
 */
import * as Sentry from '@sentry/nextjs';
import { createClient } from '@supabase/supabase-js';
import { applySupabaseEventPolicy, RPC_SPAN_ATTRIBUTE } from '@/lib/sentryEventPolicy';

interface Captured {
  message: string;
  dbTable: unknown;
  isRpc: unknown;
  mechanismType: string | undefined;
}

const captured: Captured[] = [];

/** Everything the integration hands to `beforeSend`, before our policy runs. */
function recordRaw(event: Sentry.ErrorEvent): void {
  const span = Sentry.getActiveSpan();
  const data = span ? Sentry.spanToJSON(span).data : undefined;
  captured.push({
    message: event.exception?.values?.[0]?.value ?? '',
    dbTable: data?.['db.table'],
    isRpc: data?.[RPC_SPAN_ATTRIBUTE],
    mechanismType: event.exception?.values?.[0]?.mechanism?.type,
  });
}

/**
 * A client that fails every request, wired like the real one in `lib/supabase.ts`: a custom
 * `fetch` that stamps the rpc span attribute.
 */
function failingClient(body: Record<string, unknown>) {
  return createClient('https://example.supabase.co', 'anon-key', {
    global: {
      fetch: async (input: RequestInfo | URL) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.includes('/rest/v1/rpc/')) {
          Sentry.getActiveSpan()?.setAttribute(RPC_SPAN_ATTRIBUTE, true);
        }
        return new Response(JSON.stringify(body), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      },
    },
  });
}

const PG_RAISED = { code: 'P0001', message: 'work center 853e is not in company 7523' };

beforeAll(() => {
  Sentry.init({
    dsn: 'https://abc123@o1.ingest.us.sentry.io/1',
    enabled: true,
    tracesSampleRate: 1,
    beforeSend(event, hint) {
      recordRaw(event);
      return applySupabaseEventPolicy(event, hint);
    },
    transport: () => ({ send: async () => ({}), flush: async () => true }),
  });
});

beforeEach(() => {
  captured.length = 0;
});

describe('the net: what the Supabase integration captures on its own', () => {
  it('captures a failed table write that no call site reports, tagged with the table', async () => {
    const client = failingClient(PG_RAISED);
    Sentry.instrumentSupabaseClient(client);

    // Deliberately ignoring the returned `{ error }` — the exact shape of the #708 incident,
    // where the only record of a day of failed saves was the Postgres log.
    await client.from('notes').insert({ body: 'x' });
    await Sentry.flush(200);

    expect(captured).toHaveLength(1);
    expect(captured[0].message).toContain('work center 853e');
    expect(captured[0].dbTable).toBe('notes');
    expect(captured[0].mechanismType).toBe('auto.db.supabase.postgres');
  });

  it('reaches .rpc() too — which is why rpc has to be suppressed, not assumed absent', async () => {
    const client = failingClient(PG_RAISED);
    Sentry.instrumentSupabaseClient(client);

    // Warm the lazy prototype patch, the way any real page load does.
    await client.from('notes').select('id');
    await Sentry.flush(200);
    captured.length = 0;

    await client.rpc('transfer_stock', { p_part_id: 'x' });
    await Sentry.flush(200);

    // `db.table` holds the FUNCTION name, indistinguishable from a table name without the URL.
    expect(captured).toHaveLength(1);
    expect(captured[0].dbTable).toBe('transfer_stock');
    expect(captured[0].isRpc).toBe(true);
  });
});

describe('the policy: what survives beforeSend', () => {
  it('drops rpc, so the access layer stays its sole reporter', async () => {
    const kept: unknown[] = [];
    const event = {
      exception: {
        values: [{ value: 'raised', mechanism: { type: 'auto.db.supabase.postgres', handled: false } }],
      },
    } as unknown as Sentry.ErrorEvent;

    // Stand in for the active span the real path provides.
    Sentry.startSpan(
      { name: 'insert(...) from(transfer_stock)', attributes: { [RPC_SPAN_ATTRIBUTE]: true } },
      () => {
        kept.push(applySupabaseEventPolicy(event, { originalException: { code: 'P0001' } }));
      },
    );

    expect(kept[0]).toBeNull();
  });

  it('keeps a table failure, marks it handled, and tags the table', () => {
    const event = {
      exception: {
        values: [{ value: 'raised', mechanism: { type: 'auto.db.supabase.postgres', handled: false } }],
      },
    } as unknown as Sentry.ErrorEvent;

    let result: Sentry.ErrorEvent | null = null;
    Sentry.startSpan(
      { name: 'insert(...) from(notes)', attributes: { 'db.table': 'notes' } },
      () => {
        result = applySupabaseEventPolicy(event, { originalException: { code: 'P0001' } });
      },
    );

    expect(result).not.toBeNull();
    expect(result!.exception?.values?.[0]?.mechanism?.handled).toBe(true);
    expect(result!.tags?.['db.table']).toBe('notes');
  });

  it.each([
    ['a .single() that matched nothing', { code: 'PGRST116', message: 'no rows' }],
    ['a cancelled request', { message: 'FetchError', hint: 'Request was aborted (timeout or manual cancellation)' }],
    ['an expired session', { code: 'PGRST301', message: 'JWT expired' }],
  ])('drops %s', (_label, originalException) => {
    const event = {
      exception: {
        values: [{ value: 'x', mechanism: { type: 'auto.db.supabase.postgres', handled: false } }],
      },
    } as unknown as Sentry.ErrorEvent;

    expect(applySupabaseEventPolicy(event, { originalException })).toBeNull();
  });

  it('leaves events that are not the integration\'s alone', () => {
    const event = {
      exception: { values: [{ value: 'render blew up', mechanism: { type: 'onerror', handled: false } }] },
    } as unknown as Sentry.ErrorEvent;

    const result = applySupabaseEventPolicy(event, { originalException: new Error('render blew up') });

    expect(result).toBe(event);
    // Untouched: a genuine unhandled error must keep saying so.
    expect(result!.exception?.values?.[0]?.mechanism?.handled).toBe(false);
  });
});
