import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThemeProvider } from '@mui/material/styles';
import jiggedTheme from '@/lib/theme';

import OperatorLocationActionModal from '@/components/operator/OperatorLocationActionModal';
import { depleteStockAtLocation } from '@/utils/inventoryLocationsAccess';
import { getAllJobs } from '@/utils/jobsAccess';
import type { JobWithRelations } from '@/types/job';

vi.mock('@/utils/inventoryLocationsAccess', () => ({
  addStockAtLocation: vi.fn(),
  depleteStockAtLocation: vi.fn(),
  adjustStockAtLocation: vi.fn(),
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
