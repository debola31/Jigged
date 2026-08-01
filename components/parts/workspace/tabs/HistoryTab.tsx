'use client';

import { useMemo, useState, useEffect } from 'react';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Typography from '@mui/material/Typography';
import Divider from '@mui/material/Divider';
import TextField from '@mui/material/TextField';
import Button from '@mui/material/Button';
import Alert from '@mui/material/Alert';
import Chip from '@mui/material/Chip';
import StatusChip from '@/components/common/StatusChip';
import CircularProgress from '@mui/material/CircularProgress';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Inventory2Icon from '@mui/icons-material/Inventory2';
import AddCommentIcon from '@mui/icons-material/AddComment';
import PercentIcon from '@mui/icons-material/Percent';
import NoteOutlinedIcon from '@mui/icons-material/NoteOutlined';
import AddCircleOutlineIcon from '@mui/icons-material/AddCircleOutline';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';

import {
  getPartActivity,
  addPartNote,
  deletePartNote,
  updatePartNote,
  type PartActivityEvent,
} from '@/utils/partsAccess';
import { getCurrentMember } from '@/utils/operatorAccess';
import DeleteIconButton from '@/components/common/DeleteIconButton';
import NoteEditDialog from '@/components/notes/NoteEditDialog';
import NoteDeleteDialog from '@/components/notes/NoteDeleteDialog';
import NoteEditedMark from '@/components/notes/NoteEditedMark';
import type { PartNote } from '@/types/part';

interface HistoryTabProps {
  partId: string;
  companyId: string;
  /** The part's created_at — rendered as the oldest entry at the bottom of the feed. */
  createdAt: string | null;
}

const fmtWhen = (s: string): string => new Date(s).toLocaleString();

const TXN_VERB: Record<string, string> = {
  addition: 'Added',
  depletion: 'Removed',
  adjustment: 'Adjusted to',
};

/** Which slice of the unified Activity feed is shown. */
type ActivityFilter = 'all' | 'user' | 'pricing' | 'stock';

const FILTERS: { value: ActivityFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'user', label: 'Comments' },
  { value: 'pricing', label: 'Pricing' },
  { value: 'stock', label: 'Stock' },
];

function matchesFilter(ev: PartActivityEvent, filter: ActivityFilter): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'user':
      return ev.kind === 'note' && ev.note.note_type === 'user';
    case 'pricing':
      return ev.kind === 'note' && ev.note.note_type === 'pricing';
    case 'stock':
      return ev.kind === 'transaction';
  }
}

/**
 * Activity. A single feed mixing user comments, auto-logged pricing notes, and
 * stock movements — every entry is typed and filterable. The composer adds
 * 'user' notes (shown as "comments" in the UI); pricing notes are written
 * automatically on a pricing save and
 * are not user-deletable (audit trail). Job/quote links were dropped — they're
 * already visible on the Jobs and Quotes pages.
 */
