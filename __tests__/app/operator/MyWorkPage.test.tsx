import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, waitFor, routerMocks } from '@/__tests__/test-utils';
import userEvent from '@testing-library/user-event';

import MyWorkPage from '@/app/operator/[companyId]/my-work/page';
import {
  getMyContributionTotals,
  getMyNotesPage,
  getNoteViewers,
  MY_NOTES_PAGE_SIZE,
} from '@/utils/operatorAccess';
import type { MyContributionTotals, MyNote } from '@/types/operator';

vi.mock('@/utils/operatorAccess', () => ({
  getMyContributionTotals: vi.fn(),
  getMyNotesPage: vi.fn(),
  getNoteViewers: vi.fn(),
  // The "Me" tab resolves the operator's display name through this.
  getCurrentMember: vi.fn(async () => ({ id: 'm1', name: 'Ada Lovelace', role: 'operator' })),
  MY_NOTES_PAGE_SIZE: 10,
}));

// This page became the "Me" tab, so it now reaches identity + Log out — which pull in
// `getCompany` and `getSupabase`. `lib/supabase` creates its client eagerly at module scope
// whenever `window` exists, so in jsdom merely importing it fails without env vars.
vi.mock('@/utils/companyAccess', () => ({
  getCompany: vi.fn(async () => ({ id: 'co1', name: 'Vanguard Precision Works' })),
}));
// Both getters return the same stub: the page reaches one for Log out and the feedback insert, and
// `useOperatorIdentity` reaches the other for the session. Stubbing only one left the identity load
// throwing.
//
// The stub is built INSIDE the factory on purpose — `vi.mock` is hoisted above every `const` in
// this file, so a factory closing over a module-scope helper fails with "cannot access before
// initialization" before a single test runs.
vi.mock('@/lib/supabase', () => {
  const stub = () => ({
    auth: {
      getSession: async () => ({
        data: { session: { user: { id: 'u1', email: 'ada@shop.test' } } },
      }),
      signOut: vi.fn(async () => ({ error: null })),
    },
    from: () => ({ insert: vi.fn(async () => ({ error: null })) }),
  });
  return { getSupabase: stub, getTypedSupabase: stub, supabase: null };
});

const mockGetTotals = vi.mocked(getMyContributionTotals);
const mockGetNotesPage = vi.mocked(getMyNotesPage);
const mockGetNoteViewers = vi.mocked(getNoteViewers);

function note(over: Partial<MyNote> = {}): MyNote {
  return {
    id: 'n1',
    body: 'Clamp on the boss, not the flange — it walks.',
    created_at: '2026-07-20T14:00:00Z',
    edited_at: null,
    operation_label: 'Op 20 · Mill',
    part_name: 'BRKT-1042',
    machine_name: null,
    maintenance_kind: null,
    job_id: 'job-1',
    job_number: 'J-0042',
    photo_count: 0,
    reactions: [],
    viewer_count: 0,
    usage_count: 0,
    ...over,
  };
}

/**
 * A maintenance entry, as it really arrives here.
 *
 * Maintenance is not a separate store: an entry is a `notes` row with
 * subject_kind='work_center', so it lands in the operator's own list beside their part and
 * job notes. The DB CHECK constraint permits exactly one subject, so a machine entry has NO
 * part, NO operation and NO job — which is why it needs the machine name to say anything at
 * all about what it concerns.
 */
function machineNote(over: Partial<MyNote> = {}): MyNote {
  return note({
    id: 'm1',
    body: 'Blade guard rattling at speed.',
    part_name: null,
    operation_label: null,
    job_id: null,
    job_number: null,
    machine_name: 'Bandsaw',
    maintenance_kind: 'noticed',
    ...over,
  });
}

/**
 * Stage the two loads the page makes. `totals` covers every note the operator has ever
 * written; `notes` is only the first page. They are deliberately separate arguments here
 * because the whole point of the split is that they CAN disagree — see the paging tests.
 */
function stage({
  notes = [note()],
  totals = {},
  hasMore = false,
}: {
  notes?: MyNote[];
  totals?: Partial<MyContributionTotals>;
  hasMore?: boolean;
} = {}) {
  mockGetTotals.mockResolvedValue({
    noteCount: notes.length,
    photoCount: 0,
    peopleReached: 0,
    ...totals,
  });
  mockGetNotesPage.mockResolvedValue({ notes, hasMore });
}

