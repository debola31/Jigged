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
  /** Alert tone — red-tinted; used for overdue > 0. */
  severity?: 'normal' | 'alert';
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
  const isAlert = severity === 'alert';

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
  const deltaColor =
    direction === 'flat' ? 'text.secondary' : direction === 'up' ? 'success.main' : 'error.main';
  const DeltaIcon =
    direction === 'flat' ? ArrowRightAltIcon : direction === 'up' ? ArrowUpwardIcon : ArrowDownwardIcon;

  const cardSx = {
    height: '100%',
    borderLeft: isAlert ? 3 : 0,
    borderColor: isAlert ? 'error.main' : 'transparent',
    bgcolor: isAlert ? 'rgba(239, 68, 68, 0.08)' : 'background.paper',
  };

  const inner = (
    <Box sx={{ p: 2.5, minHeight: 128, display: 'flex', flexDirection: 'column', gap: 0.5 }}>
      <Typography
        variant="body2"
        sx={{
          fontWeight: 500,
          color: isAlert ? 'error.main' : 'text.secondary',
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
            color: isAlert ? 'error.main' : 'text.primary',
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
              sx={{ fontWeight: 600, color: isAlert ? 'error.main' : 'text.primary' }}
            >
              {formatMoney(money.amount)}
            </Typography>
            <Typography variant="caption" sx={{ color: 'text.secondary' }}>
              {money.label}
            </Typography>
            {hasDelta && (
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.25, color: deltaColor }}>
                <DeltaIcon sx={{ fontSize: 14 }} />
                <Typography variant="caption" sx={{ fontWeight: 600 }}>
                  {pct !== null && delta !== 0 ? formatPercent(pct) : formatMoney(delta)}
                </Typography>
                {money.comparisonLabel && (
                  <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                    {money.comparisonLabel}
                  </Typography>
                )}
              </Box>
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
