import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/__tests__/test-utils';

import FeedTimeEntry from '@/components/operator/FeedTimeEntry';
import type { OperationIntervalWithContext } from '@/types/operationInterval';

/**
 * The Finished row's caption, which had no unit coverage at all — its only pin
 * was an E2E assertion, so a copy edit here would have shipped on a green local
 * run and surfaced a browser away.
 */
const interval = (over: Partial<OperationIntervalWithContext> = {}): OperationIntervalWithContext => ({
  id: 'iv1',
  job_operation_id: 'op1',
  job_part_id: 'jp1',
  work_center_id: 'wc1',
  started_at: '2026-08-16T09:00:00Z',
  ended_at: '2026-08-16T10:41:00Z',
  adjusted_started_at: null,
  adjusted_ended_at: null,
  adjusted_at: null,
  effective_started_at: '2026-08-16T09:00:00Z',
  effective_ended_at: '2026-08-16T10:41:00Z',
  close_reason: 'completed',
  capture_source: 'operator',
  note: null,
  quantity_good: 3,
  job_id: 'j1',
  job_number: 'J-0020',
  operation_name: 'Final Inspection',
  operation_sequence: 30,
  part_name: 'Valve Manifold',
  ...over,
});

describe('FeedTimeEntry', () => {
  it('says how many parts came off the step', () => {
    render(<FeedTimeEntry interval={interval()} kind="finish" onAdjust={vi.fn()} />);
    expect(screen.getByText(/3 parts/)).toBeInTheDocument();
  });

  it('pluralises on the count, not on a fixed suffix', () => {
    // "1 parts" is the sort of thing nobody notices in review and every operator
    // notices on the floor.
    render(<FeedTimeEntry interval={interval({ quantity_good: 1 })} kind="finish" onAdjust={vi.fn()} />);
    expect(screen.getByText(/\b1 part\b/)).toBeInTheDocument();
    expect(screen.queryByText(/1 parts/)).not.toBeInTheDocument();
  });

  it('says nothing about quantity when no completion claimed the interval', () => {
    // A 'switched' interval is real work that no completion covers. Rendering
    // "0 parts" would be a fabricated number, not an absent one.
    render(
      <FeedTimeEntry
        interval={interval({ quantity_good: null, close_reason: 'switched' })}
        kind="finish"
        onAdjust={vi.fn()}
      />,
    );
    expect(screen.queryByText(/part/)).not.toBeInTheDocument();
  });

  it('offers no Adjust while the interval is still running', () => {
    // A running interval has no finish to check a new start against, so a
    // correction made now can be contradicted by the finish that follows —
    // and job_op_intervals_adjust_only_when_closed would reject it anyway.
    // ABSENT rather than disabled: a dead control invites tapping it.
    render(
      <FeedTimeEntry
        interval={interval({ ended_at: null, effective_ended_at: null, close_reason: null, quantity_good: null })}
        kind="start"
        onAdjust={vi.fn()}
      />,
    );
    expect(screen.getByText(/^Started /)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /adjust/i })).not.toBeInTheDocument();
  });

  it('offers Adjust once the interval is closed', () => {
    render(<FeedTimeEntry interval={interval()} kind="start" onAdjust={vi.fn()} />);
    expect(screen.getByRole('button', { name: /adjust/i })).toBeInTheDocument();
  });

  it('never puts a quantity or a duration on the START row', () => {
    // The start row is the moment work began. A count there would attach an
    // outcome to an event that has none yet.
    render(<FeedTimeEntry interval={interval()} kind="start" onAdjust={vi.fn()} />);
    expect(screen.getByText(/^Started /)).toBeInTheDocument();
    expect(screen.queryByText(/part/)).not.toBeInTheDocument();
    expect(screen.queryByText(/1h/)).not.toBeInTheDocument();
  });
});
