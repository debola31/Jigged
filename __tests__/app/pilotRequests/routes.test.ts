/**
 * The two server steps of a showcase pilot request (app/pilot-requests/*).
 *
 * The properties under test are the ones a visitor's own browser must not be able to break: the
 * server picks the storage path and keeps the raw IP out of the row, the limits refuse before
 * anything is minted, and only the one call that confirms a real upload asks for the team email.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

type Op = { method: string; args: unknown[] };
type Resolver = (table: string, ops: Op[]) => unknown;

/** A PostgREST-ish builder: records every chained call, resolves through `resolveTable`. */
let resolveTable: Resolver;
const tableCalls: { table: string; ops: Op[] }[] = [];

function chain(table: string) {
  const ops: Op[] = [];
  tableCalls.push({ table, ops });
  const proxy: Record<string, unknown> = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === 'then') {
          return (onFulfilled: (v: unknown) => unknown, onRejected: (e: unknown) => unknown) =>
            Promise.resolve(resolveTable(table, ops)).then(onFulfilled, onRejected);
        }
        return (...args: unknown[]) => {
          ops.push({ method: String(prop), args });
          return proxy;
        };
      },
    },
  );
  return proxy;
}

const createSignedUploadUrl = vi.fn();
const info = vi.fn();

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: (table: string) => chain(table),
    storage: { from: () => ({ createSignedUploadUrl, info }) },
  }),
}));

const captureException = vi.fn();
vi.mock('@sentry/nextjs', () => ({
  instrumentSupabaseClient: vi.fn(),
  captureException: (...args: unknown[]) => captureException(...args),
}));

import { POST as create } from '@/app/pilot-requests/route';
import { POST as complete } from '@/app/pilot-requests/complete/route';

const ID = '3f1c2b9e-8d7a-4c6b-9e5f-1a2b3c4d5e6f';

function post(path: string, body: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(new URL(path, 'https://jigged.app'), {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

const VALID = {
  email: 'owner@shop.example',
  name: 'Pat',
  company_name: 'Acme Machining',
  note: 'Qty 40, 6061',
  file_name: 'bracket.step',
  file_size: 2048,
  website: '',
};

const opsOf = (table: string, method: string) =>
  tableCalls.filter((c) => c.table === table && c.ops.some((o) => o.method === method));

let counts: { email: number; ip_hash: number };
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  tableCalls.length = 0;
  counts = { email: 0, ip_hash: 0 };
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SECRET_KEY = 'service-key';

  resolveTable = (_table, ops) => {
    const eq = ops.find((o) => o.method === 'eq');
    if (ops.some((o) => o.method === 'insert')) return { error: null };
    if (ops.some((o) => o.method === 'select') && ops.some((o) => o.method === 'gte')) {
      const column = eq?.args[0] as 'email' | 'ip_hash';
      return { count: counts[column], error: null };
    }
    return { data: null, error: null };
  };

  createSignedUploadUrl.mockImplementation(async (path: string) => ({
    data: { signedUrl: `https://example.supabase.co/storage/v1/object/upload/sign/pilot-requests/${path}?token=t`, token: 't', path },
    error: null,
  }));

  fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
});

describe('POST /pilot-requests — the happy path', () => {
  it('records the request under a server-chosen path and returns a URL for exactly that path', async () => {
    const res = await create(post('/pilot-requests', VALID, { 'x-real-ip': '203.0.113.7' }));
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.request_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.upload.content_type).toBe('application/octet-stream');

    const inserted = opsOf('pilot_requests', 'insert')[0].ops.find((o) => o.method === 'insert')!
      .args[0] as Record<string, unknown>;
    expect(inserted.id).toBe(body.request_id);
    expect(inserted.storage_path).toBe(`${body.request_id}/bracket.step`);
    expect(createSignedUploadUrl).toHaveBeenCalledWith(inserted.storage_path);
    expect(body.upload.url).toContain(`${body.request_id}/bracket.step`);
    expect(inserted.file_type).toBe('step');
    expect(inserted.uploaded_at).toBeUndefined();
  });

  it('stores a keyed hash of the address and never the address', async () => {
    await create(post('/pilot-requests', VALID, { 'x-real-ip': '203.0.113.7' }));
    const inserted = opsOf('pilot_requests', 'insert')[0].ops.find((o) => o.method === 'insert')!
      .args[0] as Record<string, unknown>;
    expect(inserted.ip_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(inserted)).not.toContain('203.0.113.7');
  });

  it('skips the per-address limit, and stores no hash, when no address can be determined', async () => {
    await create(post('/pilot-requests', VALID));
    const counted = tableCalls.filter((c) => c.ops.some((o) => o.method === 'gte'));
    expect(counted).toHaveLength(1);
    const inserted = opsOf('pilot_requests', 'insert')[0].ops.find((o) => o.method === 'insert')!
      .args[0] as Record<string, unknown>;
    expect(inserted.ip_hash).toBeNull();
  });
});