beforeEach(() => {
  routerMocks.push.mockClear();
  mockGetTotals.mockReset();
  mockGetNotesPage.mockReset();
  mockGetNoteViewers.mockReset();
  mockGetNoteViewers.mockResolvedValue([]);
});

describe('My Work', () => {
  it('shows what the operator wrote', async () => {
    stage({ totals: { photoCount: 2 } });
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
    stage();
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
    stage();
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
    stage({ notes: [note({ job_id: null, job_number: null })] });
    render(<MyWorkPage />);

    expect(await screen.findByText(/Clamp on the boss/)).toBeInTheDocument();
    expect(screen.queryByText(/J-0042/)).not.toBeInTheDocument();
  });

  it('counts VIEWS in the summary, not people', async () => {
    // peopleReached sums each note's viewer_count, so one colleague who read
    // three of your notes contributes three. Labelling that "people" overstates
    // it; a distinct-people figure would need the note_views rows, which no
    // browser role can read by design.
    stage({ totals: { peopleReached: 5 } });
    render(<MyWorkPage />);

    expect(await screen.findByText('views')).toBeInTheDocument();
    expect(screen.queryByText(/people have (used|viewed)/i)).not.toBeInTheDocument();
  });

  it('shows the view count alone, never a second job figure beside it', async () => {
    // Once both numbers are honestly labelled "viewed", a second one earns
    // nothing — it reads as a puzzle rather than a signal. usage_count stays on
    // the row for the Playbook to rank by; it is not the operator's business here.
    stage({ notes: [note({ viewer_count: 4, usage_count: 11 })] });
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
    stage();
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
    stage({ notes: [note({ viewer_count: 2, usage_count: 1 })] });
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
    stage({
      notes: [note({ viewer_count: 5, usage_count: 9 })],
      totals: { photoCount: 3, peopleReached: 5 },
    });
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
    stage({ notes: [] });
    render(<MyWorkPage />);

    expect(await screen.findByText('Nothing written yet')).toBeInTheDocument();
    // No zeroed scoreboard on a screen the operator has never used.
    expect(screen.queryByText('0')).not.toBeInTheDocument();
  });

  it('does not put a backend failure in front of an operator as a blank page', async () => {
    mockGetTotals.mockRejectedValue(new Error('denied'));
    mockGetNotesPage.mockRejectedValue(new Error('denied'));
    render(<MyWorkPage />);

    expect(await screen.findByText(/Could not load your work/)).toBeInTheDocument();
  });
});

/**
 * Paging, and the trap it sets.
 *
 * The list is a page at a time, but the summary card is about everything the operator has
 * ever written. Those totals used to be reduced out of the fetched rows, which was only
 * correct while "the fetched rows" meant "all of them". Deriving them from a page would turn
 * the operator's note count into a count of what happens to be rendered — a number that
 * climbs as they tap Show more, wearing the label of a number about their work.
 */
