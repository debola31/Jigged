'use client';

import { useState } from 'react';
import Link from 'next/link';
import Accordion from '@mui/material/Accordion';
import AccordionSummary from '@mui/material/AccordionSummary';
import AccordionDetails from '@mui/material/AccordionDetails';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import Typography from '@mui/material/Typography';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import Skeleton from '@mui/material/Skeleton';
import Tooltip from '@mui/material/Tooltip';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import type { ActivityItem } from '@/utils/dashboardAccess';
import {
  formatRelativeTime,
  formatAbsoluteTime,
  getActivityVisual,
  formatActivityText,
} from './activityFormat';

const STORAGE_KEY = 'jigged-recent-activity-expanded';

interface RecentActivityProps {
  activities: ActivityItem[];
  loading?: boolean;
  /** When set, a "View all" link to the full activity page is shown. */
  viewAllHref?: string;
}

/** The inner content of one activity row (icon + entity + action + relative time). */
function ActivityRowContent({ activity }: { activity: ActivityItem }) {
  const { icon: Icon, color } = getActivityVisual(activity);
  return (
    <>
      <ListItemIcon sx={{ minWidth: 40 }}>
        <Icon sx={{ color, fontSize: 20 }} />
      </ListItemIcon>
      <ListItemText
        primary={
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            {activity.entityNumber && (
              <Typography variant="body2" component="span" sx={{ fontWeight: 600 }}>
                {activity.entityNumber}
              </Typography>
            )}
            <Typography variant="body2" component="span" color="text.secondary" noWrap>
              {formatActivityText(activity)}
            </Typography>
          </Box>
        }
        secondary={
          <Tooltip title={formatAbsoluteTime(activity.timestamp)}>
            <Typography variant="caption" color="text.secondary">
              {formatRelativeTime(activity.timestamp)}
            </Typography>
          </Tooltip>
        }
      />
    </>
  );
}

/**
 * Recent activity feed card for the dashboard. A compact, glanceable summary of
 * the latest business milestones with a "View all" hop to the full /activity
 * page (progressive disclosure). Data is fetched by the parent (plain Supabase,
 * no AI on mount) and passed in.
 */
export default function RecentActivity({
  activities,
  loading = false,
  viewAllHref,
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
          <Typography variant="body2" color="text.secondary" noWrap sx={{ flex: 1, ml: 0.5 }}>
            {latestActivity.entityNumber} &mdash; {formatActivityText(latestActivity)},{' '}
            {formatRelativeTime(latestActivity.timestamp)}
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
          <>
            <List disablePadding>
              {activities.map((activity) => {
                const rowSx = {
                  py: 1,
                  borderBottom: '1px solid rgba(255, 255, 255, 0.05)',
                  '&:last-child': { borderBottom: 'none' },
                };
                return activity.href ? (
                  <ListItemButton
                    key={activity.id}
                    component={Link}
                    href={activity.href}
                    disableGutters
                    sx={rowSx}
                  >
                    <ActivityRowContent activity={activity} />
                  </ListItemButton>
                ) : (
                  <ListItem key={activity.id} disableGutters sx={rowSx}>
                    <ActivityRowContent activity={activity} />
                  </ListItem>
                );
              })}
            </List>
            {viewAllHref && (
              <Box sx={{ textAlign: 'center', pt: 1 }}>
                <Typography
                  variant="body2"
                  component={Link}
                  href={viewAllHref}
                  sx={{ color: 'primary.main', textDecoration: 'none', '&:hover': { textDecoration: 'underline' } }}
                >
                  View all activity
                </Typography>
              </Box>
            )}
          </>
        )}
      </AccordionDetails>
    </Accordion>
  );
}
