import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@/__tests__/test-utils';
import userEvent from '@testing-library/user-event';

import JobFeed from '@/components/operator/JobFeed';
import { getJobNotes, addJobNote, getCurrentMember } from '@/utils/operatorAccess';
import { addJobNoteMedia, getJobNoteMediaUrl } from '@/utils/jobNoteMediaAccess';
import { compressPhoto } from '@/utils/imageCompression';
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

const mock = (fn: unknown) => fn as ReturnType<typeof vi.fn>;

const OP_CONTEXT = { jobPartId: 'jp1', jobOperationId: 'jo1', operationLabel: 'Op 20 · Mill' };
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

  it('stops showing after the cap is reached', async () => {
    window.localStorage.setItem(HINT_KEY, JSON.stringify({ shows: 3, dismissed: false }));
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
