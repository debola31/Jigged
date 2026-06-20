'use client';

import Chip from '@mui/material/Chip';
import Tooltip from '@mui/material/Tooltip';
import type { PartSetupStatus } from './partSetupStatus';

/**
 * Colour-coded "how set up is this part?" chip for the sticky header.
 *
 * Colour comes straight from the theme palette key on the status
 * (`success` / `info` / `warning`) — never a hardcoded hex — so the visual
 * cue tracks the design system. The tooltip carries the actionable next step.
 */
export default function PartCompletenessChip({ status }: { status: PartSetupStatus }) {
  const chip = (
    <Chip
      label={status.label}
      color={status.color}
      size="small"
      // Ready is a quiet confirmation; the action-needed states are emphasised.
      variant={status.state === 'ready' ? 'outlined' : 'filled'}
      sx={{ fontWeight: 600 }}
    />
  );

  return status.nextStep ? (
    <Tooltip title={status.nextStep}>{chip}</Tooltip>
  ) : (
    chip
  );
}
