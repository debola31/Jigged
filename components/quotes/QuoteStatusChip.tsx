import StatusChip, { type StatusChipColor } from '@/components/common/StatusChip';
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

/**
 * What a quote's status READS as, independent of how it is drawn.
 *
 * Extracted so the chip (detail surfaces) and the dot (the quotes list) resolve
 * it once. The "converted beats the column" rule above is the whole reason this
 * cannot be inlined at each call site -- a second copy would eventually keep
 * saying "Active" about a quote the shop had already won, which is the exact bug
 * it exists to prevent.
 */
export function resolveQuoteStatus(
  status: QuoteStatus,
  convertedAt?: string | null,
): { label: string; color: StatusChipColor } {
  if (convertedAt) return { label: 'Converted', color: 'success' };
  return QUOTE_STATUS_CONFIG[status] || { label: status, color: 'default' };
}

export default function QuoteStatusChip({ status, convertedAt, size = 'small' }: QuoteStatusChipProps) {
  const config = resolveQuoteStatus(status, convertedAt);
  return (
    <StatusChip label={config.label} color={config.color} size={size} sx={{ fontWeight: 500 }} />
  );
}
