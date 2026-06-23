'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Chip from '@mui/material/Chip';
import Card from '@mui/material/Card';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Tooltip from '@mui/material/Tooltip';
import { getActivityStream } from '@/utils/dashboardAccess';
import type { ActivityItem, ActivityType } from '@/utils/dashboardAccess';
import {
  getActivityVisual,
  formatActivityText,
  formatRelativeTime,
  formatAbsoluteTime,
} from '@/components/dashboard/activityFormat';

const PAGE_SIZE = 30;

// Module-level so each filter's `types` reference is stable across renders.
const FILTERS: { label: string; types?: ActivityType[] }[] = [
  { label: 'All' },
  { label: 'Jobs', types: ['job'] },
  { label: 'Quotes', types: ['quote'] },
  { label: 'Shipments', types: ['shipment'] },
  { label: 'Notes', types: ['note'] },
  { label: 'Photos', types: ['photo'] },
  { label: 'Operations', types: ['operation'] },
];

function ActivityRow({ item }: { item: ActivityItem }) {
  const { icon: Icon, color } = getActivityVisual(item);
  const content = (
    <>
      <ListItemIcon sx={{ minWidth: 44 }}>
        <Icon sx={{ color }} />
      </ListItemIcon>
      <ListItemText
        primary={
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
            {item.entityNumber && (
              <Typography variant="body2" component="span" sx={{ fontWeight: 600 }}>
                {item.entityNumber}
              </Typography>
            )}
            <Typography variant="body2" component="span" color="text.secondary">
              {formatActivityText(item)}
            </Typography>
          </Box>
        }
        secondary={
          <Tooltip title={formatAbsoluteTime(item.timestamp)}>
            <Typography variant="caption" color="text.secondary">
              {formatRelativeTime(item.timestamp)}
            </Typography>
          </Tooltip>
        }
      />
    </>
  );
  const rowSx = {
    borderBottom: '1px solid rgba(255, 255, 255, 0.06)',
    '&:last-child': { borderBottom: 'none' },
    minHeight: 56,
  };
  return item.href ? (
    <ListItemButton component={Link} href={item.href} sx={rowSx}>
      {content}
    </ListItemButton>
  ) : (
    <ListItem sx={rowSx}>{content}</ListItem>
  );
}

/**
 * The full cross-module activity stream — what's happening across the shop,
 * filterable by type and paginated. The compact dashboard "Recent Activity"
 * card links here ("View all"). Plain Supabase reads (no AI on mount).
 */
export default function ActivityPage() {
  const params = useParams();
  const companyId = params.companyId as string;

  const [filterIdx, setFilterIdx] = useState(0);
  const [items, setItems] = useState<ActivityItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);

  const types = FILTERS[filterIdx].types;

  // Initial / filter-change load. Async-only setState (loading reset happens in
  // the filter handler) so this effect doesn't trip set-state-in-effect.
  useEffect(() => {
    if (!companyId) return;
    let active = true;
    getActivityStream(companyId, { types, limit: PAGE_SIZE })
      .then((rows) => {
        if (!active) return;
        setItems(rows);
        setHasMore(rows.length === PAGE_SIZE);
      })
      .catch(() => {
        if (active) {
          setItems([]);
          setHasMore(false);
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [companyId, types]);

  const selectFilter = (idx: number) => {
    if (idx === filterIdx) return;
    setFilterIdx(idx);
    setItems([]);
    setLoading(true);
  };

  const loadMore = useCallback(async () => {
    const last = items[items.length - 1];
    if (!last) return;
    setLoadingMore(true);
    try {
      const rows = await getActivityStream(companyId, {
        types,
        limit: PAGE_SIZE,
        before: last.timestamp,
      });
      setItems((prev) => [...prev, ...rows]);
      setHasMore(rows.length === PAGE_SIZE);
    } catch {
      setHasMore(false);
    } finally {
      setLoadingMore(false);
    }
  }, [companyId, types, items]);

  return (
    <Box>
      {/* Filter chips */}
      <Stack direction="row" spacing={1} sx={{ mb: 3, flexWrap: 'wrap', gap: 1 }}>
        {FILTERS.map((f, idx) => (
          <Chip
            key={f.label}
            label={f.label}
            onClick={() => selectFilter(idx)}
            color={idx === filterIdx ? 'primary' : 'default'}
            variant={idx === filterIdx ? 'filled' : 'outlined'}
          />
        ))}
      </Stack>

      <Card elevation={2}>
        {loading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
            <CircularProgress />
          </Box>
        ) : items.length === 0 ? (
          <Box sx={{ py: 6, textAlign: 'center' }}>
            <Typography variant="body2" color="text.secondary">
              No activity yet.
            </Typography>
          </Box>
        ) : (
          <>
            <List disablePadding>
              {items.map((item) => (
                <ActivityRow key={item.id} item={item} />
              ))}
            </List>
            {hasMore && (
              <Box sx={{ display: 'flex', justifyContent: 'center', p: 2 }}>
                <Button onClick={loadMore} disabled={loadingMore}>
                  {loadingMore ? <CircularProgress size={20} /> : 'Load more'}
                </Button>
              </Box>
            )}
          </>
        )}
      </Card>
    </Box>
  );
}
