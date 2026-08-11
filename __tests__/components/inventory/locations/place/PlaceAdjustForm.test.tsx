/**
 * Adjust — the audit of one place, in a dialog.
 *
 * The rule worth defending here is **a blank is not a zero**. A dialog listing everything in a bin
 * invites the reading that untouched rows are being asserted as empty; they are not, and a bug that
 * made them so would silently zero every part someone walked past. The worksheet has always worked
 * this way (`CountEntries`), and the two doors must not disagree about what an untouched row means.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '../../../../test-utils';
import userEvent from '@testing-library/user-event';

vi.mock('@/lib/supabase', () => ({ getSupabase: () => ({}) }));

const content = (part_id: string, part_name: string, quantity: number) => ({
  part_id,
  part_name,
  primary_unit: 'ea',
  quantity,
  location_id: 'bin5',
});

vi.mock('@/utils/inventoryLocationsAccess', () => ({
  getLocationContents: vi.fn(async () => ({
    contents: [content('p-steel', 'RAW-STEEL-BLANK', 180), content('p-oring', 'BUY-ORING-214', 4)],
    total: 2,
  })),
}));

vi.mock('@/utils/inventoryCountAccess', () => ({
  commitCount: vi.fn(async (variances: unknown[]) => ({
    committed: variances.length,
    failures: [],
  })),
}));

vi.mock('@/utils/operatorAccess', () => ({
  getCurrentMember: vi.fn(async () => ({ id: 'member-1' })),
}));

import PlaceAdjustForm from '@/components/inventory/locations/place/PlaceAdjustForm';
import { getLocationContents } from '@/utils/inventoryLocationsAccess';
import { commitCount } from '@/utils/inventoryCountAccess';

const onDone = vi.fn();
const onClose = vi.fn();

const setup = () =>
  render(
    <PlaceAdjustForm
      companyId="co1"
      locationId="bin5"
      locationName="Bin 5"
      onCancel={onClose}
      onDone={onDone}
    />,
  );

/** Each row's own input, found by the accessible name that carries the part. */
const countedField = (partName: string) => screen.getByLabelText(`Counted ${partName}`);

beforeEach(() => vi.clearAllMocks());