describe('My Work — paging', () => {
  it('reports every note in the summary, not just the page on screen', async () => {
    stage({ notes: [note()], totals: { noteCount: 37, photoCount: 12, peopleReached: 9 }, hasMore: true });
    render(<MyWorkPage />);

    await screen.findByText(/Clamp on the boss/);
    // One note rendered, thirty-seven written.
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    expect(screen.getByText('37')).toBeInTheDocument();
    expect(screen.getByText('12')).toBeInTheDocument();
    expect(screen.getByText('9')).toBeInTheDocument();
  });

  it('asks for the first page only, and asks by page size', async () => {
    stage();
    render(<MyWorkPage />);

    await screen.findByText(/Clamp on the boss/);
    expect(mockGetNotesPage).toHaveBeenCalledTimes(1);
    expect(mockGetNotesPage).toHaveBeenCalledWith('test-company-id');
    expect(MY_NOTES_PAGE_SIZE).toBe(10);
  });

  it('appends the next page on Show more rather than replacing what is there', async () => {
    const user = userEvent.setup();
    stage({ notes: [note({ id: 'n1', body: 'First note' })], hasMore: true });
    render(<MyWorkPage />);

    await screen.findByText('First note');
    mockGetNotesPage.mockResolvedValue({
      notes: [note({ id: 'n2', body: 'Second note' })],
      hasMore: false,
    });

    await user.click(screen.getByRole('button', { name: /show more/i }));

    // Both pages on screen — the first must not be discarded.
    expect(await screen.findByText('Second note')).toBeInTheDocument();
    expect(screen.getByText('First note')).toBeInTheDocument();
    // Offset is where the loaded list ends, not a page counter that can drift.
    expect(mockGetNotesPage).toHaveBeenLastCalledWith('test-company-id', { offset: 1 });
  });

  it('stops offering Show more once the last page comes back', async () => {
    const user = userEvent.setup();
    stage({ notes: [note({ id: 'n1', body: 'First note' })], hasMore: true });
    render(<MyWorkPage />);

    await screen.findByText('First note');
    mockGetNotesPage.mockResolvedValue({
      notes: [note({ id: 'n2', body: 'Second note' })],
      hasMore: false,
    });
    await user.click(screen.getByRole('button', { name: /show more/i }));
    await screen.findByText('Second note');

    expect(screen.queryByRole('button', { name: /show more/i })).not.toBeInTheDocument();
  });

  it('offers no Show more when the first page is the whole list', async () => {
    stage({ hasMore: false });
    render(<MyWorkPage />);

    await screen.findByText(/Clamp on the boss/);
    expect(screen.queryByRole('button', { name: /show more/i })).not.toBeInTheDocument();
  });

  it('keeps the loaded pages when one extra page fails', async () => {
    // A failed Show more must cost the tap, not the notes already on screen.
    const user = userEvent.setup();
    stage({ notes: [note({ id: 'n1', body: 'First note' })], hasMore: true });
    render(<MyWorkPage />);

    await screen.findByText('First note');
    mockGetNotesPage.mockRejectedValue(new Error('offline'));

    await user.click(screen.getByRole('button', { name: /show more/i }));

    expect(await screen.findByText(/Could not load more notes/)).toBeInTheDocument();
    expect(screen.getByText('First note')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /show more/i })).toBeInTheDocument();
  });

  /**
   * The retry above only works because `getMyNotesPage` REJECTS on a query failure.
   *
   * It used to swallow the error and resolve `{notes: [], hasMore: false}`, which took the
   * success path here: nothing appended, `hasMore` false, Show more removed from the DOM,
   * no error shown. One dropped request on a shop connection therefore made every
   * remaining note look deleted, on a screen that otherwise read as settled. The guard is
   * in the access layer (a rejected promise), so this asserts the component's half: an
   * empty page that is genuinely the end must retire the button, and only a rejection may
   * surface the retry — the two must not be conflated.
   */
  it('treats a genuinely empty last page as the end, not as a failure', async () => {
    const user = userEvent.setup();
    stage({ notes: [note({ id: 'n1', body: 'First note' })], hasMore: true });
    render(<MyWorkPage />);

    await screen.findByText('First note');
    mockGetNotesPage.mockResolvedValue({ notes: [], hasMore: false });

    await user.click(screen.getByRole('button', { name: /show more/i }));

    // Button retires, and NO error is claimed — nothing actually went wrong.
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /show more/i })).not.toBeInTheDocument(),
    );
    expect(screen.queryByText(/Could not load more notes/)).not.toBeInTheDocument();
    expect(screen.getByText('First note')).toBeInTheDocument();
  });
});

/**
 * This page is the "Me" tab: the operator's work, with identity and account actions folded in
 * around it now that Profile is no longer a bottom tab.
 */
