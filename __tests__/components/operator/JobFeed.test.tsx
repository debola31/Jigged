import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@/__tests__/test-utils';
import userEvent from '@testing-library/user-event';

import JobFeed from '@/components/operator/JobFeed';
import { getJobNotes, addJobNote, getCurrentMember } from '@/utils/operatorAccess';
import {
  getJobNoteMediaUrl,
  insertNoteMedia,
  uploadJobNoteMediaFile,
} from '@/utils/jobNoteMediaAccess';
import { compressPhoto } from '@/utils/imageCompression';
import { logOperatorEvent } from '@/utils/operatorEventsAccess';
import { getMyIntervalsForJob } from '@/utils/operationIntervalsAccess';
import { getFeedCompletionsForJob } from '@/utils/operationCompletionsAccess';
import type { JobNote } from '@/types/operator';

vi.mock('@/utils/operatorAccess', () => ({
  getJobNotes: vi.fn(),
  addJobNote: vi.fn(),
  getCurrentMember: vi.fn(),
  updateNoteBody: vi.fn(),
}));
vi.mock('@/utils/jobNoteMediaAccess', () => ({
  uploadJobNoteMediaFile: vi.fn(async () => 'company/jobs/job-1/abcd_photo.jpg'),
  insertNoteMedia: vi.fn(async () => ({ id: 'media1' })),
  discardNoteMediaUploads: vi.fn(async () => undefined),
  getJobNoteMediaUrl: vi.fn(),
  deleteJobNote: vi.fn(),
  deleteJobNoteMedia: vi.fn(),
}));
vi.mock('@/utils/imageCompression', () => ({
  compressPhoto: vi.fn(async (f: File) => ({ file: f, dims: { width: 10, height: 10 } })),
}));
// Dwell tracking imports the Supabase client at module scope; it has its own
// suite in __tests__/hooks/useNoteDwell.test.tsx.
vi.mock('@/hooks/useNoteDwell', () => ({ useNoteDwell: () => ({ observe: () => () => {} }) }));
vi.mock('@/utils/operatorEventsAccess', () => ({ logOperatorEvent: vi.fn() }));
// Both time reads. Unmocked they hit a real getSupabase() with no env, useLoad
// swallows the throw, and every time row silently never renders — which is
// indistinguishable from the merge being wrong.
vi.mock('@/utils/operationIntervalsAccess', () => ({
  getMyIntervalsForJob: vi.fn(async () => []),
  adjustOperationInterval: vi.fn(async () => undefined),
}));
vi.mock('@/utils/operationCompletionsAccess', () => ({
  getFeedCompletionsForJob: vi.fn(async () => []),
}));

const mock = (fn: unknown) => fn as ReturnType<typeof vi.fn>;

const OP_CONTEXT = { jobPartId: 'jp1', jobOperationId: 'jo1' };
// OFFER_TEXT (/add it before you go/) lived here for the post-completion
// "add a photo?" prompt. That prompt was deleted with B4 and its last reference
// went with the tests below it; the constant outlived both. Gone now — capture
// is offered by a composer that is always on screen, so there is nothing left to
// chase after the fact.
const HINT_TEXT = /talk instead of type/i;

function makeNote(over: Partial<JobNote> = {}): JobNote {
  return {
    id: 'n1',
    job_id: 'job1',
    job_operation_id: null,
    operation_label: null,
    body: 'existing note',
    note_type: 'user',
    created_at: '2026-07-01T10:00:00.000Z',
    edited_at: null,
    author_name: 'Op',
    author_id: 'them',
    reactions: [],
    media: [],
    ...over,
  };
}

function renderFeed(props: Partial<React.ComponentProps<typeof JobFeed>> = {}) {
  return render(
    <JobFeed jobId="job1" companyId="co1" operationContext={OP_CONTEXT} {...props} />,
  );
}

/**
 * Render with the composer live.
 *
 * There is no switch left: a job context IS the composer, on every branch of
 * every surface. The alias stays because it says what a test is about — these
 * cover capture (the picker, the dictation hint, the funnel), not the timeline.
 */
