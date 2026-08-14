import { describe, it, expect } from 'vitest';
import { render, screen } from '../../test-utils';
import QuoteStatusChip from '@/components/quotes/QuoteStatusChip';

/**
 * What a quote's chip says, which is not what `quotes.status` stores.
 *
 * The column holds `active | expired` only; winning a quote sets `converted_at`
 * and leaves the status alone. So the raw value cannot tell "still chasing it"
 * from "already won it", and rendering it directly labelled a converted quote
 * "Active" forever — the same confusion that had the dashboard's Open Quotes
 * tile counting work the shop had already won (25 shown against 11 live on the
 * pilot shop, 9 against 1 on demo companies).
 *
 * These three words are the ones the quotes list's Status filter uses, so the
 * chip and the filter cannot drift apart.
 */
describe('QuoteStatusChip', () => {
  it('says Open for a live quote', () => {
    render(<QuoteStatusChip status="active" convertedAt={null} />);
    expect(screen.getByText('Open')).toBeInTheDocument();
  });

  it('says Converted once it has become a job', () => {
    render(<QuoteStatusChip status="active" convertedAt="2026-08-01T10:00:00Z" />);

    expect(screen.getByText('Converted')).toBeInTheDocument();
    // Converted beats the column: it is the more specific truth, and the status
    // is still literally 'active' on this row.
    expect(screen.queryByText('Open')).not.toBeInTheDocument();
  });

  it('says Expired regardless', () => {
    render(<QuoteStatusChip status="expired" convertedAt={null} />);
    expect(screen.getByText('Expired')).toBeInTheDocument();
  });

  it('falls back to the column when conversion is not passed', () => {
    // Some call sites read a narrower row shape that has no converted_at. They
    // degrade to the old behaviour rather than claiming a quote is open.
    render(<QuoteStatusChip status="active" />);
    expect(screen.getByText('Open')).toBeInTheDocument();
  });
});
