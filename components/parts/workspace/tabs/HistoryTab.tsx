'use client';

import { useState, useEffect } from 'react';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Typography from '@mui/material/Typography';
import Divider from '@mui/material/Divider';
import TextField from '@mui/material/TextField';
import Button from '@mui/material/Button';
import Alert from '@mui/material/Alert';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import MuiLink from '@mui/material/Link';
import NextLink from 'next/link';
import Inventory2Icon from '@mui/icons-material/Inventory2';
import WorkIcon from '@mui/icons-material/Work';
import RequestQuoteIcon from '@mui/icons-material/RequestQuote';
import AddCommentIcon from '@mui/icons-material/AddComment';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';

import {
  getPartActivity,
  addPartNote,
  deletePartNote,
  type PartActivityEvent,
} from '@/utils/partsAccess';
import { getCurrentOperator } from '@/utils/operatorAccess';

interface HistoryTabProps {
  partId: string;
  companyId: string;
}

const fmtWhen = (s: string): string => new Date(s).toLocaleString();

const TXN_VERB: Record<string, string> = {
  addition: 'Added',
  depletion: 'Removed',
  adjustment: 'Adjusted to',
};

/**
 * Notes & Activity. Manual notes are kept in their own section (with the
 * composer) so they're never buried by the auto-logged activity feed below —
 * the two are split from the single merged list the first cut had.
 */
