import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@/__tests__/test-utils';
import MyWorkJournal from '@/components/operator/MyWorkJournal';
import type { OperationIntervalWithContext } from '@/types/operationInterval';

const { getMyIntervalJournal } = vi.hoisted(() => ({
  getMyIntervalJournal: vi.fn(),
}));

vi.mock('@/utils/operationIntervalsAccess', () => ({ getMyIntervalJournal }));

function entry(over: Partial<OperationIntervalWithContext> = {}): OperationIntervalWithContext {
  return {
    id: 'i1',
    job_operation_id: 'op1',
    job_part_id: 'jp1',
    work_center_id: 'wc1',
    started_at: '2026-08-16T14:12:00.000Z',
    ended_at: '2026-08-16T15:59:00.000Z',
    adjusted_started_at: null,
    adjusted_ended_at: null,
    adjusted_at: null,
    effective_started_at: '2026-08-16T14:12:00.000Z',
    effective_ended_at: '2026-08-16T15:59:00.000Z',
    close_reason: 'completed',
    capture_source: 'operator',
    note: null,
    job_id: 'j1',
    job_number: 'J-0007',
    operation_sequence: 30,
    operation_name: 'Deburr',
    part_name: 'ACTUATOR-200',
    ...over,
  };
}

beforeEach(() => {
  getMyIntervalJournal.mockReset();
});

describe('MyWorkJournal', () => {
  it('names the work each entry belongs to', async () => {
    // A bare clock with no referent is useless to an operator running three
    // machines — the row has to say which job and which step it was.
    getMyIntervalJournal.mockResolvedValue([entry()]);
    render(<MyWorkJournal companyId="c1" />);

    await screen.findByText(/Deburr · J-0007/);
    expect(screen.getByText(/1h 47m/)).toBeTruthy();
  });

  it('renders NO aggregate scalar over the entries', async () => {
    // THE GUARDRAIL, asserted where it would erode first. One entry is a record;
    // two entries summed are a metric. This component's entire safety is that it
    // has no single number on it to optimise — a row count, a period total or an
    // average would reintroduce exactly the private counter Etkin 2016 measured
    // raising output while quality fell. See
    // docs/modules/operator-view.md#surveillance-guardrail-non-negotiable.
    getMyIntervalJournal.mockResolvedValue([
      entry({ id: 'a' }),
      entry({ id: 'b', job_number: 'J-0008' }),
      entry({ id: 'c', job_number: 'J-0009' }),
    ]);
    const { container } = render(<MyWorkJournal companyId="c1" />);

    await screen.findByText(/J-0009/);
    const text = container.textContent ?? '';

    for (const forbidden of [
      /streak/i,
      /average/i,
      /\bpace\b/i,
      /\brank\b/i,
      /leaderboard/i,
      /per hour/i,
      /\bminutes\b/i,
      /\btotal\b/i,
      /\bentries\b/i,
      /this (week|month)/i,
      /\bso far this\b/i,
    ]) {
      expect(text, `journal must not surface ${forbidden}`).not.toMatch(forbidden);
    }
  });

  it('shows the recorded times beside a correction, without accusing anyone', async () => {
    getMyIntervalJournal.mockResolvedValue([
      entry({
        adjusted_started_at: '2026-08-16T13:52:00.000Z',
        adjusted_at: '2026-08-16T16:00:00.000Z',
        effective_started_at: '2026-08-16T13:52:00.000Z',
      }),
    ]);
    const { container } = render(<MyWorkJournal companyId="c1" />);

    await screen.findByText(/Recorded/);
    const text = container.textContent ?? '';
    // Neutral and agentless: no actor, no edit count, no "edited by".
    expect(text).not.toMatch(/edited by|changed by|corrected by/i);
    expect(text).not.toMatch(/\b\d+ (edits?|adjustments?|corrections?)\b/i);
  });

  it('renders nothing at all when there is no recorded time', async () => {
    // No empty state, no nudge to start using the timer. A surface that badgers
    // an operator about their own participation is the thing this module refuses.
    getMyIntervalJournal.mockResolvedValue([]);
    const { container } = render(<MyWorkJournal companyId="c1" />);

    await waitFor(() => expect(getMyIntervalJournal).toHaveBeenCalled());
    expect(container.textContent).toBe('');
  });

  it('never claims the journal is private', async () => {
    // The shop holds the same records. A privacy claim that is not true would be
    // discovered, and would poison everything else on this screen.
    getMyIntervalJournal.mockResolvedValue([entry()]);
    const { container } = render(<MyWorkJournal companyId="c1" />);

    await screen.findByText(/Deburr/);
    expect(container.textContent ?? '').not.toMatch(/\bprivate\b|only you can see/i);
  });

  it('surfaces a load failure rather than rendering as empty', async () => {
    // An empty journal and a broken query must not look the same — that is how
    // the NewHelpful 400 shipped unnoticed.
    getMyIntervalJournal.mockRejectedValue(new Error('boom'));
    render(<MyWorkJournal companyId="c1" />);

    await screen.findByText(/Couldn't load this just now/i);
  });
});
