import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
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

// This jsdom setup doesn't provide localStorage (no --localstorage-file), which is also a real
// browser case — private mode and some webviews. The page tolerates its absence; these tests
// need a working one to exercise the draft, so install a minimal in-memory shim.
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

/** The count input for a named part — every row has one, so scope by label. */
const inputFor = (partName: string) =>
  screen.getByRole('spinbutton', { name: new RegExp(`counted quantity for ${partName}`, 'i') });

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

describe('landing', () => {
  it('drops you straight onto the parts with no scope step to get past', async () => {
    renderPage();
    // Both parts, and their inputs, are present on arrival — no selection gate.
    expect(await screen.findByText('4140 bar')).toBeInTheDocument();
    expect(inputFor('4140 bar')).toBeInTheDocument();
    expect(inputFor('6061 plate')).toBeInTheDocument();
  });

  it('says what the page is for, and that blanks are safe', async () => {
    renderPage();
    expect(await screen.findByText(/walk your shop and enter what you actually have/i)).toBeInTheDocument();
    expect(screen.getByText(/leave blank stays exactly as it is/i)).toBeInTheDocument();
  });

  it('starts every input empty, so nothing can be tabbed past and accepted', async () => {
    renderPage();
    await screen.findByText('4140 bar');
    expect(inputFor('4140 bar')).toHaveValue(null);
    expect(inputFor('6061 plate')).toHaveValue(null);
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

describe('inline feedback', () => {
  it('shows the delta on the row as soon as a number is typed', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('4140 bar');

    await user.type(inputFor('4140 bar'), '38');
    expect(await screen.findByText('-2')).toBeInTheDocument();
  });

  it('says a count matches rather than showing a zero delta', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('4140 bar');

    await user.type(inputFor('4140 bar'), '40');
    // Anchored: the footer also says "Everything matches so far".
    expect(await screen.findByText(/^Matches$/)).toBeInTheDocument();
  });

  it('tracks progress and what will change, in plain language', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('4140 bar');
    expect(screen.getByText(/nothing entered yet/i)).toBeInTheDocument();

    await user.type(inputFor('4140 bar'), '40'); // matches
    expect(await screen.findByText(/everything matches so far/i)).toBeInTheDocument();

    await user.type(inputFor('6061 plate'), '9'); // changes
    expect(await screen.findByText('2 counted')).toBeInTheDocument();
    expect(screen.getByText('1 will change')).toBeInTheDocument();
  });

  it('cannot save when nothing would change', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('4140 bar');
    expect(screen.getByRole('button', { name: /save 0 changes/i })).toBeDisabled();

    await user.type(inputFor('4140 bar'), '40'); // matches — still nothing to write
    expect(screen.getByRole('button', { name: /save 0 changes/i })).toBeDisabled();
  });

  it('clearing an input un-counts the row rather than counting it as zero', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('4140 bar');

    await user.type(inputFor('4140 bar'), '38');
    expect(await screen.findByText('1 counted')).toBeInTheDocument();

    await user.clear(inputFor('4140 bar'));
    expect(await screen.findByText('0 counted')).toBeInTheDocument();
  });
});

describe('saving', () => {
  const enterAndSave = async (partName: string, value: string) => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('4140 bar');
    await user.type(inputFor(partName), value);
    await user.click(screen.getByRole('button', { name: /save 1 change/i }));
    return user;
  };

  it('re-reads current quantities before confirming', async () => {
    await enterAndSave('4140 bar', '38');
    await waitFor(() => expect(refreshSystemQuantities).toHaveBeenCalledWith(['p1']));
  });

  it('confirms in a dialog instead of a separate review page', async () => {
    const user = await enterAndSave('4140 bar', '38');
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/save 1 change\?/i)).toBeInTheDocument();
    expect(commitCount).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(commitCount).toHaveBeenCalled());
    const [variances] = asMock(commitCount).mock.calls[0];
    expect(variances).toHaveLength(1);
    expect(variances[0].counted).toBe(38);
  });

  it('calls out a big swing in the dialog — most of those are miscounts', async () => {
    await enterAndSave('4140 bar', '2'); // 40 -> 2
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/more than half of what the system had/i)).toBeInTheDocument();
  });

  it('does not call that out for a routine change', async () => {
    await enterAndSave('4140 bar', '38'); // 5%
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByText(/more than half/i)).not.toBeInTheDocument();
  });

  it('says which parts moved while the count was open', async () => {
    asMock(refreshSystemQuantities).mockResolvedValue(new Map([['p1', 44]]));
    await enterAndSave('4140 bar', '38');
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/moved while you were counting/i)).toBeInTheDocument();
  });

  it('backs out to the sheet with entries intact', async () => {
    const user = await enterAndSave('4140 bar', '38');
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: /keep counting/i }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(inputFor('4140 bar')).toHaveValue(38);
    expect(commitCount).not.toHaveBeenCalled();
  });

  it('reports partial failure instead of claiming success', async () => {
    asMock(commitCount).mockResolvedValue({
      committed: 0,
      failures: [{ partName: '4140 bar', message: 'network died' }],
    });
    const user = await enterAndSave('4140 bar', '38');
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: /^save$/i }));

    expect(await screen.findByText(/could not be saved/i)).toBeInTheDocument();
    expect(mockPush).not.toHaveBeenCalled();
  });
});

describe('draft', () => {
  it('picks a count back up automatically, without asking', async () => {
    window.localStorage.setItem(
      'jigged.inventoryCount.co1',
      JSON.stringify({ version: 2, companyId: 'co1', entries: { p1: 38 }, savedAt: Date.now() }),
    );

    renderPage();
    await screen.findByText('4140 bar');
    // Restored into the field, and reported so it isn't a surprise.
    expect(inputFor('4140 bar')).toHaveValue(38);
    expect(screen.getByText(/picked up your unfinished count/i)).toBeInTheDocument();
  });

  it('can be discarded to start clean', async () => {
    window.localStorage.setItem(
      'jigged.inventoryCount.co1',
      JSON.stringify({ version: 2, companyId: 'co1', entries: { p1: 38 }, savedAt: Date.now() }),
    );
    renderPage();
    await screen.findByText('4140 bar');

    await userEvent.setup().click(screen.getByRole('button', { name: /start over/i }));
    await waitFor(() => expect(inputFor('4140 bar')).toHaveValue(null));
  });

  it('ignores a draft from another company', async () => {
    window.localStorage.setItem(
      'jigged.inventoryCount.co1',
      JSON.stringify({
        version: 2,
        companyId: 'SOMEONE-ELSE',
        entries: { p1: 5 },
        savedAt: Date.now(),
      }),
    );
    renderPage();
    await screen.findByText('4140 bar');
    expect(inputFor('4140 bar')).toHaveValue(null);
  });

  it('drops entries whose part no longer exists rather than misattaching them', async () => {
    window.localStorage.setItem(
      'jigged.inventoryCount.co1',
      JSON.stringify({
        version: 2,
        companyId: 'co1',
        entries: { 'deleted-part': 99, p1: 7 },
        savedAt: Date.now(),
      }),
    );
    renderPage();
    await screen.findByText('4140 bar');
    expect(inputFor('4140 bar')).toHaveValue(7);
    expect(await screen.findByText('1 counted')).toBeInTheDocument();
  });
});
