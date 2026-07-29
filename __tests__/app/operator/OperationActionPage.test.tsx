import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThemeProvider } from '@mui/material/styles';
import jiggedTheme from '@/lib/theme';

import OperatorOperationActionPage from '@/app/operator/[companyId]/jobs/[jobId]/parts/[jobPartId]/operations/[jobOperationId]/page';
import { getOperatorOperationDetail, revertOperationCompletion } from '@/utils/operatorAccess';
import {
  createOperationCompletion,
  getOperationCompletionSummaries,
} from '@/utils/operationCompletionsAccess';
import { logOperatorEvent } from '@/utils/operatorEventsAccess';

/**
 * CHARACTERISATION TESTS — what the completion path does TODAY.
 *
 * Written before B4 rewrites this screen, and deliberately not written
 * alongside it: tests authored next to a rewrite describe the new code, which
 * is precisely what a rewrite must not be judged by.
 *
 * Completion is the one action an operator must never lose, and until now it had
 * nine unit tests on the access layer, no component test, and no E2E — the page
 * that owns handleRecord and handleRevert was unprotected. Anything here that
 * goes red during B4 is a regression to explain, not an argument to have.
 *
 * Two invariants matter more than the rest and are called out where they are
 * asserted: completion must be DURABLE BEFORE any capture prompt appears, and
 * undoing a completion must never be recorded as making one.
 */

vi.mock('next/navigation', () => ({
  useParams: () => ({
    companyId: 'co1',
    jobId: 'job1',
    jobPartId: 'jp1',
    jobOperationId: 'op1',
  }),
  useRouter: () => ({ push: vi.fn(), back: vi.fn() }),
  usePathname: () => '/operator/co1/jobs/job1/parts/jp1/operations/op1',
}));

vi.mock('@/utils/operatorAccess', () => ({
  getOperatorOperationDetail: vi.fn(),
  getCurrentMember: vi.fn(async () => ({ id: 'acc1', name: 'Diego', user_id: 'u1' })),
  revertOperationCompletion: vi.fn(async () => undefined),
  markOperationSent: vi.fn(),
  markOperationReceived: vi.fn(),
}));

vi.mock('@/utils/operationCompletionsAccess', () => ({
  createOperationCompletion: vi.fn(async () => undefined),
  getOperationCompletionSummaries: vi.fn(),
}));

vi.mock('@/utils/operatorEventsAccess', () => ({ logOperatorEvent: vi.fn() }));

// The page embeds the feed and the part reference row; both reach Supabase.
vi.mock('@/components/operator/JobFeed', () => ({
  default: ({ captureOfferSignal }: { captureOfferSignal?: number }) => (
    <div data-testid="job-feed" data-offer-signal={captureOfferSignal ?? 0} />
  ),
}));
vi.mock('@/components/operator/PartReferenceRow', () => ({ default: () => <div /> }));

// A station is selected and MATCHES the step, so the guard is out of the way
// unless a test overrides it.
const station = { stationId: 'wc1', stationName: 'Assembly Bench', initializing: false };
vi.mock('@/components/operator/OperatorStationContext', () => ({
  useStationContext: () => station,
}));
vi.mock('@/components/operator/OperatorChromeContext', () => ({
  useSetOperatorChrome: () => {},
  useOperatorNav: () => ({ push: vi.fn(), goBack: vi.fn() }),
}));
vi.mock('@/components/operator/StationSelector', () => ({ default: () => <div /> }));

const mockDetail = vi.mocked(getOperatorOperationDetail);
const mockSummaries = vi.mocked(getOperationCompletionSummaries);
const mockCreate = vi.mocked(createOperationCompletion);
const mockRevert = vi.mocked(revertOperationCompletion);
const mockEvent = vi.mocked(logOperatorEvent);

