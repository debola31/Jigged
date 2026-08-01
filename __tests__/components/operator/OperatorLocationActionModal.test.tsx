import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThemeProvider } from '@mui/material/styles';
import jiggedTheme from '@/lib/theme';

import OperatorLocationActionModal from '@/components/operator/OperatorLocationActionModal';
import { depleteStockAtLocation, transferStock } from '@/utils/inventoryLocationsAccess';
import { getAllJobs } from '@/utils/jobsAccess';
import type { JobWithRelations } from '@/types/job';

vi.mock('@/utils/inventoryLocationsAccess', () => ({
  addStockAtLocation: vi.fn(),
  depleteStockAtLocation: vi.fn(),
  adjustStockAtLocation: vi.fn(),
  transferStock: vi.fn(),
}));
vi.mock('@/utils/jobsAccess', () => ({ getAllJobs: vi.fn() }));

const job = (over: { id: string; job_number: string; parts: string[] }) =>
  ({
    id: over.id,
    job_number: over.job_number,
    job_parts: over.parts.map((n) => ({ parts: { part_name: n } })),
  }) as unknown as JobWithRelations;

const renderModal = (props: Partial<React.ComponentProps<typeof OperatorLocationActionModal>> = {}) =>
  render(
    <OperatorLocationActionModal
      open
      action="deplete"
      companyId="co1"
      partId="p1"
      partName="Steel Rod"
      currentQuantity={12}
      primaryUnit="ea"
      unitOptions={['ea']}
      locationId="loc1"
      locationName="Bin 3"
      operatorId="op1"
      onClose={vi.fn()}
      onDone={vi.fn()}
      {...props}
    />,
    { wrapper: ({ children }) => <ThemeProvider theme={jiggedTheme}>{children}</ThemeProvider> },
  );

beforeEach(() => {
  vi.clearAllMocks();
  (getAllJobs as ReturnType<typeof vi.fn>).mockResolvedValue([
    job({ id: 'j1', job_number: 'JOB-001', parts: ['Bracket', 'Pin'] }),
    job({ id: 'j2', job_number: 'JOB-002', parts: ['Flange'] }),
  ]);
  (depleteStockAtLocation as ReturnType<typeof vi.fn>).mockResolvedValue({ location_balance: 7, part_quantity: 7 });
});

describe('OperatorLocationActionModal — deplete job tag', () => {
  it('lists active jobs with their parts and tags the removal with the chosen job', async () => {
    renderModal();

    await userEvent.type(screen.getByRole('spinbutton', { name: /quantity/i }), '5');

    await userEvent.click(await screen.findByRole('combobox', { name: /tag to a job/i }));
    await userEvent.keyboard('{ArrowDown}');
    const option = await screen.findByRole('option', { name: /JOB-001/ });
    expect(option).toHaveTextContent('Bracket, Pin'); // the job's parts disambiguate it
    await userEvent.click(option);

    await userEvent.click(screen.getByRole('button', { name: /^remove$/i }));
    await waitFor(() =>
      expect(depleteStockAtLocation).toHaveBeenCalledWith(
        'p1',
        'loc1',
        5,
        'ea',
        expect.objectContaining({ jobId: 'j1', graceful: true, operatorId: 'op1' }),
      ),
    );
  });

  it('leaves the removal untagged when no job is picked', async () => {
    renderModal();
    await userEvent.type(screen.getByRole('spinbutton', { name: /quantity/i }), '3');
    await userEvent.click(screen.getByRole('button', { name: /^remove$/i }));
    await waitFor(() =>
      expect(depleteStockAtLocation).toHaveBeenCalledWith(
        'p1',
        'loc1',
        3,
        'ea',
        expect.objectContaining({ jobId: undefined }),
      ),
    );
  });
});

/**
 * Move on the operator surface. The admin part page has always had it; this one didn't, so an
 * operator consolidating two shelves had to Remove from one and Add at the other — two ledger
 * rows and a hole in the middle if they got interrupted.
 */
describe('move', () => {
  const DESTINATIONS = [
    { id: 'loc2', label: 'Cabinet 3 › Shelf B' },
    { id: 'loc3', label: 'Yard' },
  ];

  it('transfers to the chosen destination in one call', async () => {
    const user = userEvent.setup();
    renderModal({ action: 'move', moveDestinations: DESTINATIONS });

    await user.click(screen.getByRole('combobox', { name: /move to/i }));
    await user.click(await screen.findByRole('option', { name: 'Yard' }));
    await user.type(screen.getByRole('spinbutton', { name: /quantity/i }), '4');
    await user.click(screen.getByRole('button', { name: /^move$/i }));

    await waitFor(() =>
      // operatorId now rides on every operator write, not just depletion — bin history
      // has to be able to name who moved it.
      expect(transferStock).toHaveBeenCalledWith('p1', 'loc1', 'loc3', 4, 'ea', {
        notes: undefined,
        operatorId: 'op1',
      }),
    );
  });

  it('asks where it is going rather than guessing', async () => {
    const user = userEvent.setup();
    renderModal({ action: 'move', moveDestinations: DESTINATIONS });

    await user.type(screen.getByRole('spinbutton', { name: /quantity/i }), '4');
    await user.click(screen.getByRole('button', { name: /^move$/i }));

    expect(await screen.findByText(/choose where it's going/i)).toBeInTheDocument();
    expect(transferStock).not.toHaveBeenCalled();
  });

  // One action, one name across both surfaces — this said "Set" where admin says "Adjust".
  it('calls the cycle-count action Adjust, matching the admin page', async () => {
    renderModal({ action: 'adjust' });
    expect(screen.getByText(/adjust stock \(cycle count\)/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^adjust$/i })).toBeInTheDocument();
  });
});
