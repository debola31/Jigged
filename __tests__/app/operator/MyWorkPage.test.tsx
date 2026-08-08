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
import { syncDemoAccess } from '@/utils/demoAccess';
import type { MyContributionTotals, MyNote } from '@/types/operator';

vi.mock('@/utils/operatorAccess', () => ({
  getMyContributionTotals: vi.fn(),
  getMyNotesPage: vi.fn(),
  getNoteViewers: vi.fn(),
  getNewHelpful: vi.fn(async () => []),
  markHelpfulSeen: vi.fn(async () => {}),
  MAX_HELPFUL_NAMES: 3,
  // The "Me" tab resolves the operator's display name through this.
  getCurrentMember: vi.fn(async () => ({ id: 'm1', name: 'Ada Lovelace', role: 'operator' })),
  MY_NOTES_PAGE_SIZE: 10,
}));

// This page became the "Me" tab, so it now reaches identity + Log out — which pull in
// `getCompany` and `getSupabase`. `lib/supabase` creates its client eagerly at module scope
// whenever `window` exists, so in jsdom merely importing it fails without env vars.
// `homePathForRole` and `setLastCompany` come through for the company switcher below; spreading the
// real module rather than listing stubs keeps `homePathForRole`'s operator/dashboard split honest,
// which is the whole thing the switcher test is asserting.
vi.mock('@/utils/companyAccess', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/companyAccess')>();
  return {
    ...actual,
    getCompany: vi.fn(async () => ({ id: 'co1', name: 'Vanguard Precision Works' })),
    setLastCompany: vi.fn(async () => {}),
  };
});

// The operator company switcher reads this. Assigned per test via `stageCompanies`; the factory
// only closes over the binding and never reads it, so the hoisting trap described above doesn't
// bite (the arrow runs at render time, long after the `let` initialises).
let companiesStub: Array<{
  company_id: string;
  role: string;
  companies: { id: string; name: string };
}> = [];
vi.mock('@/hooks/useCompanies', () => ({
  useCompanies: () => ({ companies: companiesStub, loading: false, error: null }),
}));

// The identity row reaches the demo-mode entry, which reads the operator company context.
// That context is mounted by the operator LAYOUT, not by this page, and `useOperatorCompany`
// throws without a provider on purpose (the same contract `useDemoMode` has) — so it is stubbed
// here rather than the hook made forgiving, which would hide a real mounting bug.
//
// Assigned per test via `stageDemo`; same late-binding trick as `companiesStub` above.
let demoStub = {
  companyId: 'test-company-id',
  companyName: 'Vanguard Precision Works' as string | null,
  isDemo: false,
  hasDemo: false,
  demoCompanyId: null as string | null,
  realCompanyId: 'test-company-id' as string | null,
  features: {},
  loading: false,
};
vi.mock('@/components/operator/OperatorCompanyContext', () => ({
  useOperatorCompany: () => demoStub,
}));

vi.mock('@/utils/demoAccess', () => ({
  syncDemoAccess: vi.fn(async () => {}),
}));

const CURRENT_COMPANY_ID = 'test-company-id'; // what the mocked useParams hands the page

/** No demo set up is the default; pass a demo id for the shop whose admin has made one. */
function stageDemo(over: Partial<typeof demoStub> = {}) {
  demoStub = {
    companyId: CURRENT_COMPANY_ID,
    companyName: 'Vanguard Precision Works',
    isDemo: false,
    hasDemo: false,
    demoCompanyId: null,
    realCompanyId: CURRENT_COMPANY_ID,
    features: {},
    loading: false,
    ...over,
  };
}

