import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThemeProvider } from '@mui/material/styles';
import jiggedTheme from '@/lib/theme';

import ConvertToJobModal from '@/components/quotes/ConvertToJobModal';
import type { QuoteWithRelations } from '@/types/quote';

vi.mock('@/utils/quotesAccess', () => ({
  convertQuoteToJob: vi.fn(),
}));
vi.mock('@/utils/jobAttachmentsAccess', () => ({
  uploadJobAttachment: vi.fn(),
}));

const quote = (): QuoteWithRelations =>
  ({
    id: 'q1',
    company_id: 'co1',
    quote_number: 'Q-100',
    lead_time_text: null,
    expiration_date: null,
    customers: { name: 'Customer Co' },
    line_items: [
      {
        id: 'li1',
        sequence: 1,
        part_id: 'p1',
        quantity: 10,
        unit_price: 5,
        total_price: 50,
        parts: { part_name: 'Bracket', primary_unit: null },
      },
    ],
  }) as unknown as QuoteWithRelations;

const wrap = (ui: React.ReactElement) => (
  <ThemeProvider theme={jiggedTheme}>{ui}</ThemeProvider>
);

const poField = () => screen.getByLabelText(/customer po/i) as HTMLInputElement;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ConvertToJobModal — reopen resets the Customer PO field', () => {
  it('clears a typed Customer PO when the modal is closed and reopened (no stale value)', async () => {
    const base = { open: true, onClose: vi.fn(), onConverted: vi.fn(), quote: quote() };

    const { rerender } = render(wrap(<ConvertToJobModal {...base} />));

    // Field starts empty (the quote never carries a PO).
    await waitFor(() => expect(poField().value).toBe(''));

    // Type a PO.
    await userEvent.type(poField(), 'PO-9999');
    expect(poField().value).toBe('PO-9999');

    // Close, then reopen — onEnter must reset the PO back to empty.
    rerender(wrap(<ConvertToJobModal {...base} open={false} />));
    rerender(wrap(<ConvertToJobModal {...base} open />));

    await waitFor(() => expect(poField().value).toBe(''));
  });
});

describe('ConvertToJobModal — per-part selection (multiple jobs/POs per quote)', () => {
  it('converts only the checked parts, leaving the rest for a later PO', async () => {
    const { convertQuoteToJob } = await import('@/utils/quotesAccess');
    (convertQuoteToJob as ReturnType<typeof vi.fn>).mockResolvedValue({
      job: { id: 'job1', job_number: 'J-100', parts: [] },
    });

    const twoPartQuote = {
      ...quote(),
      line_items: [
        {
          id: 'li1',
          sequence: 1,
          part_id: 'p1',
          quantity: 10,
          unit_price: 5,
          total_price: 50,
          parts: { part_name: 'Bracket', primary_unit: null },
        },
        {
          id: 'li2',
          sequence: 2,
          part_id: 'p2',
          quantity: 4,
          unit_price: 20,
          total_price: 80,
          parts: { part_name: 'Housing', primary_unit: null },
        },
      ],
    } as unknown as QuoteWithRelations;

    const onConverted = vi.fn();
    render(
      wrap(
        <ConvertToJobModal
          open
          onClose={vi.fn()}
          onConverted={onConverted}
          quote={twoPartQuote}
          conversions={[]}
        />,
      ),
    );

    // Both parts start checked (one PO for the whole quote is the default).
    // Uncheck Housing to leave it for a separate PO.
    await userEvent.click(screen.getByRole('checkbox', { name: /include housing/i }));

    // Fill the two required fields.
    fireEvent.change(screen.getByLabelText(/due date/i), { target: { value: '2030-01-01' } });
    await userEvent.type(poField(), 'PO-1');

    await userEvent.click(screen.getByRole('button', { name: /create j-100/i }));

    await waitFor(() =>
      expect(convertQuoteToJob).toHaveBeenCalledWith(
        'q1',
        expect.objectContaining({ selectedLineItemIds: ['li1'], customerPoNumber: 'PO-1' }),
      ),
    );
    expect(onConverted).toHaveBeenCalledWith('job1');
  });
});

describe('ConvertToJobModal — partial quantity acceptance', () => {
  it('lets you order fewer than quoted (10 → 5) and passes the quantity override', async () => {
    const { convertQuoteToJob } = await import('@/utils/quotesAccess');
    (convertQuoteToJob as ReturnType<typeof vi.fn>).mockResolvedValue({
      job: { id: 'job1', job_number: 'J-100', parts: [] },
    });

    render(
      wrap(
        <ConvertToJobModal
          open
          onClose={vi.fn()}
          onConverted={vi.fn()}
          quote={quote()}
          conversions={[]}
        />,
      ),
    );

    // Quoted qty pre-fills to 10; the customer orders 5.
    const qty = screen.getByLabelText(/order qty/i) as HTMLInputElement;
    await waitFor(() => expect(qty.value).toBe('10'));
    fireEvent.change(qty, { target: { value: '5' } });

    fireEvent.change(screen.getByLabelText(/due date/i), { target: { value: '2030-01-01' } });
    await userEvent.type(poField(), 'PO-1');
    await userEvent.click(screen.getByRole('button', { name: /create j-100/i }));

    await waitFor(() =>
      expect(convertQuoteToJob).toHaveBeenCalledWith(
        'q1',
        expect.objectContaining({
          lineOverrides: { li1: { quantity: 5, useTierPrice: false } },
        }),
      ),
    );
  });
});

describe('ConvertToJobModal — no premature error on the empty due date', () => {
  it('does not show a red "required" error on the untouched due date; Create stays disabled', async () => {
    const base = { open: true, onClose: vi.fn(), onConverted: vi.fn(), quote: quote() };
    render(wrap(<ConvertToJobModal {...base} />));

    // The empty required due date must not scream a red "required" error on
    // open — the disabled Create button already signals it, exactly like the
    // equally-required Customer PO field (which shows no error either).
    await waitFor(() => expect(poField().value).toBe(''));
    expect(screen.queryByText(/due date is required/i)).not.toBeInTheDocument();

    // Both required fields are still empty, so conversion stays gated.
    expect(screen.getByRole('button', { name: /create j-100/i })).toBeDisabled();
  });
});
