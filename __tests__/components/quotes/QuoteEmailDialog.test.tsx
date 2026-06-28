import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { ThemeProvider } from '@mui/material/styles';
import jiggedTheme from '@/lib/theme';

import QuoteEmailDialog from '@/components/quotes/QuoteEmailDialog';
import { quotePdfFilename } from '@/utils/quotePdf';
import type { QuoteWithRelations } from '@/types/quote';
import type { Company } from '@/utils/companyAccess';

vi.mock('@/utils/quotePdf', () => ({
  generateQuotePdf: vi.fn(),
  quotePdfFilename: vi.fn(() => 'quote.pdf'),
}));

const company = { id: 'co1', name: 'Acme Machining' } as unknown as Company;

const quote = (quoteNumber: string): QuoteWithRelations =>
  ({
    id: `q-${quoteNumber}`,
    quote_number: quoteNumber,
    expiration_date: null,
    created_by_member: { name: 'Sam Sales' },
    customers: { name: 'Customer Co', customer_contacts: [] },
    line_items: [],
  }) as unknown as QuoteWithRelations;

const wrap = (ui: React.ReactElement) => (
  <ThemeProvider theme={jiggedTheme}>{ui}</ThemeProvider>
);

const subjectField = () => screen.getByLabelText(/subject/i) as HTMLInputElement;

beforeEach(() => {
  vi.clearAllMocks();
  (quotePdfFilename as ReturnType<typeof vi.fn>).mockReturnValue('quote.pdf');
});

describe('QuoteEmailDialog — reopen re-seeds the Subject from the current quote', () => {
  it('shows the NEW quote_number in the Subject on reopen (no stale subject)', async () => {
    const base = { open: true, onClose: vi.fn(), company };

    // Open with quote Q-100 → subject built from "Q-100".
    const { rerender } = render(wrap(<QuoteEmailDialog {...base} quote={quote('Q-100')} />));
    await waitFor(() => expect(subjectField().value).toContain('Q-100'));

    // Close.
    rerender(wrap(<QuoteEmailDialog {...base} open={false} quote={quote('Q-100')} />));

    // Reopen with a DIFFERENT quote Q-200 → subject must rebuild from "Q-200".
    rerender(wrap(<QuoteEmailDialog {...base} quote={quote('Q-200')} />));
    await waitFor(() => expect(subjectField().value).toContain('Q-200'));
    expect(subjectField().value).not.toContain('Q-100');
  });
});
