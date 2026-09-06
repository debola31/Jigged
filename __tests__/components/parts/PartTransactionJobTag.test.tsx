/**
 * Issue #59 — an owner can link a stock removal to a job.
 *
 * Shipped in March as validated shop feedback, then silently deleted in May when the parts
 * unification replaced the page it lived on. It went unnoticed for two months because **there
 * was no test and no acceptance criterion pinning it** — see docs/modules/inventory.md §7,
 * "Validated feedback had no protection". This file is that protection.
 *
 * There is one owner-side write path now: PartLocationActionModal → depleteStockAtLocation. The
 * aggregate engine this file also covered (PartTransactionModal → removePartStock) was deleted in
 * 20260802015837 with `is_location_tracked`, so its half of the protection moved down here rather
 * than being dropped — including the two cases it alone held: an adjustment offers no job tag, and
 * a failing jobs query must not block recording stock that physically moved.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThemeProvider } from '@mui/material/styles';
import jiggedTheme from '@/lib/theme';

vi.mock('@/utils/inventoryLocationsAccess', () => ({
  addStockAtLocation: vi.fn(),
  depleteStockAtLocation: vi.fn(),
  adjustStockAtLocation: vi.fn(),
  transferStock: vi.fn(),
  getRecentHeatNumbersForPart: vi.fn(async () => []),
}));
/** New: the modal resolves the acting member so owner-side writes carry an author. */
vi.mock('@/utils/operatorAccess', () => ({
  getCurrentMember: vi.fn(async () => ({ id: 'member-1', name: 'Owner' })),
}));

vi.mock('@/utils/jobsAccess', () => ({ getAllJobs: vi.fn() }));

import PartLocationActionModal, {
  type LocationAction,
} from '@/components/parts/PartLocationActionModal';
import { depleteStockAtLocation } from '@/utils/inventoryLocationsAccess';
import { getAllJobs } from '@/utils/jobsAccess';
import type { JobWithRelations } from '@/types/job';

const asMock = (fn: unknown) => fn as ReturnType<typeof vi.fn>;

const JOBS = [
  { id: 'job-1', job_number: 'J-1047', job_parts: [{ parts: { part_name: 'Manifold' } }] },
  { id: 'job-2', job_number: 'J-1048', job_parts: [] },
] as unknown as JobWithRelations[];

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <ThemeProvider theme={jiggedTheme}>{children}</ThemeProvider>
);

beforeEach(() => {
  vi.clearAllMocks();
  asMock(getAllJobs).mockResolvedValue({ jobs: JOBS, total: JOBS.length, truncated: false });
  asMock(depleteStockAtLocation).mockResolvedValue({});
});

describe('PartLocationActionModal — job tag on removal (#59)', () => {
  const renderLoc = (action: LocationAction) =>
    render(
      <PartLocationActionModal
        open
        action={action}
        companyId="co1"
        partId="p1"
        primaryUnit="each"
        unitOptions={['each']}
        locations={[
          { id: 'l1', label: 'Shelf A' },
          { id: 'l2', label: 'Shelf B' },
        ]}
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

  /**
   * One place in the whole shop → no destination to choose, so the picker is replaced by a line
   * of text and the lone place is pre-selected. This is the ordinary shape for a shop without the
   * `inventory_locations` flag, where the auto-managed `Unassigned` bucket is all there is.
   */
  it('states the place instead of asking, when there is only one', async () => {
    const user = userEvent.setup();
    render(
      <PartLocationActionModal
        open
        action="deplete"
        companyId="co1"
        partId="p1"
        primaryUnit="each"
        unitOptions={['each']}
        locations={[{ id: 'l1', label: 'Unassigned' }]}
        onClose={vi.fn()}
        onDone={vi.fn()}
      />,
      { wrapper },
    );

    expect(await screen.findByText('Unassigned')).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: /location/i })).not.toBeInTheDocument();

    await user.type(screen.getByRole('spinbutton', { name: /quantity/i }), '2');
    await user.click(screen.getByRole('button', { name: /^confirm$/i }));

    // Pre-selected, not merely hidden — the write must still name the place.
    await waitFor(() =>
      expect(depleteStockAtLocation).toHaveBeenCalledWith('p1', 'l1', 2, 'each', expect.anything()),
    );
  });

  // An addition or an adjustment isn't consumption, so a job on it would mean nothing.
  it.each([['add'], ['adjust']] as const)('offers no job tag for a %s', async (action) => {
    renderLoc(action);
    await screen.findByRole('combobox', { name: /location/i });
    expect(screen.queryByRole('combobox', { name: /tag to a job/i })).not.toBeInTheDocument();
  });

  // A failing jobs query must not stop someone recording stock that physically moved.
  it('still allows the removal when the job list fails to load', async () => {
    asMock(getAllJobs).mockRejectedValue(new Error('offline'));
    const user = userEvent.setup();
    renderLoc('deplete');

    await user.click(await screen.findByRole('combobox', { name: /location/i }));
    await user.click(await screen.findByRole('option', { name: /^Shelf A/ }));
    await user.type(screen.getByRole('spinbutton', { name: /quantity/i }), '3');
    await user.click(screen.getByRole('button', { name: /^confirm$/i }));

    await waitFor(() => expect(depleteStockAtLocation).toHaveBeenCalled());
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
