import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThemeProvider } from '@mui/material/styles';
import jiggedTheme from '@/lib/theme';

import PartLocationActionModal, {
  type LocationBalanceOption,
  type LocationOption,
} from '@/components/parts/PartLocationActionModal';
import { transferStock } from '@/utils/inventoryLocationsAccess';

vi.mock('@/utils/inventoryLocationsAccess', () => ({
  addStockAtLocation: vi.fn(),
  depleteStockAtLocation: vi.fn(),
  adjustStockAtLocation: vi.fn(),
  transferStock: vi.fn(),
}));

// The Remove action embeds JobTagPicker, which imports jobsAccess -> lib/supabase. Stubbed so
// the module graph never evaluates a real Supabase client.
vi.mock('@/utils/jobsAccess', () => ({ getAllJobs: vi.fn(async () => []) }));

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
      expect(transferStock).toHaveBeenCalledWith('p1', 'l1', 'l2', 1, 'ea', undefined),
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
      expect(transferStock).toHaveBeenCalledWith('p1', 'l1', 'l3', 1, 'ea', undefined),
    );
  });
});
