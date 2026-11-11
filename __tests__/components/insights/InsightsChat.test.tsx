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
import posthog from 'posthog-js';

import { render, screen, resetRouterMocks, within } from '../../test-utils';
import InsightsChat from '@/components/insights/InsightsChat';
import { ChatEnqueueError } from '@/utils/insightsAccess';
import { toFriendlyError } from '@/lib/supabaseErrors';
import type { useSubscription } from '@/components/providers/SubscriptionProvider';

type Subscription = ReturnType<typeof useSubscription>;
let subscriptionStub: Subscription;
let roleStub = { isAdmin: true, loading: false };
vi.mock('@/components/providers/SubscriptionProvider', () => ({
  useSubscription: () => subscriptionStub,
  useOptionalSubscription: () => subscriptionStub,
}));
vi.mock('@/hooks/useUserRole', () => ({ useUserRole: () => roleStub }));
const mockStartCheckout = vi.fn();
const mockOpenBillingPortal = vi.fn();
vi.mock('@/lib/billingApi', () => ({
  startCheckout: (...args: unknown[]) => mockStartCheckout(...args),
  openBillingPortal: (...args: unknown[]) => mockOpenBillingPortal(...args),
}));

const mockPrepareChatUpload = vi.fn();
const mockUploadChatFiles = vi.fn();
vi.mock('@/utils/chatUploadsAccess', () => ({
  prepareChatUpload: (...args: unknown[]) => mockPrepareChatUpload(...args),
  uploadChatFiles: (...args: unknown[]) => mockUploadChatFiles(...args),
}));

const mockSubmitChatQuery = vi.fn();
const mockListReports = vi.fn();
const mockGetPendingActions = vi.fn();
const mockDecideChatAction = vi.fn();
vi.mock('@/utils/insightsAccess', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/insightsAccess')>();
  return {
    ...actual,
    submitChatQuery: (...a: unknown[]) => mockSubmitChatQuery(...a),
    listReports: (...a: unknown[]) => mockListReports(...a),
    getPendingActions: (...a: unknown[]) => mockGetPendingActions(...a),
    decideChatAction: (...a: unknown[]) => mockDecideChatAction(...a),
  };
});

// Nothing always-allowed unless a test says otherwise.
const mockListChatActionGrants = vi.fn();
vi.mock('@/utils/chatActionGrantsAccess', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/chatActionGrantsAccess')>();
  return {
    ...actual,
    listChatActionGrants: (...a: unknown[]) => mockListChatActionGrants(...a),
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
  subscriptionStub = {
    entitlement: 'full', billing: null, isDemo: false, isPastDue: false,
    isReadOnly: false, mustSubscribe: false, canWrite: true, hasCustomer: false,
    isLoading: false, refresh: vi.fn().mockResolvedValue(undefined),
  };
  roleStub = { isAdmin: true, loading: false };
  mockCreateThread.mockResolvedValue({ id: 'thread-1', title: 't', created_at: 'c', updated_at: 'u' });
  mockListThreadMessages.mockResolvedValue([]);
  mockListThreads.mockResolvedValue([]);
  mockListReports.mockResolvedValue([]);
  mockGetPendingActions.mockResolvedValue([]);
  mockListChatActionGrants.mockResolvedValue([]);
  mockListChartTurns.mockResolvedValue([]);
  mockSubmitChatQuery.mockResolvedValue({ job_id: 'job-1', status: 'queued', executor: 'worker' });
  mockUseAiJob.mockReturnValue(IDLE_JOB);
  mockPrepareChatUpload.mockResolvedValue({ id: 'upload-1', name: 'parts.zip', rows: [{}] });
  mockUploadChatFiles.mockResolvedValue({
    id: 'upload-1', name: 'parts.zip', manifest_path: 'private/manifest.json',
    part_count: 1, file_count: 3, summary: 'drawing fields',
  });
});

function blockSubscription(status: 'canceled' | 'paused' | null = null) {
  subscriptionStub = {
    ...subscriptionStub, canWrite: false, entitlement: status ? 'read_only' : 'must_subscribe',
    isReadOnly: !!status, mustSubscribe: !status, hasCustomer: !!status,
    billing: status ? {
      company_id: 'co-1', canceled_at: null, trial_end: null,
      billing_exempt: false, subscription_status: status, current_period_end: null,
      cancel_at: null, ended_at: null, stripe_customer_id: 'cus-shop',
      stripe_subscription_id: 'sub-shop', subscription_price_id: null,
    } : null,
  };
}

