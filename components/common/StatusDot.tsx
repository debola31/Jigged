'use client';

import { forwardRef } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import type { StatusChipColor } from './StatusChip';

export interface StatusDotProps {
  label: string;
  /** Same semantic palette key [`StatusChip`](./StatusChip.tsx) takes, so the two agree on colour. */
  color?: StatusChipColor;
  className?: string;
}

/**
 * Status as a small semantic dot plus its plain label — the LIST form of
 * [`StatusChip`](./StatusChip.tsx), taking the same `label` + `color` so the two
 * can never disagree about what green means.
 *
 * **Why a dot and not a pill, in a list.** A filled pill is a button-shaped
 * object: on a grid it appears once per row, a dozen times down a page, on rows
 * where the actual click target is the row itself. It reads as something to
 * press and it stops the eye at every line. A 7px dot says the same thing and
 * asks for nothing.
 *
 * **The label is not decoration — it is the second encoding, and it is the
 * point.** The hue is the shortcut for someone scanning; the word is what
 * survives when the hue does not land. Roughly one man in twelve has some
 * red-green deficiency, and these lists are read almost entirely by men over
 * fifty, often under shop lighting. A colour-only treatment was the quietest
 * option considered and was rejected on exactly this: it puts the whole meaning
 * in hue with nothing to fall back on, and grey "Not Started" against grey-blue
 * "Partially Shipped" already blurs.
 *
 * **`default` renders HOLLOW**, mirroring StatusChip's outlined neutral: an
 * "off" state should not carry the same visual weight as a live one.
 *
 * Chips still belong on DETAIL surfaces, where one status is the subject of the
 * screen rather than one cell in a scan.
 */
const StatusDot = forwardRef<HTMLDivElement, StatusDotProps>(function StatusDot(
  { label, color = 'default', className },
  ref,
) {
  const neutral = color === 'default';
  return (
    <Box
      ref={ref}
      className={className}
      sx={{ display: 'inline-flex', alignItems: 'center', gap: 1, minWidth: 0 }}
    >
      <Box
        // Presentational: the label beside it already names the state, so a
        // screen reader announcing a bullet would only add noise.
        aria-hidden
        sx={{
          width: 7,
          height: 7,
          borderRadius: '50%',
          flexShrink: 0,
          ...(neutral
            ? { boxShadow: (t) => `inset 0 0 0 1.5px ${t.palette.text.disabled}` }
            : { bgcolor: `${color}.main` }),
        }}
      />
      <Typography
        variant="body2"
        sx={{ whiteSpace: 'nowrap', color: neutral ? 'text.secondary' : 'text.primary' }}
      >
        {label}
      </Typography>
    </Box>
  );
});

export default StatusDot;
