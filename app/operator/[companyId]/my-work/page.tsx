'use client';

import { useCallback, useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useLoad } from '@/hooks/useLoad';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import ButtonBase from '@mui/material/ButtonBase';
import Tooltip from '@mui/material/Tooltip';
import CardContent from '@mui/material/CardContent';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Alert from '@mui/material/Alert';
import Collapse from '@mui/material/Collapse';
import PhotoCameraIcon from '@mui/icons-material/PhotoCamera';
import VisibilityOutlinedIcon from '@mui/icons-material/VisibilityOutlined';
import {
  getMyContributionTotals,
  getMyNotesPage,
  getNoteViewers,
  updateNoteBody,
} from '@/utils/operatorAccess';
import { deleteJobNote } from '@/utils/jobNoteMediaAccess';
import NoteEditDialog from '@/components/notes/NoteEditDialog';
import NoteEditedMark from '@/components/notes/NoteEditedMark';
import NoteDeleteDialog from '@/components/notes/NoteDeleteDialog';
import NoteActionsMenu from '@/components/notes/NoteActionsMenu';
import { useOperatorIdentity } from '@/hooks/useOperatorIdentity';
import { OperatorIdentityRow } from '@/components/operator/OperatorAccountBlock';
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
function ReachRow({
  note,
  expanded,
  onToggle,
}: {
  note: MyNote;
  expanded: boolean;
  /** Omitted when nobody has read it — there are no names to ask for. */
  onToggle?: () => void;
}) {
  const read = note.viewer_count > 0;
  const color = read ? 'success.light' : 'text.secondary';

  const face = (
    <>
      <VisibilityOutlinedIcon sx={{ fontSize: 18, color }} />
      <Typography variant="caption" sx={{ color, fontWeight: 600 }}>
        {note.viewer_count}
      </Typography>
    </>
  );

  // Nobody has read it yet: a number, not a control. This is also what keeps an
  // unread row down to ONE tap target instead of two.
  if (!onToggle) {
    return (
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, width: 48, height: 48, justifyContent: 'center', flexShrink: 0 }}>
        {face}
      </Box>
    );
  }

  /* THE DISCLOSURE FOR "WHO READ THIS", and deliberately not the whole row.
     NN/g measured (136 participants, 11 mobile prototypes) that when a row body
     and a trailing control do different things, people tap them about equally —
     a coin flip. So the row body stays inert and the two controls sit at opposite
     ends: readers here on the left, actions in the overflow on the right.
     The count is the label, which is what keeps a bare icon honest. */
  return (
    <Tooltip title={expanded ? 'Hide readers' : 'Who read this'}>
      <ButtonBase
        onClick={onToggle}
        aria-label={`Who read this note — ${note.viewer_count} so far`}
        aria-expanded={expanded}
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 0.5,
          width: 48,
          height: 48,
          flexShrink: 0,
          borderRadius: 1,
          '&:hover': { bgcolor: 'rgba(255,255,255,0.06)' },
        }}
      >
        {face}
      </ButtonBase>
    </Tooltip>
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
    /*
     * A FLAT ROW WITH TWO CONTROLS AT OPPOSITE ENDS, and an inert body between them.
     *
     * This used to be a card that was one big CardActionArea: tap anywhere to expand,
     * with Edit / Delete / Open-job as full-width buttons inside. Two things were wrong
     * with that. The card chrome cost three notes per phone screen for no information —
     * NN/g puts ~74% of viewing time in the first two screenfuls, and this screen's job
     * is reading. And the per-card `backdrop-filter` was one blurred compositing layer
     * per row, on the one screen that renders an unbounded list of them.
     *
     * The controls are split left and right ON PURPOSE. NN/g measured (136 participants,
     * 11 mobile prototypes) that when a row body and a trailing control do different
     * things, people tap them roughly equally — a coin flip. So the body does nothing at
     * all: readers open from the eye on the left, actions from the overflow on the right,
     * as far apart as the row allows. That also brings this surface into line with the
     * job feed, the Playbook sheet and the machine logbook, which all use the same
     * `NoteActionsMenu` — this screen was the only operator note surface rolling its own.
     */
    <Box component="li" sx={{ borderBottom: '1px solid', borderColor: 'divider', py: 0.5 }}>
      <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 0.5 }}>
        <ReachRow note={note} expanded={open} onToggle={note.viewer_count > 0 ? toggle : undefined} />

        <Box sx={{ flex: 1, minWidth: 0, py: 1 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap', mb: 0.5 }}>
            {note.photo_count > 0 && (
              <Chip
                size="small"
                variant="outlined"
                icon={<PhotoCameraIcon />}
                label={note.photo_count}
              />
            )}
            <Box sx={{ flex: 1 }} />
            {/* WHERE IT CAME FROM — one quiet reference, always in the same place.
                The job number for a job or part note, the machine for a maintenance
                entry; they are mutually exclusive, because a `notes` row has exactly
                one subject under the CHECK constraint.

                It sits here rather than leading the row because the NOTE is the point
                of this screen. An earlier pass put the subject first in bold with the
                step as a chip beside it, and the effect was that a list of what the
                operator had written read as a list of stations — the reference
                out-shouted the sentence it was supposed to annotate. Same reason the
                maintenance kind is plain text here rather than an icon chip: "Noticed"
                is worth knowing and not worth a wrench.

                `part_name` is the last fallback, not a normal case: a durable part note
                outlives the job it was captured on (provenance is ON DELETE SET NULL),
                so once that job is deleted the part is the only reference left. */}
            <Typography variant="caption" color="text.secondary" noWrap>
              {[note.machine_name ?? note.job_number ?? note.part_name, note.maintenance_kind]
                .filter(Boolean)
                .map((s) => `${s} · `)
                .join('')}
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
              the view count above, and the other half of what came back.

              STAYS INLINE, and is not folded in behind the eye with the readers.
              A view is involuntary and private, which is why the names sit behind a
              deliberate tap; a reaction is a voluntary public claim and attribution
              is the whole point of it. The list already caps at three names then
              "+N", so it holds at shop scale. */}
          <NoteReactions
            companyId={companyId}
            noteId={note.id}
            authorId={null}
            reactions={note.reactions}
            memberId={null}
            readOnly
          />
        </Box>

        {/* THE ONLY OTHER CONTROL, hard right. Every note here is unconditionally the
            caller's own — getMyNotesPage filters to author_id = me AND note_type =
            'user' — so there is no permission test to run. */}
        <NoteActionsMenu
          canEdit
          canDelete
          onEdit={() => setEditing(true)}
          onDelete={() => setConfirmingDelete(true)}
          onOpen={
            note.job_id && note.job_number
              ? () => router.push(`/operator/${companyId}/jobs/${note.job_id}`)
              : undefined
          }
          openLabel={note.job_number ? `Open ${note.job_number}` : undefined}
        />
      </Box>

      {/* Readers only. The actions left this disclosure when they moved to the menu,
          so what remains is content rather than a second action surface. */}
      <Collapse in={open} unmountOnExit>
        <Box sx={{ pl: 6.5, pr: 2, pb: 1.5 }}>
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
        </Box>
      </Collapse>

      {/* My work renders photo_count, not thumbnails — you cannot pick a photo to
          remove that you cannot see — so no media is passed and the dialog is
          text-only here. Removing individual photos lives on the three surfaces
          that actually show them. */}
      {/* MOUNTED ONLY WHILE OPEN, like every other call site (JobFeed, PartNotesSheet,
          MachineLogPanel all render `{editingNote && <NoteEditDialog open .../>}`).
          This screen was the exception: it kept one edit dialog and one delete dialog
          mounted per note row at open={false}, so a list of ten notes carried twenty
          idle dialog subtrees. They rendered null, which is why nobody noticed — and
          which is also why the render loop inside NoteEditDialog was invisible while it
          held a core down. The loop is fixed at its source, but a dialog nobody has
          opened should not be mounted at all. */}
      {editing && (
      <NoteEditDialog
        open
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
      )}

      {confirmingDelete && (
      <NoteDeleteDialog
        open
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
      )}
    </Box>
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

  /*
   * NO `useSetOperatorChrome({ back })` HERE, deliberately.
   *
   * Me is a tab root, and a tab root has no "back". The bottom bar already is the way
   * between tabs, so an arrow up here pointed at Jobs — a destination one tap away in
   * the nav — and made a top-level destination read like a page you had wandered into.
   * Declaring no chrome makes the header fall through to the Jigged mark, which is what
   * Jobs, Inventory and Maintenance have always shown; Me was the only tab opting out.
   *
   * The other entry point, NoteUsageBanner on the jobs page, uses a plain `router.push`
   * rather than `useOperatorNav().push`, so it doesn't bump the chrome depth counter
   * either — that route lands on the same back-less root, with no special case.
   */

  const { data: identity } = useOperatorIdentity(companyId);

  /**
   * This is the "Me" tab: who you are and the two account actions, then the work.
   *
   * Both account actions sit ABOVE the work now. They used to sandwich it — Log out last,
   * Give feedback just before it — on the reasoning that the work must lead and a
   * consequential action should be slightly slow to reach. The work still leads visually
   * (a name, an email and a small link are not what the eye lands on), but "below the
   * list" stopped being a place at all once the list could page: a pilot's feedback
   * channel that only appears after ten notes and a Show more is a channel nobody uses,
   * and a Log out you cannot reach is not a safe Log out.
   *
   * This also means neither action depends on the work loading. `MyContribution` owns its
   * own loading/error/empty states rather than early-returning from here, which is what
   * kept a brand-new operator — zero notes, the common case — from losing Log out
   * entirely; now the ordering makes that structural rather than merely careful.
   */
  return (
    <Box sx={{ pb: 4 }}>
      <OperatorIdentityRow companyId={companyId} identity={identity} />
      <MyContribution companyId={companyId} />
    </Box>
  );
}

