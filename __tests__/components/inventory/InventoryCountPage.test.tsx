import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThemeProvider } from '@mui/material/styles';
import jiggedTheme from '@/lib/theme';

const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  useParams: () => ({ companyId: 'co1' }),
  useRouter: () => ({ push: mockPush }),
}));

vi.mock('@/utils/inventoryCountAccess', () => ({
  loadCountCandidates: vi.fn(),
  refreshSystemQuantities: vi.fn(),
  commitCount: vi.fn(),
}));

import InventoryCountPage from '@/app/dashboard/[companyId]/inventory/count/page';
import {
  loadCountCandidates,
  refreshSystemQuantities,
  commitCount,
} from '@/utils/inventoryCountAccess';
import type { CountCandidate } from '@/types/inventoryCount';

const asMock = (fn: unknown) => fn as ReturnType<typeof vi.fn>;

// This jsdom setup doesn't provide localStorage (no --localstorage-file), which is also a
// real browser case — private mode and some webviews. The page tolerates its absence; these
// tests need a working one to exercise the draft, so install a minimal in-memory shim.
const memoryStorage = () => {
  let store: Record<string, string> = {};
  return {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => {
      store[k] = v;
    },
    removeItem: (k: string) => {
      delete store[k];
    },
    clear: () => {
      store = {};
    },
    key: (i: number) => Object.keys(store)[i] ?? null,
    get length() {
      return Object.keys(store).length;
    },
  } as Storage;
};
Object.defineProperty(window, 'localStorage', { value: memoryStorage(), writable: true });

const cand = (over: Partial<CountCandidate> & { partId: string }): CountCandidate => ({
  partName: over.partId,
  unit: 'ft',
  systemQuantity: 40,
  target: { kind: 'aggregate' },
  ...over,
});

const renderPage = () =>
  render(<InventoryCountPage />, {
    wrapper: ({ children }) => <ThemeProvider theme={jiggedTheme}>{children}</ThemeProvider>,
  });

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  asMock(loadCountCandidates).mockResolvedValue([
    cand({ partId: 'p1', partName: '4140 bar', systemQuantity: 40 }),
    cand({ partId: 'p2', partName: '6061 plate', systemQuantity: 12 }),
  ]);
  asMock(refreshSystemQuantities).mockResolvedValue(new Map());
  asMock(commitCount).mockResolvedValue({ committed: 1, failures: [] });
});

describe('scope step', () => {
  it('lists stocked parts with their current quantity', async () => {
    renderPage();
    expect(await screen.findByText('4140 bar')).toBeInTheDocument();
    expect(screen.getByText('40 ft')).toBeInTheDocument();
  });

  it('names parts held back instead of dropping them silently', async () => {
    asMock(loadCountCandidates).mockResolvedValue([
      cand({ partId: 'p1', partName: '4140 bar' }),
      cand({
        partId: 'p9',
        partName: 'Split part',
        target: { kind: 'excluded', reason: 'Stock is split across 3 locations' },
      }),
    ]);
    renderPage();
    await screen.findByText('4140 bar');

    expect(screen.getByText(/not on this sheet/i)).toBeInTheDocument();
    expect(screen.getByText('Split part')).toBeInTheDocument();
  });

  it('shows an empty state when nothing is stocked', async () => {
    asMock(loadCountCandidates).mockResolvedValue([]);
    renderPage();
    expect(await screen.findByText(/nothing to count yet/i)).toBeInTheDocument();
  });
});