function renderComposer(props: Partial<React.ComponentProps<typeof JobFeed>> = {}) {
  return renderFeed(props);
}

// This jsdom env ships no Storage — polyfill a minimal in-memory one (same
// pattern as OperatorStationContext.test).
class MemoryStorage {
  private store = new Map<string, string>();
  get length() {
    return this.store.size;
  }
  clear() {
    this.store.clear();
  }
  getItem(k: string) {
    return this.store.has(k) ? this.store.get(k)! : null;
  }
  key(i: number) {
    return Array.from(this.store.keys())[i] ?? null;
  }
  removeItem(k: string) {
    this.store.delete(k);
  }
  setItem(k: string, v: string) {
    this.store.set(k, String(v));
  }
}

beforeAll(() => {
  Object.defineProperty(window, 'localStorage', {
    value: new MemoryStorage(),
    configurable: true,
    writable: true,
  });
  // sessionStorage too: the mic hint spends its five-show budget once per
  // session rather than once per composer mounted, and that marker lives here.
  Object.defineProperty(window, 'sessionStorage', {
    value: new MemoryStorage(),
    configurable: true,
    writable: true,
  });
});

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  window.sessionStorage.clear();
  mock(getCurrentMember).mockResolvedValue({ id: 'op1', name: 'Op', role: 'operator' });
  mock(getJobNotes).mockResolvedValue([]);
  mock(getMyIntervalsForJob).mockResolvedValue([]);
  mock(getFeedCompletionsForJob).mockResolvedValue([]);
  mock(getJobNoteMediaUrl).mockResolvedValue('blob:thumb');
  mock(compressPhoto).mockResolvedValue({ file: new File(['x'], 'p.jpg', { type: 'image/jpeg' }) });
  mock(uploadJobNoteMediaFile).mockResolvedValue('company/jobs/job1/abcd_p.jpg');
  mock(insertNoteMedia).mockResolvedValue({ id: 'm1' });
  // Pre-dismiss the mic hint by default so it doesn't collide with offer assertions.
  window.localStorage.setItem('jigged:composer-mic-hint', JSON.stringify({ shows: 0, dismissed: true }));
});

// DELETED WITH B4: the post-completion "add a photo?" offer.
//
// Six tests went with it, and that is the right outcome rather than a loss of
// coverage. The offer existed to chase a note AFTER the fact, which is exactly
// the two-stage commit that lost photos: it prompted, the operator attached, a
// thumbnail appeared, and nothing was written until a separate Post they had no
// reason to look for. Capture now sits inside the completion block and lands
// with the completion, so there is nothing to prompt for.
//
// The property the offer protected — completion durable BEFORE capture is
// attempted — is asserted in OperationActionPage.test.tsx
// ('writes the note only AFTER the completion has landed').

