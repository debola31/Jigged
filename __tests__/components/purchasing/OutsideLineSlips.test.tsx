/**
 * An outside-service line's slips on the PO page, and the explicit correction of which slips it
 * counts (plan §3.6 "How a slip gets linked … by the explicit relink RPC"; criterion O1).
 *
 * Slips link themselves — at the send, and when the line is inserted — so this is the rare hand
 * correction. Unlink asks first and says what changes: the slip stops counting toward the line's
 * received quantity. Link a slip… reads, only when asked, the step's live slips to this vendor that
 * ship against no line. Both go through `relinkOutsideShipment`, hand the page a sentence for its
 * one refresh, show a refusal's sentence and stay open — and capture nothing: slip relink is
 * deliberately not instrumented (plan §3.14).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import userEvent from '@testing-library/user-event';
import { render, screen, waitFor, within } from '../../test-utils';
import { outsideLine, poDetail, poSlip } from './vendorPoFixtures';
import type { VendorPoUnlinkedSlip } from '@/types/vendorPo';

const relinkOutsideShipment = vi.fn();
const listUnlinkedOutsideSlips = vi.fn();
vi.mock('@/utils/vendorPoAccess', () => ({
  relinkOutsideShipment: (...a: unknown[]) => relinkOutsideShipment(...a),
  listUnlinkedOutsideSlips: (...a: unknown[]) => listUnlinkedOutsideSlips(...a),
}));
const capture = vi.fn();
vi.mock('posthog-js', () => ({ default: { capture: (...a: unknown[]) => capture(...a) } }));
vi.mock('@/hooks/useUserRole', () => ({ useUserRole: () => ({ role: 'user', isAdmin: false, loading: false }) }));

import OutsideLineSlips from '@/components/purchasing/OutsideLineSlips';

const unlinked = (over: Partial<VendorPoUnlinkedSlip> = {}): VendorPoUnlinkedSlip => ({
  id: 's2',
  slipNumber: 'VPS-0141-2',
  jobId: 'j1',
  jobOperationId: 'op30',
  quantity: 20,
  shippedAt: '2026-11-06T12:00:00Z',
  dueBackOn: null,
  closedAt: null,
  voidedAt: null,
  receivedQuantity: 0,
  outstandingQuantity: 20,
  ...over,
});

type Props = Parameters<typeof OutsideLineSlips>[0];

function draw(over: Partial<Props> = {}) {
  const onChanged = vi.fn();
  const onOpenSlip = vi.fn();
  render(
    <OutsideLineSlips
      po={poDetail({ lines: [outsideLine()], outsideSlips: [poSlip()] })}
      line={outsideLine()}
      slips={[poSlip()]}
      canCorrect
      onOpenSlip={onOpenSlip}
      onChanged={onChanged}
      {...over}
    />,
  );
  return { onChanged, onOpenSlip };
}

beforeEach(() => {
  vi.clearAllMocks();
  relinkOutsideShipment.mockResolvedValue({ outsideShipmentId: 's1', slipNumber: 'VPS-0141-1', vendorPurchaseOrderLineId: null });
  listUnlinkedOutsideSlips.mockResolvedValue([unlinked()]);
});

describe('OutsideLineSlips — the slips and what they say', () => {
  it('lists each slip with what came back, and opens it in its preview (where Void lives)', async () => {
    const user = userEvent.setup();
    const { onOpenSlip } = draw();
    expect(screen.getByText('Sent 100 · back 60 · at vendor 40')).toBeInTheDocument();
    expect(screen.getByText(/100 sent .* · 60 back · due /)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'VPS-0141-1' }));
    expect(onOpenSlip).toHaveBeenCalledWith('s1');
  });

  it('says when nothing is linked yet', () => {
    draw({ slips: [] });
    expect(screen.getByText('No slips yet — sending from the job links them here.')).toBeInTheDocument();
  });
});

describe('OutsideLineSlips — Unlink', () => {
  it('asks first, and says what changes: the slip stops counting toward the line’s received quantity', async () => {
    const user = userEvent.setup();
    draw();
    await user.click(screen.getByRole('button', { name: 'Unlink VPS-0141-1' }));
    const dialog = await screen.findByRole('dialog', { name: 'Unlink VPS-0141-1 from line 3?' });
    expect(within(dialog).getByText(/VPS-0141-1 stops counting toward line 3's received quantity/)).toBeInTheDocument();
    expect(within(dialog).getByText(/the 60 back on it come off what line 3 has received/)).toBeInTheDocument();
    expect(relinkOutsideShipment).not.toHaveBeenCalled();
  });

  it('unlinks on confirm and hands the page its sentence for the one refresh — capturing nothing', async () => {
    const user = userEvent.setup();
    const { onChanged } = draw();
    await user.click(screen.getByRole('button', { name: 'Unlink VPS-0141-1' }));
    const dialog = await screen.findByRole('dialog', { name: /unlink VPS-0141-1/i });
    await user.click(within(dialog).getByRole('button', { name: 'Unlink' }));

    await waitFor(() => expect(onChanged).toHaveBeenCalledWith('VPS-0141-1 no longer counts toward line 3.'));
    expect(relinkOutsideShipment).toHaveBeenCalledWith('s1', null);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(capture).not.toHaveBeenCalled();
  });

  it('Keep it linked changes nothing', async () => {
    const user = userEvent.setup();
    const { onChanged } = draw();
    await user.click(screen.getByRole('button', { name: 'Unlink VPS-0141-1' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Keep it linked' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(relinkOutsideShipment).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('shows a refusal’s sentence and stays open', async () => {
    relinkOutsideShipment.mockRejectedValue(
      new Error('VPS-0141-1 was just linked to another purchase order line. Reload it and try again.'),
    );
    const user = userEvent.setup();
    const { onChanged } = draw();
    await user.click(screen.getByRole('button', { name: 'Unlink VPS-0141-1' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Unlink' }));
    expect(await within(dialog).findByText(/was just linked to another purchase order line/)).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(onChanged).not.toHaveBeenCalled();
  });

  /** A voided slip counts for nothing already, and the database refuses to move one. */
  it('offers no Unlink on a voided slip', () => {
    draw({ slips: [poSlip({ voidedAt: '2026-11-07T00:00:00Z', outstandingQuantity: 0 })] });
    expect(screen.getByText(/voided/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /unlink/i })).not.toBeInTheDocument();
  });
});