function detail(over: Record<string, unknown> = {}) {
  return {
    id: 'jp1',
    job_id: 'job1',
    part_id: 'part1',
    job_number: 'J-0010',
    customer_name: 'Cascade Robotics',
    part_name: 'PROD-PUMP-100',
    part_description: null,
    part_quantity: 10,
    production_status: 'in_progress',
    operation_id: 'op1',
    operation_name: 'Assembly',
    operation_status: 'pending',
    operation_instructions: null,
    operation_work_center_id: 'wc1',
    operation_work_center_name: 'Assembly Bench',
    operation_work_center_kind: 'internal' as const,
    operation_vendor_name: null,
    operation_sent_at: null,
    estimated_minutes: null,
    operations_total: 2,
    operations_completed: 0,
    ...over,
  };
}

/** One row of the partial-completion summary for this op. */
function summary(qtyGood: number, target = 10) {
  return [
    {
      job_operation_id: 'op1',
      target,
      qty_good: qtyGood,
      qty_remaining: Math.max(0, target - qtyGood),
    },
  ];
}

function renderPage() {
  return render(
    <ThemeProvider theme={jiggedTheme}>
      <OperatorOperationActionPage />
    </ThemeProvider>,
  );
}

const recordButton = () => screen.getByRole('button', { name: /record completion/i });

beforeEach(() => {
  vi.clearAllMocks();
  mockDetail.mockResolvedValue(detail() as never);
  mockSummaries.mockResolvedValue(summary(0) as never);
  mockCreate.mockResolvedValue(undefined as never);
  mockRevert.mockResolvedValue(undefined as never);
});