export default function HistoryTab({ partId, companyId, createdAt }: HistoryTabProps) {
  const [events, setEvents] = useState<PartActivityEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [operator, setOperator] = useState<{
    id: string;
    name: string | null;
    role: string | null;
  } | null>(null);
  /** The comment being edited, or null. Held whole so the dialog can seed itself. */
  const [editingNote, setEditingNote] = useState<PartNote | null>(null);
  /** The comment pending delete confirmation. */
  const [deletingNote, setDeletingNote] = useState<PartNote | null>(null);
  const [rowBusy, setRowBusy] = useState(false);
  const [rowError, setRowError] = useState<string | null>(null);
  const [body, setBody] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [composerError, setComposerError] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const [filter, setFilter] = useState<ActivityFilter>('all');

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
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load activity');
      });
    return () => {
      cancelled = true;
    };
  }, [partId, companyId, refreshTick]);

  useEffect(() => {
    let cancelled = false;
    getCurrentMember(companyId)
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
      setComposerError(err instanceof Error ? err.message : 'Failed to add comment');
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async () => {
    if (!deletingNote) return;
    setRowBusy(true);
    setRowError(null);
    try {
      await deletePartNote(deletingNote.id);
      setDeletingNote(null);
      setRefreshTick((t) => t + 1);
    } catch (err) {
      setRowError(err instanceof Error ? err.message : 'Failed to delete comment');
    } finally {
      setRowBusy(false);
    }
  };

  const handleEditSave = async (newBody: string | null) => {
    if (!editingNote) return;
    setRowBusy(true);
    setRowError(null);
    try {
      // Non-null asserted by the dialog: a part comment has no media, so its
      // allowEmpty is always false and Save cannot fire with an empty body.
      await updatePartNote(editingNote.id, newBody ?? '');
      setEditingNote(null);
      setRefreshTick((t) => t + 1);
    } catch (err) {
      setRowError(err instanceof Error ? err.message : 'Failed to save comment');
    } finally {
      setRowBusy(false);
    }
  };

  const loading = events === null;
  const visible = useMemo(
    () => (events ?? []).filter((ev) => matchesFilter(ev, filter)),
    [events, filter],
  );
  // The part's creation is the oldest event — shown at the bottom of the feed,
  // and only under "All" (it's neither a comment, pricing note, nor stock move).
  const showCreated = filter === 'all' && !!createdAt;

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <Card elevation={2}>
        <CardContent>
          <Typography variant="h6" sx={{ fontWeight: 600 }}>
            Comments
          </Typography>

          {/* Composer — manual notes only. */}
          <TextField
            fullWidth
            multiline
            minRows={2}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Comment on this part…"
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
              {submitting ? 'Adding…' : 'Add comment'}
            </Button>
          </Box>

          <Divider sx={{ my: 2 }} />

          {/* Filter — switches the slice of the unified feed shown below. */}
          <ToggleButtonGroup
            value={filter}
            exclusive
            size="small"
            onChange={(_e, next) => {
              if (next !== null) setFilter(next as ActivityFilter);
            }}
            aria-label="Filter notes"
            sx={{ mb: 2, flexWrap: 'wrap' }}
          >
            {FILTERS.map((f) => (
              <ToggleButton key={f.value} value={f.value} sx={{ textTransform: 'none', px: 2 }}>
                {f.label}
              </ToggleButton>
            ))}
          </ToggleButtonGroup>

          {error && (
            <Alert severity="error" sx={{ mb: 2 }}>
              {error}
            </Alert>
          )}

          {loading ? (
            <Box sx={{ display: 'flex', justifyContent: 'center', py: 2 }}>
              <CircularProgress size={24} />
            </Box>
          ) : visible.length === 0 && !showCreated ? (
            <Typography variant="body2" color="text.secondary">
              {filter === 'all' ? 'Nothing here yet.' : 'Nothing matches this filter.'}
            </Typography>
          ) : (
            <List disablePadding>
              {visible.map((ev) => {
                // 'pricing' rows are the auto-logged audit trail — never editable,
                // never deletable. RLS refuses them too after #628, so this gate is
                // honesty rather than enforcement: a control that is a guaranteed
                // 42501 reads as a broken button.
                const own =
                  ev.kind === 'note' &&
                  ev.note.note_type === 'user' &&
                  !!operator &&
                  ev.note.author_id === operator.id;
                return (
                  <FeedRow
                    key={ev.id}
                    ev={ev}
                    // Edit is AUTHOR-ONLY, deliberately asymmetric with delete: an
                    // admin who could reword someone else's comment would change
                    // what it says without changing whose name is on it.
                    canEdit={own}
                    canDelete={
                      ev.kind === 'note' &&
                      ev.note.note_type === 'user' &&
                      (own || operator?.role === 'admin')
                    }
                    onEdit={() => {
                      setRowError(null);
                      if (ev.kind === 'note') setEditingNote(ev.note);
                    }}
                    onDelete={() => {
                      setRowError(null);
                      if (ev.kind === 'note') setDeletingNote(ev.note);
                    }}
                  />
                );
              })}
              {showCreated && createdAt && (
                <ListItem alignItems="flex-start" disableGutters>
                  <ListItemIcon sx={{ minWidth: 40, mt: 0.5 }}>
                    <AddCircleOutlineIcon fontSize="small" color="action" />
                  </ListItemIcon>
                  <ListItemText
                    primary={<Typography variant="body2">Part created</Typography>}
                    secondary={fmtWhen(createdAt)}
                  />
                </ListItem>
              )}
            </List>
          )}
        </CardContent>
      </Card>

      {editingNote && (
      <NoteEditDialog
        key={editingNote.id}
        open
        initialBody={editingNote.body}
        noun="comment"
        saving={rowBusy}
        error={rowError}
        onClose={() => {
          setEditingNote(null);
          setRowError(null);
        }}
        onSave={({ body: newBody }) => handleEditSave(newBody)}
      />
      )}

      {/* A part comment is a hard delete with no restore, so it gets the
          lightweight confirmation docs/interaction-standards.md requires for an
          immediately-persisted row delete. This row previously deleted on a single
          click with no confirmation — a pre-existing gap against that standard,
          closed here because #628 is already reworking this row. */}
      <NoteDeleteDialog
        open={deletingNote !== null}
        noun="comment"
        deleting={rowBusy}
        error={rowError}
        onClose={() => {
          setDeletingNote(null);
          setRowError(null);
        }}
        onConfirm={handleDelete}
      />
    </Box>
  );
}

