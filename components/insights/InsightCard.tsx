'use client';

import { useState, useEffect, useRef } from 'react';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import Typography from '@mui/material/Typography';
import CircularProgress from '@mui/material/CircularProgress';
import IconButton from '@mui/material/IconButton';
import CloseIcon from '@mui/icons-material/Close';
import InsightChart from './InsightChart';
import type { InsightCard as InsightCardType } from '@/utils/insightsAccess';

interface InsightCardProps {
  insight: InsightCardType | null;
  loading?: boolean;
  /** Card title — the saved insight's question. Absent only for the skeleton. */
  title?: string;
  /** Show × remove button */
  removable?: boolean;
  onRemove?: () => void;
  /** Chart height in pixels */
  chartHeight?: number;
}

function getTimeAgo(computedAt: string): string {
  const now = new Date();
  const computed = new Date(computedAt);
  const diffMs = now.getTime() - computed.getTime();
  const diffMinutes = Math.floor(diffMs / 60000);

  if (diffMinutes < 1) return 'just now';
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}

export default function InsightCard({
  insight,
  loading = false,
  title,
  removable = false,
  onRemove,
  chartHeight = 200,
}: InsightCardProps) {
  // Hooks must run in the same order on every render — declare them all
  // before any conditional return. The early-loading return below would
  // otherwise skip these hooks on the first render and break the order.
  const [expanded, setExpanded] = useState(false);
  const summaryRef = useRef<HTMLElement>(null);
  const [isClamped, setIsClamped] = useState(false);

  useEffect(() => {
    if (summaryRef.current) {
      setIsClamped(summaryRef.current.scrollHeight > summaryRef.current.clientHeight);
    }
  }, [insight?.summary]);

  if (loading || !insight) {
    return (
      <Card
        elevation={2}
        sx={{
          p: 2.5,
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          minHeight: 300,
        }}
      >
        <CircularProgress size={32} />
      </Card>
    );
  }

  const timeAgo = getTimeAgo(insight.computed_at);

  return (
    <Card
      elevation={2}
      sx={{
        p: 2.5,
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        position: 'relative',
      }}
    >
      {/* Remove Button */}
      {removable && onRemove && (
        <IconButton
          size="small"
          onClick={onRemove}
          aria-label="Remove insight"
          sx={{
            position: 'absolute',
            top: 8,
            right: 8,
            opacity: 0.4,
            '&:hover': { opacity: 1 },
          }}
        >
          <CloseIcon sx={{ fontSize: 16 }} />
        </IconButton>
      )}

      {/* Header */}
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1.5, pr: removable ? 3 : 0 }}>
        <Typography
          variant="subtitle1"
          sx={{
            fontWeight: 600,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {title}
        </Typography>
        <Typography variant="caption" color="text.secondary" sx={{ flexShrink: 0, ml: 1 }}>
          {timeAgo}
        </Typography>
      </Box>

      {/* Content */}
      <Box sx={{ flex: 1, mb: 1.5, minHeight: 0 }}>
        {insight.chart_config ? (
          <InsightChart chartConfig={insight.chart_config} height={chartHeight} />
        ) : (
          <Box
            sx={{
              height: chartHeight,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Typography variant="body2" color="text.secondary">
              No chart data available
            </Typography>
          </Box>
        )}
      </Box>

      {/* Summary */}
      <Typography
        ref={summaryRef}
        variant="body2"
        color="text.secondary"
        sx={expanded ? {} : {
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          display: '-webkit-box',
          WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical',
        }}
      >
        {insight.summary}
      </Typography>
      {(isClamped || expanded) && (
        <Typography
          variant="caption"
          color="primary.main"
          onClick={() => setExpanded(!expanded)}
          sx={{ cursor: 'pointer', mt: 0.5, display: 'block' }}
        >
          {expanded ? 'Show less' : 'Show more'}
        </Typography>
      )}
    </Card>
  );
}
