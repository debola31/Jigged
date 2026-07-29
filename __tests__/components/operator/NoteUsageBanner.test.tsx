import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@/__tests__/test-utils';
import userEvent from '@testing-library/user-event';

import NoteUsageBanner from '@/components/operator/NoteUsageBanner';

const rpc = vi.fn();
vi.mock('@/lib/supabase', () => ({
  getSupabase: () => ({ rpc }),
  getTypedSupabase: () => ({ rpc }),
}));

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

/** The ISO week key the component will compute for "now". */
function isoWeekKeyNow(): string {
  const d = new Date();
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

beforeEach(() => {
  vi.stubGlobal('localStorage', new MemoryStorage());
  rpc.mockReset();
  rpc.mockResolvedValue({ data: 0, error: null });
});

describe('NoteUsageBanner', () => {
  it('renders nothing at zero', async () => {
    // "0 people viewed your notes this week" is a weekly reminder that nobody
    // cares. Silence is better.
    rpc.mockResolvedValue({ data: 0, error: null });
    const { container } = render(<NoteUsageBanner companyId="c1" />);

    await waitFor(() => expect(rpc).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('counts PEOPLE, and says so', async () => {
    // Three must mean three colleagues, not one person opening a note three
    // times. The author can just ask, so an inflated number discredits the loop.
    rpc.mockResolvedValue({ data: 3, error: null });
    render(<NoteUsageBanner companyId="c1" />);

    expect(await screen.findByText('3 people viewed your notes this week.')).toBeInTheDocument();
  });

  it('reads naturally at one', async () => {
    rpc.mockResolvedValue({ data: 1, error: null });
    render(<NoteUsageBanner companyId="c1" />);

    expect(
      await screen.findByText('Someone viewed one of your notes this week.'),
    ).toBeInTheDocument();
  });

  it('asks Postgres for the week boundary in the viewer’s own timezone', async () => {
    // A UTC cutoff would flip mid-shift for a US shop, so Monday's banner would
    // be reporting part of Sunday night.
    rpc.mockResolvedValue({ data: 2, error: null });
    render(<NoteUsageBanner companyId="c1" />);

    await waitFor(() =>
      expect(rpc).toHaveBeenCalledWith(
        'my_note_view_digest',
        expect.objectContaining({ p_tz: expect.any(String) }),
      ),
    );
  });

  it('stays silent when the digest fails', async () => {
    // An operator starting work must not be shown a backend error.
    rpc.mockResolvedValue({ data: null, error: { message: 'denied' } });
    const { container } = render(<NoteUsageBanner companyId="c1" />);

    await waitFor(() => expect(rpc).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('dismissing acknowledges the NUMBER, not the week', async () => {
    // A permanent dismissal would end the loop the first time it is
    // inconvenient, so what is stored is the count already seen.
    const user = userEvent.setup();
    rpc.mockResolvedValue({ data: 4, error: null });
    render(<NoteUsageBanner companyId="c1" />);
    await screen.findByText('4 people viewed your notes this week.');

    await user.click(screen.getByRole('button', { name: /close/i }));

    await waitFor(() =>
      expect(screen.queryByText('4 people viewed your notes this week.')).not.toBeInTheDocument(),
    );
    const stored = JSON.parse(localStorage.getItem('jigged:note-usage-banner-seen')!);
    expect(stored).toMatchObject({ count: 4, week: expect.stringMatching(/^\d{4}-W\d{2}$/) });
  });

  it('comes back when the number grows, so Friday is not swallowed by Monday', async () => {
    // THE BUG THIS EXISTS FOR: the count climbs all week. Under a plain
    // week-dismissal, someone who found the repetition annoying on Monday and
    // dismissed at "1 person" never saw Friday's "6 people" — the largest and
    // most motivating number of the week, silently suppressed.
    localStorage.setItem(
      'jigged:note-usage-banner-seen',
      JSON.stringify({ week: isoWeekKeyNow(), count: 1 }),
    );
    rpc.mockResolvedValue({ data: 6, error: null });
    render(<NoteUsageBanner companyId="c1" />);

    expect(await screen.findByText('6 people viewed your notes this week.')).toBeInTheDocument();
  });

  it('stays quiet while the number has not moved', async () => {
    // The other half: no nag on every single visit to the jobs list once the
    // operator has already seen that number.
    localStorage.setItem(
      'jigged:note-usage-banner-seen',
      JSON.stringify({ week: isoWeekKeyNow(), count: 4 }),
    );
    rpc.mockResolvedValue({ data: 4, error: null });
    const { container } = render(<NoteUsageBanner companyId="c1" />);

    await waitFor(() => expect(rpc).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the banner again rather than hiding it when storage is unreadable', async () => {
    // Failing open is the safe direction: at worst one extra impression, versus
    // silently ending the feedback loop.
    localStorage.setItem('jigged:note-usage-banner-seen', 'not json');
    rpc.mockResolvedValue({ data: 2, error: null });
    render(<NoteUsageBanner companyId="c1" />);

    expect(await screen.findByText('2 people viewed your notes this week.')).toBeInTheDocument();
  });

  it('opens the detail it promises, instead of being a dead end', async () => {
    // "3 people viewed your notes" with nowhere to go is the void this whole
    // workstream exists to close. Tapping must land on the author's own notes.
    const user = userEvent.setup();
    const onOpenDetail = vi.fn();
    rpc.mockResolvedValue({ data: 3, error: null });
    render(<NoteUsageBanner companyId="c1" onOpenDetail={onOpenDetail} />);

    await user.click(await screen.findByText('3 people viewed your notes this week.'));

    expect(onOpenDetail).toHaveBeenCalledTimes(1);
  });

  it('dismissing does not count as opening the detail', async () => {
    // The close button sits inside the tappable Alert; a bubbled click would
    // navigate the operator away from the screen they were dismissing.
    const user = userEvent.setup();
    const onOpenDetail = vi.fn();
    rpc.mockResolvedValue({ data: 3, error: null });
    render(<NoteUsageBanner companyId="c1" onOpenDetail={onOpenDetail} />);
    await screen.findByText('3 people viewed your notes this week.');

    await user.click(screen.getByRole('button', { name: /close/i }));

    expect(onOpenDetail).not.toHaveBeenCalled();
  });

  it('comes back next week after being acknowledged', async () => {
    localStorage.setItem(
      'jigged:note-usage-banner-seen',
      JSON.stringify({ week: '1999-W01', count: 99 }),
    );
    rpc.mockResolvedValue({ data: 2, error: null });
    render(<NoteUsageBanner companyId="c1" />);

    expect(await screen.findByText('2 people viewed your notes this week.')).toBeInTheDocument();
  });

  it('a tap-through acknowledges it too', async () => {
    // Coming back from My work to the same banner you just acted on reads as if
    // nothing happened.
    const user = userEvent.setup();
    rpc.mockResolvedValue({ data: 3, error: null });
    render(<NoteUsageBanner companyId="c1" onOpenDetail={vi.fn()} />);

    await user.click(await screen.findByText('3 people viewed your notes this week.'));

    expect(JSON.parse(localStorage.getItem('jigged:note-usage-banner-seen')!)).toMatchObject({
      count: 3,
    });
  });
});
