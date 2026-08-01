'use client';

import { useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useLoad } from '@/hooks/useLoad';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import CardActionArea from '@mui/material/CardActionArea';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import Chip from '@mui/material/Chip';
import Divider from '@mui/material/Divider';
import CircularProgress from '@mui/material/CircularProgress';
import Alert from '@mui/material/Alert';
import Collapse from '@mui/material/Collapse';
import PhotoCameraIcon from '@mui/icons-material/PhotoCamera';
import LaunchIcon from '@mui/icons-material/Launch';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import VisibilityOutlinedIcon from '@mui/icons-material/VisibilityOutlined';
import { getMyContribution, getNoteViewers, updateNoteBody } from '@/utils/operatorAccess';
import { deleteJobNote } from '@/utils/jobNoteMediaAccess';
import NoteEditDialog from '@/components/notes/NoteEditDialog';
import NoteEditedMark from '@/components/notes/NoteEditedMark';
import NoteDeleteDialog from '@/components/notes/NoteDeleteDialog';
import { useSetOperatorChrome } from '@/components/operator/OperatorChromeContext';
import { useOperatorIdentity } from '@/hooks/useOperatorIdentity';
import {
  OperatorIdentityRow,
  OperatorAccountActions,
} from '@/components/operator/OperatorAccountBlock';
import NoteReactions from '@/components/operator/NoteReactions';
import type { MyNote, NoteViewer } from '@/types/operator';

const cardSx = { bgcolor: 'rgba(26, 31, 74, 0.55)', backdropFilter: 'blur(8px)' };

