import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@/__tests__/test-utils';
import userEvent from '@testing-library/user-event';

import JobFeed from '@/components/operator/JobFeed';
import { getJobNotes, addJobNote, getCurrentMember } from '@/utils/operatorAccess';
import { addJobNoteMedia, getJobNoteMediaUrl } from '@/utils/jobNoteMediaAccess';
import { compressPhoto } from '@/utils/imageCompression';
import { logOperatorEvent } from '@/utils/operatorEventsAccess';
import type { JobNote } from '@/types/operator';

vi.mock('@/utils/operatorAccess', () => ({
  getJobNotes: vi.fn(),
  addJobNote: vi.fn(),
  getCurrentMember: vi.fn(),
}));
vi.mock('@/utils/jobNoteMediaAccess', () => ({
  addJobNoteMedia: vi.fn(),
  getJobNoteMediaUrl: vi.fn(),
}));
vi.mock('@/utils/imageCompression', () => ({ compressPhoto: vi.fn() }));
// Dwell tracking imports the Supabase client at module scope; it has its own
// suite in __tests__/hooks/useNoteDwell.test.tsx.
vi.mock('@/hooks/useNoteDwell', () => ({ useNoteDwell: () => ({ observe: () => () => {} }) }));
vi.mock('@/utils/operatorEventsAccess', () => ({ logOperatorEvent: vi.fn() }));

const mock = (fn: unknown) => fn as ReturnType<typeof vi.fn>;

const OP_CONTEXT = { jobPartId: 'jp1', jobOperationId: 'jo1' };
const OFFER_TEXT = /add it before you go/i;
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
 * Render with the feed's OWN composer live.
 *
 * After B4 the composer only appears where no completion block owns capture — an
 * already-complete step, or an outside step. The behaviour these tests cover
 * (the photo picker, the dictation hint, the funnel events) did not change; it
 * moved into useNoteCapture and is rendered by both hosts, so they are still
 * exercised through this surface.
 */
function renderComposer(props: Partial<React.ComponentProps<typeof JobFeed>> = {}) {
  return renderFeed({ standaloneCapture: true, ...props });
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
});

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  mock(getCurrentMember).mockResolvedValue({ id: 'op1', name: 'Op', role: 'operator' });
  mock(getJobNotes).mockResolvedValue([]);
  mock(getJobNoteMediaUrl).mockResolvedValue('blob:thumb');
  mock(compressPhoto).mockResolvedValue({ file: new File(['x'], 'p.jpg', { type: 'image/jpeg' }) });
  mock(addJobNoteMedia).mockResolvedValue({ id: 'm1' });
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

describe('JobFeed — camera-roll photos unlocked', () => {
  it('file input has no capture attribute and still accepts images', async () => {
    const { container } = renderComposer();
    await waitFor(() => expect(getJobNotes).toHaveBeenCalled());
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    expect(fileInput).not.toHaveAttribute('capture');
    expect(fileInput).toHaveAttribute('accept', 'image/*');
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
