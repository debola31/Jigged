/**
 * The only path that writes a terms_acceptances row.
 *
 * The assertions here are about what the CLIENT cannot influence. A clickwrap
 * record is worth what it is worth because the party it is evidence against
 * could not have produced it — so a caller must not be able to choose the IP
 * recorded against them, the version they are recorded as having accepted, or
 * the hash of the document they are recorded as having seen.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mockGetUser = vi.fn();
const inserted: Record<string, unknown>[][] = [];
const mockAccessRows = vi.fn(() => ({ data: [] as { company_id: string }[] }));

vi.mock('@/utils/supabase/server', () => ({
  createClient: async () => ({ auth: { getUser: () => mockGetUser() } }),
}));

vi.mock('@sentry/nextjs', () => ({
  instrumentSupabaseClient: vi.fn(),
  captureException: vi.fn(),
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: (table: string) => {
      if (table === 'terms_acceptances') {
        return {
          insert: (rows: Record<string, unknown>[]) => {
            inserted.push(rows);
            return Promise.resolve({ error: null });
          },
        };
      }
      return {
        select: () => ({ eq: () => ({ eq: () => ({ limit: () => mockAccessRows() }) }) }),
      };
    },
  }),
}));

import { POST, parseAcceptBody, isSameOrigin } from '@/app/legal/accept/route';
import { CURRENT_LEGAL_VERSIONS } from '@/lib/legal/manifest';

const ORIGIN = 'https://www.jigged.app';

function post(body: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(new URL('/legal/accept', ORIGIN), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', ...headers },
    body: JSON.stringify(body),
  });
}

const VALID = {
  document_types: ['tos', 'privacy'],
  accepted_via: 'invite_accept',
  displayed_versions: {
    tos: CURRENT_LEGAL_VERSIONS.tos.version,
    privacy: CURRENT_LEGAL_VERSIONS.privacy.version,
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  inserted.length = 0;
  mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });
  mockAccessRows.mockReturnValue({ data: [] });
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SECRET_KEY = 'service-key';
});

describe('POST /legal/accept — the happy path', () => {
  it("writes one row per document with the server's own version and hash", async () => {
    const res = await POST(post(VALID, { 'x-real-ip': '203.0.113.7' }));
    expect(res.status).toBe(200);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toHaveLength(2);

    const tos = inserted[0].find((r) => r.document_type === 'tos')!;
    expect(tos.version).toBe(CURRENT_LEGAL_VERSIONS.tos.version);
    expect(tos.document_sha256).toBe(CURRENT_LEGAL_VERSIONS.tos.sha256);
    expect(tos.user_id).toBe('user-1');
  });

  it('records the surface that presented the document', async () => {
    await POST(post({ ...VALID, accepted_via: 'reacceptance_operator' }));
    expect(inserted[0][0].accepted_via).toBe('reacceptance_operator');
  });
});

describe('POST /legal/accept — the client cannot supply the IP', () => {
  /**
   * THE SECURITY PROPERTY, tested behaviourally. A test that merely omits
   * ip_address from the body proves nothing: it passes just as well against a
   * handler that honours a client IP whenever one is present.
   */
  it('ignores a client-supplied ip_address and stores the header-derived one', async () => {
    const res = await POST(
      post(
        { ...VALID, ip_address: '1.2.3.4', user_agent: 'totally-legit', version: 999 },
        { 'x-real-ip': '203.0.113.7', 'user-agent': 'RealBrowser/1.0' },
      ),
    );
    expect(res.status).toBe(200);

    const row = inserted[0][0];
    expect(row.ip_address).toBe('203.0.113.7');
    expect(row.ip_source).toBe('x-real-ip');
    expect(row.user_agent).toBe('RealBrowser/1.0');
    expect(row.version).toBe(CURRENT_LEGAL_VERSIONS.tos.version);

    // And it was not smuggled into some other column.
    expect(JSON.stringify(inserted[0])).not.toContain('1.2.3.4');
    expect(JSON.stringify(inserted[0])).not.toContain('totally-legit');
  });

  /**
   * The shape test that stops the behavioural one above from rotting. The
   * strongest form of "do not trust a client-supplied version" is to have
   * nowhere to put one, so assert the parser has no such field.
   */
  it('has nowhere to put a version, hash, IP, user agent or timestamp', () => {
    const parsed = parseAcceptBody({
      ...VALID,
      ip_address: '1.2.3.4',
      ipAddress: '1.2.3.4',
      user_agent: 'x',
      version: 9,
      document_sha256: 'b'.repeat(64),
      accepted_at: '2000-01-01',
    })!;
    const keys = Object.keys(parsed);
    for (const forbidden of [
      'ip_address',
      'ipAddress',
      'user_agent',
      'version',
      'document_sha256',
      'accepted_at',
    ]) {
      expect(keys).not.toContain(forbidden);
    }
  });

  it('still records the acceptance when no address can be determined', async () => {
    // Refusing an account creation over a missing header would be the wrong
    // trade; "unavailable" is itself a fact worth recording.
    const res = await POST(post(VALID));
    expect(res.status).toBe(200);
    expect(inserted[0][0].ip_address).toBeNull();
    expect(inserted[0][0].ip_source).toBe('unavailable');
  });
});