function formatDate(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

/**
 * How far one note travelled: one number, one icon.
 *
 * An earlier pass rendered "Not used yet" under every unread note, which on a
 * real screen is a column of seven identical apologies. A view count reads the
 * same at zero as at four — the number just hasn't moved yet.
 *
 * The word is "viewed", never "used". All that was recorded is that someone
 * opened the note and stayed on it; whether they acted on it is not something
 * this product measures, and claiming it would make every number here a small
 * lie the author can personally disprove.
 *
 * usage_count (distinct jobs) is deliberately NOT shown alongside. Once both
 * numbers are honestly labelled "viewed", a second one earns nothing — it reads
 * as a puzzle rather than a signal. It stays on the row because it is the
 * quality signal the Playbook ranks by; it is just not the operator's business
 * on this screen.
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
      </Typography>
    </Box>
  );
}

function NoteRow({
  note,
  companyId,
  onChanged,
}: {
  note: MyNote;
  companyId: string;
  /** Refetch the contribution list after an edit or a delete. */
  onChanged: () => void;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [viewers, setViewers] = useState<NoteViewer[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

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
    <Card component="li" elevation={2} sx={{ ...cardSx, mb: 1.5 }}>
      {/* The whole row expands. Navigation lives inside the expanded state
          instead of on the card, so the list stays compact and there is only one
          tap target per row — a chip up here both bloated the card and stole the
          row's tap, because a button cannot nest inside a button. */}
      <CardActionArea onClick={toggle} sx={{ p: 0 }}>
        <CardContent sx={{ py: 1.5 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap', mb: 0.5 }}>
            {/* Leads the row so every card has a number in the same place — a
                stable column to scan down, present whether or not the note
                carries a part. */}
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
            {/* Where it came from, sat quietly beside the date — an indication,
                not an action. The action is one tap away, inside the card. */}
            <Typography variant="caption" color="text.secondary">
              {note.job_number ? `${note.job_number} · ` : ''}
              {formatDate(note.created_at)}
              <NoteEditedMark editedAt={note.edited_at} />
            </Typography>
          </Box>

          {note.body && (
            <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>
              {note.body}
            </Typography>
          )}

          {/* Read-only by necessity, not omission: RLS forbids reacting to your
              own note, so here endorsements are RECEPTION — the same category as
              the view count above, and the other half of what came back. */}
          <NoteReactions
            companyId={companyId}
            noteId={note.id}
            authorId={null}
            reactions={note.reactions}
            memberId={null}
            readOnly
          />
        </CardContent>
      </CardActionArea>

      <Collapse in={open} unmountOnExit>
        <Box sx={{ px: 2, pb: 2 }}>
          <Divider sx={{ mb: 1 }} />

          {note.viewer_count > 0 && (
            <>
              {/* Explicitly labelled: the job beside a viewer's name is the job
                  THEY consulted it on, not the job in the header where the note
                  was written. Same format, different meaning — so say which. */}
              <Typography variant="overline" color="text.secondary" sx={{ display: 'block' }}>
                Viewed by
              </Typography>
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
            </>
          )}

          {/* THE PRIMARY HOME FOR EDIT AND DELETE (#628), and the one surface that
              needs no permission test at all: getMyContribution already filters to
              author_id = me AND note_type = 'user', so every note on this screen is
              unconditionally the caller's own editable note.

              Full-width buttons rather than the kebab used in the feeds, because
              the card is one big CardActionArea and a button cannot nest inside a
              button — the same constraint that put navigation down here in the
              first place. */}
          <Box
            sx={{
              display: 'flex',
              gap: 1,
              mt: note.viewer_count > 0 ? 1.5 : 0,
            }}
          >
            <Button
              variant="outlined"
              fullWidth
              startIcon={<EditOutlinedIcon />}
              onClick={() => setEditing(true)}
              sx={{ minHeight: 48 }}
            >
              Edit
            </Button>
            <Button
              variant="outlined"
              color="error"
              fullWidth
              startIcon={<DeleteOutlineIcon />}
              onClick={() => setConfirmingDelete(true)}
              sx={{ minHeight: 48 }}
            >
              Delete
            </Button>
          </Box>

          {note.job_id && note.job_number && (
            <Button
              variant="outlined"
              fullWidth
              startIcon={<LaunchIcon />}
              onClick={() => router.push(`/operator/${companyId}/jobs/${note.job_id}`)}
              sx={{ minHeight: 48, mt: 1.5 }}
            >
              Open {note.job_number}
            </Button>
          )}
        </Box>
      </Collapse>

      {/* My work renders photo_count, not thumbnails — you cannot pick a photo to
          remove that you cannot see — so no media is passed and the dialog is
          text-only here. Removing individual photos lives on the three surfaces
          that actually show them. */}
      <NoteEditDialog
        open={editing}
        initialBody={note.body}
        saving={busy}
        error={actionError}
        onClose={() => {
          setEditing(false);
          setActionError(null);
        }}
        onSave={async ({ body }) => {
          setBusy(true);
          setActionError(null);
          try {
            await updateNoteBody(note.id, body);
            setEditing(false);
            onChanged();
          } catch (err) {
            setActionError(err instanceof Error ? err.message : 'Could not save that change.');
          } finally {
            setBusy(false);
          }
        }}
      />

      <NoteDeleteDialog
        open={confirmingDelete}
        deleting={busy}
        error={actionError}
        onClose={() => {
          setConfirmingDelete(false);
          setActionError(null);
        }}
        onConfirm={async () => {
          setBusy(true);
          setActionError(null);
          try {
            // Reuses the existing helper, which reads the media storage paths
            // BEFORE the cascade drops the rows and then removes the files. It has
            // existed unused since the media work; this is its first caller.
            await deleteJobNote(note.id);
            setConfirmingDelete(false);
            onChanged();
          } catch (err) {
            setActionError(err instanceof Error ? err.message : 'Could not delete that note.');
          } finally {
            setBusy(false);
          }
        }}
      />
    </Card>
  );
}

/**
 * My Work — the operator's own contribution and its reception.
 *
 * The destination the login banner has been pointing at with nowhere to go:
 * "3 people viewed your notes this week" now opens onto which notes, and who.
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

  const { data: identity } = useOperatorIdentity(companyId);

  /**
   * This is the "Me" tab: identity, then the work, then account actions.
   *
   * The work is sandwiched rather than replaced — see `OperatorAccountBlock` for why the work
   * has to lead and why Log out sits at the very bottom.
   *
   * The three loading/error/empty states are INSIDE `MyContribution` on purpose. They used to
   * be early returns from this component, and leaving them there once Profile stopped being a
   * tab would have meant a brand-new operator — the case with zero notes, i.e. the common one —
   * had no Log out button anywhere in the app.
   */
  return (
    <Box sx={{ pb: 4 }}>
      <OperatorIdentityRow identity={identity} />
      <MyContribution companyId={companyId} />
      <OperatorAccountActions companyId={companyId} identity={identity} />
    </Box>
  );
}

/** The operator's own notes and their reception. Owns its own loading/error/empty states. */
function MyContribution({ companyId }: { companyId: string }) {
  const { data, loading, error, reload } = useLoad(
    () => getMyContribution(companyId),
    [companyId],
  );

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '30vh' }}>
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
      <Box sx={{ textAlign: 'center', py: 6, px: 2 }}>
        <Typography variant="h6" color="text.secondary" gutterBottom>
          Nothing written yet
        </Typography>
        <Typography variant="body2" color="text.secondary">
          Notes and photos you add on a step show up here, along with who has viewed them.
        </Typography>
      </Box>
    );
  }

  return (
    <Box>
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

        </CardContent>
      </Card>

      <Typography variant="overline" color="text.secondary" sx={{ px: 0.5 }}>
        Your notes
      </Typography>
      {/* A real list: it is one semantically, screen readers announce the count,
          and each card becomes an addressable item rather than an anonymous div. */}
      <Box component="ul" sx={{ mt: 0.5, listStyle: 'none', p: 0, m: 0 }}>
        {c.notes.map((n) => (
          <NoteRow key={n.id} note={n} companyId={companyId} onChanged={reload} />
        ))}
      </Box>
    </Box>
  );
}
