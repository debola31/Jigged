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

const part = (over: { id: string; part_name: string }) =>
  ({ ...over, primary_unit: 'ea' }) as unknown as Part;

const renderModal = (props: Partial<React.ComponentProps<typeof OperatorReceivePartModal>> = {}) =>
  render(
    <OperatorReceivePartModal
      open
      companyId="co1"
      locationId="loc1"
      locationName="Bin 3"
      excludePartIds={['pC']}
      operatorId="op1"
      onClose={vi.fn()}
      onDone={vi.fn()}
      {...props}
    />,
    { wrapper: ({ children }) => <ThemeProvider theme={jiggedTheme}>{children}</ThemeProvider> },
  );

beforeEach(() => {
  vi.clearAllMocks();
  (getStockedParts as ReturnType<typeof vi.fn>).mockResolvedValue([
    part({ id: 'pA', part_name: 'Part A' }),
    part({ id: 'pB', part_name: 'Part B' }),
    part({ id: 'pC', part_name: 'Part C' }), // already here → excluded
  ]);
});

describe('OperatorReceivePartModal', () => {
  const openPartPicker = async () => {
    const input = await screen.findByRole('combobox', { name: 'Part' });
    await userEvent.click(input);
    await userEvent.keyboard('{ArrowDown}'); // ensure the listbox opens
    return input;
  };

  /**
   * "Already in the bin" is the only exclusion left. The other one — a part not tracked by place —
   * went with `is_location_tracked` in 20260802015837: every part can be received anywhere now.
   */
  it('offers every part not already in the bin', async () => {
    renderModal();
    await openPartPicker();
    expect(await screen.findByRole('option', { name: 'Part A' })).toBeInTheDocument();
    expect(await screen.findByRole('option', { name: 'Part B' })).toBeInTheDocument();
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
      // Receiving into a bin is a put-away, so it carries an author like every other
      // operator write — bin history cannot name `created_by` (an auth user id).
      expect(addStockAtLocation).toHaveBeenCalledWith('pA', 'loc1', 10, 'ea', {
        notes: undefined,
        operatorId: 'op1',
      }),
    );
    expect(onDone).toHaveBeenCalled();
  });
});
