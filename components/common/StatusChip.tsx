'use client';

import { forwardRef } from 'react';
import Chip, { type ChipProps } from '@mui/material/Chip';

export type StatusChipColor = NonNullable<ChipProps['color']>;

export interface StatusChipProps extends Omit<ChipProps, 'variant' | 'color'> {
  /** Semantic status color. `default` (the neutral fallback) renders outlined. */
  color?: StatusChipColor;
}

/**
 * The standard status / state indicator chip. ONE variant rule, enforced here so
 * it can't drift across the app:
 *
 *   - a SEMANTIC color (info / success / warning / error / primary / secondary)
 *     renders FILLED — it draws the eye (Active, Connected, Trial, Overdue…);
 *   - the neutral `default` color renders OUTLINED — de-emphasized for "off"
 *     states (No subscription, Not connected, Not set up).
 *
 * Always `size="small"` by default. Use this for any on/off/lifecycle status
 * badge instead of a raw <Chip variant=…>. Forwards a ref so it works inside
 * Tooltip and other ref-requiring wrappers. See docs/design-system.md →
 * "Status Badges".
 */
const StatusChip = forwardRef<HTMLDivElement, StatusChipProps>(function StatusChip(
  { color = 'default', size = 'small', ...rest },
  ref,
) {
  return (
    <Chip
      ref={ref}
      color={color}
      size={size}
      variant={color === 'default' ? 'outlined' : 'filled'}
      {...rest}
    />
  );
});

export default StatusChip;
