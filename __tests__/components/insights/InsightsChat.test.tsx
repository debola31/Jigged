/**
 * The chat-first dashboard area: what it shows empty and in a conversation, how
 * the two composer verbs (Ask, Report) reach the two routes, what an enqueue
 * refusal looks like, and the History rail behind its one button.
 *
 * Three refusals come back from the routes and only one of them is bad news
 * about the question: 503 is the shop's AI box being off (expected downtime,
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
const mockSubmitReportRequest = vi.fn();
const mockListReports = vi.fn();
vi.mock('@/utils/insightsAccess', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/insightsAccess')>();
  return {
    ...actual,
    submitChatQuery: (...a: unknown[]) => mockSubmitChatQuery(...a),
    submitReportRequest: (...a: unknown[]) => mockSubmitReportRequest(...a),
    listReports: (...a: unknown[]) => mockListReports(...a),
  };
});

// Idle throughout: these tests never get a job row, so the hook's own behaviour
// (covered in __tests__/hooks/useAiJob.test.ts) is out of the picture.
vi.mock('@/hooks/useAiJob', () => ({
  useAiJob: () => ({
    phase: 'idle',
    job: null,
    result: null,
    message: null,
    watch: vi.fn(),
    reset: vi.fn(),
  }),
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
  { id: `m${seq + 1}`, seq: seq + 1, role: 'assistant', content: answer, chart_config: null, report: null, job_id: `job-${seq}`, created_at: 'c', ...extra },
];

async function ask(question: string) {
  const user = userEvent.setup();
  // The placeholder changes once a conversation exists ('Ask a follow-up…').
  await user.type(screen.getByPlaceholderText(/^Ask /), question);
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
  mockSubmitReportRequest.mockResolvedValue({ job_id: 'job-r', status: 'queued', executor: 'worker' });
});

describe('InsightsChat — what an enqueue refusal looks like', () => {
  it('renders a 503 as the quiet offline notice, not as an error, and does not page', async () => {
    mockSubmitChatQuery.mockRejectedValue(
      new ChatEnqueueError("The AI box is offline right now, so this can't run. Everything else still works.", 503),
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
  it('opens on one centred question with example chips, and no lists', async () => {
    render(<InsightsChat companyId="co-1" />);

    expect(screen.getByRole('heading', { name: 'What do you want to know about the shop?' })).toBeInTheDocument();
    expect(screen.getByText('What is my revenue trend over time?')).toBeInTheDocument();
    expect(screen.getByText('One-page summary of this quarter')).toBeInTheDocument();
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
    expect(posthog.capture).toHaveBeenCalledWith(
      'ai job enqueued',
      expect.objectContaining({ feature: 'insights', turn_index: 2, from_example: false, kind: 'ask' }),
    );
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

describe('InsightsChat — Report is the composer’s second verb', () => {
  it('in Report mode the request goes to the report route, in the same thread, and the event says so', async () => {
    const user = userEvent.setup();
    render(<InsightsChat companyId="co-1" />);

    await user.click(screen.getByRole('button', { name: 'Report' }));
    expect(screen.getByRole('heading', { name: 'What should the one-page summary cover?' })).toBeInTheDocument();
    await user.type(screen.getByPlaceholderText('Describe the one-page summary you want…'), 'Summary of the quarter');
    await user.click(screen.getByRole('button', { name: 'Request report' }));

    expect(mockCreateThread).toHaveBeenCalledWith('co-1', 'Summary of the quarter');
    expect(mockSubmitReportRequest).toHaveBeenCalledWith('co-1', 'Summary of the quarter', 'thread-1');
    expect(mockSubmitChatQuery).not.toHaveBeenCalled();
    const posthog = (await import('posthog-js')).default;
    expect(posthog.capture).toHaveBeenCalledWith('ai job enqueued', expect.objectContaining({ kind: 'report', from_example: false }));
  });

  it('a report chip switches the verb and sends', async () => {
    const user = userEvent.setup();
    render(<InsightsChat companyId="co-1" />);

    await user.click(screen.getByText('Backlog and late jobs right now'));

    expect(mockSubmitReportRequest).toHaveBeenCalledWith('co-1', 'Backlog and late jobs right now', 'thread-1');
    const posthog = (await import('posthog-js')).default;
    expect(posthog.capture).toHaveBeenCalledWith('ai job enqueued', expect.objectContaining({ kind: 'report', from_example: true }));
  });

  it('a report turn shows the page it produced and opens the preview from the thread', async () => {
    window.sessionStorage.setItem('jigged.aiThread.co-1', 'thread-9');
    const spec = {
      title: 'Operations summary', period_start: '2026-07-01', period_end: '2026-09-30', period_label: 'Q3',
      headline: '26 jobs started, 16 shipped.', kpis: [{ label: 'Late', value: 7, format: 'integer', caption: null }],
      blocks: [{ type: 'text', body: 'Steady.' }],
    };
    mockListThreadMessages.mockResolvedValue(
      turn(1, 'Summary of the quarter', '26 jobs started, 16 shipped.', {
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

    await user.click(screen.getByRole('button', { name: 'History' }));
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

    await user.click(screen.getByRole('button', { name: 'History' }));
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

    await user.click(screen.getByRole('button', { name: 'History' }));
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

    await user.click(screen.getByRole('button', { name: 'History' }));
    await user.click(await screen.findByRole('button', { name: 'Archive "Late jobs and customers"' }));

    expect(mockArchiveThread).toHaveBeenCalledWith('thread-9');
    expect(window.sessionStorage.getItem('jigged.aiThread.co-1')).toBeNull();
  });
});
