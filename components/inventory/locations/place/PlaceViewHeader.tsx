'use client';

/**
 * The one header every view inside the place drawer wears.
 *
 * The drawer swaps its whole body between the overview and the four verbs, so the thing that stays
 * constant has to be the way back. One component means back is always in the same place, always the
 * same size, and a new view cannot forget to offer it — which is how the old `Manage` sheet ended up
 * covering the cabinet it was acting on with no obvious way out.
 *
 * 48px, like every other target in this module.
 */

import Box from '@mui/material/Box';
import IconButton from '@mui/material/IconButton';
import Typography from '@mui/material/Typography';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';

export interface PlaceViewHeaderProps {
  title: string;
  /** Where you are. Rendered small under the title; usually the place's name or path. */
  subtitle?: string;
  /** Omit on the drawer's root view, which has nothing behind it to go back to. */
  onBack?: () => void;
  /** Trailing control — the drawer's Close. Inside the header so ONE element owns the row. */
  action?: React.ReactNode;
}

export default function PlaceViewHeader({
  title,
  subtitle,
  onBack,
  action,
}: PlaceViewHeaderProps) {
  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 1,
        px: onBack ? 1 : 2,
        py: 1.5,
        // Sticky so a long contents list or a 40-row count never scrolls the way out off screen.
        position: 'sticky',
        top: 0,
        zIndex: 2,
        /*
         * `background.default`, NOT `background.paper`.
         *
         * Paper is `rgba(32, 38, 82, 0.78)` — deliberately translucent, because a card is meant to
         * let the lit canvas through. A sticky header has rows scrolling underneath it, so it has
         * to be opaque or the count you are typing shows through the heading. `default` is
         * `#111439`, which is also the drawer paper's top gradient stop, so the header reads as
         * part of the drawer rather than as a band laid over it.
         */
        bgcolor: 'background.default',
        borderBottom: '1px solid',
        borderColor: 'divider',
      }}
    >
      {onBack && (
        <IconButton aria-label="Back" onClick={onBack} sx={{ width: 48, height: 48 }}>
          <ArrowBackIcon />
        </IconButton>
      )}
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography variant="subtitle1" sx={{ fontWeight: 700, lineHeight: 1.2 }} noWrap>
          {title}
        </Typography>
        {subtitle && (
          <Typography variant="body2" color="text.secondary" noWrap title={subtitle}>
            {subtitle}
          </Typography>
        )}
      </Box>
      {action}
    </Box>
  );
}
