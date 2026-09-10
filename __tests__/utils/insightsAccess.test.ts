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

const { mockGetSession, mockFrom } = vi.hoisted(() => ({ mockGetSession: vi.fn(), mockFrom: vi.fn() }));

vi.mock('@/lib/supabase', () => ({
  getSupabase: () => ({ auth: { getSession: mockGetSession }, from: mockFrom }),
}));

function queryStub(data: unknown) {
  const builder: Record<string, unknown> = {};
  ['select', 'eq', 'order', 'limit'].forEach((m) => {
    builder[m] = vi.fn().mockImplementation(() => builder);
  });
  builder.data = data;
  builder.error = null;
  return builder as Record<string, ReturnType<typeof vi.fn>> & { data: unknown; error: unknown };
}
vi.mock('@/lib/api', () => ({ API_BASE_URL: 'http://api.test' }));

import {
  askedQuestionOf,
  ChatEnqueueError,
  chatResultOf,
  listReports,
  reportResultOf,
  submitChatQuery,
  type AiJob,
} from '@/utils/insightsAccess';

function response(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

describe('askedQuestionOf', () => {
  // The question a job is working on, read off the job rather than stashed beside
  // it: a copy in storage is a second source of truth that can disagree with the
  // job it labels, and ai_chat_messages cannot answer mid-flight because the
  // trigger writes both turns only when the job succeeds.
  const job = (payload: unknown) => ({ payload }) as Parameters<typeof askedQuestionOf>[0];

  it('reads the chat door\'s question and the report door\'s request', () => {
    expect(askedQuestionOf(job({ question: 'how many jobs are late?' }))).toBe('how many jobs are late?');
    expect(askedQuestionOf(job({ request: 'one-page report on this quarter' }))).toBe('one-page report on this quarter');
  });

  it('returns null rather than a value the UI would render as text', () => {
    // A job from an older shape must degrade to "no echo", never to `undefined`
    // printed at the reader.
    expect(askedQuestionOf(null)).toBeNull();
    expect(askedQuestionOf(job(null))).toBeNull();
    expect(askedQuestionOf(job('a string'))).toBeNull();
    expect(askedQuestionOf(job([{ question: 'x' }]))).toBeNull();
    expect(askedQuestionOf(job({ question: 42 }))).toBeNull();
    expect(askedQuestionOf(job({ question: '   ' }))).toBeNull();
    expect(askedQuestionOf(job({}))).toBeNull();
  });
});

describe('chatResultOf', () => {
  const job = (result: unknown): AiJob => ({
    id: 'j', status: 'succeeded', executor: 'worker', model: 'qwen3:32b', result: result as AiJob['result'],
    error: null, error_kind: null, created_at: 'c', expires_at: null, lease_expires_at: null, batch_key: null, kind: 'chat',
  });

  it('narrows the off-topic flag to a boolean and defaults it off', () => {
    expect(chatResultOf(job({ answer: 'I can only answer questions about this shop.', off_topic: true }))?.off_topic).toBe(true);
    expect(chatResultOf(job({ answer: 'Four.' }))?.off_topic).toBe(false);
    expect(chatResultOf(job({ answer: 'Four.', off_topic: 'yes' }))?.off_topic).toBe(false);
  });

  it('a result without an answer is no result', () => {
    expect(chatResultOf(job({ chart_config: null }))).toBeNull();
  });
});

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
    expect('thread_id' in body).toBe(false);
  });

  it('carries the conversation id when the question continues one', async () => {
    fetchMock.mockResolvedValue(
      response(202, { job_id: 'job-2', status: 'queued', executor: 'worker' }),
    );

    await submitChatQuery('co-1', 'and by month?', 'thread-1');

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string).thread_id).toBe('thread-1');
  });

  it('a 503 carries its status, so the ask bar can show downtime as downtime', async () => {
    // The sentence is the backend's, verbatim. The STATUS is what the component
    // branches on -- before this class existed it matched /offline/ in the prose.
    fetchMock.mockResolvedValue(
      response(503, {
        detail: "Insights are temporarily unavailable right now, so this can't run. Everything else still works.",
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

describe('listReports / reportResultOf', () => {
  const job = (result: unknown, id = 'j'): AiJob => ({
    id, status: 'succeeded', executor: 'worker', model: 'qwen3:32b', result: result as AiJob['result'],
    error: null, error_kind: null, created_at: 'c', expires_at: null, lease_expires_at: null, batch_key: null, kind: 'chat',
  });

  it('reads only succeeded report jobs for the shop, newest first', async () => {
    const q = queryStub([
      { id: 'j1', created_at: 'c1', result: { report: { title: 'A' }, dropped: ['Flat'], tool_calls: ['execute_sql', 'execute_sql'] } },
      { id: 'j2', created_at: 'c2', result: { answer: 'not a report' } },
    ]);
    mockFrom.mockReturnValue(q);

    const reports = await listReports('co-1');

    expect(mockFrom).toHaveBeenCalledWith('ai_jobs');
    expect(q.eq).toHaveBeenCalledWith('company_id', 'co-1');
    expect(q.eq).toHaveBeenCalledWith('kind', 'report');
    expect(q.eq).toHaveBeenCalledWith('status', 'succeeded');
    expect(q.order).toHaveBeenCalledWith('created_at', { ascending: false });
    // A row with no report on it is left out rather than listed as one that cannot open.
    expect(reports).toEqual([{ id: 'j1', created_at: 'c1', report: { title: 'A' }, dropped: ['Flat'], tool_call_count: 2 }]);
  });

  it('narrows a settled job to its report, or null', () => {
    expect(reportResultOf(job({ report: { title: 'A' } }))?.report).toEqual({ title: 'A' });
    expect(reportResultOf(job({ report: { title: 'A' } }))?.dropped).toEqual([]);
    expect(reportResultOf(job({ answer: 'Four.' }))).toBeNull();
    expect(reportResultOf(null)).toBeNull();
  });
});