describe('counting', () => {
  it('tracks progress and leaves blank lines alone', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('4140 bar');

    await user.click(screen.getByRole('button', { name: /select all/i }));
    await user.click(screen.getByRole('button', { name: /count 2 items/i }));

    expect(await screen.findByText('0 of 2 counted')).toBeInTheDocument();

    const inputs = screen.getAllByRole('spinbutton', { name: /counted/i });
    await user.type(inputs[0], '38');

    expect(await screen.findByText('1 of 2 counted')).toBeInTheDocument();
  });

  it('re-reads current quantities before showing variances', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('4140 bar');

    await user.click(screen.getByRole('button', { name: /select all/i }));
    await user.click(screen.getByRole('button', { name: /count 2 items/i }));
    await user.type(screen.getAllByRole('spinbutton', { name: /counted/i })[0], '38');
    await user.click(screen.getByRole('button', { name: /^review$/i }));

    // Variances must be computed against a fresh read, not the sheet's opening snapshot.
    await waitFor(() => expect(refreshSystemQuantities).toHaveBeenCalledWith(['p1', 'p2']));
  });

  it('says a part moved while the count was open', async () => {
    const user = userEvent.setup();
    // Opened at 40, now 44 — the count is still valid, but the variance shifted underneath.
    asMock(refreshSystemQuantities).mockResolvedValue(new Map([['p1', 44]]));
    renderPage();
    await screen.findByText('4140 bar');

    await user.click(screen.getByRole('button', { name: /select all/i }));
    await user.click(screen.getByRole('button', { name: /count 2 items/i }));
    await user.type(screen.getAllByRole('spinbutton', { name: /counted/i })[0], '38');
    await user.click(screen.getByRole('button', { name: /^review$/i }));

    expect(await screen.findByText(/moved while you were counting/i)).toBeInTheDocument();
  });
});

describe('review and commit', () => {
  const reachReview = async (counted: string) => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('4140 bar');
    await user.click(screen.getByRole('button', { name: /select all/i }));
    await user.click(screen.getByRole('button', { name: /count 2 items/i }));
    await user.type(screen.getAllByRole('spinbutton', { name: /counted/i })[0], counted);
    await user.click(screen.getByRole('button', { name: /^review$/i }));
    return user;
  };

  it('commits a routine change without an extra prompt', async () => {
    const user = await reachReview('38'); // 40 -> 38, a 5% change
    await user.click(await screen.findByRole('button', { name: /save 1 change/i }));

    await waitFor(() => expect(commitCount).toHaveBeenCalled());
    const [variances] = asMock(commitCount).mock.calls[0];
    expect(variances).toHaveLength(1);
    expect(variances[0].counted).toBe(38);
  });

  it('asks before committing a big swing — most of those are miscounts', async () => {
    const user = await reachReview('2'); // 40 -> 2, a 95% change
    await user.click(await screen.findByRole('button', { name: /save 1 change/i }));

    expect(await screen.findByText(/big change/i)).toBeInTheDocument();
    expect(commitCount).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: /save anyway/i }));
    await waitFor(() => expect(commitCount).toHaveBeenCalled());
  });

  it('reports partial failure instead of claiming success', async () => {
    asMock(commitCount).mockResolvedValue({
      committed: 0,
      failures: [{ partName: '4140 bar', message: 'network died' }],
    });
    const user = await reachReview('38');
    await user.click(await screen.findByRole('button', { name: /save 1 change/i }));

    expect(await screen.findByText(/could not be saved/i)).toBeInTheDocument();
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('says there is nothing to do when every count matched', async () => {
    await reachReview('40'); // equals the system quantity
    expect(await screen.findByText(/nothing to change/i)).toBeInTheDocument();
  });
});

describe('draft resume', () => {
  it('offers to resume an unfinished count', async () => {
    window.localStorage.setItem(
      'jigged.inventoryCount.co1',
      JSON.stringify({
        version: 1,
        companyId: 'co1',
        partIds: ['p1', 'p2'],
        lines: [
          { partId: 'p1', counted: 38 },
          { partId: 'p2', counted: null },
        ],
        savedAt: Date.now(),
      }),
    );

    renderPage();
    expect(await screen.findByText(/unfinished count/i)).toBeInTheDocument();

    await userEvent.setup().click(screen.getByRole('button', { name: /resume/i }));
    // Picks up where it left off rather than restarting at zero.
    expect(await screen.findByText('1 of 2 counted')).toBeInTheDocument();
  });

  it('ignores a draft from another company', async () => {
    window.localStorage.setItem(
      'jigged.inventoryCount.co1',
      JSON.stringify({
        version: 1,
        companyId: 'SOMEONE-ELSE',
        partIds: ['p1'],
        lines: [{ partId: 'p1', counted: 5 }],
        savedAt: Date.now(),
      }),
    );
    renderPage();
    await screen.findByText('4140 bar');
    expect(screen.queryByText(/unfinished count/i)).not.toBeInTheDocument();
  });
});
