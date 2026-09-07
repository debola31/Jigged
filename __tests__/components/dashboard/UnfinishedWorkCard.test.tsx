import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

/**
 * The office's forgotten-stop channel, and — since 20260828124806 — the only
 * place an abandoned interval can actually be acted on.
 *
 * WHAT THESE TESTS ARE FOR. This card carried a docblock claiming it was "the
 * only route to an interval whose owner has gone home" while rendering no
 * control at all, so the claim was true of nothing. J-0001 is what that costs: a
 * timer opened at 06:49, visible on the dashboard, closable by nobody —
 * `close_operation_interval` and `cancel_operation_interval` both refuse a
 * non-owner. The Stop assertions below are the claim made checkable.
 *
 * The other half is the surveillance guardrail: `get_open_intervals` returns no
 * operator identity, so there is nothing here to name a person with, and the
 * tests assert the absence rather than trusting the query to stay that way.
 */
vi.mock('@/utils/operationIntervalsAccess', () => ({
  getOpenIntervals: vi.fn(async () => []),
  getPausedOperations: vi.fn(async () => []),
  voidOpenIntervalsForOperation: vi.fn(async () => 1),
}));

vi.mock('posthog-js', () => ({ default: { capture: vi.fn() } }));

import posthog from 'posthog-js';
import {
  getOpenIntervals,
  getPausedOperations,
  voidOpenIntervalsForOperation,
} from '@/utils/operationIntervalsAccess';
import UnfinishedWorkCard from '@/components/dashboard/UnfinishedWorkCard';

const mock = (fn: unknown) => fn as ReturnType<typeof vi.fn>;

// Two hours ago, so the row is genuinely open but not yet stale — the staleness
// banner is a separate concern and a fixed timestamp would flip it as the suite
// ages.
const twoHoursAgo = () => new Date(Date.now() - 2 * 3_600_000).toISOString();

const hoursAgo = (n: number) => new Date(Date.now() - n * 3_600_000).toISOString();

const openInterval = (over = {}) => ({
  interval_id: 'iv1',
  job_operation_id: 'jo1',
  job_id: 'job1',
  job_number: 'J-0001',
  part_name: '277343 - JAW 2',
  operation_name: 'HAAS VF-3SSYT',
  work_center_name: 'HAAS VF-3SSYT',
  started_at: twoHoursAgo(),
  capture_source: 'operator',
  // Six hours, so two hours in is well inside the estimate-relative threshold
  // (3x = 18h) AND inside the flat ceiling. The default row is not flagged.
  expected_minutes: 360,
  ...over,
});

const pausedOperation = (over = {}) => ({
  interval_id: 'iv9',
  job_operation_id: 'jo9',
  job_id: 'job9',
  job_number: 'J-0042',
  part_name: '904112 - BRACKET',
  operation_name: 'Deburr',
  work_center_name: 'Bench 1',
  paused_at: twoHoursAgo(),
  expected_minutes: 360,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  mock(getOpenIntervals).mockResolvedValue([openInterval()]);
  mock(getPausedOperations).mockResolvedValue([]);
  mock(voidOpenIntervalsForOperation).mockResolvedValue(1);
});

