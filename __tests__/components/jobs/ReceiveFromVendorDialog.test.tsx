import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThemeProvider } from '@mui/material/styles';
import jiggedTheme from '@/lib/theme';
import { toFriendlyError } from '@/lib/supabaseErrors';

vi.mock('@/utils/vendorPoAccess', async (importOriginal) => {
  // The REAL refusal checks, so a refusal is recognised here exactly as the app recognises it.
  const actual = await importOriginal<typeof import('@/utils/vendorPoAccess')>();
  return {
    closeVendorPoLines: vi.fn(),
    isNothingLeftToReceiveRefusal: actual.isNothingLeftToReceiveRefusal,
    isAlreadyClosedRefusal: actual.isAlreadyClosedRefusal,
    isPoClosedRefusal: actual.isPoClosedRefusal,
  };
});

import ReceiveFromVendorDialog, {
  closePoLineAfterReceipt,
  poLineCloseSentence,
  receivePoLineFor,
  type OpenSlipOption,
  type ReceivePoLine,
} from '@/components/jobs/ReceiveFromVendorDialog';
import { closeVendorPoLines } from '@/utils/vendorPoAccess';

/** A refusal as the access layer throws it: `purchasingRpcFailure` → `toFriendlyError` of a P0001. */
const refusal = (message: string) => toFriendlyError({ code: 'P0001', message, details: null, hint: null });

const slip = (outstanding: number) => ({
  id: 's1',
  slip_number: 'VPS-0141-2',
  shipped_at: '2026-08-14T12:00:00Z',
  outstanding,
});

function draw(outstanding = 50, onSubmit = vi.fn()) {
  render(
    <ThemeProvider theme={jiggedTheme}>
      <ReceiveFromVendorDialog
        open
        vendorName="ProFinish"
        operationName="Anodize"
        partName="J-0141"
        openSlips={[slip(outstanding)]}
        onClose={vi.fn()}
        onSubmit={onSubmit}
      />
    </ThemeProvider>,
  );
  return onSubmit;
}

const qtyField = () => screen.getByLabelText(/Amount received/i);
const closeBox = () => screen.queryByRole('checkbox', { name: /everything we're getting/i });

describe('ReceiveFromVendorDialog', () => {
  it('prefills the whole outstanding balance, so the common case is one click', () => {
    draw(50);
    expect(qtyField()).toHaveValue(50);
  });

  it('HIDES the close when everything came back — there is nothing to write off', () => {
    // An always-visible checkbox here is noise that invites a tick meaning
    // nothing, on the path the field is already prefilled for.
    draw(50);
    expect(closeBox()).not.toBeInTheDocument();
  });

  it('shows the close the moment a smaller number is typed, and names the write-off', async () => {
    draw(50);
    await userEvent.clear(qtyField());
    await userEvent.type(qtyField(), '48');
    expect(closeBox()).toBeInTheDocument();
    expect(screen.getByText(/writes off 2/i)).toBeInTheDocument();
  });

  it('stays hidden on an over-receipt — more than was sent is not a shortfall', async () => {
    draw(50);
    await userEvent.clear(qtyField());
    await userEvent.type(qtyField(), '60');
    expect(closeBox()).not.toBeInTheDocument();
  });

  it('does NOT close when the box was ticked and the quantity then raised back', async () => {
    // The control disappears; the state it set does not. Submitting a close the
    // user can no longer see would write off nothing and settle a live slip.
    const onSubmit = draw(50);
    await userEvent.clear(qtyField());
    await userEvent.type(qtyField(), '48');
    await userEvent.click(closeBox()!);
    await userEvent.clear(qtyField());
    await userEvent.type(qtyField(), '50');

    await userEvent.click(screen.getByRole('button', { name: /Record receipt/i }));
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ quantityGood: 50, closeShipment: false }),
    );
  });

  it('submits the close when it is ticked and still visible', async () => {
    const onSubmit = draw(50);
    await userEvent.clear(qtyField());
    await userEvent.type(qtyField(), '48');
    await userEvent.click(closeBox()!);
    await userEvent.click(screen.getByRole('button', { name: /Record receipt/i }));
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ quantityGood: 48, closeShipment: true }),
    );
  });

  it('allows a close with nothing received — the vendor returned none of it', async () => {
    const onSubmit = draw(50);
    await userEvent.clear(qtyField());
    await userEvent.click(closeBox()!);
    await userEvent.click(screen.getByRole('button', { name: /Record receipt/i }));
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ quantityGood: 0, closeShipment: true }),
    );
  });

  it('refuses a receipt of nothing that is not a close', async () => {
    draw(50);
    await userEvent.clear(qtyField());
    expect(screen.getByRole('button', { name: /Record receipt/i })).toBeDisabled();
  });
});

