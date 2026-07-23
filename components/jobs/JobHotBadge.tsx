'use client';

import Chip from '@mui/material/Chip';
import Tooltip from '@mui/material/Tooltip';
import LocalFireDepartmentIcon from '@mui/icons-material/LocalFireDepartment';

interface JobHotBadgeProps {
  /** Only `is_hot` is needed; accepts any object carrying it (Job, traveler, operator row). */
  job: { is_hot?: boolean | null };
  size?: 'small' | 'medium';
  /**
   * Render the quieter "was hot" treatment for a job whose work is done
   * (completed/cancelled). Priority is a property of PENDING work — once a job
   * closes, the rush is spent, so we keep the badge as history but drop it out
   * of the loud "needs attention now" register (outlined, not solid). Callers
   * pass their own notion of done: isJobClosed() on the admin side, terminal
   * production_status on the operator side.
   */
  muted?: boolean;
}

/**
 * The digital "HOT" (rush) badge — the paperless equivalent of Contour's pink
 * paper / "HOT" in red pen at the top of a traveler. Renders nothing unless the
 * job is hot.
 *
 * Deliberately distinct from JobOverdueBadge (also color="error"): the active
 * badge is a SOLID/filled red chip with a flame icon and uppercase "HOT", so the
 * two read as different signals when they appear side by side. When `muted`, it
 * drops to an outlined chip — still recognizably the hot signal, but reading as
 * "this was a rush" rather than "prioritize this now".
 */
export default function JobHotBadge({ job, size = 'small', muted = false }: JobHotBadgeProps) {
  if (!job.is_hot) return null;

  return (
    <Tooltip title={muted ? 'This was a Hot (rush) job.' : 'Hot job — rush. Prioritize this work.'}>
      <Chip
        icon={<LocalFireDepartmentIcon sx={{ fontSize: size === 'medium' ? 20 : 16 }} />}
        label="HOT"
        size={size}
        color="error"
        variant={muted ? 'outlined' : 'filled'}
        sx={{ fontWeight: muted ? 500 : 700, letterSpacing: 0.5, opacity: muted ? 0.85 : 1 }}
      />
    </Tooltip>
  );
}