describe('UnfinishedWorkCard', () => {
  it('renders nothing when nothing is running and nothing is paused', async () => {
    mock(getOpenIntervals).mockResolvedValue([]);
    const { container } = render(<UnfinishedWorkCard companyId="co1" />);
    await waitFor(() => expect(mock(getOpenIntervals)).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('links to the exact operation, not just the job', async () => {
    // THE REPORTED CONFUSION. Operations are named after their work centre, so a
    // job routing four parts through one machine has four steps all called
    // `HAAS VF-3SSYT`. Landing on the job means picking one by eye, and the
    // office picked a completed one and concluded the card was lying.
    render(<UnfinishedWorkCard companyId="co1" />);
    const link = await screen.findByRole('link', { name: 'J-0001' });
    expect(link).toHaveAttribute('href', '/dashboard/co1/jobs/job1?op=jo1');
  });

  it('names no operator anywhere on the row', async () => {
    render(<UnfinishedWorkCard companyId="co1" />);
    await screen.findByRole('link', { name: 'J-0001' });
    expect(screen.queryByText(/\bby\b/i)).not.toBeInTheDocument();
  });

  it('identifies the step by job and PART, not by the machine twice', async () => {
    // Operations are NAMED after their work centre, so rendering both produced
    // "Assembly Bench · J-0008 · Assembly Bench". The part is what tells four
    // identically-named steps apart, which is the confusion this whole change is
    // about — and no test caught it, only looking at the dialog did.
    render(<UnfinishedWorkCard companyId="co1" />);
    await userEvent.click(await screen.findByRole('button', { name: /stop/i }));

    expect(
      await screen.findByText('J-0001 · 277343 - JAW 2 · HAAS VF-3SSYT'),
    ).toBeInTheDocument();
  });

  it('confirms before discarding, because a voided interval has no inverse', async () => {
    render(<UnfinishedWorkCard companyId="co1" />);
    await userEvent.click(await screen.findByRole('button', { name: /stop/i }));

    expect(await screen.findByText(/Stop this timer\?/)).toBeInTheDocument();
    // The consequence stated in the dialog, not discovered in a snackbar after.
    expect(screen.getByText(/no time is recorded/i)).toBeInTheDocument();
    expect(voidOpenIntervalsForOperation).not.toHaveBeenCalled();
  });

  it('discards by OPERATION when confirmed', async () => {
    render(<UnfinishedWorkCard companyId="co1" />);
    await userEvent.click(await screen.findByRole('button', { name: /stop/i }));
    await userEvent.click(await screen.findByRole('button', { name: /discard the timer/i }));

    // The operation id, never the interval id: the office is not told whose row
    // it is discarding, and an interval-addressed call would require that.
    await waitFor(() => expect(voidOpenIntervalsForOperation).toHaveBeenCalledWith('jo1'));
  });

  it('re-reads the PAUSED list after a Stop too, not just the running one', async () => {
    // Discarding the open span can MOVE a step into the Paused group rather than
    // out of the card: get_paused_operations ignores voided spans, so an operation
    // A paused and B then left running becomes paused-eligible the instant Stop
    // voids B's. Refreshing only the running list makes the step vanish, which
    // reads as the Stop having finished the work.
    render(<UnfinishedWorkCard companyId="co1" />);
    await userEvent.click(await screen.findByRole('button', { name: /stop/i }));

    mock(getOpenIntervals).mockResolvedValue([]);
    mock(getPausedOperations).mockResolvedValue([pausedOperation()]);
    await userEvent.click(await screen.findByRole('button', { name: /discard the timer/i }));

    expect(await screen.findByRole('link', { name: 'J-0042' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'J-0001' })).not.toBeInTheDocument();
  });

  it('re-reads the list rather than splicing the row out', async () => {
    // The RPC is per-operation, so an ad-hoc step with two open intervals loses
    // both. Splicing would leave the other one on screen claiming a machine is
    // running that is not.
    render(<UnfinishedWorkCard companyId="co1" />);
    await userEvent.click(await screen.findByRole('button', { name: /stop/i }));
    mock(getOpenIntervals).mockResolvedValue([]);
    await userEvent.click(await screen.findByRole('button', { name: /discard the timer/i }));

    await waitFor(() => expect(mock(getOpenIntervals)).toHaveBeenCalledTimes(2));
  });

  it('sends a count and no duration when a timer is discarded', async () => {
    render(<UnfinishedWorkCard companyId="co1" />);
    await userEvent.click(await screen.findByRole('button', { name: /stop/i }));
    await userEvent.click(await screen.findByRole('button', { name: /discard the timer/i }));

    await waitFor(() =>
      expect(posthog.capture).toHaveBeenCalledWith('running timer discarded', {
        surface: 'office',
      }),
    );
  });

  it('shows a failed Stop inside the dialog, not behind it', async () => {
    // docs/interaction-standards.md: an error a confirm dialog cannot show is an
    // error the user never sees, because the dialog is still covering it.
    mock(voidOpenIntervalsForOperation).mockRejectedValue(
      new Error('Only an admin can discard a running timer'),
    );
    render(<UnfinishedWorkCard companyId="co1" />);
    await userEvent.click(await screen.findByRole('button', { name: /stop/i }));
    await userEvent.click(await screen.findByRole('button', { name: /discard the timer/i }));

    expect(await screen.findByText(/Only an admin can discard a running timer/)).toBeInTheDocument();
    // Still open, so the message has something to render inside.
    expect(screen.getByText(/Stop this timer\?/)).toBeInTheDocument();
  });

  it('shows a paused step even when nothing is running', async () => {
    // Pause's recorded objection was "one more thing to remember to undo". This
    // list is the answer, so a card that only appears when a CLOCK is going would
    // leave the objection standing.
    mock(getOpenIntervals).mockResolvedValue([]);
    mock(getPausedOperations).mockResolvedValue([pausedOperation()]);
    render(<UnfinishedWorkCard companyId="co1" />);

    expect(await screen.findByRole('link', { name: 'J-0042' })).toHaveAttribute(
      'href',
      '/dashboard/co1/jobs/job9?op=jo9',
    );
  });

  it('offers no Stop on a paused row, because there is no clock to stop', async () => {
    mock(getOpenIntervals).mockResolvedValue([]);
    mock(getPausedOperations).mockResolvedValue([pausedOperation()]);
    render(<UnfinishedWorkCard companyId="co1" />);
    await screen.findByRole('link', { name: 'J-0042' });

    expect(screen.queryByRole('button', { name: /stop/i })).not.toBeInTheDocument();
  });

  it('survives a failed paused read without losing the running list', async () => {
    // The running clock is the more urgent of the two — it is the one nobody but
    // this card can stop — so it must not disappear because the other read failed.
    mock(getPausedOperations).mockRejectedValue(new Error('nope'));
    render(<UnfinishedWorkCard companyId="co1" />);

    expect(await screen.findByRole('link', { name: 'J-0001' })).toBeInTheDocument();
  });

  it('flags a short step long before the six-hour ceiling', async () => {
    // THE POINT OF THE ESTIMATE-RELATIVE RULE. A 20-minute deburr running two
    // hours is 6x its estimate and plainly forgotten; the old flat rule said
    // nothing about it for another four hours.
    mock(getOpenIntervals).mockResolvedValue([openInterval({ expected_minutes: 20 })]);
    render(<UnfinishedWorkCard companyId="co1" />);

    expect(await screen.findByText(/sitting longer than the step should take/i)).toBeInTheDocument();
    // The reason is stated, so a reader can judge whether the flag is fair.
    expect(screen.getByText(/est\. 20m/)).toBeInTheDocument();
  });

  it('leaves a long step alone while it is inside its estimate', async () => {
    // The other half, and the one that keeps the flag worth reading: a 5-hour EDM
    // burn four hours in is doing exactly what it should.
    mock(getOpenIntervals).mockResolvedValue([
      openInterval({ started_at: hoursAgo(4), expected_minutes: 300 }),
    ]);
    render(<UnfinishedWorkCard companyId="co1" />);
    await screen.findByRole('link', { name: 'J-0001' });

    expect(screen.queryByText(/sitting longer than the step should take/i)).not.toBeInTheDocument();
  });

  it('falls back to the flat ceiling when the step carries no estimate', async () => {
    // expected_minutes arrives as 0, never null, and 0 selects the ceiling. Seven
    // hours is past it; the row is flagged with no estimate quoted, because
    // "est. 0m" would be a lie.
    mock(getOpenIntervals).mockResolvedValue([
      openInterval({ started_at: hoursAgo(7), expected_minutes: 0 }),
    ]);
    render(<UnfinishedWorkCard companyId="co1" />);

    expect(await screen.findByText(/sitting longer than the step should take/i)).toBeInTheDocument();
    expect(screen.queryByText(/est\. /)).not.toBeInTheDocument();
  });

  it('counts a stale pause in the banner alongside a stale clock', async () => {
    mock(getOpenIntervals).mockResolvedValue([openInterval({ started_at: hoursAgo(7) })]);
    mock(getPausedOperations).mockResolvedValue([pausedOperation({ paused_at: hoursAgo(9) })]);
    render(<UnfinishedWorkCard companyId="co1" />);

    expect(await screen.findByText(/2 of these have/i)).toBeInTheDocument();
  });
});