/**
 * The operator's own notes and their reception. Owns its own loading/error/empty states.
 *
 * Two loads, not one: the summary totals cover EVERY note the operator has written, while
 * the list below is a page at a time. Reducing the totals out of the loaded rows would make
 * "5 notes" mean "5 notes currently rendered" and climb on every Show more.
 */
function MyContribution({ companyId }: { companyId: string }) {
  const {
    data: totals,
    loading,
    error,
    reload: reloadTotals,
  } = useLoad(() => getMyContributionTotals(companyId), [companyId]);

  const {
    data: firstPage,
    error: pageError,
    reload: reloadFirstPage,
  } = useLoad(() => getMyNotesPage(companyId), [companyId]);

  // Pages 2..n, appended. `useLoad` has no append semantics — it replaces — so the extra
  // pages accumulate here and the first page stays owned by the hook, which keeps
  // `reload()` after an edit or delete meaning "go back to one fresh page".
  const [extraPages, setExtraPages] = useState<MyNote[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState(false);
  const [exhausted, setExhausted] = useState(false);

  const notes = useMemo(
    () => [...(firstPage?.notes ?? []), ...extraPages],
    [firstPage, extraPages],
  );
  const hasMore = !exhausted && Boolean(firstPage?.hasMore);

  /** Re-read from scratch after an edit or a delete, so the totals and the list agree. */
  const refresh = useCallback(async () => {
    setExtraPages([]);
    setExhausted(false);
    setMoreError(false);
    await Promise.all([reloadTotals(), reloadFirstPage()]);
  }, [reloadTotals, reloadFirstPage]);

  const loadMore = useCallback(async () => {
    setLoadingMore(true);
    setMoreError(false);
    try {
      const next = await getMyNotesPage(companyId, { offset: notes.length });
      setExtraPages((prev) => [...prev, ...next.notes]);
      if (!next.hasMore) setExhausted(true);
    } catch {
      // Keep what is already on screen and offer the tap again — a failed extra page
      // must not discard the pages that loaded.
      setMoreError(true);
    } finally {
      setLoadingMore(false);
    }
  }, [companyId, notes.length]);

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '30vh' }}>
        <CircularProgress />
      </Box>
    );
  }

  if (error || pageError) {
    return (
      <Box sx={{ p: 1 }}>
        <Alert severity="error">Could not load your work. Try again.</Alert>
      </Box>
    );
  }

  const c = totals ?? { noteCount: 0, photoCount: 0, peopleReached: 0 };

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
        {notes.map((n) => (
          <NoteRow key={n.id} note={n} companyId={companyId} onChanged={refresh} />
        ))}
      </Box>

      {/*
        Show more, not infinite scroll. Everything below this list — Give feedback — moves
        further away with each page, so growing the list has to be something the operator
        asks for. Auto-loading on scroll would make the bottom of the page unreachable by
        design, which is the exact complaint paging was meant to answer.
      */}
      {hasMore && (
        <Box sx={{ display: 'flex', justifyContent: 'center', mt: 1 }}>
          <Button onClick={loadMore} disabled={loadingMore} sx={{ minHeight: 48 }}>
            {loadingMore ? <CircularProgress size={20} /> : 'Show more'}
          </Button>
        </Box>
      )}

      {moreError && (
        <Alert severity="error" sx={{ mt: 1 }}>
          Could not load more notes. Try again.
        </Alert>
      )}
    </Box>
  );
}
