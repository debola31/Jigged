'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import CardActionArea from '@mui/material/CardActionArea';
import Chip from '@mui/material/Chip';
import Divider from '@mui/material/Divider';
import TextField from '@mui/material/TextField';
import CircularProgress from '@mui/material/CircularProgress';
import Alert from '@mui/material/Alert';
import IconButton from '@mui/material/IconButton';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import PlayCircleFilledIcon from '@mui/icons-material/PlayCircleFilled';
import RadioButtonUncheckedIcon from '@mui/icons-material/RadioButtonUnchecked';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import StickyNote2Icon from '@mui/icons-material/StickyNote2';
import {
  getJobPartTraveler,
  getJobNotes,
  addJobNote,
  getCurrentOperator,
} from '@/utils/operatorAccess';
import type { JobTraveler, JobTravelerOperation, JobNote } from '@/types/operator';

const cardSx = { bgcolor: 'rgba(26, 31, 74, 0.55)', backdropFilter: 'blur(8px)' };

function formatMinutes(min: number): string {
  if (!min) return '—';
  if (min < 60) return `${Number.isInteger(min) ? min : min.toFixed(1)} M`;
  return `${(min / 60).toFixed(1)} H`;
}

function formatDate(value: string | null): string | null {
  if (!value) return null;
  // due_date is a plain YYYY-MM-DD; render without TZ shifting.
  const d = new Date(`${value}T00:00:00`);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
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

function StepIcon({ status }: { status: string }) {
  if (status === 'completed') return <CheckCircleIcon color="success" />;
  if (status === 'in_progress') return <PlayCircleFilledIcon color="primary" />;
  return <RadioButtonUncheckedIcon color="disabled" />;
}

/**
 * Operator job traveler. When an operator opens a job_part (scanning a job QR
 * lands here for a single-part job, or via the parts hub for multi-part jobs),
 * they see the full step list — like a printed shop traveler — and pick which
 * step to action. Job-level notes (general, not tied to any step) live here too.
 */
export default function OperatorJobTravelerPage() {
  const params = useParams();
  const router = useRouter();
  const companyId = params.companyId as string;
  const jobId = params.jobId as string;
  const jobPartId = params.jobPartId as string;

  const [traveler, setTraveler] = useState<JobTraveler | null>(null);
  const [notes, setNotes] = useState<JobNote[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [operatorId, setOperatorId] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState('');
  const [savingNote, setSavingNote] = useState(false);
  const [noteError, setNoteError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await getJobPartTraveler(jobPartId, companyId);
      if (!data) {
        setError('Job not found.');
        return;
      }
      setTraveler(data);
      const noteRows = await getJobNotes(data.job_id, companyId);
      setNotes(noteRows);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load job');
    } finally {
      setLoading(false);
    }
  }, [jobPartId, companyId]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    async function loadOperator() {
      const operator = await getCurrentOperator(companyId);
      if (operator) setOperatorId(operator.id);
    }
    loadOperator();
  }, [companyId]);

  const openStep = (op: JobTravelerOperation) => {
    router.push(`/operator/${companyId}/jobs/${jobId}/parts/${jobPartId}/operations/${op.id}`);
  };

  const handleAddNote = async () => {
    if (!traveler) return;
    const body = noteDraft.trim();
    if (!body) return;
    if (!operatorId) {
      setNoteError('Operator not found. Please log in again.');
      return;
    }
    setSavingNote(true);
    setNoteError(null);
    try {
      const created = await addJobNote(traveler.job_id, companyId, operatorId, body);
      setNotes((prev) => [created, ...prev]);
      setNoteDraft('');
    } catch (err) {
      setNoteError(err instanceof Error ? err.message : 'Failed to add note');
    } finally {
      setSavingNote(false);
    }
  };

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '50vh' }}>
        <CircularProgress />
      </Box>
    );
  }

  if (error || !traveler) {
    return (
      <Box sx={{ p: 2 }}>
        <Alert severity="error" sx={{ mb: 2 }}>
          {error || 'Job not found.'}
        </Alert>
        <Button variant="outlined" onClick={() => router.push(`/operator/${companyId}/jobs`)}>
          Back to jobs
        </Button>
      </Box>
    );
  }

  const dueDate = formatDate(traveler.due_date);

  return (
    <Box sx={{ pb: 4 }}>
      {/* Back to the operator's station jobs list (not the parts hub, which
          auto-redirects single-part jobs straight back to this traveler). */}
      <IconButton
        onClick={() => router.push(`/operator/${companyId}/jobs`)}
        sx={{ mb: 2 }}
        aria-label="Back to jobs"
      >
        <ArrowBackIcon />
      </IconButton>

      {/* Header — mirrors the printed traveler's job block */}
      <Card elevation={2} sx={{ ...cardSx, mb: 3 }}>
        <CardContent>
          <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 1, mb: 1 }}>
            <Box sx={{ minWidth: 0 }}>
              <Typography variant="h5" component="h1" fontWeight={700}>
                {traveler.job_number}
              </Typography>
              <Typography variant="body2" color="text.secondary">
                {traveler.customer_name || 'No customer'}
              </Typography>
            </Box>
            <Chip
              size="small"
              label={traveler.production_status}
              color={
                traveler.production_status === 'in_progress'
                  ? 'primary'
                  : traveler.production_status === 'completed'
                    ? 'success'
                    : 'default'
              }
            />
          </Box>

          <Typography variant="h6">{traveler.part_name || 'Part'}</Typography>
          {traveler.part_description && (
            <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
              {traveler.part_description}
            </Typography>
          )}

          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 3, mt: 1 }}>
            <Box>
              <Typography variant="caption" color="text.secondary" display="block">
                Quantity
              </Typography>
              <Typography variant="body2" fontWeight={600}>
                {traveler.quantity}
              </Typography>
            </Box>
            {dueDate && (
              <Box>
                <Typography variant="caption" color="text.secondary" display="block">
                  Due
                </Typography>
                <Typography variant="body2" fontWeight={600}>
                  {dueDate}
                </Typography>
              </Box>
            )}
            {traveler.customer_po_number && (
              <Box>
                <Typography variant="caption" color="text.secondary" display="block">
                  PO #
                </Typography>
                <Typography variant="body2" fontWeight={600}>
                  {traveler.customer_po_number}
                </Typography>
              </Box>
            )}
          </Box>
        </CardContent>
      </Card>

      {/* Operations / steps — tap one to action it */}
      <Typography variant="overline" color="text.secondary" sx={{ px: 0.5 }}>
        Operations
      </Typography>
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5, mt: 0.5, mb: 3 }}>
        {traveler.operations.length === 0 && (
          <Typography variant="body2" color="text.secondary" sx={{ px: 0.5, py: 2 }}>
            This part has no operations.
          </Typography>
        )}
        {traveler.operations.map((op) => {
          const done = op.status === 'completed';
          return (
            <Card key={op.id} elevation={2} sx={{ ...cardSx, opacity: done ? 0.65 : 1 }}>
              {/* Completed steps stay tappable so the operator can reopen one to undo it. */}
              <CardActionArea onClick={() => openStep(op)} sx={{ p: 0 }}>
                <CardContent sx={{ display: 'flex', alignItems: 'center', gap: 1.5, py: 1.5 }}>
                  <StepIcon status={op.status} />
                  <Box sx={{ minWidth: 36 }}>
                    <Typography variant="caption" color="text.secondary" display="block">
                      Step
                    </Typography>
                    <Typography variant="h6" fontWeight={700} lineHeight={1}>
                      {op.sequence}
                    </Typography>
                  </Box>
                  <Box sx={{ flex: 1, minWidth: 0 }}>
                    <Typography variant="body1" fontWeight={600} noWrap>
                      {op.work_center_name || op.operation_name}
                    </Typography>
                    <Typography variant="body2" color="text.secondary" noWrap>
                      {op.instructions || op.operation_name}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      Setup {formatMinutes(op.setup_minutes)} &middot; Cycle {formatMinutes(op.cycle_minutes)}
                    </Typography>
                    {op.status === 'in_progress' && (
                      <Typography variant="caption" color="primary" display="block">
                        In progress
                      </Typography>
                    )}
                  </Box>
                  <ChevronRightIcon color="action" />
                </CardContent>
              </CardActionArea>
            </Card>
          );
        })}
      </Box>

      {/* Job-level notes feed */}
      <Card elevation={2} sx={cardSx}>
        <CardContent>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1.5 }}>
            <StickyNote2Icon fontSize="small" color="action" />
            <Typography variant="h6" color="text.secondary">
              Job Notes
            </Typography>
          </Box>

          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1, mb: 2 }}>
            <TextField
              multiline
              minRows={2}
              placeholder="Add a note about this job…"
              value={noteDraft}
              onChange={(e) => setNoteDraft(e.target.value)}
              fullWidth
              size="small"
            />
            {noteError && <Alert severity="error">{noteError}</Alert>}
            <Box sx={{ display: 'flex', justifyContent: 'flex-end' }}>
              <Button
                variant="contained"
                onClick={handleAddNote}
                disabled={savingNote || !noteDraft.trim()}
              >
                {savingNote ? <CircularProgress size={20} /> : 'Add note'}
              </Button>
            </Box>
          </Box>

          {notes.length === 0 ? (
            <Typography variant="body2" color="text.secondary">
              No notes yet.
            </Typography>
          ) : (
            <Box sx={{ display: 'flex', flexDirection: 'column' }}>
              {notes.map((note, idx) => (
                <Box key={note.id}>
                  {idx > 0 && <Divider sx={{ my: 1 }} />}
                  <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 1, mb: 0.25 }}>
                    <Typography variant="subtitle2" fontWeight={700}>
                      {note.author_name || 'Unknown'}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      {formatTimestamp(note.created_at)}
                    </Typography>
                  </Box>
                  <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>
                    {note.body}
                  </Typography>
                </Box>
              ))}
            </Box>
          )}
        </CardContent>
      </Card>
    </Box>
  );
}
