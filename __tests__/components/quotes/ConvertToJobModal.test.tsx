import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
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
    lead_time_days: null,
    lead_time_value: null,
    lead_time_unit: null,
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
