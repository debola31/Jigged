import StatusChip from '@/components/common/StatusChip';
import type { QuoteStatus } from '@/types/quote';
import { QUOTE_STATUS_CONFIG } from '@/types/quote';

interface QuoteStatusChipProps {
  status: QuoteStatus;
  /**
   * When the quote was converted to a job, if it was. Pass it and the chip says
   * **Converted**; leave it out and the chip falls back to the raw column value.
   *
   * Worth passing wherever it is to hand. `quotes.status` only holds
   * `active | expired` — winning a quote sets `converted_at` and leaves the
   * status alone — so an already-won quote otherwise reads "Active" forever,
   * which is the same confusion that made the dashboard's Open Quotes tile
   * count work the shop had already won.
   */
  convertedAt?: string | null;
  size?: 'small' | 'medium';
}

export default function QuoteStatusChip({ status, convertedAt, size = 'small' }: QuoteStatusChipProps) {
  // Converted beats the column: it is the more specific truth about the quote,
  // and it is the word the list's Status filter uses for the same set.
  const config = convertedAt
    ? { label: 'Converted', color: 'success' as const }
    : QUOTE_STATUS_CONFIG[status] || { label: status, color: 'default' as const };

  return (
    <StatusChip label={config.label} color={config.color} size={size} sx={{ fontWeight: 500 }} />
  );
}
