'use client';

import { useState } from 'react';
import Accordion from '@mui/material/Accordion';
import AccordionSummary from '@mui/material/AccordionSummary';
import AccordionDetails from '@mui/material/AccordionDetails';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import Typography from '@mui/material/Typography';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import Skeleton from '@mui/material/Skeleton';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import DescriptionOutlinedIcon from '@mui/icons-material/DescriptionOutlined';
import WorkOutlineIcon from '@mui/icons-material/WorkOutline';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutline';
import LocalShippingOutlinedIcon from '@mui/icons-material/LocalShippingOutlined';
import type { ActivityItem } from '@/utils/dashboardAccess';

const STORAGE_KEY = 'jigged-recent-activity-expanded';

interface RecentActivityProps {
  activities: ActivityItem[];
  loading?: boolean;
}

/**
 * Format a timestamp as a relative time string
 */
function formatRelativeTime(timestamp: string): string {
  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSeconds = Math.floor(diffMs / 1000);
  const diffMinutes = Math.floor(diffSeconds / 60);
  const diffHours = Math.floor(diffMinutes / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffSeconds < 60) {
    return 'just now';
  } else if (diffMinutes < 60) {
    return `${diffMinutes}m ago`;
  } else if (diffHours < 24) {
    return `${diffHours}h ago`;
  } else if (diffDays === 1) {
    return 'yesterday';
  } else if (diffDays < 7) {
    return `${diffDays}d ago`;
  } else {
    return date.toLocaleDateString();
  }
}

/**
 * Get icon and color for activity type
 */
function getActivityIcon(type: 'quote' | 'job', action: string) {
  if (type === 'quote') {
    return {
      icon: DescriptionOutlinedIcon,
      color: 'primary.main',
    };
  }

  switch (action) {
    case 'created':
      return { icon: WorkOutlineIcon, color: 'primary.main' };
    case 'started':
      return { icon: PlayArrowIcon, color: 'info.main' };
    case 'completed':
      return { icon: CheckCircleOutlineIcon, color: 'success.main' };
    case 'shipped':
      return { icon: LocalShippingOutlinedIcon, color: 'secondary.main' };
    default:
      return { icon: WorkOutlineIcon, color: 'text.secondary' };
  }
}

/**
 * Format the activity action text
 */
function formatActionText(
  type: 'quote' | 'job',
  action: string,
  customerName?: string
): string {
  const entityType = type === 'quote' ? 'Quote' : 'Job';

  switch (action) {
    case 'created':
      return customerName
        ? `${entityType} created for ${customerName}`
        : `${entityType} created`;
    case 'started':
      return 'Work started';
    case 'completed':
      return 'Marked complete';
    case 'shipped':
      return customerName ? `Shipped to ${customerName}` : 'Shipped';
    default:
      return action;
  }
}

/**
 * Recent activity feed component.
 * Uses an Accordion with a summary strip showing title, count, and a
 * preview of the most recent activity when collapsed.
 */
export default function RecentActivity({
  activities,
  loading = false,
}: RecentActivityProps) {
  const [expanded, setExpanded] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    try {
      return localStorage.getItem(STORAGE_KEY) === 'true';
    } catch {
      return false;
    }
  });

  const handleChange = (_event: React.SyntheticEvent, isExpanded: boolean) => {
    setExpanded(isExpanded);
    try {
      localStorage.setItem(STORAGE_KEY, String(isExpanded));
    } catch {
      // Silently fail if localStorage is unavailable
    }
  };

  const itemCount = loading ? 0 : activities.length;
  const latestActivity = !loading && activities.length > 0 ? activities[0] : null;

  return (
    <Accordion
      expanded={expanded}
      onChange={handleChange}
      elevation={2}
      disableGutters
      sx={{
        bgcolor: 'rgba(26, 31, 74, 0.55)',
        backdropFilter: 'blur(15px)',
        WebkitBackdropFilter: 'blur(15px)',
        border: '1px solid rgba(255, 255, 255, 0.15)',
        borderRadius: '8px !important',
        '&:before': { display: 'none' },
        transition: 'transform 0.2s ease, box-shadow 0.2s ease',
        '&:hover': {
          transform: 'translateY(-2px)',
        },
      }}
    >
      <AccordionSummary
        expandIcon={
          loading ? (
            <Skeleton variant="circular" width={24} height={24} />
          ) : (
            <ExpandMoreIcon sx={{ color: 'text.secondary' }} />
          )
        }
        sx={{
          minHeight: 64,
          '& .MuiAccordionSummary-content': {
            alignItems: 'center',
            gap: 1.5,
            overflow: 'hidden',
          },
        }}
      >
        <Typography variant="h6" sx={{ flexShrink: 0 }}>
          Recent Activity
        </Typography>
        {!loading && (
          <Chip
            label={itemCount}
            size="small"
            variant="outlined"
            color="primary"
            sx={{ flexShrink: 0 }}
          />
        )}
        {!expanded && latestActivity && (
          <Typography
            variant="body2"
            color="text.secondary"
            noWrap
            sx={{ flex: 1, ml: 0.5 }}
          >
            {latestActivity.entityNumber} &mdash;{' '}
            {formatActionText(
              latestActivity.type,
              latestActivity.action,
              latestActivity.customerName
            )}
            , {formatRelativeTime(latestActivity.timestamp)}
          </Typography>
        )}
      </AccordionSummary>

      <AccordionDetails sx={{ pt: 0, px: 2, pb: 2 }}>
        {loading ? (
          <List disablePadding>
            {[1, 2, 3, 4, 5].map((i) => (
              <ListItem key={i} disableGutters sx={{ py: 1 }}>
                <ListItemIcon sx={{ minWidth: 40 }}>
                  <Skeleton variant="circular" width={24} height={24} />
                </ListItemIcon>
                <ListItemText
                  primary={<Skeleton variant="text" width="60%" />}
                  secondary={<Skeleton variant="text" width="40%" />}
                />
              </ListItem>
            ))}
          </List>
        ) : activities.length === 0 ? (
          <Box sx={{ py: 4, textAlign: 'center' }}>
            <Typography variant="body2" color="text.secondary">
              No recent activity.
            </Typography>
          </Box>
        ) : (
          <List disablePadding>
            {activities.map((activity) => {
              const { icon: Icon, color } = getActivityIcon(
                activity.type,
                activity.action
              );

              return (
                <ListItem
                  key={activity.id}
                  disableGutters
                  sx={{
                    py: 1,
                    borderBottom: '1px solid rgba(255, 255, 255, 0.05)',
                    '&:last-child': { borderBottom: 'none' },
                  }}
                >
                  <ListItemIcon sx={{ minWidth: 40 }}>
                    <Icon sx={{ color, fontSize: 20 }} />
                  </ListItemIcon>
                  <ListItemText
                    primary={
                      <Box
                        sx={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 1,
                        }}
                      >
                        <Typography
                          variant="body2"
                          component="span"
                          sx={{ fontWeight: 600 }}
                        >
                          {activity.entityNumber}
                        </Typography>
                        <Typography
                          variant="body2"
                          component="span"
                          color="text.secondary"
                        >
                          {formatActionText(
                            activity.type,
                            activity.action,
                            activity.customerName
                          )}
                        </Typography>
                      </Box>
                    }
                    secondary={
                      <Typography variant="caption" color="text.secondary">
                        {formatRelativeTime(activity.timestamp)}
                      </Typography>
                    }
                  />
                </ListItem>
              );
            })}
          </List>
        )}
      </AccordionDetails>
    </Accordion>
  );
}
