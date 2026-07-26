import StatusChip from '@/components/common/StatusChip';
import type { QuoteStatus } from '@/types/quote';
import { QUOTE_STATUS_CONFIG } from '@/types/quote';

interface QuoteStatusChipProps {
  status: QuoteStatus;
  size?: 'small' | 'medium';
}

export default function QuoteStatusChip({ status, size = 'small' }: QuoteStatusChipProps) {
  const config = QUOTE_STATUS_CONFIG[status] || { label: status, color: 'default' as const };

  return (
    <StatusChip label={config.label} color={config.color} size={size} sx={{ fontWeight: 500 }} />
  );
}
