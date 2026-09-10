/**
 * The chat-first dashboard area: what it shows empty and in a conversation, how
 * one composer reaches one route whatever form the answer takes, what an enqueue
 * refusal looks like, and the History rail behind its one button.
 *
 * Three refusals come back from the routes and only one of them is bad news
 * about the question: 503 is the AI being unavailable (expected downtime,
 * the same state a mid-job outage reaches, so the same quiet notice), 429 is the
 * shop's own hourly cap, 403 is its kill-switch. None of the three is an
 * incident, so none of them reaches Sentry. Anything else is ours and does.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import * as Sentry from '@sentry/nextjs';

import { render, screen, resetRouterMocks, within } from '../../test-utils';
import InsightsChat from '@/components/insights/InsightsChat';
import { ChatEnqueueError } from '@/utils/insightsAccess';

const mockSubmitChatQuery = vi.fn();
const mockListReports = vi.fn();
vi.mock('@/utils/insightsAccess', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/insightsAccess')>();
  return {
    ...actual,
    submitChatQuery: (...a: unknown[]) => mockSubmitChatQuery(...a),
    listReports: (...a: unknown[]) => mockListReports(...a),
  };
});

// Idle unless a test says otherwise: the hook's own behaviour is covered in
// __tests__/hooks/useAiJob.test.ts; here a test hands it a settled row to see
// what the composer makes of one.
const IDLE_JOB = { phase: 'idle', job: null, result: null, message: null, watch: vi.fn(), reset: vi.fn() };
const mockUseAiJob = vi.fn(() => IDLE_JOB);
vi.mock('@/hooks/useAiJob', () => ({
  useAiJob: (...a: unknown[]) => mockUseAiJob(...a),
}));

const mockCreateThread = vi.fn();
const mockListThreadMessages = vi.fn();
const mockListThreads = vi.fn();
const mockListChartTurns = vi.fn();
const mockArchiveThread = vi.fn();
vi.mock('@/utils/aiChatAccess', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/aiChatAccess')>();
  return {
    ...actual,
    createThread: (...a: unknown[]) => mockCreateThread(...a),
    listThreadMessages: (...a: unknown[]) => mockListThreadMessages(...a),
    listThreads: (...a: unknown[]) => mockListThreads(...a),
    listChartTurns: (...a: unknown[]) => mockListChartTurns(...a),
    archiveThread: (...a: unknown[]) => mockArchiveThread(...a),
  };
});
vi.mock('@/components/insights/InsightChart', () => ({ default: () => null }));
// The preview draws a PDF with jsPDF; here it only has to say what it was handed.
vi.mock('@/components/insights/ReportPreviewDialog', () => ({
  default: ({ open, summary }: { open: boolean; summary: { id: string } | null }) =>
    open ? <div data-testid="report-preview">preview of {summary?.id}</div> : null,
}));
vi.mock('posthog-js', () => ({ default: { identify: vi.fn(), capture: vi.fn() } }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));

const turn = (seq: number, question: string, answer: string, extra: Record<string, unknown> = {}) => [
  { id: `m${seq}`, seq, role: 'user', content: question, chart_config: null, report: null, job_id: null, created_at: 'c' },
  { id: `m${seq + 1}`, seq: seq + 1, role: 'assistant', content: answer, chart_config: null, report: null, follow_ups: [], job_id: `job-${seq}`, created_at: 'c', ...extra },
];

async function ask(question: string) {
  const user = userEvent.setup();
  // BY ACCESSIBLE NAME, NOT BY PLACEHOLDER. The placeholder is copy and changes
  // with the state ('Type your question…' empty, 'Ask a follow-up…' in a
  // conversation); aria-label is the contract a screen reader reads and the one
  // thing about this field that must not drift.
  await user.type(screen.getByLabelText('Your question'), question);
  await user.click(screen.getByRole('button', { name: 'Send question' }));
}

beforeEach(() => {
  vi.clearAllMocks();
  resetRouterMocks();
  window.sessionStorage.clear();
  mockCreateThread.mockResolvedValue({ id: 'thread-1', title: 't', created_at: 'c', updated_at: 'u' });
  mockListThreadMessages.mockResolvedValue([]);
  mockListThreads.mockResolvedValue([]);
  mockListReports.mockResolvedValue([]);
  mockListChartTurns.mockResolvedValue([]);
  mockSubmitChatQuery.mockResolvedValue({ job_id: 'job-1', status: 'queued', executor: 'worker' });
  mockUseAiJob.mockReturnValue(IDLE_JOB);
});

describe('InsightsChat — what an enqueue refusal looks like', () => {
  it('renders a 503 as the quiet offline notice, not as an error, and does not page', async () => {
    mockSubmitChatQuery.mockRejectedValue(
      new ChatEnqueueError("Insights are temporarily unavailable right now, so this can't run. Everything else still works.", 503),
    );
    render(<InsightsChat companyId="co-1" />);

    await ask('How many jobs are late?');

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveClass('MuiAlert-standardInfo');
    expect(alert).toHaveTextContent(/still works/);
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it('renders a 429 as an error carrying the shop’s real limit, and does not page', async () => {
    mockSubmitChatQuery.mockRejectedValue(
      new ChatEnqueueError('Rate limit exceeded. Maximum 20 AI chat queries per hour per company.', 429),
    );
    render(<InsightsChat companyId="co-1" />);

    await ask('How many jobs are late?');

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveClass('MuiAlert-standardError');
    expect(alert).toHaveTextContent('Maximum 20');
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it('a 403 kill-switch is an error the shop chose, so it does not page either', async () => {
    mockSubmitChatQuery.mockRejectedValue(new ChatEnqueueError('AI Insights is disabled for this company.', 403));
    render(<InsightsChat companyId="co-1" />);

    await ask('How many jobs are late?');

    expect(await screen.findByRole('alert')).toHaveClass('MuiAlert-standardError');
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it('anything else is ours: rendered as an error AND reported', async () => {
    mockSubmitChatQuery.mockRejectedValue(new TypeError('Failed to fetch'));
    render(<InsightsChat companyId="co-1" />);

    await ask('How many jobs are late?');

    expect(await screen.findByRole('alert')).toHaveClass('MuiAlert-standardError');
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
  });

  it('a 409 (one question at a time) is a plain refusal, not an incident', async () => {
    mockSubmitChatQuery.mockRejectedValue(
      new ChatEnqueueError('Still working on the previous question in this conversation.', 409),
    );
    render(<InsightsChat companyId="co-1" />);

    await ask('and by month?');

    expect(await screen.findByRole('alert')).toHaveTextContent(/Still working/);
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });
});

describe('InsightsChat — the conversation', () => {
  it('gives every starter an icon, and never the wrong one', async () => {
    // The icons ride in a PARALLEL array indexed alongside the prompts, because
    // the prompts must stay a flat literal for api/tests/unit/test_chart_exemplar.py
    // to regex-parse. A parallel array is the cost of that, and this is the guard:
    // one short, and the last starter renders with no icon and no error.
    render(<InsightsChat companyId="co-1" />);

    for (const prompt of ['How many jobs are late right now?', 'What is my revenue trend over time?', 'One-page report on this quarter']) {
      const row = screen.getByRole('button', { name: new RegExp(prompt.replace(/[?]/g, '\\?')) });
      expect(row.querySelector('svg')).not.toBeNull();
    }
  });

  it('opens on one heading and three starters, and no lists', async () => {
    render(<InsightsChat companyId="co-1" />);

    // An offer, not a demand -- and scoped to what this does today, because the
    // agentic work that would widen it does not exist yet.
    expect(screen.getByRole('heading', { name: 'Ask about your shop' })).toBeInTheDocument();
    // One that answers in prose, one that charts, one that comes back as a page.
    expect(screen.getByRole('button', { name: /How many jobs are late right now\?/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /What is my revenue trend over time\?/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /One-page report on this quarter/ })).toBeInTheDocument();
    // Three, not five: the two dropped questions were the weakest of the set.
    expect(screen.queryByText(/quote pipeline/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/top customer/i)).not.toBeInTheDocument();
    // The starters are an option, not the recommended path.
    expect(screen.getByText('Or try one of these')).toBeInTheDocument();
    // One box, no picker: the words decide whether the answer is a page.
    expect(screen.queryByRole('button', { name: 'Report' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Ask' })).toBeNull();
    // Nothing is read for the dashboard's sake: history loads when History opens.
    expect(mockListThreads).not.toHaveBeenCalled();
    expect(mockListReports).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'New conversation' })).toBeNull();
  });

  it('the first question opens a thread titled by the question, and the post carries it', async () => {
    render(<InsightsChat companyId="co-1" />);

    await ask('How many jobs are late?');

    expect(mockCreateThread).toHaveBeenCalledWith('co-1', 'How many jobs are late?');
    expect(mockSubmitChatQuery).toHaveBeenCalledWith('co-1', 'How many jobs are late?', 'thread-1');
    expect(window.sessionStorage.getItem('jigged.aiThread.co-1')).toBe('thread-1');
  });

  it('a remembered thread renders oldest first, the heading gives way, and the composer asks for a follow-up', async () => {
    window.sessionStorage.setItem('jigged.aiThread.co-1', 'thread-9');
    mockListThreadMessages.mockResolvedValue([
      ...turn(1, 'How many jobs are late?', 'Four jobs are late.'),
      ...turn(3, 'Which customers?', 'Ironclad and Cascade.'),
    ]);
    render(<InsightsChat companyId="co-1" />);

    expect(await screen.findByText('Ironclad and Cascade.')).toBeInTheDocument();
    const answers = screen.getAllByText(/late\.|Cascade\./).map((el) => el.textContent);
    expect(answers).toEqual(['Four jobs are late.', 'Ironclad and Cascade.']);
    expect(screen.queryByRole('heading', { name: /What do you want to know/ })).toBeNull();
    expect(screen.getByPlaceholderText('Ask a follow-up…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New conversation' })).toBeInTheDocument();

    await ask('and by month?');

    expect(mockCreateThread).not.toHaveBeenCalled();
    expect(mockSubmitChatQuery).toHaveBeenCalledWith('co-1', 'and by month?', 'thread-9');
    const posthog = (await import('posthog-js')).default;
    // Exact: nothing about the answer's eventual form leaves at enqueue, because
    // nothing is known about it yet.
    expect(posthog.capture).toHaveBeenCalledWith('ai job enqueued', {
      feature: 'insights',
      executor: 'worker',
      from_example: false,
      from_suggestion: false,
      turn_index: 2,
    });
  });

  it('a thread the route no longer knows is forgotten, so the next question starts fresh', async () => {
    window.sessionStorage.setItem('jigged.aiThread.co-1', 'thread-gone');
    mockSubmitChatQuery.mockRejectedValueOnce(
      new ChatEnqueueError("That conversation isn't available any more. Start a new one.", 404),
    );
    render(<InsightsChat companyId="co-1" />);

    await ask('and by month?');

    expect(await screen.findByRole('alert')).toHaveTextContent(/Start a new one/);
    expect(window.sessionStorage.getItem('jigged.aiThread.co-1')).toBeNull();
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });
});

describe('InsightsChat — the surface says what it is', () => {
  it('says no caveat before there is an answer, and says one after', async () => {
    render(<InsightsChat companyId="co-1" />);

    // NOT ON THE EMPTY PAGE. A warning about mistakes shown to someone who has
    // not yet done anything was the most off-putting thing on this surface. The
    // prior reasoning -- "a caveat that only appears on an empty page is a caveat
    // nobody reads" -- was about it PERSISTING into the conversation, which it
    // still does; this is the other half of that sentence.
    expect(screen.queryByText(/check the numbers before you act/)).not.toBeInTheDocument();
    expect(screen.queryByText(/can make mistakes/i)).not.toBeInTheDocument();
    // What stands in its place invites rather than warns, and every noun in it is
    // something schema_context.py actually describes.
    expect(
      screen.getByText('Ask about your jobs, quotes, parts, customers, vendors and work centers.'),
    ).toBeInTheDocument();
    // NO TITLE, NO BETA PILL. Both were tried and both were clutter.
    expect(screen.queryByText('Ask the shop')).not.toBeInTheDocument();
    expect(screen.queryByText('BETA')).not.toBeInTheDocument();

    // Once an answer exists it is said under the composer, on every turn.
    window.sessionStorage.setItem('jigged.aiThread.co-1', 'thread-9');
    mockListThreadMessages.mockResolvedValue(turn(1, 'how many open quotes?', 'Six.'));
    render(<InsightsChat companyId="co-1" />);

    expect(await screen.findByText('Six.')).toBeInTheDocument();
    // Names the failure this system actually has -- reading a business term the
    // owner's way -- rather than asking for distrust it gives no way to act on.
    expect(screen.getAllByText(/check the numbers before you act/).length).toBeGreaterThan(0);
  });

  it('offers starting over as the primary action, not the quiet one', async () => {
    // Starting over is what people reach for when an answer went wrong, and as a
    // text button beside an outlined History it read as the lesser of the two.
    window.sessionStorage.setItem('jigged.aiThread.co-1', 'thread-9');
    mockListThreadMessages.mockResolvedValue(turn(1, 'how many open quotes?', 'Six.'));
    render(<InsightsChat companyId="co-1" />);

    const newChat = await screen.findByRole('button', { name: /New conversation/ });
    expect(newChat.className).toMatch(/MuiButton-contained/);
    expect(screen.getByRole('button', { name: 'Chat history' }).className).toMatch(
      /MuiButton-outlined/,
    );
  });

  it('names no hardware while it is working — the wait says what it is doing, not where', async () => {
    mockUseAiJob.mockReturnValue({ ...IDLE_JOB, phase: 'pending' });
    render(<InsightsChat companyId="co-1" />);

    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent(/Reading your shop data|Working out the answer|Still going/);
    // The rotation, the offline copy and the report copy are all held to this.
    expect(status.textContent).not.toMatch(/\b(box|Mac|laptop|desktop|machine|server)\b/i);
  });
});

describe('InsightsChat — what to ask next', () => {
  it('offers the model\'s follow-ups on the newest turn, and asks one on a click', async () => {
    const user = userEvent.setup();
    window.sessionStorage.setItem('jigged.aiThread.co-1', 'thread-9');
    mockListThreadMessages.mockResolvedValue([
      ...turn(1, 'how many open quotes?', 'Six.', { follow_ups: ['stale one'] }),
      ...turn(3, 'and last month?', 'Nine.', { follow_ups: ['What are they worth?'] }),
    ]);
    render(<InsightsChat companyId="co-1" />);

    expect(await screen.findByText('What are they worth?')).toBeInTheDocument();
    // NEWEST TURN ONLY. A suggestion under an answer three exchanges back invites
    // you to lose your place in the conversation you are actually having.
    expect(screen.queryByText('stale one')).not.toBeInTheDocument();

    await user.click(screen.getByText('What are they worth?'));

    expect(mockSubmitChatQuery).toHaveBeenCalledWith('co-1', 'What are they worth?', 'thread-9');
    const posthog = (await import('posthog-js')).default;
    expect(posthog.capture).toHaveBeenCalledWith('ai job enqueued', {
      feature: 'insights',
      executor: 'worker',
      from_example: false,
      from_suggestion: true,
      turn_index: 2,
    });
  });

  it('offers nothing when the model offered nothing — no empty rail, no placeholder', async () => {
    window.sessionStorage.setItem('jigged.aiThread.co-1', 'thread-9');
    mockListThreadMessages.mockResolvedValue(turn(1, 'how many open quotes?', 'Six.'));
    render(<InsightsChat companyId="co-1" />);

    expect(await screen.findByText('Six.')).toBeInTheDocument();
    expect(screen.queryByText('TRY NEXT')).not.toBeInTheDocument();
  });
});

describe('InsightsChat — a report is an answer, not a mode', () => {
  it('a report chip goes through the one door like a question; the model decides the form', async () => {
    const user = userEvent.setup();
    render(<InsightsChat companyId="co-1" />);

    await user.click(screen.getByRole('button', { name: /One-page report on this quarter/ }));

    expect(mockCreateThread).toHaveBeenCalledWith('co-1', 'One-page report on this quarter');
    expect(mockSubmitChatQuery).toHaveBeenCalledWith('co-1', 'One-page report on this quarter', 'thread-1');
    const posthog = (await import('posthog-js')).default;
    expect(posthog.capture).toHaveBeenCalledWith('ai job enqueued', {
      feature: 'insights',
      executor: 'worker',
      from_example: true,
      from_suggestion: false,
      turn_index: 0,
    });
  });

  it('a settled job the model turned into a report fires `report generated`, not `ai job settled`', async () => {
    const spec = {
      title: 'Backlog and late jobs', period_start: '2026-09-08', period_end: '2026-09-08', period_label: 'As of today',
      headline: '7 late jobs.', kpis: [{ label: 'Late', value: 7, format: 'integer', caption: null }],
      blocks: [{ type: 'text', body: 'Steady.' }],
    };
    const job = {
      id: 'job-9', status: 'succeeded', executor: 'worker', model: 'qwen3:32b', kind: 'report',
      result: { kind: 'report', report: spec, dropped: [], tool_calls: ['execute_sql', 'execute_sql'] },
      error: null, error_kind: null, created_at: 'c', expires_at: null, lease_expires_at: null, batch_key: null,
    };
    mockUseAiJob.mockReturnValue({ phase: 'done', job, result: null, message: null, watch: vi.fn(), reset: vi.fn() });
    render(<InsightsChat companyId="co-1" />);

    const posthog = (await import('posthog-js')).default;
    expect(posthog.capture).toHaveBeenCalledWith(
      'report generated',
      expect.objectContaining({ phase: 'done', kpi_count: 1, block_count: 1, table_count: 0, has_text_block: true, tool_call_count: 2 }),
    );
    expect(posthog.capture).not.toHaveBeenCalledWith('ai job settled', expect.anything());
  });

  it('a report turn shows the page it produced and opens the preview from the thread', async () => {
    window.sessionStorage.setItem('jigged.aiThread.co-1', 'thread-9');
    const spec = {
      title: 'Operations summary', period_start: '2026-07-01', period_end: '2026-09-30', period_label: 'Q3',
      headline: '26 jobs started, 16 shipped.', kpis: [{ label: 'Late', value: 7, format: 'integer', caption: null }],
      blocks: [{ type: 'text', body: 'Steady.' }],
    };
    mockListThreadMessages.mockResolvedValue(
      turn(1, 'Put that in a PDF', '26 jobs started, 16 shipped.', {
        report: { report: spec, dropped: ['Flat chart'], tool_call_count: 5 },
        job_id: 'job-r1',
      }),
    );
    render(<InsightsChat companyId="co-1" />);

    expect(await screen.findByText('Operations summary')).toBeInTheDocument();
    expect(screen.getByText(/Q3 · 1 KPIs · 1 blocks · not shown: Flat chart/)).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Open report' }));
    expect(screen.getByTestId('report-preview')).toHaveTextContent('preview of job-r1');
  });
});

describe('InsightsChat — the History rail', () => {
  it('opens on Chats, lists the conversations only then, and switches to one', async () => {
    window.sessionStorage.setItem('jigged.aiThread.co-1', 'thread-9');
    mockListThreads.mockResolvedValue([
      { id: 'thread-9', title: 'Late jobs and customers', created_at: 'c', updated_at: '2026-09-08T10:00:00Z' },
      { id: 'thread-2', title: 'Booked by month', created_at: 'c', updated_at: '2026-09-07T10:00:00Z' },
    ]);
    const user = userEvent.setup();
    render(<InsightsChat companyId="co-1" />);
    expect(mockListThreads).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Chat history' }));
    const rail = await screen.findByRole('list', { name: 'Conversations' });
    expect(within(rail).getByText('Booked by month')).toBeInTheDocument();
    const posthog = (await import('posthog-js')).default;
    expect(posthog.capture).toHaveBeenCalledWith('insights history opened', { tab: 'chats' });

    await user.click(within(rail).getByText('Booked by month'));
    expect(window.sessionStorage.getItem('jigged.aiThread.co-1')).toBe('thread-2');
  });

  it('the Reports tab lists past reports and opens one in the preview', async () => {
    mockListReports.mockResolvedValue([
      {
        id: 'job-r7', created_at: '2026-09-08T10:00:00Z', dropped: [], tool_call_count: 3,
        report: { title: 'Backlog and late jobs', period_start: '2026-09-08', period_end: '2026-09-08', period_label: 'As of today', headline: 'h', kpis: [], blocks: [{ type: 'text', body: 'x' }] },
      },
    ]);
    const user = userEvent.setup();
    render(<InsightsChat companyId="co-1" />);

    await user.click(screen.getByRole('button', { name: 'Chat history' }));
    await user.click(await screen.findByRole('tab', { name: 'Reports' }));
    const list = await screen.findByRole('list', { name: 'Reports' });
    await user.click(within(list).getByText('Backlog and late jobs'));

    expect(screen.getByTestId('report-preview')).toHaveTextContent('preview of job-r7');
  });

  it('the Charts tab is a filter over answered turns, and a chart opens its conversation', async () => {
    mockListChartTurns.mockResolvedValue([
      {
        id: 'm4', thread_id: 'thread-2', thread_title: 'Booked by month', answer: 'a', created_at: '2026-09-08T10:00:00Z',
        chart_config: { chart_type: 'area', x_key: 'm', y_key: 'v', x_label: 'Month', y_label: 'Booked', data: [{ m: '2026-06-01', v: 1 }] },
      },
    ]);
    const user = userEvent.setup();
    render(<InsightsChat companyId="co-1" />);

    await user.click(screen.getByRole('button', { name: 'Chat history' }));
    await user.click(await screen.findByRole('tab', { name: 'Charts' }));
    const list = await screen.findByRole('list', { name: 'Charts' });
    expect(within(list).getByText(/Trend · Sep 8/)).toBeInTheDocument();
    await user.click(within(list).getByText('Booked by month'));

    expect(window.sessionStorage.getItem('jigged.aiThread.co-1')).toBe('thread-2');
  });

  it('archiving the current conversation from the rail starts a fresh one', async () => {
    window.sessionStorage.setItem('jigged.aiThread.co-1', 'thread-9');
    mockListThreads.mockResolvedValue([
      { id: 'thread-9', title: 'Late jobs and customers', created_at: 'c', updated_at: '2026-09-08T10:00:00Z' },
    ]);
    mockArchiveThread.mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<InsightsChat companyId="co-1" />);

    await user.click(screen.getByRole('button', { name: 'Chat history' }));
    await user.click(await screen.findByRole('button', { name: 'Archive "Late jobs and customers"' }));

    expect(mockArchiveThread).toHaveBeenCalledWith('thread-9');
    expect(window.sessionStorage.getItem('jigged.aiThread.co-1')).toBeNull();
  });
});
