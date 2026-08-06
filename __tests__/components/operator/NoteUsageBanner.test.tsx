import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@/__tests__/test-utils';
import userEvent from '@testing-library/user-event';

import NoteUsageBanner from '@/components/operator/NoteUsageBanner';

const rpc = vi.fn();
vi.mock('@/lib/supabase', () => ({
  getSupabase: () => ({ rpc }),
}));

const SEEN_KEY = 'jigged:note-digest-acknowledged';

/** The digest is a single-row TABLE now: { views, helpful }. */
const digest = (views: number, helpful = 0) => ({ data: [{ views, helpful }], error: null });
const seen = (views: number, helpful = 0) =>
  localStorage.setItem(SEEN_KEY, JSON.stringify({ views, helpful }));

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

beforeEach(() => {
  vi.stubGlobal('localStorage', new MemoryStorage());
  rpc.mockReset();
  rpc.mockResolvedValue(digest(0));
});

describe('NoteUsageBanner', () => {
  it('renders nothing when nothing has happened', async () => {
    // A standing "0 views" is a permanent reminder that nobody cares. Silence
    // is better.
    seen(0);
    rpc.mockResolvedValue(digest(0));
    const { container } = render(<NoteUsageBanner companyId="c1" />);

    await waitFor(() => expect(rpc).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('shows only what is NEW since the operator last looked', async () => {
    // The running total is 9, but 6 of those were already seen — showing "9"
    // would claim six things happened that did not.
    seen(6);
    rpc.mockResolvedValue(digest(9));
    render(<NoteUsageBanner companyId="c1" />);

    expect(await screen.findByText('3 new views.')).toBeInTheDocument();
  });

  it('reads naturally at one', async () => {
    seen(0);
    rpc.mockResolvedValue(digest(1));
    render(<NoteUsageBanner companyId="c1" />);

    expect(await screen.findByText('1 new view.')).toBeInTheDocument();
  });

  it('asks for the total with no arguments at all', async () => {
    // The permanent rule: a caller-supplied time window would be a bisection
    // oracle for WHEN a note was read. The delta is computed here instead,
    // from a number the server already gave us.
    seen(0);
    rpc.mockResolvedValue(digest(2));
    render(<NoteUsageBanner companyId="c1" />);

    await waitFor(() => expect(rpc).toHaveBeenCalledWith('my_note_digest'));
  });

  it('stays quiet once the total has been seen', async () => {
    // No nag on every single visit to the jobs list — an operator lands there
    // many times a shift.
    seen(4);
    rpc.mockResolvedValue(digest(4));
    const { container } = render(<NoteUsageBanner companyId="c1" />);

    await waitFor(() => expect(rpc).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('comes back the moment the total grows again', async () => {
    // The whole loop: silence until something genuinely new happens.
    seen(4);
    rpc.mockResolvedValue(digest(5));
    render(<NoteUsageBanner companyId="c1" />);

    expect(await screen.findByText('1 new view.')).toBeInTheDocument();
  });

  it('leads with helpful, because it is the stronger claim', async () => {
    // A view is someone needing to look something up. A helpful is a colleague
    // choosing to say it was worth reading.
    seen(0, 0);
    rpc.mockResolvedValue(digest(3, 2));
    render(<NoteUsageBanner companyId="c1" />);

    expect(
      await screen.findByText('2 people found your notes helpful · 3 new views.'),
    ).toBeInTheDocument();
  });

  it('says only what actually moved', async () => {
    // Views unchanged, one new helpful — mentioning "0 new views" would be noise.
    seen(9, 0);
    rpc.mockResolvedValue(digest(9, 1));
    render(<NoteUsageBanner companyId="c1" />);

    expect(
      await screen.findByText('Someone found one of your notes helpful.'),
    ).toBeInTheDocument();
  });

  it('does not go negative when someone takes a helpful back', async () => {
    // viewer_count is monotonic; helpful is NOT — a reaction can be removed. A
    // raw subtraction would render "-1 new".
    seen(9, 4);
    rpc.mockResolvedValue(digest(9, 2));
    const { container } = render(<NoteUsageBanner companyId="c1" />);

    await waitFor(() => expect(rpc).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('stays silent when the digest fails', async () => {
    // An operator starting work must not be shown a backend error.
    rpc.mockResolvedValue({ data: null, error: { message: 'denied' } });
    const { container } = render(<NoteUsageBanner companyId="c1" />);

    await waitFor(() => expect(rpc).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('dismissing banks the whole total, not just the new part', async () => {
    // Banking only the delta would re-show the same news forever.
    const user = userEvent.setup();
    seen(2);
    rpc.mockResolvedValue(digest(6));
    render(<NoteUsageBanner companyId="c1" />);
    await screen.findByText('4 new views.');

    await user.click(screen.getByRole('button', { name: /close/i }));

    await waitFor(() =>
      expect(screen.queryByText('4 new views.')).not.toBeInTheDocument(),
    );
    expect(JSON.parse(localStorage.getItem(SEEN_KEY)!)).toMatchObject({ views: 6 });
  });

  it('a tap-through banks it too, and opens the detail', async () => {
    // Coming back from My work to the same banner you just acted on reads as if
    // nothing happened.
    const user = userEvent.setup();
    const onOpenDetail = vi.fn();
    seen(0);
    rpc.mockResolvedValue(digest(3));
    render(<NoteUsageBanner companyId="c1" onOpenDetail={onOpenDetail} />);

    await user.click(await screen.findByText('3 new views.'));

    expect(onOpenDetail).toHaveBeenCalledTimes(1);
    expect(JSON.parse(localStorage.getItem(SEEN_KEY)!)).toMatchObject({ views: 3 });
  });

  it('dismissing does not count as opening the detail', async () => {
    // The close button sits inside the tappable Alert; a bubbled click would
    // navigate the operator away from the screen they were dismissing.
    const user = userEvent.setup();
    const onOpenDetail = vi.fn();
    seen(0);
    rpc.mockResolvedValue(digest(3));
    render(<NoteUsageBanner companyId="c1" onOpenDetail={onOpenDetail} />);
    await screen.findByText('3 new views.');

    await user.click(screen.getByRole('button', { name: /close/i }));

    expect(onOpenDetail).not.toHaveBeenCalled();
  });

  it('announces nothing on a device that has never shown the banner', async () => {
    // THE MULTI-DEVICE TRAP. The acknowledged mark lives in localStorage, so it
    // does not follow the person: a shop tablet, a replacement phone, a second
    // browser or cleared site data all start empty. Defaulting to zero would
    // render the entire history as new — "312 new views" after a year — and the
    // banner's only asset is that its number is true.
    rpc.mockResolvedValue(digest(312));
    const { container } = render(<NoteUsageBanner companyId="c1" />);

    await waitFor(() => expect(rpc).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
    // The total is adopted silently, so the NEXT view is correctly announced.
    expect(JSON.parse(localStorage.getItem(SEEN_KEY)!)).toMatchObject({ views: 312 });
  });

  it('announces normally once that device has a mark', async () => {
    seen(312);
    rpc.mockResolvedValue(digest(313));
    render(<NoteUsageBanner companyId="c1" />);

    expect(await screen.findByText('1 new view.')).toBeInTheDocument();
  });

  it('treats a mangled stored value as absent, not as zero', async () => {
    // Zero would announce the whole history; absent adopts it quietly. Staying
    // silent beats announcing a falsehood.
    localStorage.setItem(SEEN_KEY, 'not json');
    rpc.mockResolvedValue(digest(40));
    const { container } = render(<NoteUsageBanner companyId="c1" />);

    await waitFor(() => expect(rpc).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
    expect(JSON.parse(localStorage.getItem(SEEN_KEY)!)).toMatchObject({ views: 40 });
  });
});