describe('OutsideLineSlips — Link a slip…', () => {
  it('reads the step’s live, unlinked slips to this vendor only when asked, and links the one chosen', async () => {
    const user = userEvent.setup();
    const { onChanged } = draw();
    expect(listUnlinkedOutsideSlips).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Link a slip…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Link a slip to line 3' });
    expect(listUnlinkedOutsideSlips).toHaveBeenCalledWith('test-company-id', 'op30', 'v1');
    // The only one is chosen already; the button names it.
    expect(await within(dialog).findByRole('radio', { name: /VPS-0141-2/ })).toBeChecked();
    await user.click(within(dialog).getByRole('button', { name: 'Link VPS-0141-2' }));

    await waitFor(() => expect(onChanged).toHaveBeenCalledWith('VPS-0141-2 now counts toward line 3.'));
    expect(relinkOutsideShipment).toHaveBeenCalledWith('s2', 'l3');
    expect(capture).not.toHaveBeenCalled();
  });

  it('with several, asks which — and says so while none is chosen', async () => {
    listUnlinkedOutsideSlips.mockResolvedValue([unlinked(), unlinked({ id: 's3', slipNumber: 'VPS-0141-3' })]);
    const user = userEvent.setup();
    draw();
    await user.click(screen.getByRole('button', { name: 'Link a slip…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Link a slip to line 3' });
    await within(dialog).findByRole('radio', { name: /VPS-0141-3/ });
    expect(within(dialog).getByRole('button', { name: /^link/i })).toBeDisabled();
    expect(within(dialog).getByText(/choose the slip to link/i)).toBeInTheDocument();

    await user.click(within(dialog).getByRole('radio', { name: /VPS-0141-3/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Link VPS-0141-3' }));
    await waitFor(() => expect(relinkOutsideShipment).toHaveBeenCalledWith('s3', 'l3'));
  });

  it('says when there is nothing to link, and how a slip on another PO gets here', async () => {
    listUnlinkedOutsideSlips.mockResolvedValue([]);
    const user = userEvent.setup();
    draw();
    await user.click(screen.getByRole('button', { name: 'Link a slip…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Link a slip to line 3' });
    expect(await within(dialog).findByText(/nothing to link/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/unlink it there first/i)).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: /^link/i })).not.toBeInTheDocument();
  });

  /** "Couldn't load" must never read as "nothing to link". */
  it('says a failed read failed, with Retry', async () => {
    listUnlinkedOutsideSlips.mockRejectedValueOnce(new Error('Failed to load the slips to link.'));
    const user = userEvent.setup();
    draw();
    await user.click(screen.getByRole('button', { name: 'Link a slip…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Link a slip to line 3' });
    expect(await within(dialog).findByText(/couldn.t load/i)).toBeInTheDocument();
    expect(within(dialog).queryByText(/nothing to link/i)).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: /try again|retry/i }));
    expect(await within(dialog).findByRole('radio', { name: /VPS-0141-2/ })).toBeInTheDocument();
  });

  it('shows a refusal’s sentence and stays open', async () => {
    relinkOutsideShipment.mockRejectedValue(new Error('PO-1042 line 3 is closed. Reopen it first.'));
    const user = userEvent.setup();
    const { onChanged } = draw();
    await user.click(screen.getByRole('button', { name: 'Link a slip…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Link a slip to line 3' });
    await user.click(await within(dialog).findByRole('button', { name: 'Link VPS-0141-2' }));
    expect(await within(dialog).findByText('PO-1042 line 3 is closed. Reopen it first.')).toBeInTheDocument();
    expect(onChanged).not.toHaveBeenCalled();
  });
});

describe('OutsideLineSlips — where the corrections are offered', () => {
  it('offers none where the page says nothing can change (an archived or closed PO)', () => {
    draw({ canCorrect: false });
    expect(screen.getByRole('button', { name: 'VPS-0141-1' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /unlink/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /link a slip/i })).not.toBeInTheDocument();
  });

  /** The database refuses a link to a closed line ("Reopen it first"), so the page does not offer one. */
  it('offers no Link a slip… on a closed line, but still Unlink', () => {
    const closed = outsideLine({ closedAt: '2026-11-09T00:00:00Z', status: 'closed' });
    draw({ line: closed });
    expect(screen.getByRole('button', { name: 'Unlink VPS-0141-1' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /link a slip/i })).not.toBeInTheDocument();
  });
});
