'use client';

import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import Typography from '@mui/material/Typography';
import CircularProgress from '@mui/material/CircularProgress';
import IconButton from '@mui/material/IconButton';
import Alert from '@mui/material/Alert';
import Chip from '@mui/material/Chip';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemText from '@mui/material/ListItemText';
import CloseIcon from '@mui/icons-material/Close';
import InsightChart from './InsightChart';
import type { InsightCard as InsightCardType } from '@/utils/insightsAccess';

interface InsightCardProps {
  insight: InsightCardType | null;
  loading?: boolean;
  /** Override card title (used for saved insights where title = question) */
  title?: string;
  /** Show × remove button */
  removable?: boolean;
  onRemove?: () => void;
}

const INSIGHT_LABELS: Record<string, string> = {
  revenue_trend: 'Revenue Trend',
  job_pipeline: 'Job Pipeline',
  quote_conversion: 'Quote Conversion',
  at_risk_jobs: 'At-Risk Jobs',
  inventory_alerts: 'Inventory Alerts',
};

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

function AlertList({ insight }: { insight: InsightCardType }) {
  const { type, metric_data } = insight;

  if (type === 'at_risk_jobs') {
    const jobs = (metric_data?.at_risk_jobs as Array<Record<string, unknown>>) || [];
    if (jobs.length === 0) {
      return (
        <Alert severity="success" sx={{ mb: 1 }}>
          No at-risk jobs detected.
        </Alert>
      );
    }
    return (
      <List dense disablePadding>
        {jobs.slice(0, 5).map((job, i) => (
          <ListItem key={i} disableGutters sx={{ py: 0.5 }}>
            <ListItemText
              primary={
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                  <Typography variant="body2" sx={{ fontWeight: 600 }}>
                    {String(job.job_number || '')}
                  </Typography>
                  <Chip
                    label={String(job.severity || 'unknown')}
                    size="small"
                    color={
                      job.severity === 'high'
                        ? 'error'
                        : job.severity === 'medium'
                          ? 'warning'
                          : 'default'
                    }
                    sx={{ height: 20, fontSize: '0.7rem' }}
                  />
                </Box>
              }
              secondary={`${String(job.customer_name || 'Unknown')} - ${Number(job.pct_complete || 0).toFixed(0)}% complete, ${Number(job.pct_time_elapsed || 0).toFixed(0)}% time elapsed`}
            />
          </ListItem>
        ))}
        {jobs.length > 5 && (
          <Typography variant="caption" color="text.secondary" sx={{ pl: 1 }}>
            +{jobs.length - 5} more
          </Typography>
        )}
      </List>
    );
  }

  if (type === 'inventory_alerts') {
    const alerts = (metric_data?.alerts as Array<Record<string, unknown>>) || [];
    if (alerts.length === 0) {
      return (
        <Alert severity="success" sx={{ mb: 1 }}>
          All inventory levels are above reorder points.
        </Alert>
      );
    }
    return (
      <List dense disablePadding>
        {alerts.slice(0, 5).map((alert, i) => (
          <ListItem key={i} disableGutters sx={{ py: 0.5 }}>
            <ListItemText
              primary={
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                  <Typography variant="body2" sx={{ fontWeight: 600 }}>
                    {String(alert.item_name || '')}
                  </Typography>
                  <Chip
                    label={String(alert.severity || 'unknown')}
                    size="small"
                    color={
                      alert.severity === 'critical'
                        ? 'error'
                        : alert.severity === 'high'
                          ? 'warning'
                          : 'default'
                    }
                    sx={{ height: 20, fontSize: '0.7rem' }}
                  />
                </Box>
              }
              secondary={`Qty: ${Number(alert.quantity || 0)} / Reorder: ${Number(alert.reorder_point || 0)} ${String(alert.unit || 'ea')}`}
            />
          </ListItem>
        ))}
        {alerts.length > 5 && (
          <Typography variant="caption" color="text.secondary" sx={{ pl: 1 }}>
            +{alerts.length - 5} more
          </Typography>
        )}
      </List>
    );
  }

  return null;
}

export default function InsightCard({
  insight,
  loading = false,
  title: titleOverride,
  removable = false,
  onRemove,
}: InsightCardProps) {
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

  const isAlertType = insight.type === 'at_risk_jobs' || insight.type === 'inventory_alerts';
  const title = titleOverride || INSIGHT_LABELS[insight.type] || insight.type;
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

      {/* Content: Chart or Alert List */}
      <Box sx={{ flex: 1, mb: 1.5, minHeight: 0 }}>
        {isAlertType ? (
          <AlertList insight={insight} />
        ) : insight.chart_config ? (
          <InsightChart chartConfig={insight.chart_config} height={200} />
        ) : (
          <Box
            sx={{
              height: 200,
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

      {/* Short Summary Phrase */}
      <Typography
        variant="body2"
        color="text.secondary"
        sx={{
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {insight.summary}
      </Typography>
    </Card>
  );
}