describe('PlaceAdjustForm', () => {
  /** Three columns, because the deleted review step is only redundant if the delta is on the row. */
  it('lists everything at the place under recorded / counted / changed', async () => {
    setup();

    expect(await screen.findByText('RAW-STEEL-BLANK')).toBeInTheDocument();
    // `Recorded` appears once per row as an inline label for the stacked phone layout, plus once
    // as the column heading — so this counts rather than asserting a single node.
    expect(screen.getAllByText(/^recorded$/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/^counted$/i)).toBeInTheDocument();
    expect(screen.getByText(/^changed$/i)).toBeInTheDocument();
    expect(screen.getByText('180')).toBeInTheDocument();
    expect(screen.getByText('BUY-ORING-214')).toBeInTheDocument();
    expect(screen.getByText('4')).toBeInTheDocument();
  });

  /**
   * An uncounted row shows an em dash, and a counted-but-unchanged row says so in words.
   * "0" would be a third meaning competing with both.
   */
  it('distinguishes not-counted from counted-and-unchanged', async () => {
    const user = userEvent.setup();
    setup();
    await screen.findByText('RAW-STEEL-BLANK');

    expect(screen.getAllByText('—')).toHaveLength(2);
    await user.type(countedField('RAW-STEEL-BLANK'), '180');
    expect(screen.getByText('same')).toBeInTheDocument();
    expect(screen.getAllByText('—')).toHaveLength(1);
  });

  /** The rule this file exists for. */
  it('commits only the rows a number was typed into', async () => {
    const user = userEvent.setup();
    setup();
    await screen.findByText('RAW-STEEL-BLANK');

    await user.type(countedField('RAW-STEEL-BLANK'), '175');
    await user.click(screen.getByRole('button', { name: /save 1 count/i }));

    expect(commitCount).toHaveBeenCalledTimes(1);
    const [variances] = vi.mocked(commitCount).mock.calls[0];
    expect(variances).toHaveLength(1);
    expect(variances[0].candidate.partId).toBe('p-steel');
    // The untouched O-ring keeps its 4 — it was never asserted about.
    expect(variances.some((v) => v.candidate.partId === 'p-oring')).toBe(false);
  });

  /** A counted zero IS an assertion — "this bin is empty" — and must not be mistaken for a blank. */
  it('treats a typed 0 as a count, not as a blank', async () => {
    const user = userEvent.setup();
    setup();
    await screen.findByText('BUY-ORING-214');

    await user.type(countedField('BUY-ORING-214'), '0');
    await user.click(screen.getByRole('button', { name: /save 1 count/i }));

    const [variances] = vi.mocked(commitCount).mock.calls[0];
    expect(variances[0].counted).toBe(0);
    expect(variances[0].delta).toBe(-4);
  });

  it('cannot be saved until something is counted', async () => {
    setup();
    await screen.findByText('RAW-STEEL-BLANK');

    expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled();
  });

  /**
   * The variance on the row as it is typed. A review step used to restate these on a screen of its
   * own and was removed precisely because this makes it redundant — so it has to keep working.
   */
  it('shows the variance as you type it', async () => {
    const user = userEvent.setup();
    setup();
    await screen.findByText('RAW-STEEL-BLANK');

    await user.type(countedField('RAW-STEEL-BLANK'), '175');
    expect(screen.getByText('-5')).toBeInTheDocument();

    await user.type(countedField('BUY-ORING-214'), '9');
    expect(screen.getByText('+5')).toBeInTheDocument();
  });

  /**
   * The delta is measured against what the balance is NOW, not the snapshot the dialog opened with
   * — an operator may have moved something out of this bin while it sat open. Getting this wrong
   * writes a correction against a number nobody is looking at.
   */
  it('re-reads the balance before computing the delta', async () => {
    const user = userEvent.setup();
    setup();
    await screen.findByText('RAW-STEEL-BLANK');

    // Someone took 30 out while the dialog was open.
    vi.mocked(getLocationContents).mockResolvedValueOnce({
      contents: [content('p-steel', 'RAW-STEEL-BLANK', 150), content('p-oring', 'BUY-ORING-214', 4)],
      total: 2,
    });

    await user.type(countedField('RAW-STEEL-BLANK'), '175');
    await user.click(screen.getByRole('button', { name: /save 1 count/i }));

    const [variances] = vi.mocked(commitCount).mock.calls[0];
    expect(variances[0].candidate.systemQuantity).toBe(150);
    expect(variances[0].delta).toBe(25); // against 150, not the 180 on screen
    expect(variances[0].movedSinceOpened).toBe(true);
  });

  it('names the author on the count', async () => {
    const user = userEvent.setup();
    setup();
    await screen.findByText('RAW-STEEL-BLANK');

    await user.type(countedField('RAW-STEEL-BLANK'), '175');
    await user.click(screen.getByRole('button', { name: /save 1 count/i }));

    expect(commitCount).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ operatorId: 'member-1' }),
    );
  });

  /**
   * A partial save is reported, never rolled back: the lines that committed are real observations
   * about a shelf, and re-counting them would be asking twice.
   */
  it('reports a partial save and stays open', async () => {
    const user = userEvent.setup();
    vi.mocked(commitCount).mockResolvedValueOnce({
      committed: 1,
      failures: [{ partName: 'BUY-ORING-214', locationName: 'Bin 5', message: 'Blocked' }],
    });
    setup();
    await screen.findByText('RAW-STEEL-BLANK');

    await user.type(countedField('RAW-STEEL-BLANK'), '175');
    await user.type(countedField('BUY-ORING-214'), '3');
    await user.click(screen.getByRole('button', { name: /save 2 counts/i }));

    expect(await screen.findByText(/BUY-ORING-214 \(Blocked\)/)).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    // …and the board still refreshes, because one line did land.
    expect(onDone).toHaveBeenCalled();
  });

  it('says an empty place has nothing to adjust', async () => {
    vi.mocked(getLocationContents).mockResolvedValueOnce({ contents: [], total: 0 });
    setup();

    expect(await screen.findByText(/nothing is recorded at Bin 5 yet/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled();
  });
});
