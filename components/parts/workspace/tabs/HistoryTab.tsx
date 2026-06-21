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
import StickyNote2Icon from '@mui/icons-material/StickyNote2';
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
 * Part activity timeline + manual note composer. The feed is aggregated on
 * read (notes + stock transactions + jobs + quotes) by getPartActivity. Built
 * on List/ListItem (not @mui/lab, which isn't installed).
 */
export default function HistoryTab({ partId, companyId }: HistoryTabProps) {
  const [events, setEvents] = useState<PartActivityEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [operator, setOperator] = useState<{ id: string; name: string | null } | null>(null);
  const [body, setBody] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [composerError, setComposerError] = useState<string | null>(null);
  // Bumped after add/delete to refetch the feed (avoids a synchronous
  // setState-in-effect by keeping all feed writes inside the async callback).
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

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      {/* Composer */}
      <Card elevation={2}>
        <CardContent>
          <Typography variant="h6" sx={{ fontWeight: 600 }}>
            Add a note
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
        </CardContent>
      </Card>

      {/* Activity feed */}
      <Card elevation={2}>
        <CardContent>
          <Typography variant="h6" sx={{ fontWeight: 600 }}>
            Activity
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
            Notes, stock movements, and the jobs &amp; quotes this part appears on.
          </Typography>
          <Divider sx={{ my: 2 }} />

          {error && (
            <Alert severity="error" sx={{ mb: 2 }}>
              {error}
            </Alert>
          )}

          {events === null ? (
            <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}>
              <CircularProgress size={28} />
            </Box>
          ) : events.length === 0 ? (
            <Typography variant="body2" color="text.secondary">
              No activity yet.
            </Typography>
          ) : (
            <List disablePadding>
              {events.map((ev) => {
                const canDelete =
                  ev.kind === 'note' && !!operator && ev.note.author_id === operator.id;
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
                            onClick={() => handleDelete((ev as { note: { id: string } }).note.id)}
                            sx={{ color: 'text.secondary' }}
                          >
                            <DeleteOutlineIcon fontSize="small" />
                          </IconButton>
                        </Tooltip>
                      ) : undefined
                    }
                  >
                    <ListItemIcon sx={{ minWidth: 40, mt: 0.5 }}>
                      <ActivityIcon ev={ev} />
                    </ListItemIcon>
                    <ListItemText
                      primary={<ActivityPrimary ev={ev} companyId={companyId} />}
                      secondary={<ActivitySecondary ev={ev} />}
                    />
                  </ListItem>
                );
              })}
            </List>
          )}
        </CardContent>
      </Card>
    </Box>
  );
}

function ActivityIcon({ ev }: { ev: PartActivityEvent }) {
  switch (ev.kind) {
    case 'note':
      return <StickyNote2Icon fontSize="small" color="info" />;
    case 'transaction':
      return <Inventory2Icon fontSize="small" color="action" />;
    case 'job':
      return <WorkIcon fontSize="small" color="action" />;
    case 'quote':
      return <RequestQuoteIcon fontSize="small" color="action" />;
  }
}

function ActivityPrimary({ ev, companyId }: { ev: PartActivityEvent; companyId: string }) {
  switch (ev.kind) {
    case 'note':
      return <Typography variant="body2">{ev.note.body}</Typography>;
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
  }
}

function ActivitySecondary({ ev }: { ev: PartActivityEvent }) {
  const when = fmtWhen(ev.at);
  switch (ev.kind) {
    case 'note':
      return <>{`${ev.note.author_name ?? 'Unknown'} · ${when}`}</>;
    case 'transaction':
      return <>{ev.txn.notes ? `${when} · ${ev.txn.notes}` : when}</>;
    default:
      return <>{when}</>;
  }
}
