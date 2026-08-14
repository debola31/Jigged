import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '../../test-utils';
import userEvent from '@testing-library/user-event';
import InvoicesMenu from '@/components/jobs/InvoicesMenu';

const getQuickBooksInvoiceLinksForJob = vi.fn();
vi.mock('@/utils/quickbooksAccess', () => ({
  getQuickBooksInvoiceLinksForJob: (...args: unknown[]) =>
    getQuickBooksInvoiceLinksForJob(...args),
}));

const copyText = vi.fn();
vi.mock('@/utils/clipboard', () => ({
  copyText: (...args: unknown[]) => copyText(...args),
}));

const QBO = {
  id: 'l1',
  docNumber: '1001',
  total: 500,
  createdAt: '2026-08-10T00:00:00Z',
  url: 'https://app.qbo.intuit.com/app/invoice?txnId=1',
};
// QuickBooks Desktop: url is ALWAYS null — there is no web page to open.
const QBD = { id: 'l2', docNumber: '1100', total: 683.48, createdAt: '2026-08-10T00:00:00Z', url: null };

async function openMenu() {
  await userEvent.click(await screen.findByRole('button', { name: /Invoices/ }));
}

describe('InvoicesMenu', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    copyText.mockResolvedValue(true);
  });

  it('links out to QuickBooks Online when there is a url', async () => {
    getQuickBooksInvoiceLinksForJob.mockResolvedValue([QBO]);
    render(<InvoicesMenu companyId="c1" jobId="j1" onCreate={vi.fn()} />);
    await openMenu();

    const row = await screen.findByRole('menuitem', { name: /1001/ });
    expect(row).toHaveAttribute('href', QBO.url);
  });

  it('copies the invoice number instead of navigating for a Desktop invoice', async () => {
    getQuickBooksInvoiceLinksForJob.mockResolvedValue([QBD]);
    render(<InvoicesMenu companyId="c1" jobId="j1" onCreate={vi.fn()} />);
    await openMenu();

    const row = await screen.findByRole('menuitem', { name: /Copy invoice number 1100/ });
    // The delete-gate regression that a null url once caused makes this worth
    // stating outright: a Desktop row must never become a dead <a href>.
    expect(row).not.toHaveAttribute('href');

    await userEvent.click(row);

    // The NUMBER alone — it is pasted straight into the Invoice # field of
    // QuickBooks' Find window, so any decoration would have to be deleted.
    expect(copyText).toHaveBeenCalledWith('1100');
    expect(await screen.findByText('Copied')).toBeInTheDocument();
  });

  it('tells the user how to use the number when nothing can be linked', async () => {
    getQuickBooksInvoiceLinksForJob.mockResolvedValue([QBD]);
    render(<InvoicesMenu companyId="c1" jobId="j1" onCreate={vi.fn()} />);
    await openMenu();

    expect(await screen.findByText(/press Ctrl\+F, paste it into Invoice #/)).toBeInTheDocument();
  });

  it('does not show the Desktop hint when the invoices are linkable', async () => {
    getQuickBooksInvoiceLinksForJob.mockResolvedValue([QBO]);
    render(<InvoicesMenu companyId="c1" jobId="j1" onCreate={vi.fn()} />);
    await openMenu();

    await screen.findByRole('menuitem', { name: /1001/ });
    expect(screen.queryByText(/press Ctrl\+F/)).not.toBeInTheDocument();
  });

  it('says how to copy by hand rather than claiming success when the copy fails', async () => {
    copyText.mockResolvedValue(false);
    getQuickBooksInvoiceLinksForJob.mockResolvedValue([QBD]);
    render(<InvoicesMenu companyId="c1" jobId="j1" onCreate={vi.fn()} />);
    await openMenu();

    await userEvent.click(await screen.findByRole('menuitem', { name: /Copy invoice number 1100/ }));

    await waitFor(() => expect(screen.getByText('Press Ctrl+C to copy')).toBeInTheDocument());
    expect(screen.queryByText('Copied')).not.toBeInTheDocument();
  });
});
