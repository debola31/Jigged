'use client';

import { useEffect, useState } from 'react';
import * as Sentry from '@sentry/nextjs';
import posthog from 'posthog-js';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Drawer from '@mui/material/Drawer';
import IconButton from '@mui/material/IconButton';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemText from '@mui/material/ListItemText';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import Typography from '@mui/material/Typography';
import AddCommentOutlinedIcon from '@mui/icons-material/AddCommentOutlined';
import ArchiveOutlinedIcon from '@mui/icons-material/ArchiveOutlined';
import CloseIcon from '@mui/icons-material/Close';
import { useLoad } from '@/hooks/useLoad';
import {
  archiveThread,
  listChartTurns,
  listThreads,
  type ChartTurn,
  type ChatThread,
} from '@/utils/aiChatAccess';
import { listReports, type ReportSummary } from '@/utils/insightsAccess';
import { reportSpecOf } from '@/utils/reportSpec';

export type HistoryTab = 'chats' | 'reports' | 'charts';

interface HistoryDrawerProps {
  open: boolean;
  onClose: () => void;
  companyId: string;
  currentThreadId: string | null;
  tab: HistoryTab;
  onTabChange: (tab: HistoryTab) => void;
  onSelectThread: (threadId: string) => void;
  onNewConversation: () => void;
  /** After a conversation is archived here, so the caller can drop it if it was the current one. */
  onArchived: (threadId: string) => void;
  onOpenReport: (summary: ReportSummary) => void;
}

const NO_THREADS: ChatThread[] = [];
const NO_REPORTS: ReportSummary[] = [];
const NO_CHARTS: ChartTurn[] = [];

/**
 * When this was, to the minute.
 *
 * THE DATE ALONE WAS NOT ENOUGH TO TELL TWO ENTRIES APART. Asking the same
 * question twice in an afternoon -- which is what people do when an answer did
 * not land -- produced a list of identical titles all reading "Sep 10", so the
 * rail could not say which was the one you wanted. A thread is minutes old far
 * more often than it is days old, and the time is the only part that varies
 * across the entries someone is actually choosing between.
 *
 * `toLocaleString` rather than a hand-rolled format: it is the browser's own
 * clock convention, so a shop that reads 24-hour time gets 14:09 without a
 * setting for it.
 */
