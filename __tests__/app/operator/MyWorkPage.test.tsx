import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@/__tests__/test-utils';
import userEvent from '@testing-library/user-event';

import MyWorkPage from '@/app/operator/[companyId]/my-work/page';
import { getMyContribution, getNoteViewers } from '@/utils/operatorAccess';
import type { MyContribution, MyNote } from '@/types/operator';

vi.mock('@/utils/operatorAccess', () => ({
  getMyContribution: vi.fn(),
  getNoteViewers: vi.fn(),
}));

const mockGetMyContribution = vi.mocked(getMyContribution);
const mockGetNoteViewers = vi.mocked(getNoteViewers);

function note(over: Partial<MyNote> = {}): MyNote {
  return {
    id: 'n1',
    body: 'Clamp on the boss, not the flange — it walks.',
    created_at: '2026-07-20T14:00:00Z',
    operation_label: 'Op 20 · Mill',
    part_name: 'BRKT-1042',
    photo_count: 0,
    viewer_count: 0,
    usage_count: 0,
    ...over,
  };
}

function contribution(over: Partial<MyContribution> = {}): MyContribution {
  const notes = over.notes ?? [note()];
  return {
    noteCount: notes.length,
    photoCount: 0,
    peopleReached: 0,
    jobsReached: 0,
    ...over,
    notes,
  };
}

beforeEach(() => {
  mockGetMyContribution.mockReset();
  mockGetNoteViewers.mockReset();
  mockGetNoteViewers.mockResolvedValue([]);
});

describe('My Work', () => {
  it('shows what the operator wrote', async () => {
    mockGetMyContribution.mockResolvedValue(contribution({ photoCount: 2 }));
    render(<MyWorkPage />);

    expect(await screen.findByText(/Clamp on the boss/)).toBeInTheDocument();
    expect(screen.getByText('BRKT-1042')).toBeInTheDocument();
    expect(screen.getByText('Op 20 · Mill')).toBeInTheDocument();
  });

  it('reports reach as people AND jobs, because they mean different things', async () => {
    // A note read by 11 people once is curiosity; one used on 11 jobs is
    // load-bearing. Collapsing them into a single number loses the distinction
    // the whole two-counter schema exists to preserve.
    mockGetMyContribution.mockResolvedValue(
      contribution({ notes: [note({ viewer_count: 4, usage_count: 11 })] }),
    );
    render(<MyWorkPage />);

    expect(await screen.findByText('Used on 11 jobs by 4 people')).toBeInTheDocument();
  });

  it('says so plainly when nobody has used a note yet', async () => {
    // Silence would read as a bug. "Not used yet" is true of every note on the
    // day it is written, and the operator can tell the difference.
    mockGetMyContribution.mockResolvedValue(contribution());
    render(<MyWorkPage />);

    expect(await screen.findByText('Not used yet')).toBeInTheDocument();
  });

  it('names the readers only when the author asks', async () => {
    // note_viewers() is the single window through which a reader's name is ever
    // exposed. It must never fire as part of a list render.
    const user = userEvent.setup();
    mockGetMyContribution.mockResolvedValue(
      contribution({ notes: [note({ viewer_count: 2, usage_count: 1 })] }),
    );
    mockGetNoteViewers.mockResolvedValue([
      { viewer_name: 'Diego', job_number: 'J-0004' },
      { viewer_name: 'Priya', job_number: 'J-0006' },
    ]);
    render(<MyWorkPage />);

    await screen.findByText(/Clamp on the boss/);
    expect(mockGetNoteViewers).not.toHaveBeenCalled();

    await user.click(screen.getByText(/Clamp on the boss/));

    expect(await screen.findByText('Diego · J-0004')).toBeInTheDocument();
    expect(screen.getByText('Priya · J-0006')).toBeInTheDocument();
    expect(mockGetNoteViewers).toHaveBeenCalledTimes(1);
    expect(mockGetNoteViewers).toHaveBeenCalledWith('n1');
  });

  it('is not tappable at all on a note nobody has read', async () => {
    // Nothing to reveal, so the card must not offer the gesture — an expand that
    // opens onto an empty list reads as a failed load.
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    mockGetMyContribution.mockResolvedValue(contribution());
    render(<MyWorkPage />);

    await screen.findByText(/Clamp on the boss/);
    expect(screen.getByRole('button')).toBeDisabled();

    await user.click(screen.getByRole('button'));
    await waitFor(() => expect(mockGetNoteViewers).not.toHaveBeenCalled());
  });

  it('shows no completion count, streak, average or pace', async () => {
    // The guardrail, asserted where it is most likely to erode: a contribution
    // screen is exactly where a leaderboard wants to grow. Nothing here may
    // reflect an operator's pace or standing back at them, or rank them against
    // anyone else.
    mockGetMyContribution.mockResolvedValue(
      contribution({
        photoCount: 3,
        peopleReached: 5,
        jobsReached: 9,
        notes: [note({ viewer_count: 5, usage_count: 9 })],
      }),
    );
    const { container } = render(<MyWorkPage />);

    await screen.findByText(/Clamp on the boss/);
    const text = container.textContent ?? '';
    for (const forbidden of [
      /streak/i,
      /average/i,
      /\bpace\b/i,
      /completed/i,
      /completion/i,
      /rank/i,
      /leaderboard/i,
      /per hour/i,
      /minutes/i,
    ]) {
      expect(text).not.toMatch(forbidden);
    }
  });

  it('invites a first note rather than showing an empty scoreboard', async () => {
    mockGetMyContribution.mockResolvedValue(contribution({ notes: [] }));
    render(<MyWorkPage />);

    expect(await screen.findByText('Nothing written yet')).toBeInTheDocument();
    expect(screen.queryByText('0')).not.toBeInTheDocument();
  });

  it('does not put a backend failure in front of an operator as a blank page', async () => {
    mockGetMyContribution.mockRejectedValue(new Error('denied'));
    render(<MyWorkPage />);

    expect(await screen.findByText(/Could not load your work/)).toBeInTheDocument();
  });
});
