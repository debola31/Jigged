/**
 * The office send, with the vendor PO it ships against (plan §3.6, criterion O4).
 *
 * The slip links ITSELF to the step's one open outside line — `create_outside_shipment` does it,
 * with no argument to pass — so the dialog has nothing to choose. It says which line, read-only,
 * and takes the due-back date from that line's need-by, which is the shop's own date for the step
 * rather than an invented promise.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import userEvent from '@testing-library/user-event';
import { render, screen } from '../../test-utils';

vi.mock('@/utils/outsideShipmentsAccess', () => ({
  resolveVendorShipTo: vi.fn(async () => ({ address: null, choices: [], requiresChoice: false })),
}));

import SendToVendorDialog, { type SendToVendorPoLine } from '@/components/jobs/SendToVendorDialog';

const LINE: SendToVendorPoLine = {
  poNumber: 'PO-1042',
  lineNumber: 2,
  href: '/dashboard/co1/purchasing/orders/po-1042',
  needByOn: '2026-03-09',
};

const draw = (over: Partial<Parameters<typeof SendToVendorDialog>[0]> = {}) => {
  const onSubmit = vi.fn();
  render(
    <SendToVendorDialog
      open
      vendorId="v1"
      vendorName="ProFinish"
      operationName="Anodize"
      partName="BRACKET-A"
      qtyToSend={50}
      onClose={vi.fn()}
      onSubmit={onSubmit}
      {...over}
    />,
  );
  return onSubmit;
};

const dueBack = () => screen.getByLabelText(/due back/i);

beforeEach(() => vi.clearAllMocks());

describe('SendToVendorDialog — the PO line it ships against', () => {
  it('names the line read-only, as a link to the PO — there is nothing to choose', async () => {
    draw({ poLine: LINE });
    expect(await screen.findByText(/ships against/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /PO-1042 line 2/i })).toHaveAttribute('href', LINE.href);
    // One open line per (step, vendor) is a database rule, so a picker would offer one choice.
    expect(screen.queryByRole('combobox', { name: /purchase order/i })).not.toBeInTheDocument();
  });

  it('prefills Due back from the line’s need-by date', () => {
    draw({ poLine: LINE });
    expect(dueBack()).toHaveValue('2026-03-09');
  });

  it('sends the prefilled date unless somebody changes it', async () => {
    const onSubmit = draw({ poLine: LINE });
    await userEvent.click(screen.getByRole('button', { name: /send & print slip/i }));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ quantity: 50, dueBackOn: '2026-03-09' }));
  });

  it('leaves Due back empty on a line with no need-by — nothing to take it from', () => {
    draw({ poLine: { ...LINE, needByOn: null } });
    expect(dueBack()).toHaveValue('');
  });

  it('offers "Create PO for this step" when the step is on no PO, and leaves Due back empty', () => {
    draw({ poLine: null, createPoHref: '/dashboard/co1/purchasing/orders/new?jobOperation=op-1' });
    expect(screen.getByText(/not on a purchase order/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /create po for this step/i })).toHaveAttribute(
      'href',
      '/dashboard/co1/purchasing/orders/new?jobOperation=op-1',
    );
    expect(dueBack()).toHaveValue('');
  });

  /** "Couldn't check" must not read as "not on a PO" — that invites a second PO for the step. */
  it('says nothing about POs while that is unknown', () => {
    draw({ poLine: undefined });
    expect(screen.queryByText(/ships against/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/not on a purchase order/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /create po/i })).not.toBeInTheDocument();
  });
});
