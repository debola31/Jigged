'use client';

import type { ReactNode } from 'react';
import Box from '@mui/material/Box';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';

import { formatAbsoluteTime, formatRelativeTime } from '@/components/dashboard/activityFormat';

/** What a row is about, which is all the dot encodes. */
export type JobActivityRowTone = 'done' | 'vendor' | 'note' | 'muted';

const DOT_COLOUR: Record<JobActivityRowTone, string> = {
  done: 'success.main',
  vendor: 'primary.light',
  note: 'text.secondary',
  muted: 'text.disabled',
};

/**
 * The shared chrome for one rail row: a tone dot, a title line with a relative
 * timestamp, and whatever the row wants underneath.
 *
 * ONE OBJECT, not three near-identical ones. The three row kinds differ in what
 * they say, never in how they sit — same dot column, same baseline, same
 * padding — so the layout lives here and the kinds supply content.
 *
 * The timestamp is RELATIVE with the absolute date in its tooltip, matching
 * every other office activity list (components/dashboard/activityFormat.tsx).
 * The operator feed prints absolute times instead; that is a phone standing at a
 * machine wanting to know the clock time, not an office scanning a history.
 */
export default function JobActivityRow({
  tone,
  title,
  meta,
  at,
  struck = false,
  children,
}: {
  tone: JobActivityRowTone;
  title: ReactNode;
  /** The second line — who, how many, which step. */
  meta?: ReactNode;
  at: string;
  /** Voided: the row happened and no longer counts. Never hidden. */
  struck?: boolean;
  children?: ReactNode;
}) {
  return (
    <Box
      sx={{
        display: 'grid',
        gridTemplateColumns: '14px 1fr',
        gap: 1.25,
        py: 1.25,
      }}
    >
      <Box sx={{ pt: 0.75 }}>
        <Box
          sx={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            mx: 'auto',
            bgcolor: DOT_COLOUR[tone],
            // An outline ring rather than a fill for a row that no longer
            // counts, so "voided" reads at the dot as well as in the text.
            ...(struck ? { bgcolor: 'transparent', border: '1.5px solid', borderColor: 'text.disabled' } : {}),
          }}
        />
      </Box>

      <Box sx={{ minWidth: 0 }}>
        <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1 }}>
          <Typography
            variant="body2"
            sx={{
              fontWeight: 600,
              color: struck ? 'text.disabled' : 'text.primary',
              textDecoration: struck ? 'line-through' : 'none',
              minWidth: 0,
            }}
          >
            {title}
          </Typography>
          <Tooltip title={formatAbsoluteTime(at)}>
            <Typography
              variant="caption"
              component="time"
              dateTime={at}
              sx={{ color: 'text.disabled', ml: 'auto', flexShrink: 0, whiteSpace: 'nowrap' }}
            >
              {formatRelativeTime(at)}
            </Typography>
          </Tooltip>
        </Box>

        {meta ? (
          <Typography variant="caption" component="div" sx={{ color: 'text.secondary', mt: 0.25 }}>
            {meta}
          </Typography>
        ) : null}

        {children}
      </Box>
    </Box>
  );
}