describe('POST /pilot-requests — what is refused before anything is minted', () => {
  it('answers a filled honeypot with an empty success and writes nothing', async () => {
    const res = await create(post('/pilot-requests', { ...VALID, website: 'http://spam.example' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ request_id: null, upload: null });
    expect(createSignedUploadUrl).not.toHaveBeenCalled();
    expect(tableCalls).toHaveLength(0);
  });

  it('refuses a fourth request from one email in a day', async () => {
    counts.email = 3;
    const res = await create(post('/pilot-requests', VALID, { 'x-real-ip': '203.0.113.7' }));
    expect(res.status).toBe(429);
    expect(createSignedUploadUrl).not.toHaveBeenCalled();
    expect(opsOf('pilot_requests', 'insert')).toHaveLength(0);
  });

  it('refuses a sixth request from one address in a day', async () => {
    counts.ip_hash = 5;
    const res = await create(post('/pilot-requests', VALID, { 'x-real-ip': '203.0.113.7' }));
    expect(res.status).toBe(429);
    expect(opsOf('pilot_requests', 'insert')).toHaveLength(0);
  });

  it('refuses a body the shared validator rejects, with its message', async () => {
    const res = await create(post('/pilot-requests', { ...VALID, file_name: 'model.stl' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/STEP/);
    expect(tableCalls).toHaveLength(0);
  });
});

describe('POST /pilot-requests/complete', () => {
  let row: { id: string; storage_path: string; uploaded_at: string | null } | null;
  let updatedRows: { id: string }[];

  beforeEach(() => {
    row = { id: ID, storage_path: `${ID}/bracket.step`, uploaded_at: null };
    updatedRows = [{ id: ID }];
    info.mockResolvedValue({ data: { size: 4096 }, error: null });
    resolveTable = (_table, ops) => {
      if (ops.some((o) => o.method === 'update')) return { data: updatedRows, error: null };
      if (ops.some((o) => o.method === 'maybeSingle')) return { data: row, error: null };
      return { data: null, error: null };
    };
  });

  const update = () => opsOf('pilot_requests', 'update')[0]?.ops;

  it('confirms a real upload, records its true size, and asks for the email once', async () => {
    const res = await complete(post('/pilot-requests/complete', { request_id: ID }));
    expect(res.status).toBe(200);

    const ops = update()!;
    const patch = ops.find((o) => o.method === 'update')!.args[0] as Record<string, unknown>;
    expect(patch.file_size_bytes).toBe(4096);
    expect(typeof patch.uploaded_at).toBe('string');
    // The guard that makes it one transition.
    expect(ops).toContainEqual({ method: 'is', args: ['uploaded_at', null] });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://example.supabase.co/functions/v1/notify-pilot-request');
    expect(JSON.parse(init.body as string)).toEqual({ request_id: ID });
    // No credentials travel: the function trusts only the id.
    expect(JSON.stringify(init.headers)).not.toContain('service-key');
  });

  it('is idempotent once confirmed: no update and no second email', async () => {
    row = { ...row!, uploaded_at: '2026-11-04T00:00:00Z' };
    const res = await complete(post('/pilot-requests/complete', { request_id: ID }));
    expect(res.status).toBe(200);
    expect(update()).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not email when a concurrent call won the transition', async () => {
    updatedRows = [];
    const res = await complete(post('/pilot-requests/complete', { request_id: ID }));
    expect(res.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('answers 409 when the file is not in the bucket, and confirms nothing', async () => {
    info.mockResolvedValue({ data: null, error: { status: 400, message: 'Object not found' } });
    const res = await complete(post('/pilot-requests/complete', { request_id: ID }));
    expect(res.status).toBe(409);
    expect(update()).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(captureException).not.toHaveBeenCalled();
  });

  it('answers 404 for an unknown id and 400 for a malformed one', async () => {
    row = null;
    expect((await complete(post('/pilot-requests/complete', { request_id: ID }))).status).toBe(404);
    expect((await complete(post('/pilot-requests/complete', { request_id: 'nope' }))).status).toBe(400);
  });

  it('still succeeds for the visitor when the email fails, and reports the failure', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 502 }));
    const res = await complete(post('/pilot-requests/complete', { request_id: ID }));
    expect(res.status).toBe(200);
    expect(captureException).toHaveBeenCalledTimes(1);
  });
});
