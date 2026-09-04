import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThemeProvider } from '@mui/material/styles';
import jiggedTheme from '@/lib/theme';

import PartLocationActionModal, {
  type LocationBalanceOption,
  type LocationOption,
} from '@/components/parts/PartLocationActionModal';
import {
  addStockAtLocation,
  adjustStockAtLocation,
  depleteStockAtLocation,
  transferStock,
} from '@/utils/inventoryLocationsAccess';
import { getCurrentMember } from '@/utils/operatorAccess';

vi.mock('@/utils/inventoryLocationsAccess', () => ({
  addStockAtLocation: vi.fn(),
  depleteStockAtLocation: vi.fn(),
  adjustStockAtLocation: vi.fn(),
  transferStock: vi.fn(),
  // The heat suggestions a removal offers once a location is picked; empty here.
  getRecentHeatNumbersAtLocation: vi.fn(async () => []),
}));

/** The modal resolves the acting member so owner-side writes carry an author. */
vi.mock('@/utils/operatorAccess', () => ({
  getCurrentMember: vi.fn(async () => ({ id: 'member-1', name: 'Owner' })),
}));

// The Remove action embeds JobTagPicker, which imports jobsAccess -> lib/supabase. Stubbed so
// the module graph never evaluates a real Supabase client.
vi.mock('@/utils/jobsAccess', () => ({
  getAllJobs: vi.fn(async () => ({ jobs: [], total: 0, truncated: false })),
}));

const ALL: LocationOption[] = [
  { id: 'l1', label: 'Left' },
  { id: 'l2', label: 'Right' },
  { id: 'l3', label: 'Bin' },
];

const renderMove = (sourceBalances: LocationBalanceOption[]) =>
  render(
    <PartLocationActionModal
      open
      action="move"
      companyId="co1"
      partId="p1"
      primaryUnit="ea"
      unitOptions={['ea']}
      locations={ALL}
      sourceBalances={sourceBalances}
      onClose={vi.fn()}
      onDone={vi.fn()}
    />,
    { wrapper: ({ children }) => <ThemeProvider theme={jiggedTheme}>{children}</ThemeProvider> },
  );

beforeEach(() => {
  vi.clearAllMocks();
  (transferStock as ReturnType<typeof vi.fn>).mockResolvedValue({ transfer_group_id: 'g', from_balance: 0, to_balance: 0 });
});

describe('PartLocationActionModal — Move', () => {
  it('auto-selects the source when the part is in one place (no From picker)', async () => {
    renderMove([{ id: 'l1', label: 'Left', quantity: 2 }]);
    // Single source → no "From location" picker; the source is implied (proven
    // by transferStock receiving 'l1' below without us choosing it).
    const toCombo = await screen.findByRole('combobox', { name: /to location/i });
    expect(screen.queryByRole('combobox', { name: /from location/i })).not.toBeInTheDocument();

    await userEvent.click(toCombo);
    await userEvent.click(await screen.findByRole('option', { name: /^Right/ }));
    await userEvent.type(screen.getByRole('spinbutton', { name: /quantity/i }), '1');
    await userEvent.click(screen.getByRole('button', { name: /confirm/i }));

    await waitFor(() =>
      expect(transferStock).toHaveBeenCalledWith('p1', 'l1', 'l2', 1, 'ea', {
        notes: undefined,
        operatorId: 'member-1',
      }),
    );
  });

  it('blocks moving more than the source holds, upfront (no DB call)', async () => {
    renderMove([{ id: 'l1', label: 'Left', quantity: 2 }]);
    await userEvent.click(await screen.findByRole('combobox', { name: /to location/i }));
    await userEvent.click(await screen.findByRole('option', { name: /^Right/ }));
    await userEvent.type(screen.getByRole('spinbutton', { name: /quantity/i }), '5');
    await userEvent.click(screen.getByRole('button', { name: /confirm/i }));

    expect(await screen.findByText(/only 2 ea at the source/i)).toBeInTheDocument();
    expect(transferStock).not.toHaveBeenCalled();
  });

  it('offers only locations with stock as the source when there are several', async () => {
    renderMove([
      { id: 'l1', label: 'Left', quantity: 2 },
      { id: 'l2', label: 'Right', quantity: 3 },
    ]);
    await userEvent.click(await screen.findByRole('combobox', { name: /from location/i }));
    expect(await screen.findByRole('option', { name: /Left — 2 ea/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Right — 3 ea/ })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /^Bin/ })).not.toBeInTheDocument(); // empty location not a source
    await userEvent.click(screen.getByRole('option', { name: /Left — 2 ea/ }));

    await userEvent.click(screen.getByRole('combobox', { name: /to location/i }));
    await userEvent.click(await screen.findByRole('option', { name: /^Bin/ }));
    await userEvent.type(screen.getByRole('spinbutton', { name: /quantity/i }), '1');
    await userEvent.click(screen.getByRole('button', { name: /confirm/i }));

    await waitFor(() =>
      expect(transferStock).toHaveBeenCalledWith('p1', 'l1', 'l3', 1, 'ea', {
        notes: undefined,
        operatorId: 'member-1',
      }),
    );
  });
});

/**
 * Every owner-side write must name who made it. The RPCs also stamp `created_by`, but that holds
 * an `auth.users` id the browser cannot resolve — so without `operatorId` the part page's own
 * history renders these rows permanently anonymous while the operator's phone names its own.
 */
describe('PartLocationActionModal — attribution', () => {
  const renderSingle = (action: 'add' | 'deplete' | 'adjust') =>
    render(
      <PartLocationActionModal
        open
        action={action}
        companyId="co1"
        partId="p1"
        primaryUnit="ea"
        unitOptions={['ea']}
        locations={ALL}
        onClose={vi.fn()}
        onDone={vi.fn()}
      />,
      { wrapper: ({ children }) => <ThemeProvider theme={jiggedTheme}>{children}</ThemeProvider> },
    );

  const write = async (action: 'add' | 'deplete' | 'adjust') => {
    const user = userEvent.setup();
    renderSingle(action);
    // `findBy`, not `getBy`: the Dialog mounts its body through a transition, and `handleEnter`
    // (which resolves the member) fires with it.
    await user.click(await screen.findByRole('combobox', { name: /location/i }));
    await user.click(await screen.findByRole('option', { name: /^Left/ }));
    await user.type(screen.getByRole('spinbutton', { name: /quantity/i }), '1');
    await user.click(screen.getByRole('button', { name: /confirm/i }));
  };

  it.each([
    ['add', addStockAtLocation],
    ['deplete', depleteStockAtLocation],
    ['adjust', adjustStockAtLocation],
  ] as const)('stamps the acting member on %s', async (action, fn) => {
    await write(action);
    await waitFor(() => expect(fn).toHaveBeenCalled());
    const opts = vi.mocked(fn).mock.calls[0].at(-1) as { operatorId?: string | null };
    expect(opts.operatorId).toBe('member-1');
  });

  /** A name lookup that fails must never block a stock correction. */
  it('still writes when the member cannot be resolved', async () => {
    vi.mocked(getCurrentMember).mockRejectedValueOnce(new Error('offline'));
    await write('add');

    await waitFor(() => expect(addStockAtLocation).toHaveBeenCalled());
    const opts = vi.mocked(addStockAtLocation).mock.calls[0].at(-1) as { operatorId?: string | null };
    expect(opts.operatorId).toBeNull();
  });
});
