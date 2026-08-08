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

describe('ConvertToJobModal — reprice opt-in only on a real price-break crossing', () => {
  it('does NOT offer a reprice for a single-tier part, even when the tier price differs from the quoted price', async () => {
    // A single-tier part whose snapshot tier price ($175.28) differs from the
    // line's stored/quoted price ($127.12) — a drift, not a break. Changing the
    // ordered qty must NOT surface a "Reprice to the qty-N tier" option, because
    // there is no other tier to cross.
    const singleTierQuote = {
      ...quote(),
      line_items: [
        {
          id: 'li1',
          sequence: 1,
          part_id: 'p1',
          quantity: 7,
          unit_price: 127.12,
          total_price: 889.84,
          is_quote_override: false,
          basis_unknown: false,
          pricing_basis_snapshot: {
            tiers: [{ id: 't1', quantity: 1, unit_price: 175.28, markup_percent: 45 }],
            resolved_tier_id: 't1',
            resolved_quantity: 7,
            captured_at: '2026-01-01T00:00:00Z',
          },
          parts: { part_name: 'ASM-GEARBOX', primary_unit: null },
        },
      ],
    } as unknown as QuoteWithRelations;

    render(
      wrap(
        <ConvertToJobModal
          open
          onClose={vi.fn()}
          onConverted={vi.fn()}
          quote={singleTierQuote}
          conversions={[]}
        />,
      ),
    );

    // Change the ordered qty (7 → 5) — still no reprice option for a single tier.
    const qty = screen.getByLabelText(/order qty/i);
    fireEvent.change(qty, { target: { value: '5' } });

    expect(screen.queryByText(/reprice to the qty/i)).not.toBeInTheDocument();
  });
});

