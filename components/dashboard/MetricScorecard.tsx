'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import Card from '@mui/material/Card';
import CardActionArea from '@mui/material/CardActionArea';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Skeleton from '@mui/material/Skeleton';
import ArrowUpwardIcon from '@mui/icons-material/ArrowUpward';
import ArrowDownwardIcon from '@mui/icons-material/ArrowDownward';
import ArrowRightAltIcon from '@mui/icons-material/ArrowRightAlt';

/**
 * The money behind a metric's count.
 *
 * `label` says which KIND of money this is, not which slice of work it belongs
 * to — the card title already does that. It reads as one axis across the row:
 * "not yet shipped" for money committed but not earned, "shipped this week" for
 * money earned. A bare dollar figure on each card would flatten the two into one
 * apparent pot, and the first thing anyone does with several dollar figures on
 * one screen is add them up.
 */
export interface ScorecardMoney {
  amount: number;
  label: string;
  /** Prior-period amount; renders the delta chip. Completed only. */
  previousAmount?: number;
  comparisonLabel?: string;
}

export interface MetricScorecardProps {
  label: string;
  /** The count. Always the primary number: you act on jobs, not on dollars. */
  value: number;
  /**
   * Secondary money line. Omitted entirely when there is no honest figure
   * (Open Quotes) or when the viewer is not a company admin.
   */
  money?: ScorecardMoney;
  /** Third line, e.g. Open Jobs' "51 Not Started · 12 In Progress". */
  detail?: string;
  /** Rendered in the card's corner — the Completed card's period toggle. */
  action?: ReactNode;
  href?: string;
  /**
   * Attention tone — amber-tinted; used for overdue > 0.
   *
   * Amber rather than red on purpose. Andon is the convention the shop floor
   * already runs on — green running, amber behind, red stopped — and an overdue
   * job is behind, not broken. Red is kept for things that are actually wrong,
   * so that it still means something on the day one happens.
   */
  severity?: 'normal' | 'warning';
  loading?: boolean;
}

function formatMoney(value: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(value);
}

function formatPercent(pct: number): string {
  const sign = pct > 0 ? '+' : pct < 0 ? '-' : '';
  return `${sign}${Math.round(Math.abs(pct))}%`;
}

export default function MetricScorecard({
  label,
  value,
  money,
  detail,
  action,
  href,
  severity = 'normal',
  loading = false,
}: MetricScorecardProps) {
  const isAlert = severity === 'warning';

  // A delta against a zero prior period is not a comparison: the percentage is
  // undefined, and the absolute change just restates the headline figure — the
  // card ends up printing the same number twice, which reads as a bug.
  const hasDelta = money?.previousAmount !== undefined && money.previousAmount > 0;
  const delta = hasDelta ? money.amount - (money.previousAmount as number) : 0;
  const pct =
    hasDelta && (money.previousAmount as number) !== 0
      ? (delta / (money.previousAmount as number)) * 100
      : null;
  const direction: 'up' | 'down' | 'flat' = delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat';
  // error.light, not error.main: a falling delta is TEXT, and #ef4444 measures
  // 3.70:1 on the card background — under the 4.5:1 body floor. success.main
  // clears it at 5.48:1, so only the red needed raising.
  const deltaColor =
    direction === 'flat' ? 'text.secondary' : direction === 'up' ? 'success.main' : 'error.light';
  const DeltaIcon =
    direction === 'flat' ? ArrowRightAltIcon : direction === 'up' ? ArrowUpwardIcon : ArrowDownwardIcon;

  const cardSx = {
    height: '100%',
    borderLeft: isAlert ? 3 : 0,
    borderColor: isAlert ? 'warning.main' : 'transparent',
    // 8% amber over the canvas. The red tint this replaced went muddy purple
    // over deep indigo — neither red nor navy; amber stays neutral.
    bgcolor: isAlert ? 'rgba(245, 158, 11, 0.08)' : 'background.paper',
  };

  const inner = (
    <Box sx={{ p: 2.5, minHeight: 128, display: 'flex', flexDirection: 'column', gap: 0.5 }}>
      <Typography
        variant="body2"
        sx={{
          fontWeight: 500,
          color: isAlert ? 'warning.light' : 'text.secondary',
          textTransform: 'uppercase',
          letterSpacing: 0.4,
          fontSize: '0.7rem',
          // Room for the corner action, which is a sibling of the link rather
          // than a child of it (see below).
          pr: action ? 12 : 0,
        }}
      >
        {label}
      </Typography>

      {loading ? (
        <Skeleton variant="text" width={80} height={44} />
      ) : (
        <Typography
          variant="h4"
          sx={{
            fontWeight: 600,
            lineHeight: 1.1,
            color: isAlert ? 'warning.light' : 'text.primary',
            mt: 0.25,
          }}
        >
          {value.toLocaleString()}
        </Typography>
      )}

      <Box sx={{ mt: 'auto', minHeight: 20 }}>
        {!loading && money && (
          <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 0.75, flexWrap: 'wrap' }}>
            <Typography
              variant="body2"
              sx={{ fontWeight: 600, color: isAlert ? 'warning.light' : 'text.primary' }}
            >
              {formatMoney(money.amount)}
            </Typography>
            <Typography variant="caption" sx={{ color: 'text.secondary' }}>
              {money.label}
            </Typography>
            {/*
              Ordinary INLINE flow, not flex, and one flex item rather than
              several. Both halves of that matter:

              A nested flex container takes its baseline from its first item —
              here an SVG arrow, which has no text baseline, so the browser
              synthesises one from the icon's bottom edge and lifted the whole
              delta a few pixels above "$9,197". An inline element takes its
              baseline from its text, which is what we want it to sit on; the
              arrow is a glyph, not text, so it aligns itself against the line.

              Keeping it as ONE item stops the row breaking between "-37%" and
              "vs last week" — the card is a quarter of the width at 4-across,
              so this row does wrap, and it has to wrap as a phrase.
            */}
            {hasDelta && (
              <Typography
                variant="caption"
                component="span"
                sx={{ fontWeight: 600, color: deltaColor, whiteSpace: 'nowrap' }}
              >
                <DeltaIcon sx={{ fontSize: 14, verticalAlign: 'text-bottom', mr: 0.25 }} />
                {pct !== null && delta !== 0 ? formatPercent(pct) : formatMoney(delta)}
                {money.comparisonLabel && (
                  <Box
                    component="span"
                    sx={{ color: 'text.secondary', fontWeight: 400, ml: 0.5 }}
                  >
                    {money.comparisonLabel}
                  </Box>
                )}
              </Typography>
            )}
          </Box>
        )}
        {!loading && detail && (
          <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block' }}>
            {detail}
          </Typography>
        )}
      </Box>
    </Box>
  );

  // `action` is a SIBLING of the link, never a child of it. Nesting a toggle
  // inside CardActionArea makes every click on it also navigate away, which is
  // exactly what the Completed card's period control would do.
  return (
    <Card elevation={2} sx={{ ...cardSx, position: 'relative' }}>
      {action && (
        <Box sx={{ position: 'absolute', top: 10, right: 10, zIndex: 1 }}>{action}</Box>
      )}
      {href && !loading ? (
        <CardActionArea component={Link} href={href} sx={{ height: '100%' }}>
          {inner}
        </CardActionArea>
      ) : (
        inner
      )}
    </Card>
  );
}
