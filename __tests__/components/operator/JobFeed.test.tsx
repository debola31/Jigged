import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@/__tests__/test-utils';
import userEvent from '@testing-library/user-event';

import JobFeed from '@/components/operator/JobFeed';
import { getJobNotes, addJobNote, getCurrentMember } from '@/utils/operatorAccess';
import { addJobNoteMedia, getJobNoteMediaUrl, deleteJobNote } from '@/utils/jobNoteMediaAccess';
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
  deleteJobNote: vi.fn(),
}));
vi.mock('@/utils/imageCompression', () => ({ compressPhoto: vi.fn() }));
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
    media: [],
    ...over,
  };
}

function renderFeed(props: Partial<React.ComponentProps<typeof JobFeed>> = {}) {
  return render(
    <JobFeed jobId="job1" companyId="co1" operationContext={OP_CONTEXT} {...props} />,
  );
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
  mock(deleteJobNote).mockResolvedValue(undefined);
  // Pre-dismiss the mic hint by default so it doesn't collide with offer assertions.
  window.localStorage.setItem('jigged:composer-mic-hint', JSON.stringify({ shows: 0, dismissed: true }));
});

describe('JobFeed — post-completion capture offer', () => {
  it('shows the offer only after a completion signal, and only when nothing is captured', async () => {
    const { rerender } = renderFeed({ captureOfferSignal: 0 });
    await waitFor(() => expect(getJobNotes).toHaveBeenCalled());

    // No offer before a completion event.
    expect(screen.queryByText(OFFER_TEXT)).not.toBeInTheDocument();

    // A new completion signal, empty feed → offer appears.
    rerender(<JobFeed jobId="job1" companyId="co1" operationContext={OP_CONTEXT} captureOfferSignal={1} />);
    expect(await screen.findByText(OFFER_TEXT)).toBeInTheDocument();
  });

  it('does NOT offer when the operator already captured a note or photo', async () => {
    mock(getJobNotes).mockResolvedValue([makeNote({ body: 'set jaws to 0.5' })]);
    const { rerender } = renderFeed({ captureOfferSignal: 0 });
    await waitFor(() => expect(screen.getByText('set jaws to 0.5')).toBeInTheDocument());

    rerender(<JobFeed jobId="job1" companyId="co1" operationContext={OP_CONTEXT} captureOfferSignal={1} />);
    // Give the effect a chance to run, then assert it stayed closed.
    await Promise.resolve();
    expect(screen.queryByText(OFFER_TEXT)).not.toBeInTheDocument();
  });

  it('still offers when the only note is an auto-logged event note', async () => {
    mock(getJobNotes).mockResolvedValue([
      makeNote({ note_type: 'event', body: 'Order qty changed 10 → 12' }),
    ]);
    const { rerender } = renderFeed({ captureOfferSignal: 0 });
    await waitFor(() => expect(screen.getByText('Order qty changed 10 → 12')).toBeInTheDocument());

    rerender(<JobFeed jobId="job1" companyId="co1" operationContext={OP_CONTEXT} captureOfferSignal={1} />);
    expect(await screen.findByText(OFFER_TEXT)).toBeInTheDocument();
  });

  it('is one-per-event: Skip dismisses and it only reopens on a new signal', async () => {
    const user = userEvent.setup();
    const { rerender } = renderFeed({ captureOfferSignal: 1 });
    await screen.findByText(OFFER_TEXT);

    await user.click(screen.getByRole('button', { name: 'Skip' }));
    expect(screen.queryByText(OFFER_TEXT)).not.toBeInTheDocument();

    // Re-render with the SAME signal — stays closed (skip means skip).
    rerender(<JobFeed jobId="job1" companyId="co1" operationContext={OP_CONTEXT} captureOfferSignal={1} />);
    expect(screen.queryByText(OFFER_TEXT)).not.toBeInTheDocument();

    // A brand-new completion → a fresh single offer.
    rerender(<JobFeed jobId="job1" companyId="co1" operationContext={OP_CONTEXT} captureOfferSignal={2} />);
    expect(await screen.findByText(OFFER_TEXT)).toBeInTheDocument();
  });

  it('Skip performs no writes — the offer can never affect the (already-committed) completion', async () => {
    const user = userEvent.setup();
    renderFeed({ captureOfferSignal: 1 });
    await screen.findByText(OFFER_TEXT);

    await user.click(screen.getByRole('button', { name: 'Skip' }));
    expect(addJobNote).not.toHaveBeenCalled();
    expect(addJobNoteMedia).not.toHaveBeenCalled();
  });

  it('"Add photo" opens the file picker and closes the offer', async () => {
    const user = userEvent.setup();
    const { container } = renderFeed({ captureOfferSignal: 1 });
    await screen.findByText(OFFER_TEXT);

    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    const clickSpy = vi.spyOn(fileInput, 'click').mockImplementation(() => {});

    // Offer's "Add photo" is the first (rendered above the composer's button).
    await user.click(screen.getAllByRole('button', { name: 'Add photo' })[0]);

    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(OFFER_TEXT)).not.toBeInTheDocument();
  });

  it('"Add note" focuses the composer and closes the offer', async () => {
    const user = userEvent.setup();
    renderFeed({ captureOfferSignal: 1 });
    await screen.findByText(OFFER_TEXT);

    await user.click(screen.getByRole('button', { name: 'Add note' }));

    const field = screen.getByPlaceholderText('Add a note or photo for this step…');
    expect(field).toHaveFocus();
    expect(screen.queryByText(OFFER_TEXT)).not.toBeInTheDocument();
  });
});

