'use client';

import Chip from '@mui/material/Chip';
import Tooltip from '@mui/material/Tooltip';
import LocalFireDepartmentIcon from '@mui/icons-material/LocalFireDepartment';

interface JobHotBadgeProps {
  /** Only `is_hot` is needed; accepts any object carrying it (Job, traveler, operator row). */
  job: { is_hot?: boolean | null };
  size?: 'small' | 'medium';
}

/**
 * The digital "HOT" (rush) badge — the paperless equivalent of Contour's pink
 * paper / "HOT" in red pen at the top of a traveler. Renders nothing unless the
 * job is hot.
 *
 * Deliberately distinct from JobOverdueBadge (also color="error"): this one is a
 * SOLID/filled red chip with a flame icon and uppercase "HOT", so the two read
 * as different signals when they appear side by side.
 */
export default function JobHotBadge({ job, size = 'small' }: JobHotBadgeProps) {
  if (!job.is_hot) return null;

  return (
    <Tooltip title="Hot job — rush. Prioritize this work.">
      <Chip
        icon={<LocalFireDepartmentIcon sx={{ fontSize: size === 'medium' ? 20 : 16 }} />}
        label="HOT"
        size={size}
        color="error"
        variant="filled"
        sx={{ fontWeight: 700, letterSpacing: 0.5 }}
      />
    </Tooltip>
  );
}
