import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThemeProvider } from '@mui/material/styles';
import jiggedTheme from '@/lib/theme';

import JobEditForm from '@/components/jobs/JobEditForm';
import type { JobWithRelations } from '@/types/job';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/utils/jobsAccess', () => ({
  updateJobDetails: vi.fn().mockResolvedValue({}),
  updateJobAddressContact: vi.fn().mockResolvedValue({}),
  updateJobPartQuantity: vi.fn().mockResolvedValue({}),
  updateJobPartPrice: vi.fn().mockResolvedValue({}),
}));

import {
  updateJobDetails,
  updateJobAddressContact,
  updateJobPartQuantity,
  updateJobPartPrice,
} from '@/utils/jobsAccess';

const baseJob = {
  id: 'job-1',
  job_number: 'J-0001',
  customer_id: 'cust-1',
  customer_po_number: 'PO-1',
  due_date: '2026-07-01',
  billing_address_id: 'addr-1',
  shipping_address_id: 'addr-1',
  contact_id: 'contact-1',
  customers: {
    addresses: [
      {
        id: 'addr-1',
        address_line1: '1 Main St',
        city: 'Town',
        state: 'ST',
        postal_code: '00000',
        country: 'USA',
      },
    ],
    customer_contacts: [{ id: 'contact-1', name: 'Dana Reyes' }],
  },
  job_parts: [
    {
      id: 'jp-1',
      part_id: 'p-1',
      quantity: 10,
      unit_price: 100,
      total_price: 1000,
      production_status: 'in_progress',
      parts: { part_name: 'Bracket' },
    },
  ],
} as unknown as JobWithRelations;

const invoiceLink = { invoiceId: 'i1', docNumber: '1001', url: 'http://qb.example/1' };

const wrap = (ui: React.ReactElement) => (
  <ThemeProvider theme={jiggedTheme}>{ui}</ThemeProvider>
);

const renderForm = (over: Partial<React.ComponentProps<typeof JobEditForm>> = {}) =>
  render(
    wrap(
      <JobEditForm
        job={baseJob}
        companyId="co-1"
        qbInvoiceLink={null}
        shippedByPart={new Map()}
        onCancel={vi.fn()}
        onSaved={vi.fn()}
        {...over}
      />,
    ),
  );

describe('JobEditForm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('saves header + addresses, and routes changed lines to qty/price writers', async () => {
    const onSaved = vi.fn();
    renderForm({ onSaved });

    const qty = screen.getByLabelText(/quantity/i);
    await userEvent.clear(qty);
    await userEvent.type(qty, '25');
    const price = screen.getByLabelText(/unit price/i);
    await userEvent.clear(price);
    await userEvent.type(price, '120');

    await userEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(updateJobPartQuantity).toHaveBeenCalledWith('jp-1', 25));
    expect(updateJobPartPrice).toHaveBeenCalledWith('jp-1', 120);
    expect(updateJobDetails).toHaveBeenCalledWith(
      'job-1',
      'co-1',
      expect.objectContaining({ customer_po_number: 'PO-1', due_date: '2026-07-01' }),
    );
    expect(updateJobAddressContact).toHaveBeenCalled();
    expect(onSaved).toHaveBeenCalled();
  });

  it('does not touch qty/price writers when nothing on the line changed', async () => {
    renderForm();
    await userEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(updateJobDetails).toHaveBeenCalled());
    expect(updateJobPartQuantity).not.toHaveBeenCalled();
    expect(updateJobPartPrice).not.toHaveBeenCalled();
  });

  it('locks line qty/price when the job is invoiced', () => {
    renderForm({ qbInvoiceLink: invoiceLink });
    expect(screen.getByLabelText(/quantity/i)).toBeDisabled();
    expect(screen.getByLabelText(/unit price/i)).toBeDisabled();
    expect(screen.getByText(/Invoiced in QuickBooks/i)).toBeInTheDocument();
  });

  it('blocks saving a quantity below what has already shipped', async () => {
    renderForm({ shippedByPart: new Map([['jp-1', 8]]) });
    const qty = screen.getByLabelText(/quantity/i);
    await userEvent.clear(qty);
    await userEvent.type(qty, '5');
    expect(screen.getByRole('button', { name: /save changes/i })).toBeDisabled();
    expect(screen.getByText(/already shipped/i)).toBeInTheDocument();
  });
});
