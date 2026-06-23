import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThemeProvider } from '@mui/material/styles';
import jiggedTheme from '@/lib/theme';

import OperatorReceivePartModal from '@/components/operator/OperatorReceivePartModal';
import { addStockAtLocation } from '@/utils/inventoryLocationsAccess';
import { getStockedParts } from '@/utils/partsAccess';
import type { Part } from '@/types/part';

vi.mock('@/utils/inventoryLocationsAccess', () => ({ addStockAtLocation: vi.fn() }));
vi.mock('@/utils/partsAccess', () => ({ getStockedParts: vi.fn() }));

const part = (over: { id: string; part_name: string; is_location_tracked: boolean }) =>
  ({ ...over, primary_unit: 'ea' }) as unknown as Part;

const renderModal = (props: Partial<React.ComponentProps<typeof OperatorReceivePartModal>> = {}) =>
  render(
    <OperatorReceivePartModal
      open
      companyId="co1"
      locationId="loc1"
      locationName="Bin 3"
      excludePartIds={['pC']}
      onClose={vi.fn()}
      onDone={vi.fn()}
      {...props}
    />,
    { wrapper: ({ children }) => <ThemeProvider theme={jiggedTheme}>{children}</ThemeProvider> },
  );

beforeEach(() => {
  vi.clearAllMocks();
  (getStockedParts as ReturnType<typeof vi.fn>).mockResolvedValue([
    part({ id: 'pA', part_name: 'Part A', is_location_tracked: true }),
    part({ id: 'pB', part_name: 'Part B', is_location_tracked: false }), // not tracked → excluded
    part({ id: 'pC', part_name: 'Part C', is_location_tracked: true }), // already here → excluded
  ]);
});

describe('OperatorReceivePartModal', () => {
  const openPartPicker = async () => {
    const input = await screen.findByRole('combobox', { name: 'Part' });
    await userEvent.click(input);
    await userEvent.keyboard('{ArrowDown}'); // ensure the listbox opens
    return input;
  };

  it('offers only tracked parts not already in the bin', async () => {
    renderModal();
    await openPartPicker();
    expect(await screen.findByRole('option', { name: 'Part A' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Part B' })).not.toBeInTheDocument(); // untracked
    expect(screen.queryByRole('option', { name: 'Part C' })).not.toBeInTheDocument(); // already here
  });

  it('adds the chosen part at this location', async () => {
    (addStockAtLocation as ReturnType<typeof vi.fn>).mockResolvedValue({ location_balance: 10, part_quantity: 10 });
    const onDone = vi.fn();
    renderModal({ onDone });

    await openPartPicker();
    await userEvent.click(await screen.findByRole('option', { name: 'Part A' }));
    await userEvent.type(screen.getByRole('spinbutton', { name: 'Quantity' }), '10');
    await userEvent.click(screen.getByRole('button', { name: /^add$/i }));

    await waitFor(() =>
      expect(addStockAtLocation).toHaveBeenCalledWith('pA', 'loc1', 10, 'ea', undefined),
    );
    expect(onDone).toHaveBeenCalled();
  });
});
