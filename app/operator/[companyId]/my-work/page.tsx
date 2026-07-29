'use client';

import { useState } from 'react';
import { useParams } from 'next/navigation';
import { useLoad } from '@/hooks/useLoad';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import CardActionArea from '@mui/material/CardActionArea';
import Typography from '@mui/material/Typography';
import Chip from '@mui/material/Chip';
import Divider from '@mui/material/Divider';
import CircularProgress from '@mui/material/CircularProgress';
import Alert from '@mui/material/Alert';
import Collapse from '@mui/material/Collapse';
import PhotoCameraIcon from '@mui/icons-material/PhotoCamera';
import VisibilityOutlinedIcon from '@mui/icons-material/VisibilityOutlined';
import { getMyContribution, getNoteViewers } from '@/utils/operatorAccess';
import { useSetOperatorChrome } from '@/components/operator/OperatorChromeContext';
import type { MyNote, NoteViewer } from '@/types/operator';

const cardSx = { bgcolor: 'rgba(26, 31, 74, 0.55)', backdropFilter: 'blur(8px)' };

function formatDate(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

/**
 * How far one note travelled, as a number rather than a sentence.
 *
 * An earlier pass rendered "Not used yet" under every unread note, which on a
 * real screen is a column of seven identical apologies. A view count reads the
 * same at zero as at four — the number just hasn't moved yet — and it says
 * exactly what viewer_count means without editorialising about it.
 *
 * The jobs figure stays alongside because the two mean different things: people
 * saturates near shop size, jobs does not. A note used on eleven jobs is
 * load-bearing; one read by eleven people once is curiosity.
 */
function ReachRow({ note }: { note: MyNote }) {
  const read = note.viewer_count > 0;
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
      <VisibilityOutlinedIcon
        sx={{ fontSize: 16, color: read ? 'success.light' : 'text.secondary' }}
      />
      <Typography variant="caption" sx={{ color: read ? 'success.light' : 'text.secondary' }}>
        {note.viewer_count}
        {note.usage_count > 0 &&
          ` · used on ${note.usage_count === 1 ? '1 job' : `${note.usage_count} jobs`}`}
      </Typography>
    </Box>
  );
}