// REVERSED: this block used to be 'JobFeed — camera-roll photos unlocked', and it
// asserted `not.toHaveAttribute('capture')`.
//
// That assertion was correct for the requirement it was written under. The camera
// roll was deliberately left reachable because the observed failure was setup
// photos stranded in it, and the audit that followed found the
// phone-camera-then-attach flow was how photos actually arrived. Neither
// observation has been contradicted.
//
// What changed is what a note's photo is FOR. It is read back later as a record of
// what this job looked like, so it now has to be shot in Jigged — which the camera
// roll cannot promise. The cost was accepted openly: an operator who shoots at the
// machine and files the note afterwards must now open Jigged at the machine.
//
// The signal to watch is composer_focused against note_saved. That pair is
// documented as reading "capture friction", and if this change hurts, it will look
// exactly like that and mean something else.
describe('JobFeed — capture is independent of completing the step', () => {
  it('posts a note with no completion, at the default quantity', async () => {
    /**
     * THE REGRESSION THIS FILE EXISTS TO HOLD DOWN.
     *
     * Capture briefly lived inside the operation page's completion block, and
     * the quantity field is prefilled with the remaining balance — so the
     * primary button was START, then RECORD n FINISHED, and the note arm it was
     * supposed to fall back to needed the operator to clear the quantity by hand
     * first. In practice a note could not be saved without finishing the step.
     *
     * Nothing here clears any field, because there is no field to clear: the
     * composer commits itself.
     */
    const user = userEvent.setup();
    mock(addJobNote).mockResolvedValue(makeNote({ id: 'new', body: 'waiting on material' }));
    renderComposer();
    await waitFor(() => expect(getJobNotes).toHaveBeenCalled());

    await user.type(
      screen.getByPlaceholderText('Add a note or photo for this step…'),
      'waiting on material',
    );
    await user.click(await screen.findByRole('button', { name: 'Post' }));

    await waitFor(() =>
      expect(addJobNote).toHaveBeenCalledWith('job1', 'co1', 'op1', 'waiting on material', {
        jobPartId: 'jp1',
        jobOperationId: 'jo1',
      }),
    );
  });

  it('writes a JOB note, with no step, from the traveler', async () => {
    // The traveler has no operation selected and must not ask for one — that
    // would be the step selector this feed was designed without. A null step is
    // a real note, not a degraded one.
    const user = userEvent.setup();
    mock(addJobNote).mockResolvedValue(makeNote({ id: 'new', body: 'customer called' }));
    renderFeed({ operationContext: { jobPartId: 'jp1', jobOperationId: null } });
    await waitFor(() => expect(getJobNotes).toHaveBeenCalled());

    // And it says so — "for this job", not "for this step".
    await user.type(
      screen.getByPlaceholderText('Add a note or photo for this job…'),
      'customer called',
    );
    await user.click(await screen.findByRole('button', { name: 'Post' }));

    await waitFor(() =>
      expect(addJobNote).toHaveBeenCalledWith('job1', 'co1', 'op1', 'customer called', {
        jobPartId: 'jp1',
        jobOperationId: null,
      }),
    );
  });

  it('says so while a draft is unposted, and stops saying it once it is gone', async () => {
    /**
     * The hazard the merged commit existed to prevent, answered by a status line
     * rather than by welding the two writes together: a staged photo used to LOOK
     * saved, and nothing said otherwise.
     *
     * Derived from the draft alone, deliberately — it is true the whole time the
     * risk exists, instead of firing once at a moment we guessed. It is also the
     * only shape available: remembering that moment needs setState in an effect
     * (the repo's ratcheting warning budget), setState during render, or a ref
     * read during render — and the last two are lint ERRORS here.
     */
    const user = userEvent.setup();
    renderComposer();
    await waitFor(() => expect(getJobNotes).toHaveBeenCalled());

    expect(screen.queryByText(/not posted yet/i)).not.toBeInTheDocument();

    const field = screen.getByPlaceholderText('Add a note or photo for this step…');
    await user.type(field, 'half a thought');
    expect(await screen.findByText(/not posted yet/i)).toBeInTheDocument();

    await user.clear(field);
    await waitFor(() =>
      expect(screen.queryByText(/not posted yet/i)).not.toBeInTheDocument(),
    );
  });

  it('brings the composer back into view when a step action lands on a draft', async () => {
    /**
     * The status line sits BELOW the action block the operator just tapped, which
     * on a phone has already scrolled past — saying it where they are not looking
     * is the same silence in a different colour. This is the half that has to be
     * an event, and the only half that needs to remember anything, so it lives
     * entirely inside an effect where touching a ref is legal.
     */
    const user = userEvent.setup();
    const scrollIntoView = vi.fn();
    // jsdom implements no scrollIntoView at all, so there is nothing to spy on —
    // it has to be installed.
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      value: scrollIntoView,
      configurable: true,
      writable: true,
    });

    const { rerender } = render(
      <JobFeed jobId="job1" companyId="co1" operationContext={OP_CONTEXT} refreshSignal={0} />,
    );
    await waitFor(() => expect(getJobNotes).toHaveBeenCalled());

    await user.type(
      screen.getByPlaceholderText('Add a note or photo for this step…'),
      'half a thought',
    );
    scrollIntoView.mockClear();

    rerender(
      <JobFeed jobId="job1" companyId="co1" operationContext={OP_CONTEXT} refreshSignal={1} />,
    );

    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
  });

  it('does NOT chase the operator when the step action lands on an empty composer', async () => {
    // Completing a step with nothing typed is the ordinary case. Scrolling for it
    // would move the screen under someone for no reason.
    const scrollIntoView = vi.fn();
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      value: scrollIntoView,
      configurable: true,
      writable: true,
    });

    const { rerender } = render(
      <JobFeed jobId="job1" companyId="co1" operationContext={OP_CONTEXT} refreshSignal={0} />,
    );
    await waitFor(() => expect(getJobNotes).toHaveBeenCalled());
    scrollIntoView.mockClear();

    rerender(
      <JobFeed jobId="job1" companyId="co1" operationContext={OP_CONTEXT} refreshSignal={1} />,
    );

    await waitFor(() => expect(getFeedCompletionsForJob).toHaveBeenCalled());
    expect(scrollIntoView).not.toHaveBeenCalled();
  });
});

