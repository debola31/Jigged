/**
 * notifyWaitlist (lib/waitlistServer.ts): the secret key goes on `apikey` — Supabase refuses an
 * sb_secret_ key as a bearer token — and a failed email files to Sentry instead of throwing into a
 * sign-up that is already saved.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const captureException = vi.fn();
vi.mock('@sentry/nextjs', () => ({ captureException: (...args: unknown[]) => captureException(...args) }));

import { notifyWaitlist } from '@/lib/waitlistServer';

const RECORD = {
  email: 'owner@shop.example',
  name: 'Pat',
  company_name: 'Acme Machining',
  shop_size: null,
  source: 'showcase_pilot',
  created_at: '2026-11-09T19:12:23Z',
};

const fetchMock = vi.fn();

beforeEach(() => {
  captureException.mockReset();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://project.supabase.co');
  vi.stubEnv('SUPABASE_SECRET_KEY', 'sb_secret_test');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('notifyWaitlist', () => {
  it('posts the record to notify-waitlist with the secret key on apikey', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));
    await notifyWaitlist(RECORD);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://project.supabase.co/functions/v1/notify-waitlist');
    expect(init.headers).toMatchObject({ apikey: 'sb_secret_test' });
    expect(init.headers).not.toHaveProperty('Authorization');
    expect(JSON.parse(init.body)).toEqual({ record: RECORD });
    expect(captureException).not.toHaveBeenCalled();
  });

  it('files a refused call to Sentry, tagged by source and without the address', async () => {
    fetchMock.mockResolvedValue(new Response('{"error":"Unauthorized"}', { status: 401 }));
    await expect(notifyWaitlist(RECORD)).resolves.toBeUndefined();

    expect(captureException).toHaveBeenCalledTimes(1);
    const [error, context] = captureException.mock.calls[0];
    expect(String(error)).toContain('401');
    expect(context.tags).toEqual({ waitlist: 'notify_failed', waitlist_source: 'showcase_pilot' });
    expect(JSON.stringify(context)).not.toContain(RECORD.email);
  });

  it('files a network failure to Sentry without throwing', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    await expect(notifyWaitlist(RECORD)).resolves.toBeUndefined();
    expect(captureException).toHaveBeenCalledTimes(1);
  });

  it('files missing credentials to Sentry and calls nothing', async () => {
    vi.stubEnv('SUPABASE_SECRET_KEY', '');
    await notifyWaitlist(RECORD);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(captureException).toHaveBeenCalledTimes(1);
  });
});