describe('POST /legal/accept — refusals', () => {
  it('refuses an unauthenticated caller', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null });
    expect((await POST(post(VALID))).status).toBe(401);
    expect(inserted).toHaveLength(0);
  });

  it('refuses a cross-site request', async () => {
    const res = await POST(post(VALID, { 'sec-fetch-site': 'cross-site' }));
    expect(res.status).toBe(403);
    expect(inserted).toHaveLength(0);
  });

  /**
   * A tab open since before a version bump must not have its tick recorded
   * against the new text — that would be a signature on a document the user
   * never saw. Rejection-only: never a silent upgrade.
   */
  it('refuses a stale tab with 409 rather than silently upgrading it', async () => {
    const res = await POST(post({ ...VALID, displayed_versions: { tos: 0, privacy: 0 } }));
    expect(res.status).toBe(409);
    expect(inserted).toHaveLength(0);
    expect((await res.json()).current_versions.tos).toBe(CURRENT_LEGAL_VERSIONS.tos.version);
  });

  it('refuses an unknown document type or surface', async () => {
    expect((await POST(post({ ...VALID, document_types: ['cookies'] }))).status).toBe(400);
    expect((await POST(post({ ...VALID, accepted_via: 'carrier_pigeon' }))).status).toBe(400);
    expect(inserted).toHaveLength(0);
  });

  it('refuses a malformed body', async () => {
    const bad = new NextRequest(new URL('/legal/accept', ORIGIN), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
      body: 'not json',
    });
    expect((await POST(bad)).status).toBe(400);
  });
});

describe('POST /legal/accept — company_id is verified, never trusted', () => {
  it('drops a company the caller is not a member of', async () => {
    mockAccessRows.mockReturnValue({ data: [] });
    await POST(post({ ...VALID, company_id: 'not-mine' }));
    expect(inserted[0][0].company_id).toBeNull();
  });

  it('keeps a company the caller really belongs to', async () => {
    mockAccessRows.mockReturnValue({ data: [{ company_id: 'c-1' }] });
    await POST(post({ ...VALID, company_id: 'c-1' }));
    expect(inserted[0][0].company_id).toBe('c-1');
  });
});

describe('isSameOrigin', () => {
  it('accepts same-origin and refuses cross-site', () => {
    const req = (h: Record<string, string>) =>
      new NextRequest(new URL('/legal/accept', ORIGIN), { method: 'POST', headers: h });
    expect(isSameOrigin(req({ 'sec-fetch-site': 'same-origin' }))).toBe(true);
    expect(isSameOrigin(req({ 'sec-fetch-site': 'cross-site' }))).toBe(false);
  });
});