describe('JobFeed — camera-roll photos unlocked', () => {
  it('file input has no capture attribute and still accepts images', async () => {
    const { container } = renderFeed();
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
    renderFeed();
    expect(await screen.findByText(HINT_TEXT)).toBeInTheDocument();
    expect(JSON.parse(window.localStorage.getItem(HINT_KEY)!)).toEqual({ shows: 1, dismissed: false });
  });

  it('still shows on the last allowed mount (below the cap of 5)', async () => {
    window.localStorage.setItem(HINT_KEY, JSON.stringify({ shows: 4, dismissed: false }));
    renderFeed();
    expect(await screen.findByText(HINT_TEXT)).toBeInTheDocument();
  });

  it('stops showing once the cap of 5 is reached', async () => {
    window.localStorage.setItem(HINT_KEY, JSON.stringify({ shows: 5, dismissed: false }));
    renderFeed();
    await waitFor(() => expect(getJobNotes).toHaveBeenCalled());
    expect(screen.queryByText(HINT_TEXT)).not.toBeInTheDocument();
  });

  it('hides immediately and persists dismissal when the × is tapped', async () => {
    const user = userEvent.setup();
    window.localStorage.removeItem(HINT_KEY);
    renderFeed();
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
    renderFeed();
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
    renderFeed();
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
    renderFeed();
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
    const { unmount } = renderFeed();
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
    const { unmount } = renderFeed();
    await waitFor(() => expect(getJobNotes).toHaveBeenCalled());
    unmount();

    expect(
      mock(logOperatorEvent).mock.calls.some((c: unknown[]) => c[1] === 'composer_abandoned'),
    ).toBe(false);
  });

  it('does NOT record abandonment after a successful save', async () => {
    const user = userEvent.setup();
    mock(addJobNote).mockResolvedValue(makeNote({ id: 'new', body: 'saved' }));
    const { unmount } = renderFeed();
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

// The photo path. The reported failure — "took photos during the diary week and
// none uploaded" — turned out to be the operator using their phone's camera app,
// so the shots never entered Jigged at all. These cover the two adjacent defects
// found while tracing that, both of which lose photos SILENTLY, plus the
// above-the-fold way in.
describe('JobFeed — photo path', () => {
  it('says a pending photo is not saved yet', async () => {
    // A thumbnail alone reads as "done". Nothing is stored until Post, and the
    // gap between those two states is where photos go missing with no signal.
    const user = userEvent.setup();
    const { container } = renderFeed();
    await waitFor(() => expect(getJobNotes).toHaveBeenCalled());

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(input, new File(['x'], 'setup.jpg', { type: 'image/jpeg' }));

    expect(await screen.findByText(/not saved yet — tap Post/i)).toBeInTheDocument();
  });

  it('reports photos dropped from a multi-pick instead of dropping them quietly', async () => {
    // Was a bare `continue`: pick three, one reads back empty, two attach and
    // nothing is said — because the error only fired when EVERY pick failed.
    const user = userEvent.setup();
    const { container } = renderFeed();
    await waitFor(() => expect(getJobNotes).toHaveBeenCalled());

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(input, [
      new File(['x'], 'good.jpg', { type: 'image/jpeg' }),
      new File([], 'empty.jpg', { type: 'image/jpeg' }),
    ]);

    expect(await screen.findByText(/1 of 2 photos could not be read/i)).toBeInTheDocument();
    // ...and the readable one is still attached, not thrown away with it.
    expect(screen.getByAltText('Pending photo')).toBeInTheDocument();
  });

  it('stores a thumbnail alongside the photo', async () => {
    // thumbnail_path was never populated, so every 76px tile pulled a full
    // 2048px JPEG. On shop wifi those tiles never resolve — which looks exactly
    // like a photo that failed to upload.
    const user = userEvent.setup();
    const thumb = new File(['t'], 'thumb.jpg', { type: 'image/jpeg' });
    mock(compressPhoto).mockResolvedValue({
      file: new File(['f'], 'setup.jpg', { type: 'image/jpeg' }),
      thumbnail: thumb,
      dims: { width: 100, height: 80 },
    });
    mock(addJobNote).mockResolvedValue(makeNote({ id: 'n-photo', body: null }));
    mock(addJobNoteMedia).mockResolvedValue({
      id: 'm1',
      note_id: 'n-photo',
      storage_path: 'p',
      thumbnail_path: 't',
      kind: 'photo',
      mime_type: 'image/jpeg',
      width: 100,
      height: 80,
    });

    const { container } = renderFeed();
    await waitFor(() => expect(getJobNotes).toHaveBeenCalled());
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(input, new File(['x'], 'setup.jpg', { type: 'image/jpeg' }));
    await user.click(screen.getByRole('button', { name: 'Post' }));

    await waitFor(() =>
      expect(addJobNoteMedia).toHaveBeenCalledWith(
        'co1',
        'job1',
        'n-photo',
        expect.any(File),
        expect.objectContaining({ thumbnail: thumb }),
      ),
    );
  });

  it('opens the picker when the above-the-fold button signals', async () => {
    // The composer sits below the job card, reference row and completion block —
    // off-screen on a phone. The op card's button drives the picker from where
    // the operator actually is.
    const { container, rerender } = renderFeed({ photoPickSignal: 0 });
    await waitFor(() => expect(getJobNotes).toHaveBeenCalled());
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const clickSpy = vi.spyOn(input, 'click').mockImplementation(() => {});

    rerender(
      <JobFeed jobId="job1" companyId="co1" operationContext={OP_CONTEXT} photoPickSignal={1} />,
    );

    await waitFor(() => expect(clickSpy).toHaveBeenCalledTimes(1));
  });

  it('records photo_attached with what was picked versus attached', async () => {
    const user = userEvent.setup();
    const { container } = renderFeed();
    await waitFor(() => expect(getJobNotes).toHaveBeenCalled());

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(input, new File(['x'], 'setup.jpg', { type: 'image/jpeg' }));

    expect(logOperatorEvent).toHaveBeenCalledWith(
      'co1',
      'photo_attached',
      expect.objectContaining({ attached: 1, unreadable: 0, picked: 1 }),
    );
  });
});

// Reproduced live on a preview whose storage bucket was missing: the note row was
// created, the photo upload failed, and an empty entry was left in the feed under
// the operator's name while the photo sat pending — so the obvious retry would
// have made a second note.
describe('JobFeed — partial post failure', () => {
  it('removes the note when nothing landed on it', async () => {
    const user = userEvent.setup();
    mock(addJobNote).mockResolvedValue(makeNote({ id: 'orphan', body: null }));
    mock(compressPhoto).mockResolvedValue({
      file: new File(['f'], 'setup.jpg', { type: 'image/jpeg' }),
    });
    mock(addJobNoteMedia).mockRejectedValue(new Error('Bucket not found'));

    const { container } = renderFeed();
    await waitFor(() => expect(getJobNotes).toHaveBeenCalled());
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(input, new File(['x'], 'setup.jpg', { type: 'image/jpeg' }));
    await user.click(screen.getByRole('button', { name: 'Post' }));

    await waitFor(() => expect(deleteJobNote).toHaveBeenCalledWith('orphan'));
  });

  it('keeps a note that has text, even when its photo fails', async () => {
    // The text is real work. Only an entry with nothing in it is debris.
    const user = userEvent.setup();
    mock(addJobNote).mockResolvedValue(makeNote({ id: 'kept', body: 'watch the bore' }));
    mock(compressPhoto).mockResolvedValue({
      file: new File(['f'], 'setup.jpg', { type: 'image/jpeg' }),
    });
    mock(addJobNoteMedia).mockRejectedValue(new Error('Bucket not found'));

    const { container } = renderFeed();
    await waitFor(() => expect(getJobNotes).toHaveBeenCalled());
    await user.type(
      screen.getByPlaceholderText('Add a note or photo for this step…'),
      'watch the bore',
    );
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(input, new File(['x'], 'setup.jpg', { type: 'image/jpeg' }));
    await user.click(screen.getByRole('button', { name: 'Post' }));

    // Target the error text, not role=alert — the "not saved yet" warning is an
    // Alert too, so the role matches both.
    await screen.findByText(/Bucket not found/i);
    expect(deleteJobNote).not.toHaveBeenCalled();
  });

  it('does not re-offer photos that already attached, so a retry cannot duplicate them', async () => {
    // Two photos, second upload fails. The first is on the note; leaving it
    // pending would upload it again on the operator's next tap.
    const user = userEvent.setup();
    mock(addJobNote).mockResolvedValue(makeNote({ id: 'partial', body: 'two shots' }));
    mock(compressPhoto).mockResolvedValue({
      file: new File(['f'], 'setup.jpg', { type: 'image/jpeg' }),
    });
    mock(addJobNoteMedia)
      .mockResolvedValueOnce({
        id: 'm1',
        note_id: 'partial',
        storage_path: 'p',
        thumbnail_path: null,
        kind: 'photo',
        mime_type: 'image/jpeg',
        width: null,
        height: null,
      })
      .mockRejectedValueOnce(new Error('network died'));

    const { container } = renderFeed();
    await waitFor(() => expect(getJobNotes).toHaveBeenCalled());
    await user.type(screen.getByPlaceholderText('Add a note or photo for this step…'), 'two shots');
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(input, [
      new File(['a'], 'one.jpg', { type: 'image/jpeg' }),
      new File(['b'], 'two.jpg', { type: 'image/jpeg' }),
    ]);
    expect(screen.getAllByAltText('Pending photo')).toHaveLength(2);

    await user.click(screen.getByRole('button', { name: 'Post' }));

    // Only the failed one remains queued.
    await waitFor(() => expect(screen.getAllByAltText('Pending photo')).toHaveLength(1));
  });
});
