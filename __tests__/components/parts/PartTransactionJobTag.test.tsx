/**
 * Issue #59 — an owner can link a stock removal to a job.
 *
 * Shipped in March as validated shop feedback, then silently deleted in May when the parts
 * unification replaced the page it lived on. It went unnoticed for two months because **there
 * was no test and no acceptance criterion pinning it** — see docs/modules/inventory.md §7,
 * "Validated feedback had no protection". This file is that protection.
 *
 * Both owner-side write paths are covered: the aggregate engine (PartTransactionModal →
 * removePartStock) and the location engine (PartLocationActionModal → depleteStockAtLocation).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThemeProvider } from '@mui/material/styles';
import jiggedTheme from '@/lib/theme';

vi.mock('@/utils/partsAccess', () => ({
  addPartStock: vi.fn(),
  removePartStock: vi.fn(),
  adjustPartStock: vi.fn(),
}));
vi.mock('@/utils/inventoryLocationsAccess', () => ({
  addStockAtLocation: vi.fn(),
  depleteStockAtLocation: vi.fn(),
  adjustStockAtLocation: vi.fn(),
  transferStock: vi.fn(),
}));
vi.mock('@/utils/jobsAccess', () => ({ getAllJobs: vi.fn() }));

import PartTransactionModal from '@/components/parts/PartTransactionModal';
import PartLocationActionModal from '@/components/parts/PartLocationActionModal';
import { removePartStock } from '@/utils/partsAccess';
import { depleteStockAtLocation } from '@/utils/inventoryLocationsAccess';
import { getAllJobs } from '@/utils/jobsAccess';
import type { Part } from '@/types/part';
import type { JobWithRelations } from '@/types/job';

const asMock = (fn: unknown) => fn as ReturnType<typeof vi.fn>;

const JOBS = [
  { id: 'job-1', job_number: 'J-1047', job_parts: [{ parts: { part_name: 'Manifold' } }] },
  { id: 'job-2', job_number: 'J-1048', job_parts: [] },
] as unknown as JobWithRelations[];

const PART = {
  id: 'p1',
  part_name: 'BUY-ORING-214',
  primary_unit: 'each',
  quantity: 500,
  is_stocked: true,
} as unknown as Part;

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <ThemeProvider theme={jiggedTheme}>{children}</ThemeProvider>
);

beforeEach(() => {
  vi.clearAllMocks();
  asMock(getAllJobs).mockResolvedValue(JOBS);
  asMock(removePartStock).mockResolvedValue({});
  asMock(depleteStockAtLocation).mockResolvedValue({});
});

const renderTxn = (defaultType: 'addition' | 'depletion' | 'adjustment') =>
  render(
    <PartTransactionModal
      open
      onClose={vi.fn()}
      companyId="co1"
      part={PART}
      unitConversions={[]}
      defaultType={defaultType}
    />,
    { wrapper },
  );

describe('PartTransactionModal — job tag on removal (#59)', () => {
  it('passes the chosen job through to removePartStock', async () => {
    const user = userEvent.setup();
    renderTxn('depletion');

    const picker = await screen.findByRole('combobox', { name: /tag to a job/i });
    await user.click(picker);
    await user.click(await screen.findByRole('option', { name: /J-1047/ }));

    await user.clear(screen.getByRole('spinbutton', { name: /quantity/i }));
    await user.type(screen.getByRole('spinbutton', { name: /quantity/i }), '4');
    await user.click(screen.getByRole('button', { name: /remove stock/i }));

    await waitFor(() =>
      expect(removePartStock).toHaveBeenCalledWith('p1', 4, 'each', '', 'job-1'),
    );
  });

  // The tag is optional — a removal with no job must still be recordable.
  it('records the removal with no job when none is chosen', async () => {
    const user = userEvent.setup();
    renderTxn('depletion');
    await screen.findByRole('combobox', { name: /tag to a job/i });

    await user.clear(screen.getByRole('spinbutton', { name: /quantity/i }));
    await user.type(screen.getByRole('spinbutton', { name: /quantity/i }), '2');
    await user.click(screen.getByRole('button', { name: /remove stock/i }));

    await waitFor(() =>
      expect(removePartStock).toHaveBeenCalledWith('p1', 2, 'each', '', undefined),
    );
  });

  // An addition or an adjustment isn't consumption, so a job on it would mean nothing.
  it.each([['addition'], ['adjustment']] as const)('offers no job tag for a %s', async (type) => {
    renderTxn(type);
    await waitFor(() => expect(getAllJobs).toHaveBeenCalled());
    expect(screen.queryByRole('combobox', { name: /tag to a job/i })).not.toBeInTheDocument();
  });

  // A failing jobs query must not stop someone recording stock that physically moved.
  it('still allows the removal when the job list fails to load', async () => {
    asMock(getAllJobs).mockRejectedValue(new Error('offline'));
    const user = userEvent.setup();
    renderTxn('depletion');

    await user.clear(await screen.findByRole('spinbutton', { name: /quantity/i }));
    await user.type(screen.getByRole('spinbutton', { name: /quantity/i }), '3');
    await user.click(screen.getByRole('button', { name: /remove stock/i }));

    await waitFor(() =>
      expect(removePartStock).toHaveBeenCalledWith('p1', 3, 'each', '', undefined),
    );
  });
});

describe('PartLocationActionModal — job tag on removal (#59)', () => {
  const renderLoc = (action: 'deplete' | 'add') =>
    render(
      <PartLocationActionModal
        open
        action={action}
        companyId="co1"
        partId="p1"
        primaryUnit="each"
        unitOptions={['each']}
        locations={[{ id: 'l1', label: 'Shelf A' }]}
        onClose={vi.fn()}
        onDone={vi.fn()}
      />,
      { wrapper },
    );

  it('passes the chosen job through to depleteStockAtLocation', async () => {
    const user = userEvent.setup();
    renderLoc('deplete');

    await user.click(await screen.findByRole('combobox', { name: /location/i }));
    await user.click(await screen.findByRole('option', { name: 'Shelf A' }));

    await user.click(screen.getByRole('combobox', { name: /tag to a job/i }));
    await user.click(await screen.findByRole('option', { name: /J-1048/ }));

    await user.type(screen.getByRole('spinbutton', { name: /quantity/i }), '5');
    await user.click(screen.getByRole('button', { name: /^confirm$/i }));

    await waitFor(() =>
      expect(depleteStockAtLocation).toHaveBeenCalledWith(
        'p1', 'l1', 5, 'each', expect.objectContaining({ jobId: 'job-2' }),
      ),
    );
  });

  it('offers no job tag when adding stock', async () => {
    renderLoc('add');
    await screen.findByRole('combobox', { name: /location/i });
    expect(screen.queryByRole('combobox', { name: /tag to a job/i })).not.toBeInTheDocument();
  });
});
