import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThemeProvider } from '@mui/material/styles';
import jiggedTheme from '@/lib/theme';
import ReceiveFromVendorDialog from '@/components/jobs/ReceiveFromVendorDialog';

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