describe('InsightsChat — subscription access', () => {
  it.each([
    [null, /start your subscription/i, 'Start subscription'],
    ['canceled', /has ended.*reactivate/i, 'Manage subscription'],
    ['paused', /is paused.*resume/i, 'Manage subscription'],
  ] as const)('explains %s before typing and offers the admin a billing action', (status, message, label) => {
    blockSubscription(status);
    render(<InsightsChat companyId="co-1" />);
    const notice = screen.getByRole('region', { name: 'Chat subscription' });
    expect(notice).toHaveTextContent(message);
    expect(within(notice).getByRole('button', { name: label })).toBeEnabled();
    expect(notice).toHaveTextContent('You can still view your chat history.');
    expect(screen.getByLabelText('Your question')).toBeEnabled();
    expect(screen.getByLabelText('Your question')).toHaveAccessibleDescription(/active subscription/i);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('keeps a typed draft and focuses the subscription explanation on Send or Enter, without writing', async () => {
    blockSubscription();
    const user = userEvent.setup();
    render(<InsightsChat companyId="co-1" />);
    await ask('How many jobs are late?');
    const field = screen.getByLabelText('Your question');
    expect(field).toHaveValue('How many jobs are late?');
    expect(screen.getByRole('region', { name: 'Chat subscription' })).toHaveFocus();
    await user.click(field);
    await user.keyboard('{Enter}');
    expect(screen.getByRole('region', { name: 'Chat subscription' })).toHaveFocus();
    expect(mockCreateThread).not.toHaveBeenCalled();
    expect(mockSubmitChatQuery).not.toHaveBeenCalled();
    expect(Sentry.captureException).not.toHaveBeenCalled();
    expect(posthog.capture).toHaveBeenCalledWith('ai job refused', expect.objectContaining({ reason: 'subscription_required' }));
  });

  it('keeps a selected starter as a draft and blocks file preparation and upload', async () => {
    blockSubscription();
    const user = userEvent.setup();
    render(<InsightsChat companyId="co-1" />);
    await user.click(screen.getByRole('button', { name: 'How many jobs are late right now?' }));
    expect(screen.getByLabelText('Your question')).toHaveValue('How many jobs are late right now?');
    await user.upload(screen.getByLabelText('Choose chat files'), new File(['zip'], 'parts.zip'));
    expect(mockPrepareChatUpload).not.toHaveBeenCalled();
    expect(mockUploadChatFiles).not.toHaveBeenCalled();
    expect(mockCreateThread).not.toHaveBeenCalled();
    expect(mockSubmitChatQuery).not.toHaveBeenCalled();
  });

  it('keeps history readable but blocks follow-ups and approvals in an existing conversation', async () => {
    blockSubscription('canceled');
    const user = userEvent.setup();
    mockListThreads.mockResolvedValue([{ id: 't-1', title: 'Previous conversation', created_at: 'c', updated_at: 'u' }]);
    mockListThreadMessages.mockResolvedValue(turn(1, 'Old question', 'Saved answer', { follow_ups: ['What about next week?'] }));
    mockGetPendingActions.mockResolvedValue([{ id: 'a-1', tool: 'create_quote', title: 'Create quote', summary: 'Draft a quote', destructive: false }]);
    render(<InsightsChat companyId="co-1" />);
    await user.click(screen.getByRole('button', { name: 'Chat history' }));
    await user.click(await screen.findByText('Previous conversation'));
    expect(await screen.findByText('Saved answer')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'What about next week?' }));
    await user.click(await screen.findByRole('button', { name: 'Approve', exact: true }));
    expect(mockSubmitChatQuery).not.toHaveBeenCalled();
    expect(mockDecideChatAction).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Your question')).toHaveValue('What about next week?');
  });

  it('points a non-admin to their shop admin without offering an inaccessible billing action', () => {
    blockSubscription('canceled');
    roleStub = { isAdmin: false, loading: false };
    render(<InsightsChat companyId="co-1" />);
    const notice = screen.getByRole('region', { name: 'Chat subscription' });
    expect(notice).toHaveTextContent(/ask an admin at your shop to reactivate/i);
    expect(within(notice).queryByRole('button')).not.toBeInTheDocument();
  });

  it.each(['demo', 'past_due', 'grace'] as const)('preserves entitled %s access', async (access) => {
    if (access === 'demo') subscriptionStub = { ...subscriptionStub, isDemo: true };
    if (access === 'past_due') subscriptionStub = { ...subscriptionStub, entitlement: 'past_due', isPastDue: true };
    if (access === 'grace') {
      blockSubscription('canceled');
      subscriptionStub = { ...subscriptionStub, entitlement: 'full', canWrite: true, isReadOnly: false };
    }
    render(<InsightsChat companyId="co-1" />);
    await ask('How many jobs are late?');
    expect(mockSubmitChatQuery).toHaveBeenCalledWith('co-1', 'How many jobs are late?', 'thread-1');
    expect(screen.queryByRole('region', { name: 'Chat subscription' })).not.toBeInTheDocument();
  });

  it('waits for entitlement without flashing a subscription notice and preserves typing', async () => {
    subscriptionStub = { ...subscriptionStub, isLoading: true, canWrite: false };
    const user = userEvent.setup();
    const { rerender } = render(<InsightsChat companyId="co-1" />);
    await user.type(screen.getByLabelText('Your question'), 'My draft');
    expect(screen.queryByRole('region', { name: 'Chat subscription' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send question' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'How many jobs are late right now?' })).toBeDisabled();
    await user.keyboard('{Enter}');
    expect(mockCreateThread).not.toHaveBeenCalled();
    subscriptionStub = { ...subscriptionStub, isLoading: false, canWrite: true };
    rerender(<InsightsChat companyId="co-1" />);
    await user.click(screen.getByRole('button', { name: 'Send question' }));
    expect(mockSubmitChatQuery).toHaveBeenCalledWith('co-1', 'My draft', 'thread-1');
  });

  it('translates a billing denial from a stale cache, refreshes billing, and never exposes RLS details', async () => {
    const raw = { code: '42501', message: 'new row violates row-level security policy "billing_gate_insert" for table "ai_chat_threads"' };
    mockCreateThread.mockRejectedValueOnce(toFriendlyError(raw));
    const { rerender } = render(<InsightsChat companyId="co-1" />);
    await ask('How many jobs are late?');
    expect(await screen.findByRole('region', { name: 'Chat subscription' })).toBeInTheDocument();
    expect(subscriptionStub.refresh).toHaveBeenCalledOnce();
    expect(screen.queryByText(/row-level security|billing_gate|ai_chat_threads/)).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(mockSubmitChatQuery).not.toHaveBeenCalled();
    expect(Sentry.captureException).not.toHaveBeenCalled();
    // A new billing snapshot that confirms access restores chat and retains the draft.
    subscriptionStub = { ...subscriptionStub, billing: {
      company_id: 'co-1', canceled_at: null, trial_end: null,
      billing_exempt: true, subscription_status: null, current_period_end: null,
      cancel_at: null, ended_at: null, stripe_customer_id: null,
      stripe_subscription_id: null, subscription_price_id: null,
    } };
    rerender(<InsightsChat companyId="co-1" />);
    expect(screen.queryByRole('region', { name: 'Chat subscription' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Your question')).toHaveValue('How many jobs are late?');
  });

  it('restores the draft after billing navigation and clears it only after a successful send', async () => {
    blockSubscription();
    const { unmount } = render(<InsightsChat companyId="co-1" />);
    await ask('Keep this question');
    expect(window.sessionStorage.getItem('jigged.aiDraft.co-1')).toBe('Keep this question');
    unmount();
    subscriptionStub = { ...subscriptionStub, canWrite: true, mustSubscribe: false };
    const user = userEvent.setup();
    render(<InsightsChat companyId="co-1" />);
    await vi.waitFor(() => expect(screen.getByLabelText('Your question')).toHaveValue('Keep this question'));
    await user.click(screen.getByRole('button', { name: 'Send question' }));
    expect(mockSubmitChatQuery).toHaveBeenCalledWith('co-1', 'Keep this question', 'thread-1');
    expect(window.sessionStorage.getItem('jigged.aiDraft.co-1')).toBeNull();
  });
});

describe('InsightsChat — uploaded drawings', () => {
  it('stages a package without an AI call, then sends the uploaded reference with the question', async () => {
    const user = userEvent.setup();
    render(<InsightsChat companyId="co-1" />);
    await user.upload(screen.getByLabelText('Choose chat files'), new File(['zip bytes'], 'parts.zip'));
    expect(await screen.findByText('parts.zip · 1 part')).toBeInTheDocument();
    expect(mockSubmitChatQuery).not.toHaveBeenCalled();
    expect(mockUploadChatFiles).not.toHaveBeenCalled();
    await ask('Set up these parts and draft a quote for review.');
    expect(mockUploadChatFiles).toHaveBeenCalledWith('co-1', 'thread-1', expect.objectContaining({ id: 'upload-1' }), expect.any(Function));
    expect(mockSubmitChatQuery).toHaveBeenCalledWith('co-1', 'Set up these parts and draft a quote for review.', 'thread-1', [expect.objectContaining({ file_count: 3 })]);
    expect(screen.queryByText('parts.zip · 1 part')).not.toBeInTheDocument();
  });

  it('keeps the question and successful upload on an enqueue rejection, and reuses the bytes on retry', async () => {
    const user = userEvent.setup();
    mockSubmitChatQuery.mockRejectedValueOnce(new ChatEnqueueError('Busy', 409));
    render(<InsightsChat companyId="co-1" />);
    await user.upload(screen.getByLabelText('Choose chat files'), new File(['zip bytes'], 'parts.zip'));
    await screen.findByText('parts.zip · 1 part');
    await ask('Set up these parts');
    expect(await screen.findByRole('alert')).toHaveTextContent('Busy');
    expect(screen.getByLabelText('Your question')).toHaveValue('Set up these parts');
    await user.click(screen.getByRole('button', { name: 'Send question' }));
    expect(mockSubmitChatQuery).toHaveBeenCalledTimes(2);
    expect(mockUploadChatFiles).toHaveBeenCalledTimes(1);
  });

  it('shows a review link from the stored successful action, and refuses another company path', async () => {
    window.sessionStorage.setItem('jigged.aiThread.co-1', 't-1');
    mockListThreadMessages.mockResolvedValue([
      ...turn(1, 'Draft a quote', 'The parts are ready.', { quoteDraftUrl: 'https://jigged.app/dashboard/co-1/quotes/new?parts=p1' }),
      ...turn(3, 'Again', 'Done.', { quoteDraftUrl: 'https://example.com/dashboard/other/quotes/new' }),
    ]);
    render(<InsightsChat companyId="co-1" />);
    const link = await screen.findByRole('link', { name: 'Review quote draft' });
    expect(link).toHaveAttribute('href', '/dashboard/co-1/quotes/new?parts=p1');
    expect(screen.getAllByRole('link', { name: 'Review quote draft' })).toHaveLength(1);
  });
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

  it('a refusal at the door is a PostHog rate, not a Sentry incident', async () => {
    mockSubmitChatQuery.mockRejectedValue(
      new ChatEnqueueError("Insights are temporarily unavailable right now, so this can't run. Everything else still works.", 503),
    );
    render(<InsightsChat companyId="co-1" />);

    await ask('How many jobs are late?');

    const posthog = (await import('posthog-js')).default;
    // The event the door-level refusal had no way to report before: it never
    // becomes a job row, so `ai job settled` cannot see it, and Sentry is
    // deliberately silent for it.
    expect(posthog.capture).toHaveBeenCalledWith('ai job refused', {
      feature: 'insights',
      reason: 'offline',
      turn_index: 0,
      from_example: false,
      from_suggestion: false,
      question_length_bucket: '5w_15w',
    });
    // Nothing was enqueued, so the denominator must not move.
    expect(posthog.capture).not.toHaveBeenCalledWith('ai job enqueued', expect.anything());
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it('each expected status carries its own reason, and none of them page', async () => {
    const cases: [number, string][] = [
      [429, 'rate_limited'],
      [403, 'disabled'],
      [409, 'busy'],
      [404, 'thread_missing'],
    ];
    for (const [status, reason] of cases) {
      vi.clearAllMocks();
      mockSubmitChatQuery.mockRejectedValue(new ChatEnqueueError('nope', status));
      const { unmount } = render(<InsightsChat companyId="co-1" />);

      await ask('How many jobs are late?');

      const posthog = (await import('posthog-js')).default;
      expect(posthog.capture).toHaveBeenCalledWith('ai job refused', expect.objectContaining({ reason }));
      expect(Sentry.captureException).not.toHaveBeenCalled();
      unmount();
    }
  });

  it('an unmapped failure still pages, and is not filed as a refusal', async () => {
    mockSubmitChatQuery.mockRejectedValue(new TypeError('Failed to fetch'));
    render(<InsightsChat companyId="co-1" />);

    await ask('How many jobs are late?');

    const posthog = (await import('posthog-js')).default;
    // The negation the REFUSAL_REASONS map replaced: absence from it is what
    // keeps an unforeseen status an error rather than quietly becoming a rate.
    expect(posthog.capture).not.toHaveBeenCalledWith('ai job refused', expect.anything());
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
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
      question_length_bucket: 'under_5w',
      upload_count: 0, file_count: 0, part_count: 0,
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
    expect(
      screen.getAllByText(/Jigged AI can make mistakes\. Please double-check responses\./).length,
    ).toBeGreaterThan(0);
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

  it('restores the question from the job after leaving the page and coming back', async () => {
    // THE WALK-AWAY CASE, and it is the normal one rather than an edge: a question
    // runs for tens of seconds and a report for minutes, so people go and do
    // something else. `askedQuestion` is React state and dies with the unmount, so
    // returning used to show a spinner labelled with nothing — the answer was never
    // at risk (the job handle survives in sessionStorage and the turn is written by
    // a trigger), only the sentence saying what it was thinking about.
    //
    // Nothing is typed here: this mounts fresh onto a job already in flight, which
    // is exactly what coming back looks like.
    mockUseAiJob.mockReturnValue({
      ...IDLE_JOB,
      phase: 'pending',
      job: { id: 'job-7', status: 'running', payload: { question: 'how many jobs are late right now?' } },
    });
    render(<InsightsChat companyId="co-1" />);

    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent('how many jobs are late right now?');
  });

  it('reads the report door\'s wording too, and shows nothing when the row has neither', async () => {
    // The chat door writes payload.question, the report door writes payload.request.
    mockUseAiJob.mockReturnValue({
      ...IDLE_JOB,
      phase: 'pending',
      job: { id: 'job-8', status: 'running', payload: { request: 'one-page report on this quarter' } },
    });
    const { unmount } = render(<InsightsChat companyId="co-1" />);
    expect(await screen.findByRole('status')).toHaveTextContent('one-page report on this quarter');
    unmount();

    // A job from an older shape degrades to no echo rather than rendering undefined.
    mockUseAiJob.mockReturnValue({ ...IDLE_JOB, phase: 'pending', job: { id: 'job-9', status: 'running', payload: null } });
    render(<InsightsChat companyId="co-1" />);
    const bare = await screen.findByRole('status');
    expect(bare.textContent).not.toMatch(/undefined|null/);
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
      question_length_bucket: 'under_5w',
      upload_count: 0, file_count: 0, part_count: 0,
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
      question_length_bucket: '5w_15w',
      upload_count: 0, file_count: 0, part_count: 0,
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
    // DATE AND TIME, not the date alone. Asking the same question twice in an
    // afternoon -- what people do when an answer did not land -- produced a list of
    // identical titles all reading "Sep 8", and the rail could not say which entry
    // was which. Matched loosely on the clock part because the format follows the
    // runner's locale and timezone, and pinning either makes this fail in CI
    // rather than fail when the copy is wrong.
    expect(within(list).getByText(/Trend · Sep 8, \d{1,2}:\d{2}/)).toBeInTheDocument();
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

describe('InsightsChat — a change waiting for approval', () => {
  const CREATE = {
    id: 'call-1',
    tool: 'create_quote',
    title: 'Create quote',
    summary: 'Create a quote for Cascade Robotics: 10 of ASM-GEARBOX, lead time 3 weeks.',
    destructive: false,
  };

  function withPendingTurn(actions = [CREATE]) {
    window.sessionStorage.setItem('jigged.aiThread.co-1', 'thread-9');
    mockListThreadMessages.mockResolvedValue(
      turn(1, 'Quote Cascade 10 gearboxes', `This needs your approval before it runs: ${actions[0].summary}`),
    );
    mockGetPendingActions.mockImplementation((jobId: string) =>
      Promise.resolve(jobId === 'job-1' ? actions : []),
    );
  }

  it('shows exactly what will change, on the newest turn, read from that turn’s job', async () => {
    withPendingTurn();
    render(<InsightsChat companyId="co-1" />);

    const card = await screen.findByRole('group', { name: 'Change waiting for your approval' });
    expect(card).toHaveTextContent('Approve this change?');
    expect(card).toHaveTextContent(CREATE.summary);
    expect(mockGetPendingActions).toHaveBeenCalledWith('job-1');
    expect(screen.getByRole('button', { name: 'Approve' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Always allow' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Decline' })).toBeEnabled();
  });

  it.each(['approve', 'always', 'decline'] as const)(
    'sends %s for that job alone, then waits on the decision’s own job',
    async (decision) => {
      withPendingTurn();
      mockDecideChatAction.mockResolvedValue({ job_id: 'job-2', status: 'settled', executor: 'backend' });
      render(<InsightsChat companyId="co-1" />);
      const user = userEvent.setup();
      const label = { approve: 'Approve', always: 'Always allow', decline: 'Decline' }[decision];

      await user.click(await screen.findByRole('button', { name: label }));

      expect(mockDecideChatAction).toHaveBeenCalledWith('co-1', 'job-1', decision);
      expect(IDLE_JOB.watch).toHaveBeenCalledWith('job-2');
      expect(posthog.capture).toHaveBeenCalledWith('chat action decided', {
        decision,
        action_count: 1,
        destructive: false,
        tool_names: ['create_quote'],
      });
    },
  );

  it('marks a destructive change in words, not colour alone', async () => {
    withPendingTurn([{ ...CREATE, tool: 'archive_record', title: 'Archive record', destructive: true }]);
    render(<InsightsChat companyId="co-1" />);
    const card = await screen.findByRole('group', { name: 'Change waiting for your approval' });
    expect(card).toHaveTextContent('Check carefully');
  });

  it('shows no card when nothing is waiting', async () => {
    window.sessionStorage.setItem('jigged.aiThread.co-1', 'thread-9');
    mockListThreadMessages.mockResolvedValue(turn(1, 'how many open quotes?', 'Six.'));
    render(<InsightsChat companyId="co-1" />);
    await screen.findByText('Six.');
    expect(screen.queryByRole('group', { name: 'Change waiting for your approval' })).toBeNull();
  });

  it('offers Allowed actions only once something is always-allowed', async () => {
    window.sessionStorage.setItem('jigged.aiThread.co-1', 'thread-9');
    mockListThreadMessages.mockResolvedValue(turn(1, 'how many open quotes?', 'Six.'));
    const { unmount } = render(<InsightsChat companyId="co-1" />);
    await screen.findByText('Six.');
    expect(screen.queryByRole('button', { name: 'Allowed actions' })).toBeNull();
    unmount();

    mockListChatActionGrants.mockResolvedValue([{ id: 'g1', tool_name: 'create_quote', created_at: '2026-11-09T00:00:00Z' }]);
    render(<InsightsChat companyId="co-1" />);
    const user = userEvent.setup();
    // The thread first: until it loads, the button sits in the empty-page row, and the
    // conversation's arrival re-renders it in the other one -- a click in between lands
    // on a node that is gone.
    await screen.findByText('Six.');
    await user.click(screen.getByRole('button', { name: 'Allowed actions' }));
    const dialog = await screen.findByRole('dialog', { name: 'Allowed actions' });
    expect(within(dialog).getByText('Create quote')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Turn off' })).toBeEnabled();
  });
});