export default function HistoryTab({ partId, companyId }: HistoryTabProps) {
  const [events, setEvents] = useState<PartActivityEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [operator, setOperator] = useState<{ id: string; name: string | null } | null>(null);
  const [body, setBody] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [composerError, setComposerError] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    getPartActivity(partId, companyId)
      .then((ev) => {
        if (!cancelled) {
          setEvents(ev);
          setError(null);
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load history');
      });
    return () => {
      cancelled = true;
    };
  }, [partId, companyId, refreshTick]);

  useEffect(() => {
    let cancelled = false;
    getCurrentOperator(companyId)
      .then((op) => {
        if (!cancelled) setOperator(op);
      })
      .catch(() => {
        /* non-fatal — composer guards on null operator */
      });
    return () => {
      cancelled = true;
    };
  }, [companyId]);

  const handleAdd = async () => {
    const trimmed = body.trim();
    if (!trimmed) return;
    if (!operator) {
      setComposerError('Could not identify your account — reload the page and try again.');
      return;
    }
    setSubmitting(true);
    setComposerError(null);
    try {
      await addPartNote(partId, companyId, operator.id, trimmed);
      setBody('');
      setRefreshTick((t) => t + 1);
    } catch (err) {
      setComposerError(err instanceof Error ? err.message : 'Failed to add note');
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (noteId: string) => {
    try {
      await deletePartNote(noteId);
      setRefreshTick((t) => t + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete note');
    }
  };

  const loading = events === null;
  const noteEvents = (events ?? []).filter((e) => e.kind === 'note');
  const activityEvents = (events ?? []).filter((e) => e.kind !== 'note');

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      {/* Notes — manual, with the composer. Kept separate from activity. */}
      <Card elevation={2}>
        <CardContent>
          <Typography variant="h6" sx={{ fontWeight: 600 }}>
            Notes
          </Typography>
          <TextField
            fullWidth
            multiline
            minRows={2}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Note about this part…"
            disabled={submitting}
            sx={{ mt: 1.5 }}
          />
          {composerError && (
            <Alert severity="error" sx={{ mt: 1.5 }}>
              {composerError}
            </Alert>
          )}
          <Box sx={{ display: 'flex', justifyContent: 'flex-end', mt: 1.5 }}>
            <Button
              variant="contained"
              onClick={handleAdd}
              disabled={submitting || !body.trim()}
              startIcon={
                submitting ? <CircularProgress size={16} color="inherit" /> : <AddCommentIcon />
              }
            >
              {submitting ? 'Adding…' : 'Add note'}
            </Button>
          </Box>

          <Divider sx={{ my: 2 }} />

          {loading ? (
            <Box sx={{ display: 'flex', justifyContent: 'center', py: 2 }}>
              <CircularProgress size={24} />
            </Box>
          ) : noteEvents.length === 0 ? (
            <Typography variant="body2" color="text.secondary">
              No notes yet.
            </Typography>
          ) : (
            <List disablePadding>
              {noteEvents.map((ev) => {
                if (ev.kind !== 'note') return null;
                const canDelete = !!operator && ev.note.author_id === operator.id;
                return (
                  <ListItem
                    key={ev.id}
                    alignItems="flex-start"
                    disableGutters
                    secondaryAction={
                      canDelete ? (
                        <Tooltip title="Delete note">
                          <IconButton
                            edge="end"
                            size="small"
                            onClick={() => handleDelete(ev.note.id)}
                            sx={{ color: 'text.secondary' }}
                          >
                            <DeleteOutlineIcon fontSize="small" />
                          </IconButton>
                        </Tooltip>
                      ) : undefined
                    }
                  >
                    <ListItemText
                      primary={<Typography variant="body2">{ev.note.body}</Typography>}
                      secondary={`${ev.note.author_name ?? 'Unknown'} · ${fmtWhen(ev.at)}`}
                    />
                  </ListItem>
                );
              })}
            </List>
          )}
        </CardContent>
      </Card>

      {/* Activity — auto-logged events only (stock, jobs, quotes). */}
      <Card elevation={2}>
        <CardContent>
          <Typography variant="h6" sx={{ fontWeight: 600 }}>
            Activity
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
            Stock movements and the jobs &amp; quotes this part appears on.
          </Typography>
          <Divider sx={{ my: 2 }} />

          {error && (
            <Alert severity="error" sx={{ mb: 2 }}>
              {error}
            </Alert>
          )}

          {loading ? (
            <Box sx={{ display: 'flex', justifyContent: 'center', py: 2 }}>
              <CircularProgress size={24} />
            </Box>
          ) : activityEvents.length === 0 ? (
            <Typography variant="body2" color="text.secondary">
              No activity yet.
            </Typography>
          ) : (
            <List disablePadding>
              {activityEvents.map((ev) => (
                <ListItem key={ev.id} alignItems="flex-start" disableGutters>
                  <ListItemIcon sx={{ minWidth: 40, mt: 0.5 }}>
                    <ActivityIcon ev={ev} />
                  </ListItemIcon>
                  <ListItemText
                    primary={<ActivityPrimary ev={ev} companyId={companyId} />}
                    secondary={<ActivitySecondary ev={ev} />}
                  />
                </ListItem>
              ))}
            </List>
          )}
        </CardContent>
      </Card>
    </Box>
  );
}

function ActivityIcon({ ev }: { ev: PartActivityEvent }) {
  switch (ev.kind) {
    case 'transaction':
      return <Inventory2Icon fontSize="small" color="action" />;
    case 'job':
      return <WorkIcon fontSize="small" color="action" />;
    case 'quote':
      return <RequestQuoteIcon fontSize="small" color="action" />;
    default:
      return null;
  }
}

function ActivityPrimary({ ev, companyId }: { ev: PartActivityEvent; companyId: string }) {
  switch (ev.kind) {
    case 'transaction':
      return (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
          <Typography variant="body2">
            {TXN_VERB[ev.txn.type] ?? ev.txn.type} {ev.txn.quantity} {ev.txn.unit}
          </Typography>
          {ev.txn.has_discrepancy && <Chip size="small" color="warning" label="Discrepancy" />}
        </Box>
      );
    case 'job':
      return (
        <Typography variant="body2">
          Added to job{' '}
          <MuiLink
            component={NextLink}
            href={`/dashboard/${companyId}/jobs/${ev.job.job_id}`}
            underline="hover"
          >
            {ev.job.job_number}
          </MuiLink>{' '}
          (qty {ev.job.quantity})
        </Typography>
      );
    case 'quote':
      return (
        <Typography variant="body2">
          Added to quote{' '}
          <MuiLink
            component={NextLink}
            href={`/dashboard/${companyId}/quotes/${ev.quote.quote_id}`}
            underline="hover"
          >
            {ev.quote.quote_number}
          </MuiLink>
        </Typography>
      );
    default:
      return null;
  }
}

function ActivitySecondary({ ev }: { ev: PartActivityEvent }) {
  const when = fmtWhen(ev.at);
  if (ev.kind === 'transaction') {
    return <>{ev.txn.notes ? `${when} · ${ev.txn.notes}` : when}</>;
  }
  return <>{when}</>;
}
