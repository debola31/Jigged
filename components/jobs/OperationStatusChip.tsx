import StatusChip from '@/components/common/StatusChip';
import type { OperationStatus } from '@/types/job';
import { OPERATION_STATUS_CONFIG } from '@/types/job';

interface OperationStatusChipProps {
  status: OperationStatus;
  size?: 'small' | 'medium';
}

export default function OperationStatusChip({ status, size = 'small' }: OperationStatusChipProps) {
  const config = OPERATION_STATUS_CONFIG[status] || { label: status, color: 'default' as const };

  return (
    <StatusChip label={config.label} color={config.color} size={size} sx={{ fontWeight: 500 }} />
  );
}