function shortDate(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

const CHART_LABEL: Record<string, string> = {
  area: 'Trend',
  bar: 'Bar chart',
  bar_horizontal: 'Ranking',
  pie: 'Share',
  sparkline: 'Trend',
};

/**
 * Everything asked before, behind one button: the caller's conversations, the
 * one-page reports, and every answer that carried a chart.
 *
 * The three lists are read when their tab is showing and never on dashboard
 * load: a page that opens on a question should not pay for lists nobody asked
 * for. A chart is kept by having been answered -- the Charts tab is a filter
 * over turns, not a saved-insights feature -- so opening one opens its
 * conversation. Archiving takes a conversation's charts with it.
 */
export default function HistoryDrawer({
  open,
  onClose,
  companyId,
  currentThreadId,
  tab,
  onTabChange,
  onSelectThread,
  onNewConversation,
  onArchived,
  onOpenReport,
}: HistoryDrawerProps) {
  const [version, setVersion] = useState(0);
  const [archiving, setArchiving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Shape only: which tab was opened. Whether anyone ever opens History is the
  // number that says whether the rail earns its button.
  useEffect(() => {
    if (open) posthog.capture('insights history opened', { tab });
  }, [open, tab]);

  const threads = useLoad(
    () => (open && tab === 'chats' ? listThreads(companyId, 30) : Promise.resolve(NO_THREADS)),
    [open, tab, companyId, version],
    { onError: (err) => { Sentry.captureException(err); setError('Failed to load your conversations.'); } },
  );
  const reports = useLoad(
    () => (open && tab === 'reports' ? listReports(companyId, 20) : Promise.resolve(NO_REPORTS)),
    [open, tab, companyId, version],
    { onError: (err) => { Sentry.captureException(err); setError('Failed to load your reports.'); } },
  );
  const charts = useLoad(
    () => (open && tab === 'charts' ? listChartTurns(companyId, 30) : Promise.resolve(NO_CHARTS)),
    [open, tab, companyId, version],
    { onError: (err) => { Sentry.captureException(err); setError('Failed to load your charts.'); } },
  );

  const archive = async (thread: ChatThread) => {
    setArchiving(thread.id);
    setError(null);
    try {
      await archiveThread(thread.id);
      setVersion((v) => v + 1);
      onArchived(thread.id);
    } catch (err) {
      Sentry.captureException(err);
      setError(err instanceof Error ? err.message : 'Failed to archive');
    } finally {
      setArchiving(null);
    }
  };

  const loading = threads.loading || reports.loading || charts.loading;

  return (
    <Drawer
      anchor="right"
      open={open}
      onClose={onClose}
      slotProps={{ paper: { sx: { width: { xs: '100%', sm: 400 }, display: 'flex', flexDirection: 'column' } } }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', px: 2, pt: 1.5 }}>
        <Typography variant="h6" component="h2" sx={{ fontWeight: 600 }}>
          History
        </Typography>
        <IconButton onClick={onClose} aria-label="Close history" sx={{ minWidth: 48, minHeight: 48 }}>
          <CloseIcon />
        </IconButton>
      </Box>
      <Tabs
        value={tab}
        onChange={(_, value: HistoryTab) => onTabChange(value)}
        aria-label="What to look back at"
        variant="fullWidth"
        sx={{ px: 1 }}
      >
        <Tab value="chats" label="Chats" sx={{ minHeight: 48 }} />
        <Tab value="reports" label="Reports" sx={{ minHeight: 48 }} />
        <Tab value="charts" label="Charts" sx={{ minHeight: 48 }} />
      </Tabs>

      <Box sx={{ flex: 1, overflowY: 'auto', px: 1, pb: 2 }}>
        {tab === 'chats' && (
          <Button
            fullWidth
            variant="outlined"
            startIcon={<AddCommentOutlinedIcon />}
            onClick={onNewConversation}
            sx={{ my: 1.5, minHeight: 48 }}
          >
            New conversation
          </Button>
        )}

        {error && (
          <Typography role="alert" variant="body2" color="error" sx={{ px: 1, py: 1 }}>
            {error}
          </Typography>
        )}

        {loading && (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }} role="status" aria-live="polite">
            <CircularProgress size={22} />
          </Box>
        )}

        {tab === 'chats' && !threads.loading && (
          <List disablePadding aria-label="Conversations">
            {(threads.data ?? NO_THREADS).map((t) => (
              <ListItem
                key={t.id}
                disablePadding
                secondaryAction={
                  <IconButton
                    edge="end"
                    aria-label={`Archive "${t.title}"`}
                    onClick={() => archive(t)}
                    disabled={archiving === t.id}
                    sx={{ minWidth: 48, minHeight: 48 }}
                  >
                    {archiving === t.id ? <CircularProgress size={18} /> : <ArchiveOutlinedIcon fontSize="small" />}
                  </IconButton>
                }
              >
                <ListItemButton
                  selected={t.id === currentThreadId}
                  onClick={() => onSelectThread(t.id)}
                  sx={{ minHeight: 48, borderRadius: 1, pr: 7 }}
                >
                  <ListItemText primary={t.title} secondary={shortDate(t.updated_at)} />
                </ListItemButton>
              </ListItem>
            ))}
            {(threads.data ?? NO_THREADS).length === 0 && (
              <Typography variant="body2" color="text.secondary" sx={{ px: 1, py: 2 }}>
                No conversations yet.
              </Typography>
            )}
          </List>
        )}

        {tab === 'reports' && !reports.loading && (
          <List disablePadding aria-label="Reports">
            {(reports.data ?? NO_REPORTS).map((r) => {
              const spec = reportSpecOf(r.report);
              return (
                <ListItemButton key={r.id} onClick={() => onOpenReport(r)} sx={{ minHeight: 48, borderRadius: 1 }}>
                  <ListItemText
                    primary={spec?.title ?? 'Report'}
                    secondary={spec ? `${spec.period_label} · ${shortDate(r.created_at)}` : shortDate(r.created_at)}
                  />
                </ListItemButton>
              );
            })}
            {(reports.data ?? NO_REPORTS).length === 0 && (
              <Typography variant="body2" color="text.secondary" sx={{ px: 1, py: 2 }}>
                No reports yet. Ask for a report — a one-pager, a PDF, a printout — and it will appear here.
              </Typography>
            )}
          </List>
        )}

        {tab === 'charts' && !charts.loading && (
          <List disablePadding aria-label="Charts">
            {(charts.data ?? NO_CHARTS).map((c) => (
              <ListItemButton key={c.id} onClick={() => onSelectThread(c.thread_id)} sx={{ minHeight: 48, borderRadius: 1 }}>
                <ListItemText
                  primary={c.thread_title}
                  secondary={`${CHART_LABEL[c.chart_config.chart_type] ?? 'Chart'} · ${shortDate(c.created_at)}`}
                />
              </ListItemButton>
            ))}
            {(charts.data ?? NO_CHARTS).length === 0 && (
              <Typography variant="body2" color="text.secondary" sx={{ px: 1, py: 2 }}>
                No charts yet. An answer that comes with a chart is kept here.
              </Typography>
            )}
          </List>
        )}
      </Box>
    </Drawer>
  );
}