describe('JobFeed — capture-only media', () => {
  it('sends the photo button straight to the camera, with no library', async () => {
    const { container } = renderComposer();
    await waitFor(() => expect(getJobNotes).toHaveBeenCalled());
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    expect(fileInput).toHaveAttribute('capture', 'environment');
    expect(fileInput).toHaveAttribute('accept', 'image/*');
  });

  it('drops `multiple`, which HTML Media Capture ignores anyway', async () => {
    const { container } = renderComposer();
    await waitFor(() => expect(getJobNotes).toHaveBeenCalled());
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    // Several photos per note come from tapping again, each appending to the strip.
    expect(fileInput).not.toHaveAttribute('multiple');
  });

  it('offers no video button under jsdom, because jsdom cannot record', async () => {
    renderComposer();
    await waitFor(() => expect(getJobNotes).toHaveBeenCalled());
    // The capability gate is what keeps every other suite in this repo green: with
    // no MediaRecorder the control is never rendered, so no existing test that
    // queries the composer has to know video exists. A device that cannot record
    // sees the same thing, which is the point — a button that can only fail is
    // worse than no button.
    expect(screen.queryByLabelText('Record video')).toBeNull();
  });
});

describe('JobFeed — dictation hint', () => {
  const HINT_KEY = 'jigged:composer-mic-hint';

  it('shows on first composer mounts and counts the show', async () => {
    window.localStorage.removeItem(HINT_KEY);
    renderComposer();
    expect(await screen.findByText(HINT_TEXT)).toBeInTheDocument();
    expect(JSON.parse(window.localStorage.getItem(HINT_KEY)!)).toEqual({ shows: 1, dismissed: false });
  });

  it('spends ONE show for two composers in the same session', async () => {
    /**
     * The constraint operator-view.md states outright: the cap used to be per
     * hook instance, which is why it said the tip's budget "constrains where the
     * composer may be mounted". There are two job composers now — the step page
     * and the traveler — and an operator passes through both in one journey, so
     * a per-mount count would retire a five-show tip in two and a half visits.
     */
    window.localStorage.removeItem(HINT_KEY);

    const first = renderComposer();
    expect(await screen.findByText(HINT_TEXT)).toBeInTheDocument();
    expect(JSON.parse(window.localStorage.getItem(HINT_KEY)!).shows).toBe(1);
    first.unmount();

    // Same session, second composer — still shown, still one show spent.
    renderComposer();
    expect(await screen.findByText(HINT_TEXT)).toBeInTheDocument();
    expect(JSON.parse(window.localStorage.getItem(HINT_KEY)!).shows).toBe(1);
  });

  it('still shows on the last allowed mount (below the cap of 5)', async () => {
    window.localStorage.setItem(HINT_KEY, JSON.stringify({ shows: 4, dismissed: false }));
    renderComposer();
    expect(await screen.findByText(HINT_TEXT)).toBeInTheDocument();
  });

  it('stops showing once the cap of 5 is reached', async () => {
    window.localStorage.setItem(HINT_KEY, JSON.stringify({ shows: 5, dismissed: false }));
    renderComposer();
    await waitFor(() => expect(getJobNotes).toHaveBeenCalled());
    expect(screen.queryByText(HINT_TEXT)).not.toBeInTheDocument();
  });

  it('hides immediately and persists dismissal when the × is tapped', async () => {
    const user = userEvent.setup();
    window.localStorage.removeItem(HINT_KEY);
    renderComposer();
    await screen.findByText(HINT_TEXT);

    await user.click(screen.getByRole('button', { name: 'Dismiss tip' }));
    expect(screen.queryByText(HINT_TEXT)).not.toBeInTheDocument();
    expect(JSON.parse(window.localStorage.getItem(HINT_KEY)!).dismissed).toBe(true);
  });
});