describe('ConvertToJobModal — price-options part (quick-pick breaks + editable qty)', () => {
  it('quoted breaks are one-tap chips; any qty converts at the tier price (useTierPrice)', async () => {
    const { convertQuoteToJob } = await import('@/utils/quotesAccess');
    (convertQuoteToJob as ReturnType<typeof vi.fn>).mockResolvedValue({
      job: { id: 'job1', job_number: 'J-100', parts: [] },
    });

    const snapshot = {
      tiers: [
        { id: 't1', quantity: 1, unit_price: 127.12, markup_percent: 45 },
        { id: 't2', quantity: 80, unit_price: 119.79, markup_percent: 40 },
      ],
      resolved_tier_id: 't1',
      resolved_quantity: 7,
      captured_at: '2026-01-01T00:00:00Z',
    };
    const mkLine = (id: string, qty: number, price: number) => ({
      id,
      sequence: qty,
      part_id: 'p1',
      quantity: qty,
      unit_price: price,
      total_price: price * qty,
      is_quote_override: false,
      basis_unknown: false,
      pricing_basis_snapshot: snapshot,
      parts: { part_name: 'ASM-GEARBOX', primary_unit: null },
    });
    const optionsQuote = {
      ...quote(),
      line_items: [mkLine('li7', 7, 127.12), mkLine('li80', 80, 119.79)],
    } as unknown as QuoteWithRelations;

    render(
      wrap(
        <ConvertToJobModal
          open
          onClose={vi.fn()}
          onConverted={vi.fn()}
          quote={optionsQuote}
          conversions={[]}
        />,
      ),
    );

    // Defaults to the lowest break (7); the editable field is pre-filled.
    const qty = screen.getByLabelText(/order qty/i) as HTMLInputElement;
    await waitFor(() => expect(qty.value).toBe('7'));

    // Tap the 80-break chip → sets qty to 80 and that line as the base.
    await userEvent.click(screen.getByText(/80 ea/i));
    expect(qty.value).toBe('80');

    fireEvent.change(screen.getByLabelText(/due date/i), { target: { value: '2030-01-01' } });
    await userEvent.type(poField(), 'PO-1');
    await userEvent.click(screen.getByRole('button', { name: /create j-100/i }));

    await waitFor(() =>
      expect(convertQuoteToJob).toHaveBeenCalledWith(
        'q1',
        expect.objectContaining({
          selectedLineItemIds: ['li80'],
          lineOverrides: { li80: { quantity: 80, useTierPrice: true } },
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

/**
 * Lead time follows the same all-or-nothing rule as the PDF and the quote
 * detail page: if ANY line carries its own, the single quote-level value is
 * suppressed and each part shows its effective one. This modal was the only
 * one of the three that never got it — it read `quote.lead_time_text` and
 * nothing else, so a quote with three per-part lead times showed one.
 * Mirrors `__tests__/utils/quotePdf.test.ts` > per-item lead times.
 */
describe('ConvertToJobModal — per-part lead times', () => {
  const twoParts = (
    leadA: string | null,
    leadB: string | null,
    quoteLead: string | null,
  ): QuoteWithRelations =>
    ({
      id: 'q1',
      company_id: 'co1',
      quote_number: 'Q-100',
      lead_time_text: quoteLead,
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
          lead_time_text: leadA,
          parts: { part_name: 'Bracket', primary_unit: null },
        },
        {
          id: 'li2',
          sequence: 2,
          part_id: 'p2',
          quantity: 4,
          unit_price: 9,
          total_price: 36,
          lead_time_text: leadB,
          parts: { part_name: 'Housing', primary_unit: null },
        },
      ],
    }) as unknown as QuoteWithRelations;

  const open = (q: QuoteWithRelations) =>
    render(wrap(<ConvertToJobModal open onClose={vi.fn()} onConverted={vi.fn()} quote={q} />));

  it('shows one quote-level lead time when no line carries its own', async () => {
    open(twoParts(null, null, '4 weeks ARO'));

    await waitFor(() => expect(screen.getByText(/quoted lead time/i)).toBeInTheDocument());
    expect(screen.getByText('4 weeks ARO')).toBeInTheDocument();
    expect(screen.queryByText(/^Lead time:/)).not.toBeInTheDocument();
  });

  it('suppresses the single value and shows each part’s own when they differ', async () => {
    open(twoParts('2–3 weeks', '6–8 weeks', '4 weeks ARO'));

    await waitFor(() => expect(screen.getByText(/Lead time: 2–3 weeks/)).toBeInTheDocument());
    expect(screen.getByText(/Lead time: 6–8 weeks/)).toBeInTheDocument();
    // The header value would contradict the per-part rows, so it goes.
    expect(screen.queryByText(/quoted lead time/i)).not.toBeInTheDocument();
  });

  it('falls back to the quote-level value for a part that has none of its own', async () => {
    open(twoParts('2–3 weeks', null, '4 weeks ARO'));

    await waitFor(() => expect(screen.getByText(/Lead time: 2–3 weeks/)).toBeInTheDocument());
    expect(screen.getByText(/Lead time: 4 weeks ARO/)).toBeInTheDocument();
  });

  it('warns that one job carries one due date when the included parts differ', async () => {
    open(twoParts('2–3 weeks', '6–8 weeks', '4 weeks ARO'));

    await waitFor(() =>
      expect(screen.getByText(/quoted with different lead times/i)).toBeInTheDocument(),
    );
    expect(screen.getByText(/2–3 weeks, 6–8 weeks/)).toBeInTheDocument();
  });

  it('drops the warning once the differing part is excluded from this job', async () => {
    open(twoParts('2–3 weeks', '6–8 weeks', '4 weeks ARO'));

    await waitFor(() =>
      expect(screen.getByText(/quoted with different lead times/i)).toBeInTheDocument(),
    );

    // Unchecking Housing leaves one lead time on this job, so the caveat about
    // a single due date no longer applies.
    await userEvent.click(screen.getByRole('checkbox', { name: /include housing/i }));

    await waitFor(() =>
      expect(screen.queryByText(/quoted with different lead times/i)).not.toBeInTheDocument(),
    );
  });
});
