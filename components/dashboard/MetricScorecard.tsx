'use client';

import Link from 'next/link';
import Card from '@mui/material/Card';
import CardActionArea from '@mui/material/CardActionArea';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Skeleton from '@mui/material/Skeleton';
import ArrowUpwardIcon from '@mui/icons-material/ArrowUpward';
import ArrowDownwardIcon from '@mui/icons-material/ArrowDownward';
import ArrowRightAltIcon from '@mui/icons-material/ArrowRightAlt';

export interface MetricScorecardProps {
  label: string;
  periodSuffix?: string; // e.g. "this week", "today" — rendered under the label
  value: number;
  format: 'number' | 'currency';
  previousValue?: number;
  comparisonLabel?: string; // e.g. "vs last week"
  href?: string;
  /** Alert tone — turns the card red-tinted; used for overdue > 0. */
  severity?: 'normal' | 'alert';
  loading?: boolean;
}

function formatValue(value: number, format: 'number' | 'currency'): string {
  if (format === 'currency') {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(value);
  }
  return value.toLocaleString();
}

function formatDelta(delta: number, format: 'number' | 'currency'): string {
  const sign = delta > 0 ? '+' : delta < 0 ? '-' : '';
  const abs = Math.abs(delta);
  if (format === 'currency') {
    return `${sign}${new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(abs)}`;
  }
  return `${sign}${abs.toLocaleString()}`;
}

function formatPercent(pct: number): string {
  const sign = pct > 0 ? '+' : pct < 0 ? '-' : '';
  return `${sign}${Math.round(Math.abs(pct))}%`;
}

export default function MetricScorecard({
  label,
  periodSuffix,
  value,
  format,
  previousValue,
  comparisonLabel,
  href,
  severity = 'normal',
  loading = false,
}: MetricScorecardProps) {
  const isAlert = severity === 'alert';

  const hasDelta = previousValue !== undefined;
  const delta = hasDelta ? value - (previousValue as number) : 0;
  const pct = hasDelta && (previousValue as number) !== 0
    ? (delta / (previousValue as number)) * 100
    : null;
  const deltaDirection: 'up' | 'down' | 'flat' = delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat';
  const deltaColor =
    deltaDirection === 'flat' ? 'text.secondary' : deltaDirection === 'up' ? 'success.main' : 'error.main';
  const DeltaIcon =
    deltaDirection === 'flat'
      ? ArrowRightAltIcon
      : deltaDirection === 'up'
        ? ArrowUpwardIcon
        : ArrowDownwardIcon;

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
        }}
      >
        {label}
      </Typography>
      {periodSuffix && (
        <Typography variant="caption" sx={{ color: 'text.secondary', mt: -0.25 }}>
          {periodSuffix}
        </Typography>
      )}
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
          {formatValue(value, format)}
        </Typography>
      )}
      <Box sx={{ mt: 'auto', minHeight: 20 }}>
        {!loading && hasDelta && (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, color: deltaColor }}>
            <DeltaIcon sx={{ fontSize: 16 }} />
            <Typography variant="caption" sx={{ fontWeight: 600 }}>
              {formatDelta(delta, format)}
              {pct !== null && delta !== 0 && ` (${formatPercent(pct)})`}
            </Typography>
            {comparisonLabel && (
              <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                {comparisonLabel}
              </Typography>
            )}
          </Box>
        )}
      </Box>
    </Box>
  );

  if (href && !loading) {
    return (
      <Card elevation={2} sx={cardSx}>
        <CardActionArea component={Link} href={href} sx={{ height: '100%' }}>
          {inner}
        </CardActionArea>
      </Card>
    );
  }

  return (
    <Card elevation={2} sx={cardSx}>
      {inner}
    </Card>
  );
}