// The capture funnel. With an empty notes corpus these events are the only
// readable signal for the first weeks of the pilot, so what matters is that the
// steps stay DISTINGUISHABLE: "opened the composer" must not be conflated with
// "saved", and a failed post must never be counted as a save. Otherwise the
// result reads as "adoption was poor" with no way to tell friction from fit.
describe('JobFeed — capture funnel events', () => {
  it('records composer_focused once, however many times they refocus', async () => {
    const user = userEvent.setup();
    renderComposer();
    await waitFor(() => expect(getJobNotes).toHaveBeenCalled());
    const field = screen.getByPlaceholderText('Add a note or photo for this step…');

    await user.click(field);
    await user.tab();
    await user.click(field);

    const focused = mock(logOperatorEvent).mock.calls.filter(
      (c: unknown[]) => c[1] === 'composer_focused',
    );
    expect(focused).toHaveLength(1);
  });

  it('records note_saved only after the write resolves', async () => {
    const user = userEvent.setup();
    mock(addJobNote).mockResolvedValue(makeNote({ id: 'new', body: 'watch the bore' }));
    renderComposer();
    await waitFor(() => expect(getJobNotes).toHaveBeenCalled());

    await user.type(
      screen.getByPlaceholderText('Add a note or photo for this step…'),
      'watch the bore',
    );
    await user.click(screen.getByRole('button', { name: 'Post' }));

    await waitFor(() =>
      expect(mock(logOperatorEvent).mock.calls.some((c: unknown[]) => c[1] === 'note_saved')).toBe(
        true,
      ),
    );
  });

  it('does NOT record a save when the post fails', async () => {
    // The distinction the funnel exists for: they tried and it broke is capture
    // friction, not a successful capture.
    const user = userEvent.setup();
    mock(addJobNote).mockRejectedValue(new Error('offline'));
    renderComposer();
    await waitFor(() => expect(getJobNotes).toHaveBeenCalled());

    await user.type(
      screen.getByPlaceholderText('Add a note or photo for this step…'),
      'never lands',
    );
    await user.click(screen.getByRole('button', { name: 'Post' }));

    await screen.findByRole('alert');
    expect(
      mock(logOperatorEvent).mock.calls.some(
        (c: unknown[]) => c[1] === 'note_saved' || c[1] === 'note_saved_with_photo',
      ),
    ).toBe(false);
  });

  it('posts nothing to the feed when the photo upload fails (#624)', async () => {
    // The shop-floor case: an operator photographs a problem on dropping wifi and
    // the upload stalls. It used to post a photo-less note anyway, which is the
    // one outcome that reads as "saved" while losing the thing it was taken for.
    const user = userEvent.setup();
    mock(uploadJobNoteMediaFile).mockRejectedValue(new Error('The upload timed out'));
    mock(addJobNote).mockResolvedValue(makeNote({ id: 'new', body: 'cracked insert' }));
    renderComposer();
    await waitFor(() => expect(getJobNotes).toHaveBeenCalled());

    await user.type(
      screen.getByPlaceholderText('Add a note or photo for this step…'),
      'cracked insert',
    );
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(input, new File(['x'], 'p.jpg', { type: 'image/jpeg' }));
    await user.click(screen.getByRole('button', { name: 'Post' }));

    await screen.findByRole('alert');
    expect(addJobNote).not.toHaveBeenCalled();
    // The feed is still empty — no photo-less note was prepended.
    expect(screen.getByText('No activity yet.')).toBeInTheDocument();
    // Still in hand, so tapping Post again is a retry rather than a second note.
    expect(screen.getByDisplayValue('cracked insert')).toBeInTheDocument();
  });

  it('records composer_abandoned when they open it and leave without saving', async () => {
    const user = userEvent.setup();
    const { unmount } = renderComposer();
    await waitFor(() => expect(getJobNotes).toHaveBeenCalled());

    await user.type(
      screen.getByPlaceholderText('Add a note or photo for this step…'),
      'half a thought',
    );
    unmount();

    const abandoned = mock(logOperatorEvent).mock.calls.filter(
      (c: unknown[]) => c[1] === 'composer_abandoned',
    );
    expect(abandoned).toHaveLength(1);
    expect(abandoned[0][2]).toMatchObject({ bodyLength: 'half a thought'.length });
  });

  it('does NOT record abandonment when they never opened the composer', async () => {
    const { unmount } = renderComposer();
    await waitFor(() => expect(getJobNotes).toHaveBeenCalled());
    unmount();

    expect(
      mock(logOperatorEvent).mock.calls.some((c: unknown[]) => c[1] === 'composer_abandoned'),
    ).toBe(false);
  });

  it('does NOT record abandonment after a successful save', async () => {
    const user = userEvent.setup();
    mock(addJobNote).mockResolvedValue(makeNote({ id: 'new', body: 'saved' }));
    const { unmount } = renderComposer();
    await waitFor(() => expect(getJobNotes).toHaveBeenCalled());

    await user.type(screen.getByPlaceholderText('Add a note or photo for this step…'), 'saved');
    await user.click(screen.getByRole('button', { name: 'Post' }));
    await waitFor(() => expect(addJobNote).toHaveBeenCalled());
    unmount();

    expect(
      mock(logOperatorEvent).mock.calls.some((c: unknown[]) => c[1] === 'composer_abandoned'),
    ).toBe(false);
  });
});

