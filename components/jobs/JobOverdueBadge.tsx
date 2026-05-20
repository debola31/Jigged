'use client';

import Chip from '@mui/material/Chip';
import Tooltip from '@mui/material/Tooltip';
import ScheduleIcon from '@mui/icons-material/Schedule';
import { isJobOverdue } from '@/types/job';
import type { Job } from '@/types/job';

interface JobOverdueBadgeProps {
  job: Pick<Job, 'due_date' | 'production_status' | 'fulfillment_status'>;
  size?: 'small' | 'medium';
}

export default function JobOverdueBadge({ job, size = 'small' }: JobOverdueBadgeProps) {
  if (!isJobOverdue(job)) return null;

  const dueDate = job.due_date ? new Date(job.due_date).toLocaleDateString() : '—';

  return (
    <Tooltip title={`Was due ${dueDate}`}>
      <Chip
        icon={<ScheduleIcon sx={{ fontSize: size === 'medium' ? 18 : 14 }} />}
        label="Overdue"
        size={size}
        color="error"
        sx={{ fontWeight: 600 }}
      />
    </Tooltip>
  );
}
