/**
 * J7 — the operator takes material for a job.
 *
 * The highest-value assertions here are the two engine routes. A wrong route is not a soft
 * failure: `deplete_stock_at_location` RAISES for an untracked part, and
 * `enforce_tracked_part_quantity` REJECTS a direct parts.quantity write for a tracked one. On
 * top of that `removePartStockGraceful` had zero call sites before this feature, so its first
 * real execution is in production unless it is pinned here.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThemeProvider } from '@mui/material/styles';
import jiggedTheme from '@/lib/theme';

vi.mock('@/utils/partsAccess', () => ({ removePartStockGraceful: vi.fn() }));
vi.mock('@/utils/inventoryLocationsAccess', () => ({ depleteStockAtLocation: vi.fn() }));
vi.mock('@/utils/operatorAccess', () => ({ addJobNote: vi.fn() }));

import OperatorIssueMaterialModal from '@/components/operator/OperatorIssueMaterialModal';
import { removePartStockGraceful } from '@/utils/partsAccess';
import { depleteStockAtLocation } from '@/utils/inventoryLocationsAccess';
import { addJobNote } from '@/utils/operatorAccess';
import type { MaterialLocation, MaterialRequirement } from '@/types/materialCheck';

const asMock = (fn: unknown) => fn as ReturnType<typeof vi.fn>;

const bin = (id: string, quantity: number, path: string[] = ['Cabinet 3']): MaterialLocation => ({
  locationId: id,
  locationName: id,
  path,
  quantity,
});

const requirement = (over: Partial<MaterialRequirement> = {}): MaterialRequirement => ({
  bomLineId: 'b1',
  partId: 'p1',
  partName: 'BUY-ORING-214',
  bomUnit: 'each',
  consumeWholeUnits: false,
  requiredInBomUnit: 8,
  requiredInStockUnit: 8,
  stockUnit: 'each',
  onHand: 100,
  issued: 0,
  hasDiscrepancy: false,
  remainingToIssue: 8,
  shortBy: 0,
  status: 'ok',
  basis: { kind: 'same', unit: 'each' },
  isLocationTracked: false,
  locations: [],
  ...over,
});

const onDone = vi.fn();
const onClose = vi.fn();

const renderModal = (req: MaterialRequirement, over: Record<string, unknown> = {}) =>
  render(
    <OperatorIssueMaterialModal
      open
      companyId="co1"
      jobId="job1"
      jobNumber="J-1047"
      jobPartId="jp1"
      madePartName="Hydraulic Pump"
      requirement={req}
      unassigned={{ id: 'loc-un', name: 'Unassigned' }}
      unitOptions={['each']}
      operatorId="op1"
      onClose={onClose}
      onDone={onDone}
      {...over}
    />,
    { wrapper: ({ children }) => <ThemeProvider theme={jiggedTheme}>{children}</ThemeProvider> },
  );

const take = async (user: ReturnType<typeof userEvent.setup>) =>
  user.click(screen.getByRole('button', { name: /take material/i }));

beforeEach(() => {
  vi.clearAllMocks();
  asMock(removePartStockGraceful).mockResolvedValue({});
  asMock(depleteStockAtLocation).mockResolvedValue({});
  asMock(addJobNote).mockResolvedValue({});
});

describe('engine routing', () => {
  it('writes an untracked part through the aggregate path, tagged with the job', async () => {
    const user = userEvent.setup();
    renderModal(requirement());
    await take(user);

    await waitFor(() =>
      expect(removePartStockGraceful).toHaveBeenCalledWith(
        'p1', 8, 'each', 'Issued to J-1047 (Hydraulic Pump)', 'job1', undefined, 'op1',
      ),
    );
    // The direct parts.quantity write would be rejected for a tracked part — never try it.
    expect(depleteStockAtLocation).not.toHaveBeenCalled();
  });

  it('writes a tracked part at its location, gracefully, never to parts.quantity', async () => {
    const user = userEvent.setup();
    renderModal(requirement({ isLocationTracked: true, locations: [bin('loc-a', 40)] }));
    await take(user);

    await waitFor(() =>
      expect(depleteStockAtLocation).toHaveBeenCalledWith(
        'p1', 'loc-a', 8, 'each',
        expect.objectContaining({ graceful: true, jobId: 'job1', operatorId: 'op1' }),
      ),
    );
    expect(removePartStockGraceful).not.toHaveBeenCalled();
  });

  // The traveler has no operation context, and the spec folds the confirm-at-operation step
  // away — the take-event IS the consumption (#550).
  it('ties the depletion to the job, never to an operation', async () => {
    const user = userEvent.setup();
    renderModal(requirement({ isLocationTracked: true, locations: [bin('loc-a', 40)] }));
    await take(user);

    await waitFor(() => expect(depleteStockAtLocation).toHaveBeenCalled());
    const opts = asMock(depleteStockAtLocation).mock.calls[0][4];
    expect(opts.jobOperationId).toBeUndefined();
  });

  it('falls back to Unassigned when a tracked part is not recorded anywhere', async () => {
    const user = userEvent.setup();
    renderModal(requirement({ isLocationTracked: true, locations: [bin('loc-a', 0)] }));

    expect(screen.getByText(/nothing is recorded at any location/i)).toBeInTheDocument();
    await take(user);
    await waitFor(() =>
      expect(depleteStockAtLocation).toHaveBeenCalledWith(
        'p1', 'loc-un', 8, 'each', expect.anything(),
      ),
    );
  });

  it('refuses to guess when a tracked part has nowhere at all to take from', async () => {
    renderModal(
      requirement({ isLocationTracked: true, locations: [] }),
      { unassigned: null },
    );
    expect(screen.getByRole('button', { name: /take material/i })).toBeDisabled();
  });
});

describe('choosing a bin', () => {
  const multi = () =>
    requirement({
      isLocationTracked: true,
      locations: [bin('loc-a', 10), bin('loc-b', 90), bin('loc-c', 50)],
    });

  /**
   * The operator is standing at the shelf, so they pick — unlike a count, which excludes
   * multi-bin parts because nobody is there to disambiguate. Defaulting to the fullest keeps
   * the common case one tap.
   */
  it('asks which bin, pre-selected to the fullest', async () => {
    const user = userEvent.setup();
    renderModal(multi());
    expect(screen.getByText(/which one did you open/i)).toBeInTheDocument();

    await take(user);
    await waitFor(() =>
      expect(depleteStockAtLocation).toHaveBeenCalledWith('p1', 'loc-b', 8, 'each', expect.anything()),
    );
  });

  it('writes to the bin the operator actually chose', async () => {
    const user = userEvent.setup();
    renderModal(multi());

    await user.click(screen.getByRole('radio', { name: /loc-c/ }));
    await take(user);

    await waitFor(() =>
      expect(depleteStockAtLocation).toHaveBeenCalledWith('p1', 'loc-c', 8, 'each', expect.anything()),
    );
  });

  // Two ledger rows from one tap, with no rollback if the second fails.
  it('never splits a take across bins', async () => {
    const user = userEvent.setup();
    renderModal(multi());
    await take(user);
    await waitFor(() => expect(depleteStockAtLocation).toHaveBeenCalledTimes(1));
  });
});

