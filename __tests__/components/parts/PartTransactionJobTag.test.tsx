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
    await user.click(await screen.findByRole('option', { name: /^Shelf A/ }));

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

/**
 * Over-removing used to fail at the database with a bare "Failed to update stock." — the
 * location dropdown offered every node including parents holding nothing, the modal never said
 * what was there, and the RPC's actual reason was thrown away because Supabase errors are
 * plain objects rather than Error instances.
 */
describe('PartLocationActionModal — removing more than is there', () => {
  const renderRemove = (balances: Array<{ id: string; label: string; quantity: number }>) =>
    render(
      <PartLocationActionModal
        open
        action="deplete"
        companyId="co1"
        partId="p1"
        primaryUnit="each"
        unitOptions={['each']}
        locations={[{ id: 'l1', label: 'Shelf A' }, { id: 'cab', label: 'Cabinet 3' }]}
        sourceBalances={balances}
        onClose={vi.fn()}
        onDone={vi.fn()}
      />,
      { wrapper },
    );

  // Option names now carry the quantity ("Shelf A40 each"), so match the label prefix.
  const pickLocation = async (user: ReturnType<typeof userEvent.setup>, label: string) => {
    await user.click(await screen.findByRole('combobox', { name: /location/i }));
    await user.click(await screen.findByRole('option', { name: new RegExp(`^${label}`) }));
  };

  /**
   * The point of the whole change: the quantity is on the OPTION, so you pick a shelf that has
   * stock rather than picking blind and being corrected afterwards.
   */
  it('shows what each location holds in the dropdown, stocked ones first', async () => {
    const user = userEvent.setup();
    renderRemove([{ id: 'l1', label: 'Shelf A', quantity: 40 }]);
    await user.click(await screen.findByRole('combobox', { name: /location/i }));

    const options = await screen.findAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual(['Shelf A40 each', 'Cabinet 3empty']);
  });

  it('says what is actually at the chosen location', async () => {
    const user = userEvent.setup();
    renderRemove([{ id: 'l1', label: 'Shelf A', quantity: 40 }]);
    await pickLocation(user, 'Shelf A');
    expect(await screen.findByText(/40 each at this location now/i)).toBeInTheDocument();
  });

  // The screenshot case: a parent node with no stock row at all.
  it('says so when the location holds nothing', async () => {
    const user = userEvent.setup();
    renderRemove([{ id: 'l1', label: 'Shelf A', quantity: 40 }]);
    await pickLocation(user, 'Cabinet 3');
    expect(await screen.findByText(/nothing recorded at this location/i)).toBeInTheDocument();
  });

  it('warns before you commit an over-removal', async () => {
    const user = userEvent.setup();
    renderRemove([{ id: 'l1', label: 'Shelf A', quantity: 40 }]);
    await pickLocation(user, 'Shelf A');
    await user.type(screen.getByRole('spinbutton', { name: /quantity/i }), '999');
    // Exact wording, because interleaving text and expressions across JSX lines silently
    // swallowed a space here once ("0 eachrecorded here").
    expect(
      await screen.findByText(
        "That's more than the 40 each recorded here. Saving sets this location to zero and "
          + "flags the difference — it won't be blocked.",
      ),
    ).toBeInTheDocument();
  });

  it('words the warning for a location that holds nothing', async () => {
    const user = userEvent.setup();
    renderRemove([{ id: 'l1', label: 'Shelf A', quantity: 40 }]);
    await pickLocation(user, 'Cabinet 3');
    await user.type(screen.getByRole('spinbutton', { name: /quantity/i }), '5');
    expect(
      await screen.findByText(/nothing is recorded at this location, so all 5 each will be logged/i),
    ).toBeInTheDocument();
  });

  // Warn, don't block: the stock left the shelf whether or not our number agreed.
  it('records the over-removal gracefully rather than refusing it', async () => {
    const user = userEvent.setup();
    renderRemove([{ id: 'l1', label: 'Shelf A', quantity: 40 }]);
    await pickLocation(user, 'Shelf A');
    await user.type(screen.getByRole('spinbutton', { name: /quantity/i }), '999');
    await user.click(screen.getByRole('button', { name: /^confirm$/i }));

    await waitFor(() =>
      expect(depleteStockAtLocation).toHaveBeenCalledWith(
        'p1', 'l1', 999, 'each', expect.objectContaining({ graceful: true }),
      ),
    );
  });

  it('surfaces the database reason instead of a generic failure', async () => {
    // A PostgrestError is a plain object — `e instanceof Error` is false for it.
    asMock(depleteStockAtLocation).mockRejectedValue({
      code: 'P0001',
      message: 'Insufficient stock at location (have 0, need 999)',
    });
    const user = userEvent.setup();
    renderRemove([{ id: 'l1', label: 'Shelf A', quantity: 40 }]);
    await pickLocation(user, 'Shelf A');
    await user.type(screen.getByRole('spinbutton', { name: /quantity/i }), '999');
    await user.click(screen.getByRole('button', { name: /^confirm$/i }));

    expect(await screen.findByText(/insufficient stock at location/i)).toBeInTheDocument();
    expect(screen.queryByText(/^failed to update stock\.$/i)).not.toBeInTheDocument();
  });
});