function FeedRow({
  ev,
  canEdit,
  canDelete,
  onEdit,
  onDelete,
}: {
  ev: PartActivityEvent;
  canEdit: boolean;
  canDelete: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  // Both controls sit at rest, and the delete stays a bare error-coloured trash
  // icon rather than moving into an overflow menu: docs/interaction-standards.md
  // requires the destructive control shown at rest, and this is a desktop surface
  // with the width and the hover to carry two icons. The operator surfaces use a
  // kebab instead, because their note headers already wrap on a 375px phone.
  const actions =
    ev.kind === 'note' && (canEdit || canDelete) ? (
      <>
        {canEdit && (
          <Tooltip title="Edit comment">
            <IconButton size="small" aria-label="Edit comment" onClick={onEdit}>
              <EditOutlinedIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        )}
        {/* Delete last — the destructive option is predictably rightmost. */}
        {canDelete && (
          <DeleteIconButton edge="end" ariaLabel="Delete comment" onClick={onDelete} />
        )}
      </>
    ) : undefined;

  return (
    <ListItem alignItems="flex-start" disableGutters secondaryAction={actions}>
      <ListItemIcon sx={{ minWidth: 40, mt: 0.5 }}>
        <FeedIcon ev={ev} />
      </ListItemIcon>
      <ListItemText primary={<FeedPrimary ev={ev} />} secondary={<FeedSecondary ev={ev} />} />
    </ListItem>
  );
}

function FeedIcon({ ev }: { ev: PartActivityEvent }) {
  if (ev.kind === 'transaction') return <Inventory2Icon fontSize="small" color="action" />;
  if (ev.note.note_type === 'pricing') return <PercentIcon fontSize="small" color="action" />;
  return <NoteOutlinedIcon fontSize="small" color="action" />;
}

function FeedPrimary({ ev }: { ev: PartActivityEvent }) {
  if (ev.kind === 'transaction') {
    return (
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
        <Typography variant="body2">
          {TXN_VERB[ev.txn.type] ?? ev.txn.type} {ev.txn.quantity} {ev.txn.unit}
        </Typography>
        {ev.txn.has_discrepancy && <StatusChip color="warning" label="Discrepancy" />}
      </Box>
    );
  }
  if (ev.note.note_type === 'pricing') {
    return (
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
        <Chip size="small" color="info" variant="outlined" label="Auto · Pricing" />
        <Typography variant="body2">{ev.note.body}</Typography>
      </Box>
    );
  }
  return <Typography variant="body2">{ev.note.body}</Typography>;
}

function FeedSecondary({ ev }: { ev: PartActivityEvent }) {
  const when = fmtWhen(ev.at);
  if (ev.kind === 'transaction') {
    return <>{ev.txn.notes ? `${when} · ${ev.txn.notes}` : when}</>;
  }
  return (
    <>
      {`${ev.note.author_name ?? 'Unknown'} · ${when}`}
      <NoteEditedMark editedAt={ev.note.edited_at} />
    </>
  );
}