describe('quantity', () => {
  it('prefills what is still to fetch, not the whole requirement', async () => {
    renderModal(requirement({ issued: 5, remainingToIssue: 3 }));
    expect(screen.getByRole('spinbutton', { name: /how much did you take/i })).toHaveValue(3);
  });

  // Clamping would silently under-record; graceful depletion exists to record the truth.
  it('does not clamp the prefill to what is on hand', async () => {
    renderModal(requirement({ onHand: 1, remainingToIssue: 8 }));
    expect(screen.getByRole('spinbutton', { name: /how much did you take/i })).toHaveValue(8);
  });

  it('suggests nothing when the units cannot be compared', async () => {
    renderModal(requirement({
      status: 'incomparable', remainingToIssue: null, requiredInStockUnit: null,
      bomUnit: 'feet', basis: { kind: 'incomparable', bomUnit: 'feet', stockUnit: 'each' },
    }));
    expect(screen.getByRole('spinbutton', { name: /how much did you take/i })).toHaveValue(null);
    expect(screen.getByText(/can't suggest a number/i)).toBeInTheDocument();
  });

  it('rejects a zero or empty amount before writing anything', async () => {
    const user = userEvent.setup();
    renderModal(requirement({ remainingToIssue: 0 }));
    await take(user);

    expect(await screen.findByText(/enter how much you took/i)).toBeInTheDocument();
    expect(removePartStockGraceful).not.toHaveBeenCalled();
  });
});

describe('after the take', () => {
  it('reloads the caller then closes', async () => {
    const user = userEvent.setup();
    renderModal(requirement());
    await take(user);

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(onDone).toHaveBeenCalled();
    expect(onDone.mock.invocationCallOrder[0]).toBeLessThan(onClose.mock.invocationCallOrder[0]);
  });

  it('leaves a readable trace in the job feed', async () => {
    const user = userEvent.setup();
    renderModal(requirement({ isLocationTracked: true, locations: [bin('loc-a', 40)] }));
    await take(user);

    await waitFor(() =>
      // Authored with the user_company_access id, NOT auth.uid() — notes.author_id is an FK
      // to user_company_access, and getting it wrong fails silently behind the best-effort
      // catch. That happened once; this pins it.
      expect(addJobNote).toHaveBeenCalledWith(
        'job1', 'co1', 'op1',
        'Took 8 each of BUY-ORING-214 from Cabinet 3 › loc-a',
        expect.objectContaining({ jobPartId: 'jp1', noteType: 'event' }),
      ),
    );
  });

  // The stock write has already landed and can't be undone — a failed note is not a failed take.
  it('still succeeds when the feed note fails', async () => {
    asMock(addJobNote).mockRejectedValue(new Error('feed down'));
    const user = userEvent.setup();
    renderModal(requirement());
    await take(user);

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(screen.queryByText(/could not record/i)).not.toBeInTheDocument();
  });

  it('shows the error inline and does not reload when the write fails', async () => {
    asMock(removePartStockGraceful).mockRejectedValue(new Error('network died'));
    const user = userEvent.setup();
    renderModal(requirement());
    await take(user);

    expect(await screen.findByText('network died')).toBeInTheDocument();
    expect(onDone).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});
