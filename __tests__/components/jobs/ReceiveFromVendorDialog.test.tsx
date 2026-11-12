import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThemeProvider } from '@mui/material/styles';
import jiggedTheme from '@/lib/theme';

vi.mock('@/utils/vendorPoAccess', () => ({ closeVendorPoLines: vi.fn() }));

import ReceiveFromVendorDialog, {
  closePoLineAfterReceipt,
  type OpenSlipOption,
  type ReceivePoLine,
} from '@/components/jobs/ReceiveFromVendorDialog';
import { closeVendorPoLines } from '@/utils/vendorPoAccess';

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

describe('ReceiveFromVendorDialog — the vendor PO line behind the slip', () => {
  const PO_LINE: ReceivePoLine = {
    vendorPurchaseOrderId: 'po-1042',
    poNumber: 'PO-1042',
    lineId: 'line-2',
    lineNumber: 2,
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
  };

  it('closes the one line, after the receipt, and reports nothing on success', async () => {
    vi.mocked(closeVendorPoLines).mockResolvedValueOnce({} as Awaited<ReturnType<typeof closeVendorPoLines>>);
    await expect(closePoLineAfterReceipt(PO_LINE)).resolves.toBeNull();
    expect(closeVendorPoLines).toHaveBeenCalledWith('po-1042', ['line-2'], expect.any(String));
  });

  it('does nothing when no line was ticked', async () => {
    vi.mocked(closeVendorPoLines).mockClear();
    await expect(closePoLineAfterReceipt(null)).resolves.toBeNull();
    expect(closeVendorPoLines).not.toHaveBeenCalled();
  });

  /** The receipt already landed; the message must not invite recording it again. */
  it('says the receipt stands when the line could not be closed', async () => {
    vi.mocked(closeVendorPoLines).mockRejectedValueOnce(new Error('That record is not available.'));
    const message = await closePoLineAfterReceipt(PO_LINE);
    expect(message).toMatch(/receipt was recorded/i);
    expect(message).toMatch(/PO-1042 line 2/);
    expect(message).toMatch(/That record is not available\./);
  });
});