describe('receivePoLineFor — the PO line a slip read names', () => {
  const join = {
    id: 'line-2',
    line_number: 2,
    vendor_purchase_order_id: 'po-1042',
    vendor_purchase_order: { id: 'po-1042', po_number: 'PO-1042' },
  };

  it('reads the line and its PO off the join — what the line still expects is unknown from a slip alone', () => {
    expect(receivePoLineFor({ vendor_purchase_order_line_id: 'line-2', vendor_purchase_order_line: join })).toEqual({
      vendorPurchaseOrderId: 'po-1042',
      poNumber: 'PO-1042',
      lineId: 'line-2',
      lineNumber: 2,
      remainingQuantity: null,
    });
  });

  /** The job page reads its PO lines anyway; they say how much the line still expects. */
  it("says what the line still expects when the caller has read the job's PO lines", () => {
    const slip = { vendor_purchase_order_line_id: 'line-2', vendor_purchase_order_line: join };
    const lines = [
      { lineId: 'line-9', quantity: 5, receivedQuantity: 0 },
      { lineId: 'line-2', quantity: 50, receivedQuantity: 48 },
    ];
    expect(receivePoLineFor(slip, lines)?.remainingQuantity).toBe(2);
    // Over-received is nothing left, never a negative.
    expect(receivePoLineFor(slip, [{ lineId: 'line-2', quantity: 50, receivedQuantity: 60 }])?.remainingQuantity).toBe(0);
    // A read that does not hold the line knows nothing about it.
    expect(receivePoLineFor(slip, [lines[0]])?.remainingQuantity).toBeNull();
    expect(receivePoLineFor(slip, null)?.remainingQuantity).toBeNull();
  });

  it('is null for a slip on no PO', () => {
    expect(receivePoLineFor({ vendor_purchase_order_line_id: null, vendor_purchase_order_line: null })).toBeNull();
  });

  /** Never offer to close a line the slip is no longer linked to. */
  it('is null when the join names another line than the link', () => {
    expect(receivePoLineFor({ vendor_purchase_order_line_id: 'line-9', vendor_purchase_order_line: join })).toBeNull();
    expect(receivePoLineFor({ vendor_purchase_order_line_id: 'line-2', vendor_purchase_order_line: { ...join, vendor_purchase_order: null } })).toBeNull();
  });
});

describe('ReceiveFromVendorDialog — the vendor PO line behind the slip', () => {
  const PO_LINE: ReceivePoLine = {
    vendorPurchaseOrderId: 'po-1042',
    poNumber: 'PO-1042',
    lineId: 'line-2',
    lineNumber: 2,
    remainingQuantity: 50,
  };
  const linked = (over: Partial<OpenSlipOption> = {}): OpenSlipOption => ({ ...slip(50), poLine: PO_LINE, ...over });

  const drawSlips = (openSlips: OpenSlipOption[], onSubmit = vi.fn()) => {
    render(
      <ThemeProvider theme={jiggedTheme}>
        <ReceiveFromVendorDialog
          open
          vendorName="ProFinish"
          operationName="Anodize"
          partName="J-0141"
          openSlips={openSlips}
          onClose={vi.fn()}
          onSubmit={onSubmit}
        />
      </ThemeProvider>,
    );
    return onSubmit;
  };

  const alsoClose = () => screen.queryByRole('checkbox', { name: /also close PO-1042 line 2/i });

  it('names the PO beside a lone slip', () => {
    drawSlips([linked()]);
    expect(screen.getByText(/Against VPS-0141-2 · PO-1042 — 50 still out/)).toBeInTheDocument();
  });

  it('names the PO on each slip in the picker', async () => {
    drawSlips([linked(), { ...slip(10), id: 's2', slip_number: 'VPS-0141-3', poLine: null }]);
    await userEvent.click(screen.getByRole('combobox', { name: /against which slip/i }));
    expect(await screen.findByRole('option', { name: /VPS-0141-2 · PO-1042 — 50 still out/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /^VPS-0141-3 — 10 still out/ })).toBeInTheDocument();
  });

  it('offers to close the PO line only under a ticked short-close, and leaves it unticked', async () => {
    drawSlips([linked()]);
    await userEvent.clear(qtyField());
    await userEvent.type(qtyField(), '48');
    expect(alsoClose()).not.toBeInTheDocument();

    await userEvent.click(closeBox()!);
    expect(alsoClose()).toBeInTheDocument();
    expect(alsoClose()).not.toBeChecked();
    expect(screen.getByText('Also close PO-1042 line 2 — nothing more expected')).toBeInTheDocument();
  });

  it('submits the PO line to close only when that box is ticked', async () => {
    const onSubmit = drawSlips([linked()]);
    await userEvent.clear(qtyField());
    await userEvent.type(qtyField(), '48');
    await userEvent.click(closeBox()!);
    await userEvent.click(alsoClose()!);
    await userEvent.click(screen.getByRole('button', { name: /Record receipt/i }));
    expect(onSubmit).toHaveBeenCalledWith({
      shipmentId: 's1',
      quantityGood: 48,
      closeShipment: true,
      closePoLine: PO_LINE,
    });
  });

  it('closes no PO line on a plain short-close', async () => {
    const onSubmit = drawSlips([linked()]);
    await userEvent.clear(qtyField());
    await userEvent.type(qtyField(), '48');
    await userEvent.click(closeBox()!);
    await userEvent.click(screen.getByRole('button', { name: /Record receipt/i }));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ closeShipment: true, closePoLine: null }));
  });

  it('drops the PO-line close with the short-close it depends on', async () => {
    const onSubmit = drawSlips([linked()]);
    await userEvent.clear(qtyField());
    await userEvent.type(qtyField(), '48');
    await userEvent.click(closeBox()!);
    await userEvent.click(alsoClose()!);
    await userEvent.click(closeBox()!);
    expect(alsoClose()).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Record receipt/i }));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ closeShipment: false, closePoLine: null }));
  });

  it('offers no PO-line close on a slip that is on no PO', async () => {
    drawSlips([linked({ poLine: null })]);
    await userEvent.clear(qtyField());
    await userEvent.type(qtyField(), '48');
    await userEvent.click(closeBox()!);
    expect(screen.queryByRole('checkbox', { name: /also close/i })).not.toBeInTheDocument();
  });
});

