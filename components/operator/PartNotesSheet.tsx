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
import { logOperatorEvent } from '@/utils/operatorEventsAccess';
import { useNoteDwell } from '@/hooks/useNoteDwell';
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

function NoteRow({
  note,
  observe,
}: {
  note: PartPreviousNote;
  observe: (id: string) => (el: HTMLElement | null) => void;
}) {
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
        <Typography ref={observe(note.id)} variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>
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
  //
  // Whether this default is RIGHT is an open question, and deliberately an
  // empirical one rather than an argued one. An earlier revision of the plan
  // proposed deleting the toggle in favour of a step-first list, on the inference
  // that it was the "non-default toggle" that hid seeded knowledge in a prior
  // usability session. That inference was unsupported — the default is the
  // BROADER view, so the toggle narrows rather than hides — and it contradicted
  // the operator request recorded above. The industry evidence splits too:
  // work-instruction guidance favours per-step scoping, but tribal knowledge is
  // precisely the cross-cutting material that isn't in a step's SOP.
  //
  // So: keep the toggle, and instrument it (see handleClose). If operators
  // habitually narrow to their step, that argues for a step-first default. If the
  // toggle is never touched, it is dead weight and can go. Either way the next
  // decision is made on data from the shop rather than on a plausible story.
  const [scope, setScope] = useState<Scope>('part');
  const [toggled, setToggled] = useState(false);

  // THE surface the read-back loop exists to measure: knowledge from a previous
  // run, being read on a new one. excludeJobId is the job the operator is
  // standing in, so it is the right read context for the per-job dedupe.
  const { observe } = useNoteDwell(companyId, excludeJobId, open);

  const { data, loading, error } = useLoad(
    () =>
      getPartPreviousNotes(partId, companyId, {
        excludeJobId,
        jobOperationId: scope === 'step' ? jobOperationId : undefined,
      }),
    [partId, companyId, excludeJobId, scope, jobOperationId],
  );
  const notes = data ?? [];

  // One event per visit, emitted on close so it can carry the whole interaction:
  // which scope they landed on, whether they narrowed, and how much was there to
  // read. Logging on OPEN instead would miss the toggle entirely, and a separate
  // "scope changed" kind would need a migration to widen the kind CHECK.
  //
  // Records counts and the scope only — never which notes were shown. Naming the
  // notes someone read is exactly what note_views' RLS exists to prevent, and an
  // operator_events row is service-role readable, so it must not become a back
  // door into the same information.
  const handleClose = () => {
    logOperatorEvent(companyId, 'prior_notes_opened', {
      openedFrom: jobOperationId ? 'operation' : 'traveler',
      finalScope: scope,
      toggled,
      noteCount: notes.length,
    });
    onClose();
  };

  return (
    <Dialog open={open} onClose={handleClose} fullScreen>
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
          <IconButton edge="end" aria-label="Close" onClick={handleClose}>
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
              if (!v) return;
              setScope(v as Scope);
              setToggled(true);
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
                <NoteRow note={note} observe={observe} />
              </Box>
            ))}
          </Box>
        )}
      </Box>
    </Dialog>
  );
}
