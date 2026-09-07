/**
 * The ask bar's enqueue failures, rendered.
 *
 * Three refusals come back from POST /chat and only one of them is bad news
 * about the question: 503 is the shop's AI box being off (expected downtime,
 * the same state a mid-job outage reaches, so the same quiet notice), 429 is the
 * shop's own hourly cap, 403 is its kill-switch. None of the three is an
 * incident, so none of them reaches Sentry. Anything else is ours and does.
 *
 * Before ChatEnqueueError carried the status, the 503 rendered red -- telling
 * the user their question had gone wrong when nothing had -- and the Sentry
 * decision matched /offline|rate limit|disabled/ against user-facing copy.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import * as Sentry from '@sentry/nextjs';

import { render, screen, resetRouterMocks } from '../../test-utils';
import InsightsChat from '@/components/insights/InsightsChat';
import { ChatEnqueueError } from '@/utils/insightsAccess';

const mockSubmitChatQuery = vi.fn();
vi.mock('@/utils/insightsAccess', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/insightsAccess')>();
  return {
    ...actual,
    submitChatQuery: (...a: unknown[]) => mockSubmitChatQuery(...a),
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
vi.mock('@/utils/savedInsightsAccess', () => ({ saveInsight: vi.fn() }));
vi.mock('@/components/insights/InsightChart', () => ({ default: () => null }));
vi.mock('posthog-js', () => ({ default: { identify: vi.fn(), capture: vi.fn() } }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));

async function ask(question: string) {
  const user = userEvent.setup();
  await user.type(screen.getByPlaceholderText('Ask about your shop data...'), question);
  await user.click(screen.getByRole('button', { name: 'Send question' }));
}

describe('InsightsChat — what an enqueue refusal looks like', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetRouterMocks();
  });

  it('renders a 503 as the quiet offline notice, not as an error, and does not page', async () => {
    mockSubmitChatQuery.mockRejectedValue(
      new ChatEnqueueError(
        "The AI box is offline right now, so this can't run. Everything else still works.",
        503,
      ),
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
      new ChatEnqueueError(
        'Rate limit exceeded. Maximum 20 AI chat queries per hour per company.',
        429,
      ),
    );
    render(<InsightsChat companyId="co-1" />);

    await ask('How many jobs are late?');

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveClass('MuiAlert-standardError');
    expect(alert).toHaveTextContent('Maximum 20');
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it('a 403 kill-switch is an error the shop chose, so it does not page either', async () => {
    mockSubmitChatQuery.mockRejectedValue(
      new ChatEnqueueError('AI Insights is disabled for this company.', 403),
    );
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
});
