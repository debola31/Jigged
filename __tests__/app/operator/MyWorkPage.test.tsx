import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, routerMocks } from '@/__tests__/test-utils';
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
    job_id: 'job-1',
    job_number: 'J-0042',
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
    ...over,
    notes,
  };
}

beforeEach(() => {
  routerMocks.push.mockClear();
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
    // Where it came from, beside the date — visible without expanding anything.
    expect(screen.getByText(/J-0042 · Jul 20, 2026/)).toBeInTheDocument();
  });

  it('leads back to the job the note was written on', async () => {
    // A note with no context is an orphan: the author cannot tell what they were
    // looking at when they wrote it, let alone go and check. The link lives in
    // the expanded state so the row itself stays one compact tap target.
    const user = userEvent.setup();
    mockGetMyContribution.mockResolvedValue(contribution());
    render(<MyWorkPage />);

    await user.click(await screen.findByText(/Clamp on the boss/));
    await user.click(await screen.findByRole('button', { name: /Open J-0042/ }));

    expect(routerMocks.push).toHaveBeenCalledWith(
      '/operator/test-company-id/jobs/job-1',
    );
  });

  it('opens on a note nobody has read, so its job is still reachable', async () => {
    // The card used to be inert at zero views. That stranded exactly the notes an
    // author is most likely to be checking up on — no viewers AND no way back to
    // the job. There is always something behind the tap now.
    const user = userEvent.setup();
    mockGetMyContribution.mockResolvedValue(contribution());
    render(<MyWorkPage />);

    await user.click(await screen.findByText(/Clamp on the boss/));

    expect(await screen.findByRole('button', { name: /Open J-0042/ })).toBeInTheDocument();
    // Still no pointless RPC: there are no names to fetch.
    expect(mockGetNoteViewers).not.toHaveBeenCalled();
    expect(screen.queryByText('Viewed by')).not.toBeInTheDocument();
  });

  it('survives a note whose job has been deleted', async () => {
    // Provenance is ON DELETE SET NULL: the knowledge outlives its origin, so a
    // missing job must cost the link, never the note.
    mockGetMyContribution.mockResolvedValue(
      contribution({ notes: [note({ job_id: null, job_number: null })] }),
    );
    render(<MyWorkPage />);

    expect(await screen.findByText(/Clamp on the boss/)).toBeInTheDocument();
    expect(screen.queryByText(/J-0042/)).not.toBeInTheDocument();
  });

  it('counts VIEWS in the summary, not people', async () => {
    // peopleReached sums each note's viewer_count, so one colleague who read
    // three of your notes contributes three. Labelling that "people" overstates
    // it; a distinct-people figure would need the note_views rows, which no
    // browser role can read by design.
    mockGetMyContribution.mockResolvedValue(contribution({ peopleReached: 5 }));
    render(<MyWorkPage />);

    expect(await screen.findByText('views')).toBeInTheDocument();
    expect(screen.queryByText(/people have (used|viewed)/i)).not.toBeInTheDocument();
  });

  it('shows the view count alone, never a second job figure beside it', async () => {
    // Once both numbers are honestly labelled "viewed", a second one earns
    // nothing — it reads as a puzzle rather than a signal. usage_count stays on
    // the row for the Playbook to rank by; it is not the operator's business here.
    mockGetMyContribution.mockResolvedValue(
      contribution({ notes: [note({ viewer_count: 4, usage_count: 11 })] }),
    );
    render(<MyWorkPage />);

    await screen.findByText(/Clamp on the boss/);
    expect(within(screen.getAllByRole('listitem')[0]).getByText('4')).toBeInTheDocument();
    expect(screen.queryByText(/11/)).not.toBeInTheDocument();
    expect(screen.queryByText(/\d+ jobs?\b/)).not.toBeInTheDocument();
  });

  it('shows an unread note as a zero, not as a sentence about being unread', async () => {
    // An earlier pass rendered "Not used yet" under every note; seven of those
    // down a real screen is a column of apologies. A count reads the same at
    // zero as at four — it just hasn't moved yet.
    mockGetMyContribution.mockResolvedValue(contribution());
    render(<MyWorkPage />);

    await screen.findByText(/Clamp on the boss/);
    // Scoped to the note card — the summary block carries its own "0 views".
    expect(within(screen.getAllByRole('listitem')[0]).getByText('0')).toBeInTheDocument();
    expect(screen.queryByText(/not used/i)).not.toBeInTheDocument();
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

  it('shows no completion count, streak, average or pace', async () => {
    // The guardrail, asserted where it is most likely to erode: a contribution
    // screen is exactly where a leaderboard wants to grow. Nothing here may
    // reflect an operator's pace or standing back at them, or rank them against
    // anyone else.
    mockGetMyContribution.mockResolvedValue(
      contribution({
        photoCount: 3,
        peopleReached: 5,
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
    // No zeroed scoreboard on a screen the operator has never used.
    expect(screen.queryByText('0')).not.toBeInTheDocument();
  });

  it('does not put a backend failure in front of an operator as a blank page', async () => {
    mockGetMyContribution.mockRejectedValue(new Error('denied'));
    render(<MyWorkPage />);

    expect(await screen.findByText(/Could not load your work/)).toBeInTheDocument();
  });
});
