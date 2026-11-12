/**
 * Close… — nothing more expected on these lines (plan §3.13, criterion P5).
 *
 * Every open line starts ticked, and every line ticked is the whole PO closing — one write that the
 * database records on the header. Fewer is a batch line close, atomic too. Closing never bumps the
 * revision and never blocks.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import userEvent from '@testing-library/user-event';
import { render, screen, waitFor } from '../../test-utils';
import { otherLine, outsideLine, poDetail, poLine } from './vendorPoFixtures';

const closeVendorPoLines = vi.fn();
vi.mock('@/utils/vendorPoAccess', () => ({
  closeVendorPoLines: (...args: unknown[]) => closeVendorPoLines(...args),
}));
const capture = vi.fn();
vi.mock('posthog-js', () => ({ default: { capture: (...args: unknown[]) => capture(...args) } }));
vi.mock('@/hooks/useUserRole', () => ({ useUserRole: () => ({ role: 'user', isAdmin: false, loading: false }) }));

import CloseVendorPoLinesDialog from '@/components/purchasing/CloseVendorPoLinesDialog';

const onClose = vi.fn();
const onClosed = vi.fn();
const po = poDetail({ lines: [poLine(), otherLine(), outsideLine(), poLine({ id: 'l4', lineNumber: 4, status: 'received', receivedQuantity: 3 })] });

beforeEach(() => {
  vi.clearAllMocks();
  closeVendorPoLines.mockResolvedValue({ id: 'po-1' });
});

describe('CloseVendorPoLinesDialog', () => {
  it('lists the lines still expecting something, all ticked, and says what closing means', () => {
    render(<CloseVendorPoLinesDialog open po={po} onClose={onClose} onClosed={onClosed} />);
    expect(screen.getByRole('checkbox', { name: /line 1/i })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /line 2/i })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /line 3/i })).toBeChecked();
    // A fully received line has nothing left to close.
    expect(screen.queryByRole('checkbox', { name: /line 4/i })).not.toBeInTheDocument();
    expect(screen.getByText(/nothing more expected on these lines; they stop counting as on order/i)).toBeInTheDocument();
  });

  it('closes the whole PO when every line is ticked', async () => {
    const user = userEvent.setup();
    render(<CloseVendorPoLinesDialog open po={po} onClose={onClose} onClosed={onClosed} />);
    await user.type(screen.getByLabelText(/note/i), 'Vendor out of stock');
    await user.click(screen.getByRole('button', { name: /close the po/i }));
    await waitFor(() => expect(closeVendorPoLines).toHaveBeenCalledWith('po-1', 'all', 'Vendor out of stock'));
    expect(capture).toHaveBeenCalledWith('vendor po lines closed', { whole_po: true, line_count: 3, had_receipts: true });
    expect(onClosed).toHaveBeenCalled();
  });

  it('closes only the ticked lines otherwise, in one batch', async () => {
    const user = userEvent.setup();
    render(<CloseVendorPoLinesDialog open po={po} onClose={onClose} onClosed={onClosed} />);
    await user.click(screen.getByRole('checkbox', { name: /line 1/i }));
    await user.click(screen.getByRole('checkbox', { name: /line 3/i }));
    await user.click(screen.getByRole('button', { name: /close 1 line/i }));
    await waitFor(() => expect(closeVendorPoLines).toHaveBeenCalledWith('po-1', ['l2'], null));
    expect(capture).toHaveBeenCalledWith('vendor po lines closed', { whole_po: false, line_count: 1, had_receipts: false });
  });

  it('can start from one line, for a row’s own Close short', () => {
    render(<CloseVendorPoLinesDialog open po={po} initialLineIds={['l2']} onClose={onClose} onClosed={onClosed} />);
    expect(screen.getByRole('checkbox', { name: /line 1/i })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: /line 2/i })).toBeChecked();
  });

  it('keeps Close off with nothing ticked, and says why', async () => {
    const user = userEvent.setup();
    render(<CloseVendorPoLinesDialog open po={po} initialLineIds={['l2']} onClose={onClose} onClosed={onClosed} />);
    await user.click(screen.getByRole('checkbox', { name: /line 2/i }));
    expect(screen.getByRole('button', { name: /^close/i })).toBeDisabled();
    expect(screen.getByText(/tick the lines to close/i)).toBeInTheDocument();
  });

  it('shows a refusal and stays open', async () => {
    closeVendorPoLines.mockRejectedValue(new Error('PO-1042 is archived. Nothing on it can change.'));
    const user = userEvent.setup();
    render(<CloseVendorPoLinesDialog open po={po} onClose={onClose} onClosed={onClosed} />);
    await user.click(screen.getByRole('button', { name: /close the po/i }));
    expect(await screen.findByText(/is archived/i)).toBeInTheDocument();
    expect(onClosed).not.toHaveBeenCalled();
  });
});
