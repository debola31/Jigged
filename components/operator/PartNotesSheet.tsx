'use client';

import { useState } from 'react';
import { useLoad } from '@/hooks/useLoad';
import Dialog from '@mui/material/Dialog';
import AppBar from '@mui/material/AppBar';
import Toolbar from '@mui/material/Toolbar';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import IconButton from '@mui/material/IconButton';
import Chip from '@mui/material/Chip';
import Divider from '@mui/material/Divider';
import Alert from '@mui/material/Alert';
import CircularProgress from '@mui/material/CircularProgress';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import CloseIcon from '@mui/icons-material/Close';
import { getPartPreviousNotes } from '@/utils/operatorAccess';
import NoteMediaGallery from '@/components/operator/NoteMediaGallery';
import type { PartPreviousNote } from '@/types/operator';

type Scope = 'step' | 'part';

interface PartNotesSheetProps {
  open: boolean;
  onClose: () => void;
  partId: string;
  companyId: string;
  /** The current job — never show its own notes as "previous". */
  excludeJobId: string;
  /** Present on the operation page — enables the "This step" filter. */
  jobOperationId?: string;
  partName?: string | null;
}

function formatTimestamp(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function NoteRow({ note }: { note: PartPreviousNote }) {
  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.25, flexWrap: 'wrap' }}>
        <Typography variant="subtitle2" fontWeight={700} noWrap>
          {note.author_name || 'Unknown'}
        </Typography>
        {note.operation_label && (
          <Chip size="small" label={note.operation_label} variant="outlined" />
        )}
        <Box sx={{ flex: 1 }} />
        <Typography variant="caption" color="text.secondary">
          {note.job_number} · {formatTimestamp(note.created_at)}
        </Typography>
      </Box>
      {note.body && (
        <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>
          {note.body}
        </Typography>
      )}
      <NoteMediaGallery media={note.media} />
    </Box>
  );
}

/**
 * Full-screen "previous notes for this part" sheet. A flat, newest-first stream
 * of notes captured on PRIOR completed runs of the part — the accumulated shop
 * wisdom (setup tips, gotchas, photos) — rather than a list of past jobs. Each
 * note shows its author, the step it was tagged to, a light source-job
 * reference, and its photos. When opened from an operation (jobOperationId set),
 * a "This step / All part" toggle narrows to the same step. Read-only, part-
 * centric, no time metrics.
 */
export default function PartNotesSheet({
  open,
  onClose,
  partId,
  companyId,
  excludeJobId,
  jobOperationId,
  partName,
}: PartNotesSheetProps) {
  // Default to the whole part's notes (the operator asked for "notes for the
  // part"); when opened from a step, offer a filter to just that step.
  const [scope, setScope] = useState<Scope>('part');

  const { data, loading, error } = useLoad(
    () =>
      getPartPreviousNotes(partId, companyId, {
        excludeJobId,
        jobOperationId: scope === 'step' ? jobOperationId : undefined,
      }),
    [partId, companyId, excludeJobId, scope, jobOperationId],
  );
  const notes = data ?? [];

  return (
    <Dialog open={open} onClose={onClose} fullScreen>
      <AppBar position="relative" elevation={0} sx={{ bgcolor: 'rgba(17, 20, 57, 0.98)' }}>
        <Toolbar>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography variant="h6" noWrap>
              Previous notes
            </Typography>
            {partName && (
              <Typography variant="caption" color="text.secondary" noWrap component="div">
                {partName}
              </Typography>
            )}
          </Box>
          <IconButton edge="end" aria-label="Close" onClick={onClose}>
            <CloseIcon />
          </IconButton>
        </Toolbar>
      </AppBar>

      <Box sx={{ p: 2 }}>
        {jobOperationId && (
          <ToggleButtonGroup
            size="small"
            exclusive
            value={scope}
            onChange={(_e, v) => {
              if (v) setScope(v as Scope);
            }}
            aria-label="Notes scope"
            sx={{ mb: 2 }}
          >
            <ToggleButton value="step">This step</ToggleButton>
            <ToggleButton value="part">All part</ToggleButton>
          </ToggleButtonGroup>
        )}

        {loading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
            <CircularProgress />
          </Box>
        ) : error ? (
          <Alert severity="error">Could not load notes. Try again.</Alert>
        ) : notes.length === 0 ? (
          <Box sx={{ textAlign: 'center', py: 8, px: 2 }}>
            <Typography variant="h6" color="text.secondary" gutterBottom>
              No previous notes
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {scope === 'step'
                ? 'No notes from previous runs of this step yet.'
                : 'Notes added on previous runs of this part will show up here.'}
            </Typography>
          </Box>
        ) : (
          <Box>
            {notes.map((note, idx) => (
              <Box key={note.id}>
                {idx > 0 && <Divider sx={{ my: 1.5 }} />}
                <NoteRow note={note} />
              </Box>
            ))}
          </Box>
        )}
      </Box>
    </Dialog>
  );
}
