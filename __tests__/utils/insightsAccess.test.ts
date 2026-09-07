/**
 * The enqueue call's failure shape.
 *
 * The backend's `detail` is the sentence the user reads, verbatim -- the real
 * rate-limit number on 429, the kill-switch text on 403, the offline sentence on
 * 503. What the ask bar must NOT do is decide how to render it by matching that
 * prose, so the error carries the HTTP status alongside and the component
 * branches on the number. These tests pin the carrier.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGetSession } = vi.hoisted(() => ({ mockGetSession: vi.fn() }));

vi.mock('@/lib/supabase', () => ({
  getSupabase: () => ({ auth: { getSession: mockGetSession } }),
}));
vi.mock('@/lib/api', () => ({ API_BASE_URL: 'http://api.test' }));

import { ChatEnqueueError, submitChatQuery } from '@/utils/insightsAccess';

function response(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

describe('submitChatQuery', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue({ data: { session: { access_token: 'tok' } } });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('posts the question with the caller’s local date and returns the job handle', async () => {
    fetchMock.mockResolvedValue(
      response(202, { job_id: 'job-1', status: 'queued', executor: 'worker' }),
    );

    const enqueued = await submitChatQuery('co-1', 'How many jobs are late?');

    expect(enqueued).toEqual({ job_id: 'job-1', status: 'queued', executor: 'worker' });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://api.test/api/insights/co-1/chat');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    const body = JSON.parse(init.body as string);
    expect(body.question).toBe('How many jobs are late?');
    expect(body.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('a 503 carries its status, so the ask bar can show downtime as downtime', async () => {
    // The sentence is the backend's, verbatim. The STATUS is what the component
    // branches on -- before this class existed it matched /offline/ in the prose.
    fetchMock.mockResolvedValue(
      response(503, {
        detail: "The AI box is offline right now, so this can't run. Everything else still works.",
      }),
    );

    const err = await submitChatQuery('co-1', 'q').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ChatEnqueueError);
    expect((err as ChatEnqueueError).status).toBe(503);
    expect((err as ChatEnqueueError).message).toMatch(/still works/);
  });

  it('a 429 keeps the shop’s real limit in the sentence and the status alongside', async () => {
    fetchMock.mockResolvedValue(
      response(429, { detail: 'Rate limit exceeded. Maximum 20 AI chat queries per hour per company.' }),
    );

    const err = await submitChatQuery('co-1', 'q').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ChatEnqueueError);
    expect((err as ChatEnqueueError).status).toBe(429);
    expect((err as ChatEnqueueError).message).toContain('Maximum 20');
  });

  it('a body that is not JSON still yields a typed error carrying the status', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => {
        throw new Error('not json');
      },
    } as unknown as Response);

    const err = await submitChatQuery('co-1', 'q').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ChatEnqueueError);
    expect((err as ChatEnqueueError).status).toBe(500);
    expect((err as ChatEnqueueError).message).toBe('Failed to submit chat query (500)');
  });
});