function stageCompanies(
  list: Array<{ id: string; name: string; role: string }> = [],
) {
  companiesStub = list.map((c) => ({
    company_id: c.id,
    role: c.role,
    companies: { id: c.id, name: c.name },
  }));
}
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
  return { getSupabase: stub, supabase: null };
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
  // Single-company by default — which is what nearly every real operator is.
  stageCompanies([{ id: CURRENT_COMPANY_ID, name: 'Vanguard Precision Works', role: 'operator' }]);
  // No demo set up by default, so the demo entry is absent unless a test asks for it.
  stageDemo();
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
    // ONE quiet reference beside the date, and nothing leading the row. The subject
    // used to lead in bold with the step as a chip, which made a list of what the
    // operator wrote read as a list of stations.
    expect(screen.getByText(/J-0042 · Jul 20, 2026/)).toBeInTheDocument();
    expect(screen.queryByText('BRKT-1042')).not.toBeInTheDocument();
    expect(screen.queryByText('Op 20 · Mill')).not.toBeInTheDocument();
  });

  it('leads back to the job the note was written on', async () => {
    // A note with no context is an orphan: the author cannot tell what they were
    // looking at when they wrote it, let alone go and check. The route back lives
    // in the overflow menu, first and furthest from Delete.
    const user = userEvent.setup();
    stage();
    render(<MyWorkPage />);

    await user.click(await screen.findByRole('button', { name: /actions for this note/i }));
    await user.click(await screen.findByRole('menuitem', { name: /Open J-0042/ }));

    expect(routerMocks.push).toHaveBeenCalledWith(
      '/operator/test-company-id/jobs/job-1',
    );
  });

  it('reaches the job of a note nobody has read', async () => {
    // The row used to be inert at zero views, which stranded exactly the notes an
    // author is most likely to be checking up on — no viewers AND no way back to
    // the job. The menu does not depend on the view count, so the route survives.
    const user = userEvent.setup();
    stage();
    render(<MyWorkPage />);

    await user.click(await screen.findByRole('button', { name: /actions for this note/i }));

    expect(await screen.findByRole('menuitem', { name: /Open J-0042/ })).toBeInTheDocument();
    // Still no pointless RPC: there are no names to fetch.
    expect(mockGetNoteViewers).not.toHaveBeenCalled();
    expect(screen.queryByText('Viewed by')).not.toBeInTheDocument();
  });

  /**
   * The row body does nothing, and that is the design.
   *
   * NN/g measured across 136 participants and 11 mobile prototypes that when a row body
   * and a trailing control do different things, people tap them about equally. A row that
   * both expands on body-tap AND carries a menu is therefore a coin flip on every tap —
   * which is unacceptable when one of the outcomes is a delete menu. So the readers open
   * from the eye on the far left and the actions from the overflow on the far right, with
   * nothing tappable in between.
   */
  it('does nothing when the note body is tapped', async () => {
    const user = userEvent.setup();
    stage({ notes: [note({ viewer_count: 2 })] });
    render(<MyWorkPage />);

    await user.click(await screen.findByText(/Clamp on the boss/));

    expect(mockGetNoteViewers).not.toHaveBeenCalled();
    expect(screen.queryByText('Viewed by')).not.toBeInTheDocument();
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('offers no reader disclosure at all when nobody has read it', async () => {
    // One tap target on an unread row, not two: there are no names to ask for, so the
    // count is a number rather than a control.
    stage({ notes: [note({ viewer_count: 0 })] });
    render(<MyWorkPage />);

    await screen.findByText(/Clamp on the boss/);
    expect(screen.queryByRole('button', { name: /who read this/i })).not.toBeInTheDocument();
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

    expect(await screen.findByText('Times viewed')).toBeInTheDocument();
    expect(screen.queryByText(/people have (used|viewed)/i)).not.toBeInTheDocument();
    // "viewed", never "used" — all that was recorded is that somebody opened the note.
    expect(screen.queryByText(/used/i)).not.toBeInTheDocument();
  });

  /**
   * The summary heading predicates THE NOTES, not the operator.
   *
   * It used to read "What you've added", which was true of the notes and the photos and
   * false of the views — a view is not something the operator added, it is what came back.
   * Moving the grammatical subject to the notes makes every figure a true predicate of it:
   * the notes number 17, and they have been opened 9 times.
   *
   * "so far" is load-bearing and must stay unbounded. A windowed heading ("this month",
   * "last 30 days") turns a tally into a rate, and a rate is pace — which the surveillance
   * guardrail in docs/modules/operator-view.md forbids outright.
   */
  it('heads the summary with a claim that is true of every figure under it', async () => {
    stage({ totals: { noteCount: 17, photoCount: 2, peopleReached: 9 } });
    render(<MyWorkPage />);

    expect(await screen.findByRole('heading', { name: /your notes so far/i })).toBeInTheDocument();
    // Never a claim the operator authored the views.
    expect(screen.queryByText(/what you.?ve added/i)).not.toBeInTheDocument();
    // Never a bounded window, which would make it a rate.
    expect(screen.queryByText(/this (week|month)|last \d+ days/i)).not.toBeInTheDocument();
  });

  /**
   * A standing "0 · Times viewed" is a permanent notice that nobody cares, which is why
   * the login banner renders null rather than announcing zero. This card cannot vanish —
   * it is the tally — so the figure stays (hiding it would move "Times viewed" between
   * columns from one visit to the next, and a zero is a real value, not a disabled
   * control) and one forward-looking line appears underneath. Only at zero: it must never
   * become standing chrome.
   */
  it('turns a zero view count forward instead of leaving it standing', async () => {
    stage({ totals: { noteCount: 3, photoCount: 0, peopleReached: 0 } });
    render(<MyWorkPage />);

    expect(await screen.findByText(/whoever runs the job or the machine next/i)).toBeInTheDocument();
    // The figure itself stays put — the column must not move between visits.
    expect(screen.getByText('Times viewed')).toBeInTheDocument();
  });

  it('drops that line as soon as anyone has read something', async () => {
    stage({ totals: { noteCount: 3, photoCount: 0, peopleReached: 1 } });
    render(<MyWorkPage />);

    await screen.findByText('Time viewed');
    expect(screen.queryByText(/whoever runs the job or the machine next/i)).not.toBeInTheDocument();
  });

  /**
   * The figures are data, not section titles. They rendered as `variant="h4"` — literal
   * `<h4>` elements — so a screen reader's heading rotor listed "17", "0" and "9" as three
   * headings with no antecedent, and nothing tied a figure to its caption. A `dt`/`dd` pair
   * is the documented semantic for a big-number-plus-caption tile.
   */
  it('does not announce the figures as headings', async () => {
    stage({ totals: { noteCount: 17, photoCount: 2, peopleReached: 9 } });
    render(<MyWorkPage />);

    await screen.findByRole('heading', { name: /your notes so far/i });
    for (const figure of ['17', '2', '9']) {
      expect(screen.queryByRole('heading', { name: figure })).not.toBeInTheDocument();
    }
    expect(screen.getByText('Notes')).toBeInTheDocument();
    expect(screen.getByText('Photos')).toBeInTheDocument();
    expect(screen.getByText('Times viewed')).toBeInTheDocument();
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

    await user.click(screen.getByRole('button', { name: /who read this/i }));

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
  it('names the machine where a job note names its job', async () => {
    // A machine entry has no job, so the work center takes the same quiet slot beside
    // the date rather than a bold heading of its own.
    stage({ notes: [machineNote()] });
    render(<MyWorkPage />);

    const row = (await screen.findAllByRole('listitem'))[0];
    expect(within(row).getByText(/Bandsaw · noticed · /)).toBeInTheDocument();
    // Nothing invented: a machine entry has no job to point at.
    expect(within(row).queryByText(/J-\d+/)).not.toBeInTheDocument();
  });

  it('leaves an unclassified maintenance entry with just the machine', async () => {
    // Classifying is optional and null is a common, legal state — so absence must render
    // as absence, not as a placeholder.
    stage({ notes: [machineNote({ maintenance_kind: null })] });
    render(<MyWorkPage />);

    const row = (await screen.findAllByRole('listitem'))[0];
    expect(within(row).getByText(/^Bandsaw · /)).toBeInTheDocument();
    expect(within(row).queryByText(/noticed|cleaned|repaired|adjusted|replaced/)).not.toBeInTheDocument();
  });

  /**
   * A durable part note outlives the job it was captured on — provenance is
   * ON DELETE SET NULL, so the knowledge survives losing its origin. Once that job is
   * gone the part is the only reference left, so it becomes the fallback rather than
   * leaving the row with no context at all.
   */
  it('falls back to the part once the capturing job is gone', async () => {
    stage({ notes: [note({ job_id: null, job_number: null })] });
    render(<MyWorkPage />);

    const row = (await screen.findAllByRole('listitem'))[0];
    expect(within(row).getByText(/^BRKT-1042 · /)).toBeInTheDocument();
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
    // findAllByRole, not getAllByRole: the identity block renders immediately but the notes
    // arrive on their own load, so a synchronous query here races the list and fails on a
    // slower machine. CI caught exactly this.
    const firstNote = (await screen.findAllByRole('listitem'))[0];
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

    // Above the work, not below it. Awaited — the notes load after the identity block.
    const firstNote = (await screen.findAllByRole('listitem'))[0];
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
    // Awaited: the notes load after the identity block this test opened on.
    const firstNote = (await screen.findAllByRole('listitem'))[0];
    expect(
      logout.compareDocumentPosition(firstNote) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});

/**
 * An operator who works for two shops previously had no way to reach the second one: the company
 * switcher lives in the office sidebar, and the operator surface has no sidebar. Logging out
 * didn't help either — login routes to `last_company_id`, i.e. straight back.
 *
 * It stayed invisible while multi-company operators were vanishingly rare. Fixing invite
 * acceptance for people who already have an account is what makes holding two memberships an
 * ordinary thing rather than an accident.
 */
describe('My Work — company switching', () => {
  it('shows nothing at all to the single-company operator', async () => {
    stage();
    render(<MyWorkPage />);

    await screen.findByRole('button', { name: /log out/i });
    expect(screen.queryByRole('button', { name: /switch company/i })).not.toBeInTheDocument();
  });

  it('lets an operator who works for two shops move between them', async () => {
    const user = userEvent.setup();
    stageCompanies([
      { id: CURRENT_COMPANY_ID, name: 'Vanguard Precision Works', role: 'operator' },
      { id: 'co2', name: 'Contour Tool & Machine', role: 'operator' },
    ]);
    stage();
    render(<MyWorkPage />);

    await user.click(await screen.findByRole('button', { name: /switch company/i }));
    await user.click(await screen.findByRole('button', { name: /contour tool & machine/i }));

    // The shop floor, not a dashboard AuthGuard would bounce them straight out of.
    await waitFor(() => expect(routerMocks.push).toHaveBeenCalledWith('/operator/co2'));
  });

  it('sends someone who is an operator here but an admin there to the right surface', async () => {
    // Role is per-company, which is exactly what the old hardcoded /dashboard push got wrong.
    const user = userEvent.setup();
    stageCompanies([
      { id: CURRENT_COMPANY_ID, name: 'Vanguard Precision Works', role: 'operator' },
      { id: 'co2', name: 'Contour Tool & Machine', role: 'admin' },
    ]);
    stage();
    render(<MyWorkPage />);

    await user.click(await screen.findByRole('button', { name: /switch company/i }));
    await user.click(await screen.findByRole('button', { name: /contour tool & machine/i }));

    await waitFor(() => expect(routerMocks.push).toHaveBeenCalledWith('/dashboard/co2'));
  });

  it('keeps Log out isolated even with the switcher on screen', async () => {
    // The switcher is a SIBLING of the identity row for this reason. If it ever migrates into the
    // row — e.g. by making the company name tappable — this fails, and it should.
    stageCompanies([
      { id: CURRENT_COMPANY_ID, name: 'Vanguard Precision Works', role: 'operator' },
      { id: 'co2', name: 'Contour Tool & Machine', role: 'operator' },
    ]);
    stage();
    render(<MyWorkPage />);

    const logout = await screen.findByRole('button', { name: /log out/i });
    const row = logout.parentElement!;

    expect(within(row).getAllByRole('button')).toHaveLength(1);
    expect(within(row).queryAllByRole('link')).toHaveLength(0);
    expect(screen.getByRole('button', { name: /switch company/i })).toBeInTheDocument();
  });
});

/**
 * Demo mode, from the shop floor.
 *
 * Demo mode is a second hidden `company_id` you navigate into, and its only control lived on the
 * office Settings page — behind `AdminGuard`, on a route `AuthGuard` bounces operator-role users
 * off before they get there. So an operator could not reach it at all, and the module doc claimed
 * the opposite for months. This is the way in, and the constraint on it is that an operator can
 * ENTER a demo but never CREATE one: `create_demo_company` raises for non-admins in the database.
 */
describe('My Work — demo mode', () => {
  it('offers nothing to a shop whose admin has not set up a demo', async () => {
    // An operator cannot create one, so a button here would only ever produce a permission
    // error. No control beats a control that cannot work.
    stage();
    render(<MyWorkPage />);

    await screen.findByRole('button', { name: /log out/i });
    expect(screen.queryByRole('button', { name: /demo mode/i })).not.toBeInTheDocument();
  });

  it('lets an operator into the demo company once one exists', async () => {
    const user = userEvent.setup();
    stageDemo({ hasDemo: true, demoCompanyId: 'demo-1' });
    stage();
    render(<MyWorkPage />);

    await user.click(await screen.findByRole('button', { name: /demo mode/i }));

    // The jobs list, not this page. Entry lands where the demo experience begins — the
    // station picker and the dispatch list — rather than preserving page context the way the
    // office provider does.
    await waitFor(() =>
      expect(routerMocks.push).toHaveBeenCalledWith('/operator/demo-1/jobs'),
    );
  });

  it('mirrors membership into the demo before going there', async () => {
    // An operator hired AFTER the demo was created has no access row in it, and the layout's
    // membership check would sign them out on arrival. This is the call that adds them.
    const user = userEvent.setup();
    stageDemo({ hasDemo: true, demoCompanyId: 'demo-1' });
    stage();
    render(<MyWorkPage />);

    await user.click(await screen.findByRole('button', { name: /demo mode/i }));

    await waitFor(() =>
      expect(vi.mocked(syncDemoAccess)).toHaveBeenCalledWith(CURRENT_COMPANY_ID, 'demo-1'),
    );
  });

  it('still enters when the membership sync fails', async () => {
    // The sync only ADDS members and converges flags; everyone present when the demo was made
    // is already mirrored, which is the common case. Blocking on it would turn a shop-wifi blip
    // into "demo mode is broken", and the layout's own membership check is the real gate.
    const user = userEvent.setup();
    vi.mocked(syncDemoAccess).mockRejectedValueOnce(new Error('network'));
    stageDemo({ hasDemo: true, demoCompanyId: 'demo-1' });
    stage();
    render(<MyWorkPage />);

    await user.click(await screen.findByRole('button', { name: /demo mode/i }));

    await waitFor(() =>
      expect(routerMocks.push).toHaveBeenCalledWith('/operator/demo-1/jobs'),
    );
  });

  it('offers no way IN while already exploring the demo — the bar owns the way out', async () => {
    stageDemo({ isDemo: true, hasDemo: true, demoCompanyId: null, realCompanyId: 'co-real' });
    stage();
    render(<MyWorkPage />);

    await screen.findByRole('button', { name: /log out/i });
    expect(screen.queryByRole('button', { name: /demo mode/i })).not.toBeInTheDocument();
  });

  it('keeps Log out isolated with the demo entry on screen', async () => {
    // Same invariant as the switcher: this button is a SIBLING of the identity row, never a
    // child of it. Log out must have nothing beside it for a habituated thumb to slip from.
    stageDemo({ hasDemo: true, demoCompanyId: 'demo-1' });
    stage();
    render(<MyWorkPage />);

    const logout = await screen.findByRole('button', { name: /log out/i });
    const row = logout.parentElement!;

    expect(within(row).getAllByRole('button')).toHaveLength(1);
    expect(within(row).queryAllByRole('link')).toHaveLength(0);
    expect(screen.getByRole('button', { name: /demo mode/i })).toBeInTheDocument();
  });
});
