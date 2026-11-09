/**
 * Feedback's access layer (utils/feedbackAccess.ts): the id is minted in the browser — a
 * non-admin cannot read their own feedback back — and the email goes with the person's own
 * session, filing any failure to Sentry instead of failing feedback that is already saved.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { insert, getSession } = vi.hoisted(() => ({ insert: vi.fn(), getSession: vi.fn() }));

vi.mock('@/lib/supabase', () => ({
  getSupabase: () => ({ from: () => ({ insert }), auth: { getSession } }),
  getEdgeFunctionUrl: (name: string) => `https://project.supabase.co/functions/v1/${name}`,
}));

const captureException = vi.fn();
vi.mock('@sentry/nextjs', () => ({ captureException: (...args: unknown[]) => captureException(...args) }));

import { createFeedback, notifyFeedback } from '@/utils/feedbackAccess';

const INPUT = {
  company_id: 'company-1',
  user_id: 'user-1',
  page_path: '/dashboard/company-1/jobs',
  page_title: 'Jobs',
  feedback_text: 'The jobs list is great',
};

const fetchMock = vi.fn();

beforeEach(() => {
  insert.mockReset();
  getSession.mockReset();
  captureException.mockReset();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  getSession.mockResolvedValue({ data: { session: { access_token: 'user-jwt' } } });
});

afterEach(() => vi.unstubAllGlobals());

describe('createFeedback', () => {
  it('inserts with an id it minted and returns that id', async () => {
    insert.mockResolvedValue({ error: null });
    const id = await createFeedback(INPUT);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(insert).toHaveBeenCalledWith({ ...INPUT, id });
  });

  it('throws when the insert fails', async () => {
    insert.mockResolvedValue({ error: { message: 'denied' } });
    await expect(createFeedback(INPUT)).rejects.toEqual({ message: 'denied' });
  });
});

describe('notifyFeedback', () => {
  it('posts the id to notify-feedback with the session as bearer', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));
    await notifyFeedback('fb-1');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://project.supabase.co/functions/v1/notify-feedback');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer user-jwt' });
    expect(JSON.parse(init.body)).toEqual({ feedback_id: 'fb-1' });
    expect(captureException).not.toHaveBeenCalled();
  });

  it('files a failed send to Sentry without throwing', async () => {
    fetchMock.mockResolvedValue(new Response('{"error":"Email send failed"}', { status: 502 }));
    await expect(notifyFeedback('fb-1')).resolves.toBeUndefined();
    expect(captureException).toHaveBeenCalledTimes(1);
    expect(String(captureException.mock.calls[0][0])).toContain('502');
  });

  it('files a missing session to Sentry and calls nothing', async () => {
    getSession.mockResolvedValue({ data: { session: null } });
    await notifyFeedback('fb-1');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(captureException).toHaveBeenCalledTimes(1);
  });
});