describe('operation action page — completion (characterisation)', () => {
  it('defaults the quantity to what is REMAINING, not the order quantity', async () => {
    // 10 ordered, 4 already good → the field offers 6. Defaulting to the order
    // quantity would silently double-count on the second visit.
    mockSummaries.mockResolvedValue(summary(4) as never);
    renderPage();

    const field = await screen.findByLabelText('Good pieces finished');
    await waitFor(() => expect(field).toHaveValue(6));
  });

  it('records the quantity in the field', async () => {
    renderPage();
    await screen.findByLabelText('Good pieces finished');

    await userEvent.click(recordButton());

    await waitFor(() =>
      expect(mockCreate).toHaveBeenCalledWith({
        companyId: 'co1',
        jobOperationId: 'op1',
        jobPartId: 'jp1',
        quantityGood: 10,
      }),
    );
  });

  it('records a partial when the number is dialled down', async () => {
    // The whole point of one field and one button: a partial is the same
    // gesture with a smaller number, not a separate mode.
    const user = userEvent.setup();
    renderPage();
    const field = await screen.findByLabelText('Good pieces finished');

    await user.clear(field);
    await user.type(field, '3');
    await user.click(recordButton());

    await waitFor(() =>
      expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ quantityGood: 3 })),
    );
  });

  it('cannot record zero', async () => {
    const user = userEvent.setup();
    renderPage();
    const field = await screen.findByLabelText('Good pieces finished');

    await user.clear(field);

    await waitFor(() => expect(recordButton()).toBeDisabled());
  });

  it('allows over-completion — warned, never blocked', async () => {
    // Shops finish more than ordered. Blocking it would leave the operator
    // unable to record what physically happened.
    const user = userEvent.setup();
    renderPage();
    const field = await screen.findByLabelText('Good pieces finished');

    await user.clear(field);
    await user.type(field, '12');

    expect(recordButton()).toBeEnabled();
    await user.click(recordButton());
    await waitFor(() =>
      expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ quantityGood: 12 })),
    );
  });

  it('logs completion_recorded only AFTER the write resolves', async () => {
    // The funnel's entire job is separating "tried" from "succeeded". A failed
    // completion that still logged would make the number a lie.
    let release: () => void = () => {};
    mockCreate.mockReturnValue(new Promise<void>((r) => (release = () => r())) as never);
    renderPage();
    await screen.findByLabelText('Good pieces finished');

    await userEvent.click(recordButton());
    expect(mockEvent).not.toHaveBeenCalledWith('co1', 'completion_recorded', expect.anything());

    release();
    await waitFor(() =>
      expect(mockEvent).toHaveBeenCalledWith(
        'co1',
        'completion_recorded',
        expect.objectContaining({ jobOperationId: 'op1', quantityGood: 10 }),
      ),
    );
  });

  it('does not log a completion when the write fails', async () => {
    mockCreate.mockRejectedValue(new Error('offline') as never);
    renderPage();
    await screen.findByLabelText('Good pieces finished');

    await userEvent.click(recordButton());

    expect(await screen.findByText('offline')).toBeInTheDocument();
    expect(mockEvent).not.toHaveBeenCalledWith('co1', 'completion_recorded', expect.anything());
  });

  it('prompts for capture only AFTER completion is durable', async () => {
    // THE INVARIANT B4 MUST PRESERVE IN WHATEVER SHAPE IT TAKES. The offer
    // signal is bumped strictly after the write resolves, so a client death at
    // the prompt cannot un-complete a finished step. B4 removes the prompt; the
    // ordering it protects — completion first, capture second — must survive.
    let release: () => void = () => {};
    mockCreate.mockReturnValue(new Promise<void>((r) => (release = () => r())) as never);
    renderPage();
    await screen.findByLabelText('Good pieces finished');

    await userEvent.click(recordButton());
    expect(screen.getByTestId('job-feed')).toHaveAttribute('data-offer-signal', '0');

    release();
    await waitFor(() =>
      expect(screen.getByTestId('job-feed')).toHaveAttribute('data-offer-signal', '1'),
    );
  });

  it('offers Undo only once something has been recorded', async () => {
    renderPage();
    await screen.findByLabelText('Good pieces finished');
    expect(screen.queryByRole('button', { name: /undo all/i })).not.toBeInTheDocument();

    mockSummaries.mockResolvedValue(summary(4) as never);
    await userEvent.click(recordButton());

    expect(await screen.findByRole('button', { name: /undo all \(4\)/i })).toBeInTheDocument();
  });

  it('undoing is NOT recorded as a completion', async () => {
    // Both handlers share the same tail (clear dirty, reload), and the funnel
    // event once sat in the wrong one — an operator UNDOING a step counted as
    // finishing it.
    mockSummaries.mockResolvedValue(summary(4) as never);
    renderPage();

    await userEvent.click(await screen.findByRole('button', { name: /undo all/i }));

    await waitFor(() => expect(mockRevert).toHaveBeenCalledWith('op1'));
    expect(mockEvent).not.toHaveBeenCalledWith('co1', 'completion_recorded', expect.anything());
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('surfaces a failed undo without pretending it worked', async () => {
    mockSummaries.mockResolvedValue(summary(4) as never);
    mockRevert.mockRejectedValue(new Error('could not undo') as never);
    renderPage();

    await userEvent.click(await screen.findByRole('button', { name: /undo all/i }));

    expect(await screen.findByText('could not undo')).toBeInTheDocument();
  });

  it('warns on a station mismatch but still lets the step be recorded', async () => {
    // Completion keys off the operation id, not the station, so a mismatch is a
    // likely wrong-QR signal — not a reason to stop someone recording real work.
    mockDetail.mockResolvedValue(
      detail({ operation_work_center_id: 'wc9', operation_work_center_name: 'Bandsaw' }) as never,
    );
    renderPage();

    expect(await screen.findByText(/but this step runs at/i)).toBeInTheDocument();
    await userEvent.click(recordButton());
    await waitFor(() => expect(mockCreate).toHaveBeenCalled());
  });

  it('reports reaching the step, for the reader funnel', async () => {
    renderPage();

    await waitFor(() =>
      expect(mockEvent).toHaveBeenCalledWith(
        'co1',
        'op_card_opened',
        expect.objectContaining({ jobOperationId: 'op1' }),
      ),
    );
  });
});