describe('My Work — the "Me" tab', () => {
  it('shows the work itself, not an account screen you have to leave', async () => {
    stage();
    render(<MyWorkPage />);

    // The note is present on first paint — no second tap to reach your own work.
    expect(await screen.findByText(/Clamp on the boss/)).toBeInTheDocument();
    expect(await screen.findByText('Ada Lovelace')).toBeInTheDocument();
  });

  /**
   * A maintenance entry has no part, no operation and no job — the CHECK constraint on
   * `notes` allows exactly one subject and a machine entry's is the work center. Before the
   * machine name was selected, such an entry rendered as a bare sentence with nothing
   * anywhere on the row saying what it was about, sitting in a list where every other row
   * announced a part or a job. It was indistinguishable from a note whose context had been
   * lost.
   */
  it('names the machine on a maintenance entry, which has no other subject', async () => {
    stage({ notes: [machineNote()] });
    render(<MyWorkPage />);

    const row = (await screen.findAllByRole('listitem'))[0];
    expect(within(row).getByText('Bandsaw')).toBeInTheDocument();
    expect(within(row).getByText('noticed')).toBeInTheDocument();
    // Nothing invented: a machine entry has no job to point at.
    expect(within(row).queryByText(/J-\d+/)).not.toBeInTheDocument();
  });

  it('leaves an unclassified maintenance entry without a kind chip', async () => {
    // Classifying is optional and null is a common, legal state — so absence must render
    // as absence, not as a placeholder.
    stage({ notes: [machineNote({ maintenance_kind: null })] });
    render(<MyWorkPage />);

    const row = (await screen.findAllByRole('listitem'))[0];
    expect(within(row).getByText('Bandsaw')).toBeInTheDocument();
    expect(within(row).queryByText(/noticed|cleaned|repaired|adjusted|replaced/)).not.toBeInTheDocument();
  });

  it('keeps the part name for a part note, unchanged', async () => {
    stage({ notes: [note()] });
    render(<MyWorkPage />);

    const row = (await screen.findAllByRole('listitem'))[0];
    expect(within(row).getByText('BRKT-1042')).toBeInTheDocument();
    expect(within(row).getByText('Op 20 · Mill')).toBeInTheDocument();
  });

  /**
   * Give feedback moved above the work. It used to sit under the operator's entire note
   * list, which is the one place a pilot's feedback channel must not be: once the list
   * pages, reaching it means ten notes and a Show more, and the operators most likely to
   * have something to say are the ones who never scrolled that far.
   */
  it('puts Give feedback above the work, not after it', async () => {
    stage();
    render(<MyWorkPage />);

    const feedback = await screen.findByRole('button', { name: /give feedback/i });
    const firstNote = screen.getAllByRole('listitem')[0];
    expect(
      feedback.compareDocumentPosition(firstNote) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('puts the email in the identity row, not in a caption further down', async () => {
    // It used to read "Signed in as …" near the bottom of the page. That was a second,
    // worse home for a fact that is plainly identity — and it was behind the whole note
    // list, so the one time it matters (reading your address out to support) it was the
    // hardest thing on the screen to reach.
    stage();
    render(<MyWorkPage />);

    const email = await screen.findByText('ada@shop.test');
    expect(email).toBeInTheDocument();
    expect(screen.queryByText(/signed in as/i)).not.toBeInTheDocument();

    // Above the work, not below it.
    const firstNote = screen.getAllByRole('listitem')[0];
    expect(email.compareDocumentPosition(firstNote) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  /**
   * The regression this guards is severe rather than cosmetic. The loading, error and empty
   * states used to be early returns from the page component. Folding Profile in without moving
   * them would have left a brand-new operator — zero notes, i.e. the common case — with no Log
   * out button anywhere in the app, because Profile had just stopped being a tab.
   */
  it('can still log out with nothing written yet', async () => {
    stage({ notes: [] });
    render(<MyWorkPage />);

    expect(await screen.findByText('Nothing written yet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /log out/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /give feedback/i })).toBeInTheDocument();
  });

  it('can still log out when the work fails to load', async () => {
    mockGetTotals.mockRejectedValue(new Error('denied'));
    mockGetNotesPage.mockRejectedValue(new Error('denied'));
    render(<MyWorkPage />);

    expect(await screen.findByText(/Could not load your work/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /log out/i })).toBeInTheDocument();
  });

  /**
   * Log out moved from "last on the page, set apart" to "an isolated icon in the identity row",
   * and the safety argument moved with it — from DISTANCE to ISOLATION.
   *
   * The old placement put it below the operator's entire note list, which is unbounded. Once
   * the list pages, distance stops meaning "slightly slower to reach" and starts meaning "past
   * however many Show mores it takes", which is not a safety property, it is a broken control.
   *
   * The slip NN/g's proximity guidance protects against is a mis-tap onto a consequential
   * action from a benign one BESIDE it. So what this asserts is the replacement invariant:
   * Log out is the only thing you can tap in that row. Nothing adjacent means nothing to slip
   * from — which is the same reasoning the operator layout uses to forbid a second icon button
   * in the header, applied rather than contradicted.
   */
  it('leaves Log out with no neighbouring tap target to slip from', async () => {
    stage();
    render(<MyWorkPage />);

    const logout = await screen.findByRole('button', { name: /log out/i });
    const row = logout.parentElement!;

    // Sole interactive element in its row.
    expect(within(row).getAllByRole('button')).toHaveLength(1);
    expect(within(row).queryAllByRole('link')).toHaveLength(0);

    // And reachable before the work rather than after it — the point of the move.
    const firstNote = screen.getAllByRole('listitem')[0];
    expect(
      logout.compareDocumentPosition(firstNote) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});
