import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@/__tests__/test-utils';
import userEvent from '@testing-library/user-event';

/**
 * The operator's own running and paused work, above the dispatch queue.
 *
 * WHAT THESE TESTS ARE FOR. This panel is the closest thing in the app to the
 * header strip withdrawn on 2026-08-17, and the two rules that made that
 * withdrawal safe have to keep holding as it grows:
 *
 *   1. NO STEP-LEVEL CONTROL LEAVES THE STEP SCREEN. Every row here is a link.
 *      A RECORD, Pause or Cancel button appearing on the jobs list is the exact
 *      regression the E2E suite also watches for.
 *   2. NO SCALAR. A count, total or average over an operator's own work is the
 *      number that describes the PERSON rather than the job in front of them —
 *      docs/modules/operator-view.md#surveillance-guardrail-non-negotiable — and
 *      this surface is precisely where one wants to grow.
 *
 * A third is enforced in SQL and asserted here as a backstop: no estimate, and
 * nothing derived from one, on an operator surface.
 */
const nav = { push: vi.fn(), goBack: vi.fn() };
vi.mock('@/components/operator/OperatorChromeContext', () => ({
  useOperatorNav: () => nav,
}));

const state: { open: unknown[]; paused: unknown[] } = { open: [], paused: [] };
vi.mock('@/components/operator/OperatorIntervalContext', () => ({
  useIntervalContext: () => ({
    openIntervals: state.open,
    pausedOperations: state.paused,
    serverSkewMs: 0,
    loading: false,
  }),
}));

vi.mock('next/navigation', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('next/navigation');
  return { ...actual, useParams: () => ({ companyId: 'co1' }) };
});

import RunningNowPanel from '@/components/operator/RunningNowPanel';

const hoursAgo = (n: number) => new Date(Date.now() - n * 3_600_000).toISOString();

const running = (over = {}) => ({
  id: 'iv1',
  job_operation_id: 'op1',
  job_part_id: 'jp1',
  job_id: 'job1',
  job_number: 'J-0007',
  operation_name: 'Mill OP 10',
  part_name: 'BRACKET',
  effective_started_at: hoursAgo(2),
  ...over,
});

const paused = (over = {}) => ({
  interval_id: 'iv9',
  job_operation_id: 'op9',
  job_part_id: 'jp9',
  job_id: 'job9',
  job_number: 'J-0042',
  operation_name: 'Deburr',
  part_name: 'PLATE',
  work_center_name: 'Bench 1',
  paused_at: hoursAgo(1),
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  state.open = [];
  state.paused = [];
});

describe('RunningNowPanel', () => {
  it('renders nothing when the operator holds nothing', () => {
    const { container } = render(<RunningNowPanel />);
    expect(container).toBeEmptyDOMElement();
  });

  it('lists every machine the operator has running, not just one', () => {
    // THE WHOLE REASON IT EXISTS. The chain keys on the WORK CENTRE, so one
    // operator legitimately holds several open spans — three spindles is a normal
    // Tuesday — and the step screen only ever shows the one being looked at.
    state.open = [
      running(),
      running({ id: 'iv2', job_operation_id: 'op2', job_number: 'J-0009', operation_name: 'Lathe OP 20' }),
    ];
    render(<RunningNowPanel />);

    expect(screen.getByText(/J-0007 · Mill OP 10/)).toBeInTheDocument();
    expect(screen.getByText(/J-0009 · Lathe OP 20/)).toBeInTheDocument();
  });

  it('routes a row to its step screen and nowhere else', () => {
    state.open = [running()];
    render(<RunningNowPanel />);

    return userEvent.click(screen.getByText(/J-0007 · Mill OP 10/)).then(() => {
      expect(nav.push).toHaveBeenCalledWith(
        '/operator/co1/jobs/job1/parts/jp1/operations/op1',
      );
    });
  });

  it('carries no step-level control', () => {
    // The half of the 2026-08-17 withdrawal that still stands.
    state.open = [running()];
    state.paused = [paused()];
    render(<RunningNowPanel />);

    expect(screen.queryByRole('button', { name: /record/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /cancel activity/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^pause/i })).not.toBeInTheDocument();
  });

  it('shows no count, total or average over the operator\'s work', () => {
    state.open = [running(), running({ id: 'iv2', job_operation_id: 'op2' })];
    state.paused = [paused()];
    render(<RunningNowPanel />);

    expect(screen.queryByText(/\b3 (running|items|steps|jobs)\b/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/total|average|per hour|so far today|this week/i)).not.toBeInTheDocument();
  });

  it('shows no estimate and nothing derived from one', () => {
    // Enforced in SQL too — get_my_paused_operations does not return the column —
    // but asserted here because the running rows come from a shape that has other
    // fields on it, and the guardrail calls this the half that must not move.
    state.open = [running()];
    render(<RunningNowPanel />);

    expect(screen.queryByText(/est\.|estimate|estimated/i)).not.toBeInTheDocument();
  });

  it('separates paused work from running work', () => {
    state.open = [running()];
    state.paused = [paused()];
    render(<RunningNowPanel />);

    expect(screen.getByText('Running now')).toBeInTheDocument();
    expect(screen.getByText('Paused')).toBeInTheDocument();
    expect(screen.getByText(/Paused .* · .* ago/)).toBeInTheDocument();
  });

  it('shows paused work even when nothing is running', () => {
    // Otherwise Pause is a control that hides the work it is used on.
    state.paused = [paused()];
    render(<RunningNowPanel />);

    expect(screen.getByText(/J-0042 · Deburr/)).toBeInTheDocument();
  });

  it('asks for a decision on a step running past the flat ceiling', () => {
    state.open = [running({ effective_started_at: hoursAgo(9) })];
    render(<RunningNowPanel />);

    expect(screen.getByText(/Finish it, pause it, or cancel it/i)).toBeInTheDocument();
  });

  it('says nothing about a step running a normal length of time', () => {
    state.open = [running({ effective_started_at: hoursAgo(2) })];
    render(<RunningNowPanel />);

    expect(screen.queryByText(/Finish it, pause it, or cancel it/i)).not.toBeInTheDocument();
  });

  it('shows a running clock but never one on a paused row', () => {
    // Nothing is ticking on a paused span, and a stopwatch there would claim it is.
    state.paused = [paused()];
    render(<RunningNowPanel />);

    expect(screen.queryByText(/^\d+:\d{2}:\d{2}$/)).not.toBeInTheDocument();
  });
});
