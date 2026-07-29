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

beforeEach(() => {
  vi.stubGlobal('localStorage', new MemoryStorage());
  rpc.mockReset();
  rpc.mockResolvedValue({ data: 0, error: null });
});

describe('NoteUsageBanner', () => {
  it('renders nothing at zero', async () => {
    // "0 people used your notes this week" is a weekly reminder that nobody
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

    expect(await screen.findByText('3 people used your notes this week.')).toBeInTheDocument();
  });

  it('reads naturally at one', async () => {
    rpc.mockResolvedValue({ data: 1, error: null });
    render(<NoteUsageBanner companyId="c1" />);

    expect(
      await screen.findByText('Someone used one of your notes this week.'),
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

  it('dismisses for this week only, so the loop survives one tap', async () => {
    // A permanent dismissal would end the feedback loop the first time it is
    // inconvenient. The key carries the ISO week.
    const user = userEvent.setup();
    rpc.mockResolvedValue({ data: 4, error: null });
    render(<NoteUsageBanner companyId="c1" />);
    await screen.findByText('4 people used your notes this week.');

    await user.click(screen.getByRole('button', { name: /close/i }));

    await waitFor(() =>
      expect(screen.queryByText('4 people used your notes this week.')).not.toBeInTheDocument(),
    );
    const stored = localStorage.getItem('jigged:note-usage-banner-dismissed');
    expect(stored).toMatch(/^\d{4}-W\d{2}$/);
  });

  it('comes back next week after being dismissed', async () => {
    localStorage.setItem('jigged:note-usage-banner-dismissed', '1999-W01');
    rpc.mockResolvedValue({ data: 2, error: null });
    render(<NoteUsageBanner companyId="c1" />);

    expect(await screen.findByText('2 people used your notes this week.')).toBeInTheDocument();
  });
});