describe('closePoLineAfterReceipt', () => {
  const PO_LINE: ReceivePoLine = {
    vendorPurchaseOrderId: 'po-1042',
    poNumber: 'PO-1042',
    lineId: 'line-2',
    lineNumber: 2,
    remainingQuantity: 50,
  };
  const closed = {} as Awaited<ReturnType<typeof closeVendorPoLines>>;

  beforeEach(() => vi.mocked(closeVendorPoLines).mockReset());

  it('closes the one line, after the receipt, and says it closed', async () => {
    vi.mocked(closeVendorPoLines).mockResolvedValueOnce(closed);
    await expect(closePoLineAfterReceipt(PO_LINE, 48)).resolves.toEqual({ kind: 'closed' });
    expect(closeVendorPoLines).toHaveBeenCalledWith('po-1042', ['line-2'], expect.any(String));
  });

  it('does nothing when no line was ticked', async () => {
    await expect(closePoLineAfterReceipt(null, 48)).resolves.toBeNull();
    expect(closeVendorPoLines).not.toHaveBeenCalled();
  });

  /** The receipt already landed; the message must not invite recording it again. */
  it('says the receipt stands when the line could not be closed', async () => {
    vi.mocked(closeVendorPoLines).mockRejectedValueOnce(refusal('That record is not available.'));
    const outcome = await closePoLineAfterReceipt(PO_LINE, 48);
    expect(outcome?.kind).toBe('failed');
    const message = outcome?.kind === 'failed' ? outcome.message : '';
    expect(message).toMatch(/receipt was recorded/i);
    expect(message).toMatch(/PO-1042 line 2/);
    expect(message).toMatch(/That record is not available\./);
  });

  /**
   * THE E2E FINDING. A receipt that brings the line up to what it ordered leaves nothing on it to
   * close — the database refuses a close there ("Line 2 has nothing left to receive."), and the
   * person was told the line "could not be closed: … Close it on the PO" about a line that is done.
   * "Nothing more expected" is exactly what a line received in full means, so it counts as done.
   */
  it('skips the close when this receipt leaves nothing on the line — received in full is done', async () => {
    await expect(closePoLineAfterReceipt({ ...PO_LINE, remainingQuantity: 2 }, 2)).resolves.toEqual({ kind: 'received' });
    await expect(closePoLineAfterReceipt({ ...PO_LINE, remainingQuantity: 2 }, 3)).resolves.toEqual({ kind: 'received' });
    // A write-off with nothing back, on a line that already had everything.
    await expect(closePoLineAfterReceipt({ ...PO_LINE, remainingQuantity: 0 }, 0)).resolves.toEqual({ kind: 'received' });
    expect(closeVendorPoLines).not.toHaveBeenCalled();
  });

  it('still closes a line this receipt leaves short', async () => {
    vi.mocked(closeVendorPoLines).mockResolvedValueOnce(closed);
    await expect(closePoLineAfterReceipt({ ...PO_LINE, remainingQuantity: 2 }, 1.5)).resolves.toEqual({ kind: 'closed' });
    expect(closeVendorPoLines).toHaveBeenCalledTimes(1);
  });

  /** The drawer reads slips only, and any screen can be a receipt behind: the database decides. */
  it('counts the "nothing left to receive" refusal as done when the screen could not tell', async () => {
    vi.mocked(closeVendorPoLines).mockRejectedValueOnce(refusal('Line 2 has nothing left to receive.'));
    await expect(closePoLineAfterReceipt({ ...PO_LINE, remainingQuantity: null }, 48)).resolves.toEqual({ kind: 'received' });

    // The line had less left than this screen knew (another receipt landed meanwhile).
    vi.mocked(closeVendorPoLines).mockRejectedValueOnce(refusal('Line 2 has nothing left to receive.'));
    await expect(closePoLineAfterReceipt({ ...PO_LINE, remainingQuantity: 50 }, 48)).resolves.toEqual({ kind: 'received' });
  });

  /**
   * "Also close" on a slip whose line was closed first — on the PO page, or by another slip's
   * "Also close" — was refused ("Line 2 is already closed.") and warned that the line "could not be
   * closed … Close it on the PO", about a line that is closed. Nothing more is expected on it, which
   * is what the box asked: done, and said as what happened rather than as a close.
   */
  it('counts the "already closed" refusal as done, and says the line was already closed', async () => {
    vi.mocked(closeVendorPoLines).mockRejectedValueOnce(refusal('Line 2 is already closed.'));
    await expect(closePoLineAfterReceipt(PO_LINE, 48)).resolves.toEqual({ kind: 'already_closed' });
    // The screen's own read of the line cannot know: the database decides, wherever it is asked.
    vi.mocked(closeVendorPoLines).mockRejectedValueOnce(refusal('Line 2 is already closed.'));
    await expect(closePoLineAfterReceipt({ ...PO_LINE, remainingQuantity: null }, 48)).resolves.toEqual({
      kind: 'already_closed',
    });

    expect(poLineCloseSentence(PO_LINE, { kind: 'already_closed' })).toBe('PO-1042 line 2 was already closed.');
  });

  /**
   * "Also close" on a slip whose whole PO was closed first — on the PO page — was refused before any
   * line was looked at ("PO-1042 is closed. Reopen it first.") and warned that the line "could not
   * be closed", telling the person to reopen a PO only to close it again. Nothing more is expected on
   * any of its lines, which is what the box asked: done, and said as what happened.
   */
  it('counts the whole PO closed first as done, and says the PO was already closed', async () => {
    vi.mocked(closeVendorPoLines).mockRejectedValueOnce(refusal('PO-1042 is closed. Reopen it first.'));
    await expect(closePoLineAfterReceipt(PO_LINE, 48)).resolves.toEqual({ kind: 'po_already_closed' });
    // Wherever it is asked from: the screen's own read of the PO cannot know either.
    vi.mocked(closeVendorPoLines).mockRejectedValueOnce(refusal('PO-1042 is closed. Reopen it first.'));
    await expect(closePoLineAfterReceipt({ ...PO_LINE, remainingQuantity: null }, 48)).resolves.toEqual({
      kind: 'po_already_closed',
    });

    expect(poLineCloseSentence(PO_LINE, { kind: 'po_already_closed' })).toBe('PO-1042 was already closed.');
  });

  it('counts only those refusals, for this line and its PO: anything else still says the line did not close', async () => {
    const unknown = { ...PO_LINE, remainingQuantity: null };
    for (const err of [
      refusal('Line 3 has nothing left to receive.'), // another line's
      refusal('Line 3 is already closed.'), // another line's
      refusal('PO-1043 is closed. Reopen it first.'), // another PO's
      refusal('PO-1042 is archived.'), // archived is not closed
      new Error('Line 2 has nothing left to receive.'), // the words, without the refusal code
      new Error('Line 2 is already closed.'),
      new Error('PO-1042 is closed. Reopen it first.'),
    ]) {
      vi.mocked(closeVendorPoLines).mockRejectedValueOnce(err);
      const outcome = await closePoLineAfterReceipt(unknown, 48);
      expect(outcome?.kind, err.message).toBe('failed');
    }
  });
});