// ============================================================================
// Edit / delete affordances (#628)
// ============================================================================
// The permission rules are the part worth testing here: getting them wrong
// offers an action that RLS will refuse, which reads to an operator as a broken
// button rather than as a boundary.

describe('note actions', () => {
  const menuFor = () => screen.queryByRole('button', { name: /Actions for this note/i });

  it('offers no actions on somebody else’s note', async () => {
    mock(getJobNotes).mockResolvedValue([makeNote({ author_id: 'them' })]);
    renderFeed();
    await screen.findByText('existing note');

    expect(menuFor()).not.toBeInTheDocument();
  });

  it('offers Edit and Delete on your own note', async () => {
    const user = userEvent.setup();
    mock(getJobNotes).mockResolvedValue([makeNote({ author_id: 'op1' })]);
    renderFeed();
    await screen.findByText('existing note');

    await user.click(menuFor()!);
    expect(screen.getByRole('menuitem', { name: 'Edit' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toBeInTheDocument();
  });

  it('offers Delete but NOT Edit to an admin on somebody else’s note', async () => {
    const user = userEvent.setup();
    mock(getCurrentMember).mockResolvedValue({ id: 'boss', name: 'Boss', role: 'admin' });
    mock(getJobNotes).mockResolvedValue([makeNote({ author_id: 'them' })]);
    renderFeed();
    await screen.findByText('existing note');

    await user.click(menuFor()!);
    // Deliberately asymmetric: an admin rewriting somebody else's note would
    // change what it says without changing whose name is on it.
    expect(screen.queryByRole('menuitem', { name: 'Edit' })).not.toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toBeInTheDocument();
  });

  it('offers nothing on an auto-logged event note, even to its own author', async () => {
    mock(getJobNotes).mockResolvedValue([
      makeNote({ author_id: 'op1', note_type: 'event', body: 'Order quantity changed' }),
    ]);
    renderFeed();
    await screen.findByText('Order quantity changed');

    // 'event' rows are the audit trail. RLS refuses them too, so the control
    // would be a guaranteed 42501.
    expect(menuFor()).not.toBeInTheDocument();
  });

  it('offers the menu on the traveler too, which is a writable surface now', async () => {
    // The traveler used to pass `readOnly`, which suppressed both the composer
    // and this menu. It posts notes now, and an operator who can write one there
    // must be able to fix their own typo there — RLS scopes edit to the author
    // and delete to author-or-admin either way.
    mock(getJobNotes).mockResolvedValue([makeNote({ author_id: 'op1' })]);
    renderFeed({ operationContext: { jobPartId: 'jp1', jobOperationId: null } });
    await screen.findByText('existing note');

    expect(menuFor()).toBeInTheDocument();
  });

  it('marks an edited note, and leaves an unedited one unmarked', async () => {
    mock(getJobNotes).mockResolvedValue([
      makeNote({ id: 'a', body: 'was corrected', edited_at: '2026-08-01T10:00:00Z' }),
      makeNote({ id: 'b', body: 'never touched', edited_at: null }),
    ]);
    renderFeed();
    await screen.findByText('was corrected');

    // One mark for the one edited note — the counter deliberately does not
    // reset on an edit, so this is what tells a reader the words changed.
    expect(screen.getAllByText(/edited/)).toHaveLength(1);
  });

  describe('completions with no interval', () => {
    const completion = (over = {}) => ({
      id: 'c1',
      job_operation_id: 'jo1',
      quantity_good: 4,
      completed_at: '2026-07-01T11:00:00.000Z',
      operation_name: 'Final Inspection',
      capture_source: 'operator' as const,
      ...over,
    });

    const closedInterval = (over = {}) => ({
      id: 'iv1',
      job_operation_id: 'jo1',
      job_part_id: 'jp1',
      work_center_id: 'wc1',
      started_at: '2026-07-01T09:00:00.000Z',
      ended_at: '2026-07-01T11:00:00.000Z',
      adjusted_started_at: null,
      adjusted_ended_at: null,
      adjusted_at: null,
      effective_started_at: '2026-07-01T09:00:00.000Z',
      effective_ended_at: '2026-07-01T11:00:00.000Z',
      close_reason: 'completed',
      capture_source: 'operator',
      note: null,
      completion_id: 'c1',
      quantity_good: 4,
      job_id: 'job1',
      job_number: 'J-1',
      operation_name: 'Final Inspection',
      operation_sequence: 30,
      part_name: 'Widget',
      ...over,
    });

    it('shows a Complete-without-timing completion as a Finished row', async () => {
      // Before this it produced NOTHING in the feed: the step flipped to
      // complete with no record of it, while the timed path appended two rows.
      mock(getFeedCompletionsForJob).mockResolvedValue([completion()]);
      render(<JobFeed jobId="job1" companyId="co1" operationContext={OP_CONTEXT} />);

      expect(await screen.findByText(/Finished Final Inspection/)).toBeInTheDocument();
      expect(screen.getByText(/4 parts/)).toBeInTheDocument();
    });

    it('marks it "not timed" and offers no Adjust', async () => {
      // The three things that make it read differently from a timed finish.
      // There is no interval behind it, so Adjust would open a dialog over
      // nothing, and a duration would be a number we do not have.
      mock(getFeedCompletionsForJob).mockResolvedValue([completion()]);
      render(<JobFeed jobId="job1" companyId="co1" operationContext={OP_CONTEXT} />);

      expect(await screen.findByText(/not timed/)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /^adjust$/i })).not.toBeInTheDocument();
    });

    it('does NOT double-count a completion an interval already claims', async () => {
      // The dedup. Both reads return the same completion — one directly, one
      // through the interval that closed it — and it must appear once, as the
      // TIMED row (with its duration and Adjust), never twice.
      mock(getMyIntervalsForJob).mockResolvedValue([closedInterval()]);
      mock(getFeedCompletionsForJob).mockResolvedValue([completion()]);
      render(<JobFeed jobId="job1" companyId="co1" operationContext={OP_CONTEXT} />);

      expect(await screen.findByText(/Finished Final Inspection/)).toBeInTheDocument();
      expect(screen.getAllByText(/Finished Final Inspection/)).toHaveLength(1);
      expect(screen.queryByText(/not timed/)).not.toBeInTheDocument();
      // Two, not one: a closed interval renders a Started row AND a Finished
      // row, and both are adjustable.
      expect(screen.getAllByRole('button', { name: /^adjust$/i })).toHaveLength(2);
    });

    it('goes back for completions when the parent signals a write', async () => {
      // The parent bumps refreshSignal after Complete without timing. That path
      // writes NO interval, so a feed that only re-reads intervals never picks
      // it up and the one row this feature exists to add stays invisible until
      // a remount.
      mock(getFeedCompletionsForJob).mockResolvedValue([]);
      const { rerender } = render(
        <JobFeed jobId="job1" companyId="co1" operationContext={OP_CONTEXT} refreshSignal={0} />,
      );
      await waitFor(() => expect(mock(getFeedCompletionsForJob)).toHaveBeenCalled());
      expect(screen.queryByText(/not timed/)).not.toBeInTheDocument();

      mock(getFeedCompletionsForJob).mockResolvedValue([completion()]);
      rerender(
        <JobFeed jobId="job1" companyId="co1" operationContext={OP_CONTEXT} refreshSignal={1} />,
      );

      expect(await screen.findByText(/not timed/)).toBeInTheDocument();
    });

    it('says an office completion was recorded in the office, not that you forgot the clock', async () => {
      // The two rows must not read identically. "You finished this and forgot to
      // start the timer" and "the office closed this step out" are different
      // facts, and rendering the second as the first tells an operator they did
      // something they did not do.
      mock(getFeedCompletionsForJob).mockResolvedValue([completion({ capture_source: 'office' })]);
      render(<JobFeed jobId="job1" companyId="co1" operationContext={OP_CONTEXT} />);

      expect(await screen.findByText(/recorded in the office/)).toBeInTheDocument();
      expect(screen.queryByText(/not timed/)).not.toBeInTheDocument();
    });

    it('names no actor on an office row', async () => {
      // Office rows are the one kind everybody on the job can see, which is
      // exactly why they must carry no name — see getFeedCompletionsForJob.
      mock(getFeedCompletionsForJob).mockResolvedValue([completion({ capture_source: 'office' })]);
      render(<JobFeed jobId="job1" companyId="co1" operationContext={OP_CONTEXT} />);

      const row = await screen.findByText(/Finished Final Inspection/);
      // The query shape the surveillance guardrail cares about: no `by <person>`
      // anywhere in the rendered entry.
      expect(row.parentElement?.textContent).not.toMatch(/\bby\b/i);
    });

    it('offers no Adjust on an office row either — there is no interval behind it', async () => {
      mock(getFeedCompletionsForJob).mockResolvedValue([completion({ capture_source: 'office' })]);
      render(<JobFeed jobId="job1" companyId="co1" operationContext={OP_CONTEXT} />);

      await screen.findByText(/recorded in the office/);
      expect(screen.queryByRole('button', { name: /^adjust$/i })).not.toBeInTheDocument();
    });

    it('treats a pre-column completion as the operator\'s own untimed row', async () => {
      // NULL capture_source means "recorded before 20260828124806". Those rows
      // only reach the feed because the caller owns them, so `not timed` — the
      // behaviour before this change — is still the right caption.
      mock(getFeedCompletionsForJob).mockResolvedValue([completion({ capture_source: null })]);
      render(<JobFeed jobId="job1" companyId="co1" operationContext={OP_CONTEXT} />);

      expect(await screen.findByText(/not timed/)).toBeInTheDocument();
    });

    it('falls back to untimed when the interval that claimed it is gone', async () => {
      // getMyIntervalsForJob filters voided rows out, so a completion whose
      // interval was voided arrives here unclaimed. Showing it as untimed is
      // right: the work happened, the timing no longer exists.
      mock(getMyIntervalsForJob).mockResolvedValue([]);
      mock(getFeedCompletionsForJob).mockResolvedValue([completion()]);
      render(<JobFeed jobId="job1" companyId="co1" operationContext={OP_CONTEXT} />);

      expect(await screen.findByText(/not timed/)).toBeInTheDocument();
    });
  });
});