function NoteRow({ note }: { note: MyNote }) {
  const [open, setOpen] = useState(false);
  const [viewers, setViewers] = useState<NoteViewer[] | null>(null);
  const [loading, setLoading] = useState(false);

  // Names are fetched only when the author asks for them. note_viewers() is the
  // one narrow window through which any reader's name is ever exposed — it is
  // authors-only and returns no timestamps — so it is never part of a list render.
  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (!next || viewers || note.viewer_count === 0) return;
    setLoading(true);
    try {
      setViewers(await getNoteViewers(note.id));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card elevation={2} sx={{ ...cardSx, mb: 1.5 }}>
      <CardActionArea onClick={toggle} disabled={note.viewer_count === 0} sx={{ p: 0 }}>
        <CardContent sx={{ py: 1.5 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap', mb: 0.5 }}>
            {/* Leads the row so every card has a number in the same place — a
                stable column to scan down, present whether or not the note
                carries a part or a step. */}
            <ReachRow note={note} />
            {note.part_name && (
              <Typography variant="subtitle2" fontWeight={700} noWrap>
                {note.part_name}
              </Typography>
            )}
            {note.operation_label && (
              <Chip size="small" label={note.operation_label} variant="outlined" />
            )}
            {note.photo_count > 0 && (
              <Chip
                size="small"
                variant="outlined"
                icon={<PhotoCameraIcon />}
                label={note.photo_count}
              />
            )}
            <Box sx={{ flex: 1 }} />
            <Typography variant="caption" color="text.secondary">
              {formatDate(note.created_at)}
            </Typography>
          </Box>

          {note.body && (
            <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>
              {note.body}
            </Typography>
          )}
        </CardContent>
      </CardActionArea>

      <Collapse in={open} unmountOnExit>
        <Box sx={{ px: 2, pb: 2 }}>
          <Divider sx={{ mb: 1 }} />
          {loading ? (
            <CircularProgress size={16} />
          ) : (
            (viewers ?? []).map((v, i) => (
              <Typography key={`${v.viewer_name}-${i}`} variant="body2" color="text.secondary">
                {v.viewer_name ?? 'Unknown'}
                {v.job_number ? ` · ${v.job_number}` : ''}
              </Typography>
            ))
          )}
        </Box>
      </Collapse>
    </Card>
  );
}

/**
 * My Work — the operator's own contribution and its reception.
 *
 * The destination the login banner has been pointing at with nowhere to go:
 * "3 people used your notes this week" now opens onto which notes, and who.
 *
 * WHAT IS DELIBERATELY ABSENT. No completion count, no streak, no average,
 * nothing comparable against another operator. This screen is exactly where a
 * leaderboard wants to grow, and the guardrail is that no operator-facing
 * surface reflects an operator's pace or standing back at them. Their own
 * output and its reception — nothing else. Completion timestamps exist and are
 * used in owner-side reporting; they never appear here.
 */
export default function MyWorkPage() {
  const params = useParams();
  const companyId = params.companyId as string;

  useSetOperatorChrome(
    { back: { href: `/operator/${companyId}/jobs`, label: 'Back to jobs' } },
    [companyId],
  );

  const { data, loading, error } = useLoad(() => getMyContribution(companyId), [companyId]);

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '50vh' }}>
        <CircularProgress />
      </Box>
    );
  }

  if (error) {
    return (
      <Box sx={{ p: 1 }}>
        <Alert severity="error">Could not load your work. Try again.</Alert>
      </Box>
    );
  }

  const c = data ?? { noteCount: 0, photoCount: 0, peopleReached: 0, jobsReached: 0, notes: [] };

  if (c.noteCount === 0) {
    return (
      <Box sx={{ textAlign: 'center', py: 8, px: 2 }}>
        <Typography variant="h6" color="text.secondary" gutterBottom>
          Nothing written yet
        </Typography>
        <Typography variant="body2" color="text.secondary">
          Notes and photos you add on a step show up here, along with who used them.
        </Typography>
      </Box>
    );
  }

  return (
    <Box sx={{ pb: 4 }}>
      {/* Contribution leads. What you put in comes before what came back —
          the point is that writing things down is the work, not a score. */}
      <Card elevation={2} sx={{ ...cardSx, mb: 3 }}>
        <CardContent>
          <Typography variant="overline" color="text.secondary">
            What you&apos;ve added
          </Typography>
          <Box sx={{ display: 'flex', gap: 4, flexWrap: 'wrap', mt: 0.5 }}>
            <Box>
              <Typography variant="h4" fontWeight={700}>
                {c.noteCount}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                {c.noteCount === 1 ? 'note' : 'notes'}
              </Typography>
            </Box>
            <Box>
              <Typography variant="h4" fontWeight={700}>
                {c.photoCount}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                {c.photoCount === 1 ? 'photo' : 'photos'}
              </Typography>
            </Box>
            {/* "views", not "people". This sums each note's viewer_count, so one
                colleague who read three of your notes contributes three — which
                is a view total, not a headcount. A distinct-people figure would
                need the note_views rows, which no browser role can read by
                design. The per-note numbers below are exact. */}
            <Box>
              <Typography
                variant="h4"
                fontWeight={700}
                sx={{ color: c.peopleReached > 0 ? 'success.light' : 'text.primary' }}
              >
                {c.peopleReached}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                {c.peopleReached === 1 ? 'view' : 'views'}
              </Typography>
            </Box>
          </Box>

          {c.jobsReached > 0 && (
            <Typography variant="body2" sx={{ mt: 2, color: 'success.light' }}>
              {/* The load-bearing signal, and the only one worth a sentence: a note
                  consulted while someone was actually doing the work. */}
              Your notes have been used on{' '}
              {c.jobsReached === 1 ? '1 job' : `${c.jobsReached} jobs`}.
            </Typography>
          )}
        </CardContent>
      </Card>

      <Typography variant="overline" color="text.secondary" sx={{ px: 0.5 }}>
        Your notes
      </Typography>
      <Box sx={{ mt: 0.5 }}>
        {c.notes.map((n) => (
          <NoteRow key={n.id} note={n} />
        ))}
      </Box>
    </Box>
  );
}
