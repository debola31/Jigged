'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useLoad } from '@/hooks/useLoad';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import BusyButton from '@/components/common/BusyButton';
import Chip from '@mui/material/Chip';
import Divider from '@mui/material/Divider';
import IconButton from '@mui/material/IconButton';
import CircularProgress from '@mui/material/CircularProgress';
import Alert from '@mui/material/Alert';
import Dialog from '@mui/material/Dialog';
import DialogContent from '@mui/material/DialogContent';
import DynamicFeedIcon from '@mui/icons-material/DynamicFeed';
import CloseIcon from '@mui/icons-material/Close';
import PlayCircleOutlineIcon from '@mui/icons-material/PlayCircleOutline';
import { formatStopwatch } from '@/lib/duration';
import { getJobNotes, getCurrentMember, updateNoteBody } from '@/utils/operatorAccess';
import NoteReactions from '@/components/operator/NoteReactions';
import NoteActionsMenu from '@/components/notes/NoteActionsMenu';
import NoteEditedMark from '@/components/notes/NoteEditedMark';
import NoteEditDialog from '@/components/notes/NoteEditDialog';
import NoteDeleteDialog from '@/components/notes/NoteDeleteDialog';
import {
  getJobNoteMediaUrl,
  deleteJobNote,
  deleteJobNoteMedia,
} from '@/utils/jobNoteMediaAccess';
import { useNoteDwell } from '@/hooks/useNoteDwell';
import { useNoteCapture, useStepNoteWriter } from '@/hooks/useNoteCapture';
import NoteCaptureFields from '@/components/operator/NoteCaptureFields';
import type { JobNote, JobNoteMedia } from '@/types/operator';
import FeedTimeEntry from '@/components/operator/FeedTimeEntry';
import FeedUntimedEntry from '@/components/operator/FeedUntimedEntry';
import AdjustTimesDialog from '@/components/operator/AdjustTimesDialog';
import { getMyIntervalsForJob, adjustOperationInterval } from '@/utils/operationIntervalsAccess';
import { getFeedCompletionsForJob } from '@/utils/operationCompletionsAccess';
import type { JobFeedCompletion } from '@/utils/operationCompletionsAccess';
import type { OperationIntervalWithContext } from '@/types/operationInterval';

/** A note or one end of a recorded interval, merged into one chronological list. */
type TimelineItem = {
  key: string;
  at: string;
  note?: JobNote;
  interval?: OperationIntervalWithContext;
  edge?: 'start' | 'finish';
  /** A completion no interval claims — the `Complete without timing` path. */
  untimed?: JobFeedCompletion;
};

/** Stable empty array so useLoad's null does not remake the timeline every render. */
const EMPTY_INTERVALS: OperationIntervalWithContext[] = [];
const EMPTY_COMPLETIONS: JobFeedCompletion[] = [];

const cardSx = { bgcolor: 'rgba(26, 31, 74, 0.55)', backdropFilter: 'blur(8px)' };
const THUMB = 76;

// Stable empty fallback so the merge memo doesn't churn while the first load runs.
const EMPTY_NOTES: JobNote[] = [];

/**
 * What a capture on this surface is ABOUT, and the only thing that differs
 * between the two places this feed is mounted.
 *
 * The operation page passes a step, so every capture is auto-tagged to it — no
 * step selector, which is the decision this feed was built around. The traveler
 * passes the part with a NULL step, because an operator looking at the whole
 * list has not picked one and should not have to; that lands as a job-subject
 * note, which the feed already renders.
 *
 * Omitted entirely only when there is no job context at all, which no caller
 * does today — the composer then simply does not render.
 */
export interface JobFeedOperationContext {
  jobPartId: string;
  jobOperationId: string | null;
}

interface JobFeedProps {
  jobId: string;
  companyId: string;
  /** What captures are tagged to. Without it there is no composer. */
  operationContext?: JobFeedOperationContext;
  /**
   * Bumped by the parent after a STEP ACTION — start, complete, cancel — so the
   * feed reloads to show the row that action created.
   *
   * It also drives the unposted-draft warning below, because those are the exact
   * moments a staged note is most likely to be forgotten.
   */
  refreshSignal?: number;
}

// The dictation hint and the pending-photo pipeline moved into
// hooks/useNoteCapture.ts, so the completion block and this feed render one
// implementation rather than two.

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

/** A pending photo the operator picked but hasn't posted yet. */
/**
 * The job feed: one append-only stream per job (job-level + operation-tagged
 * notes, each with optional photos). Captured on the operation page (composer
 * auto-tagged to the step) and read on both the operation page and the traveler.
 * Listing is a plain Supabase read (no AI on mount).
 */
export default function JobFeed({
  jobId,
  companyId,
  operationContext,
  refreshSignal,
}: JobFeedProps) {
  const [error, setError] = useState<string | null>(null);
  // Notes posted optimistically (prepended before the next full load). Deduped
  // out of the merged list once they show up in a fresh load by id.
  const [pendingNotes, setPendingNotes] = useState<JobNote[]>([]);

  const [operatorId, setOperatorId] = useState<string | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [editingNote, setEditingNote] = useState<JobNote | null>(null);
  const [deletingNote, setDeletingNote] = useState<JobNote | null>(null);
  const [rowBusy, setRowBusy] = useState(false);
  const [rowError, setRowError] = useState<string | null>(null);

  // Signed URLs for media thumbnails, keyed by media id (fetched on demand).
  const [mediaUrls, setMediaUrls] = useState<Record<string, string>>({});
  // Full-size viewer.
  const [viewer, setViewer] = useState<{ url: string; kind: JobNoteMedia['kind'] } | null>(null);

  const writer = useStepNoteWriter({
    companyId,
    jobId,
    operatorId,
    context: operationContext ?? null,
  });

  /**
   * THE ONLY COMPOSER, on every branch of every surface that has a job context.
   *
   * It used to be switched off wherever the operation page's completion block
   * rendered capture instead, which made saving a note something you could only
   * do by finishing the step — see the hook's header for how that came about.
   * There is one composer now and it is always this one, so there is no branch
   * left where capture goes missing and none where two appear.
   *
   * KEYED ON THE CONTEXT, NOT ON THE WRITER, and that distinction is load-bearing
   * rather than stylistic. `writer` is null until `getCurrentMember` resolves, so
   * gating on it would make this false on the first render — and `useNoteCapture`
   * reads `enabled` AT MOUNT for two things that never re-evaluate: the mic hint's
   * initial state and the `composer_abandoned` cleanup, whose effect has empty
   * deps. Both would have gone permanently silent, and neither would have looked
   * broken. The Post button carries the not-loaded-yet case instead, where it is
   * visible.
   */
  const showComposer = !!operationContext;
  const capture = useNoteCapture({ companyId, operatorId, writer, enabled: showComposer });

  // Read tracking. The feed is where an operator encounters other people's notes
  // in the course of a job, so it is the surface the whole loop is measuring.
  const { observe } = useNoteDwell(companyId, jobId);

  const {
    data: loadedNotesData,
    loading,
    reload: load,
    refresh: refreshNotes,
  } = useLoad(() => getJobNotes(jobId, companyId), [jobId, companyId], {
    onError: (err) => {
      setError(err instanceof Error ? err.message : 'Could not load the feed.');
    },
  });
  const loadedNotes = loadedNotesData ?? EMPTY_NOTES;

  // The caller's OWN recorded time on this job. Notes here belong to everyone;
  // time entries do not — see FeedTimeEntry for why that asymmetry is deliberate.
  const { data: intervalsData, refresh: reloadIntervals } = useLoad(
    () => getMyIntervalsForJob(companyId, jobId),
    [companyId, jobId],
  );
  const intervals = intervalsData ?? EMPTY_INTERVALS;

  // The caller's own completions PLUS every office-recorded one, so the ones NO
  // interval claims can still appear. Loaded separately rather than folded into
  // the intervals query because it is the absence of an interval that makes a
  // completion interesting here, and an absence cannot be expressed as a join to
  // one — and because office rows have no interval to join through at all.
  const { data: completionsData, refresh: reloadCompletions } = useLoad(
    () => getFeedCompletionsForJob(companyId, jobId),
    [companyId, jobId],
  );
  const completions = completionsData ?? EMPTY_COMPLETIONS;

  // Which recorded time the operator is correcting, and WHICH END. Adjust is
  // offered on the row showing the wrong number, so the dialog opens on that
  // field rather than asking about both.
  const [adjusting, setAdjusting] = useState<{
    interval: OperationIntervalWithContext;
    edge: 'start' | 'finish';
  } | null>(null);
  const [adjustError, setAdjustError] = useState<string | null>(null);
  const [adjustSaving, setAdjustSaving] = useState(false);

  // Merge optimistic posts ahead of the loaded feed, dropping any that the
  // latest load already includes (matched by id) so there are no duplicates.
  const notes = useMemo(() => {
    if (pendingNotes.length === 0) return loadedNotes;
    const loadedIds = new Set(loadedNotes.map((n) => n.id));
    const stillPending = pendingNotes.filter((n) => !loadedIds.has(n.id));
    return [...stillPending, ...loadedNotes];
  }, [loadedNotes, pendingNotes]);

  /**
   * Notes and time events in one chronological list, newest first.
   *
   * An interval contributes TWO entries — a start and, once closed, a finish —
   * because a feed is a log and a row that rewrites itself after the fact reads
   * as the surface losing track. Each is keyed by interval id plus which end it
   * represents, so the two never collide.
   */
  const timeline = useMemo(() => {
    const items: TimelineItem[] = notes.map((note) => ({
      key: `note-${note.id}`,
      at: note.created_at,
      note,
    }));
    for (const interval of intervals) {
      items.push({
        key: `start-${interval.id}`,
        at: interval.effective_started_at,
        interval,
        edge: 'start',
      });
      if (interval.effective_ended_at) {
        items.push({
          key: `finish-${interval.id}`,
          at: interval.effective_ended_at,
          interval,
          edge: 'finish',
        });
      }
    }

    // A completion an interval already claims is ALREADY on the timeline as that
    // interval's Finished row, carrying the same quantity — so adding it again
    // here would double every timed completion. What is left is the untimed
    // ones. `intervals` is loaded pre-filtered to non-voided, which is also what
    // makes a completion whose interval was voided fall through to untimed
    // rather than vanishing.
    const claimed = new Set(
      intervals.map((i) => i.completion_id).filter((id): id is string => id != null),
    );
    for (const completion of completions) {
      if (claimed.has(completion.id)) continue;
      items.push({
        key: `untimed-${completion.id}`,
        at: completion.completed_at,
        untimed: completion,
      });
    }

    return items.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
  }, [notes, intervals, completions]);

  // Resolved unconditionally, not just when the composer is shown: reactions need
  // the member id on the read-only traveler feed too, both to know whether the
  // reader has already reacted and to hide the control on their own notes.
  useEffect(() => {
    let active = true;
    getCurrentMember(companyId).then((op) => {
      if (active && op) {
        setOperatorId(op.id);
        setIsAdmin(op.role === 'admin');
      }
    });
    return () => {
      active = false;
    };
  }, [companyId]);

  /**
   * An unposted draft, and the two halves of saying so.
   *
   * THIS IS THE HAZARD THE OLD MERGED COMMIT EXISTED TO PREVENT. Capture and
   * completion were welded into one button because a two-stage commit lost
   * photos: the thumbnail showed, the flow read as finished, a back tap discarded
   * it and nothing said so. Splitting them apart again re-opens that, so it has
   * to be answered — but every way of REMEMBERING the moment it happens is
   * closed. `set-state-in-effect` is the repo's ratcheting warning budget,
   * `set-state-in-render` is an error, and so is reading a ref during render
   * (all three ship in eslint-plugin-react-hooks' recommended preset, which
   * eslint-config-next spreads; only the first is downgraded in
   * eslint.config.mjs). Every history-keeping version of this needed one of them.
   *
   * That constraint produced a better answer than the one it refused. Rather than
   * a warning that fires once and has to be remembered, there is:
   *
   *   1. A STATUS LINE derived from nothing but the draft itself, so it is true
   *      the whole time the risk exists rather than only in the moment we guessed
   *      the operator was about to walk away. Quiet, not an alert: it reports a
   *      state, and something that shouts while you are still typing teaches
   *      people to ignore it.
   *   2. A SCROLL, when a step action lands while a draft is staged. That is the
   *      moment the status line would go unread — it sits below the button just
   *      tapped, which on a phone has already scrolled past. Bringing it back is
   *      the part that has to be an event, and it is the only part that needs the
   *      history, so ALL of it lives inside the effect where a ref is legal.
   */
  const hasUnpostedDraft = capture.hasContent;

  const composerRef = useRef<HTMLDivElement | null>(null);
  const draftSinceSignal = useRef<number | undefined>(undefined);
  useEffect(() => {
    const signal = refreshSignal ?? 0;
    if (!capture.hasContent) {
      draftSinceSignal.current = undefined;
      return;
    }
    if (draftSinceSignal.current === undefined) {
      draftSinceSignal.current = signal;
      return;
    }
    if (draftSinceSignal.current === signal) return;
    // A step action landed on top of this draft. Move the goalposts first, so a
    // later re-render cannot scroll a second time for the same action.
    draftSinceSignal.current = signal;
    // Optional-call: jsdom does not implement scrollIntoView, and this is a
    // nicety rather than behaviour worth throwing over — the same `?.()` guard
    // NoteCaptureFields uses for the same reason.
    composerRef.current?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
  }, [capture.hasContent, refreshSignal]);

  // Reflect a write the PARENT made — a start, a completion, a cancelled timer.
  // Ignores the initial undefined/0 so a mount does not double-load.
  const lastRefresh = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!refreshSignal) return;
    if (refreshSignal === lastRefresh.current) return;
    lastRefresh.current = refreshSignal;
    // `refresh`, not `load`: the parent bumps this right after a write, and
    // blanking the feed to a spinner at the exact moment its new entry arrives
    // is the worst possible time to do it.
    refreshNotes();
    // Intervals too: the parent bumps this after starting, stopping or
    // completing, and those are feed entries now rather than just notes.
    reloadIntervals();
    // AND completions, or `Complete without timing` writes a row this feed never
    // goes back for — it records no interval, so reloading intervals alone
    // leaves the one path whose whole point is appearing here still invisible.
    reloadCompletions();
  }, [refreshSignal, refreshNotes, reloadIntervals, reloadCompletions]);

  // Fetch signed URLs for any media we don't already have a URL for.
  useEffect(() => {
    const missing = notes
      .flatMap((n) => n.media)
      .filter((m) => !mediaUrls[m.id]);
    if (missing.length === 0) return;
    let active = true;
    Promise.all(
      missing.map(async (m) => {
        try {
          return [m.id, await getJobNoteMediaUrl(m.thumbnail_path ?? m.storage_path)] as const;
        } catch {
          return null;
        }
      }),
    ).then((pairs) => {
      if (!active) return;
      const next: Record<string, string> = {};
      for (const p of pairs) if (p) next[p[0]] = p[1];
      if (Object.keys(next).length > 0) setMediaUrls((prev) => ({ ...prev, ...next }));
    });
    return () => {
      active = false;
    };
  }, [notes, mediaUrls]);

  // Preview-URL cleanup, the draft snapshot and composer_abandoned all moved into
  // useNoteCapture, so they fire for whichever surface owns capture.

  // The photo pipeline, the dictation hint and the note+media write live in
  // useNoteCapture, shared with the machine log. All that is left here is what
  // "Post" means on THIS surface: write it, then show it optimistically.

  /**
   * What Post is waiting for. Media is the whole reason this is not "Saving…":
   * a text note is a fast insert, a clip is a multi-minute transfer, and the
   * operator cannot tell which they are in without being told.
   */
  const photoCount = capture.pending.filter((m) => m.kind === 'photo').length;
  const videoCount = capture.pending.filter((m) => m.kind === 'video').length;
  const postPendingLabel =
    videoCount > 0
      ? videoCount > 1
        ? 'Uploading videos…'
        : 'Uploading video…'
      : photoCount > 0
        ? photoCount > 1
          ? 'Uploading photos…'
          : 'Uploading photo…'
        : 'Posting…';

  const handlePost = async () => {
    try {
      const note = await capture.submit();
      if (note) setPendingNotes((prev) => [note, ...prev]);
    } catch {
      // useNoteCapture surfaces the message in the fields. A note may exist with
      // partial media, so reload to show what is actually there rather than the
      // optimistic guess.
      load();
    }
  };

  const openViewer = async (media: JobNoteMedia) => {
    try {
      setViewer({ url: await getJobNoteMediaUrl(media.storage_path), kind: media.kind });
    } catch {
      setError(media.kind === 'video' ? 'Could not open the video.' : 'Could not open the photo.');
    }
  };

  return (
    <>
      {/* CAPTURE IS ITS OWN CARD, AND ITS OWN COMMIT.
          It sits above the feed and BELOW whatever the parent renders — on the
          step screen that is the action block, so the primary button does not
          move down to make room for it. Taking these fields back out of the
          completion block is what shortened that block, and the button actually
          moved up.
          A separate card rather than a section inside the feed because the two
          are different acts: one is what you are writing, the other is what has
          already happened. Reading them as one surface is how a staged draft came
          to look like something already saved. */}
      {showComposer && (
        <Card elevation={2} sx={{ ...cardSx, mb: 2 }} ref={composerRef}>
          <CardContent sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
            <NoteCaptureFields
              capture={capture}
              placeholder={
                operationContext?.jobOperationId
                  ? 'Add a note or photo for this step…'
                  : 'Add a note or photo for this job…'
              }
            />
            {/* Shares the button's row rather than taking one of its own: this
                screen's failure mode is crowding, and a status line is not worth
                a line of height. */}
            <Box
              sx={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 1,
              }}
            >
              <Typography variant="body2" color="text.secondary">
                {hasUnpostedDraft ? 'Not posted yet' : ''}
              </Typography>
              {/* NAMES THE WAIT, because on this surface the wait is not a
                  Supabase round trip — `submit` puts every file in the bucket
                  BEFORE the note row, and a full-length clip is ~23 MB over shop
                  cellular. That is interaction-standards §5's 1–10s row, where a
                  silent spinner is a WCAG 4.1.3 gap rather than a style choice.
                  The label says which of the two waits it is, since "posting a
                  sentence" and "pushing 23 MB up a bar of signal" are minutes
                  apart. */}
              <BusyButton
                variant="contained"
                onClick={handlePost}
                // `!writer` is the brief window before getCurrentMember resolves.
                // Disabled rather than letting the tap through, because `submit`
                // returns null without a writer — a Post that silently does
                // nothing is the worse of the two.
                disabled={!writer || !capture.hasContent || capture.saving}
                pending={capture.saving}
                pendingLabel={postPendingLabel}
                sx={{ minHeight: 48 }}
              >
                Post
              </BusyButton>
            </Box>
          </CardContent>
        </Card>
      )}

      <Card elevation={2} sx={cardSx}>
      <CardContent>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1.5 }}>
          <DynamicFeedIcon fontSize="small" color="action" />
          <Typography variant="h6" color="text.secondary">
            Job Feed
          </Typography>
        </Box>

        {error && (
          <Alert severity="error" sx={{ mb: 1 }} onClose={() => setError(null)}>
            {error}
          </Alert>
        )}

        {loading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 2 }}>
            <CircularProgress size={20} />
          </Box>
        ) : timeline.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            No activity yet.
          </Typography>
        ) : (
          <Box sx={{ display: 'flex', flexDirection: 'column' }}>
            {timeline.map((item, idx) => {
              // A recorded start or finish. Rendered before the note branch so
              // the rest of this block can keep assuming `note` exists.
              if (item.untimed) {
                return (
                  <Box key={item.key}>
                    {idx > 0 && <Divider sx={{ my: 1 }} />}
                    <FeedUntimedEntry completion={item.untimed} />
                  </Box>
                );
              }
              if (item.interval && item.edge) {
                return (
                  <Box key={item.key}>
                    {idx > 0 && <Divider sx={{ my: 1 }} />}
                    <FeedTimeEntry
                      interval={item.interval}
                      kind={item.edge}
                      onAdjust={() => setAdjusting({ interval: item.interval!, edge: item.edge! })}
                    />
                  </Box>
                );
              }
              const note = item.note!;
              return (
              <Box key={note.id}>
                {idx > 0 && <Divider sx={{ my: 1 }} />}
                <Box
                  sx={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    gap: 1,
                    mb: 0.25,
                  }}
                >
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0 }}>
                    <Typography variant="subtitle2" fontWeight={700} noWrap>
                      {note.author_name || 'Unknown'}
                    </Typography>
                    {note.operation_label && (
                      <Chip size="small" label={note.operation_label} variant="outlined" />
                    )}
                  </Box>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, flexShrink: 0 }}>
                    <Typography variant="caption" color="text.secondary">
                      {formatTimestamp(note.created_at)}
                      <NoteEditedMark editedAt={note.edited_at} />
                    </Typography>
                    {/* 'event' notes are the auto-logged audit trail (e.g. an
                        order-quantity change) — never editable, never deletable.
                        RLS refuses them too, so this gate stops a guaranteed
                        42501 rendering as a broken button. */}
                    {note.note_type === 'user' && (
                      <NoteActionsMenu
                        canEdit={operatorId !== null && note.author_id === operatorId}
                        canDelete={
                          operatorId !== null &&
                          (note.author_id === operatorId || isAdmin)
                        }
                        onEdit={() => {
                          setRowError(null);
                          setEditingNote(note);
                        }}
                        onDelete={() => {
                          setRowError(null);
                          setDeletingNote(note);
                        }}
                      />
                    )}
                  </Box>
                </Box>

                {/* The observed element is the BODY, deliberately. Observing the
                    card would count a header scrolling past as a read. */}
                {note.body && (
                  <Typography
                    ref={observe(note.id)}
                    variant="body2"
                    sx={{ whiteSpace: 'pre-wrap' }}
                  >
                    {note.body}
                  </Typography>
                )}

                {note.media.length > 0 && (
                  <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, mt: 0.5 }}>
                    {note.media.map((m) => {
                      const url = mediaUrls[m.id];
                      // See NoteMediaGallery: the signed URL falls back to
                      // storage_path, so a poster-less clip must never reach an
                      // <img> — it paints nothing and costs the whole file.
                      const posterless = m.kind === 'video' && !m.thumbnail_path;
                      const showImage = !!url && !posterless;
                      return (
                        <Box
                          key={m.id}
                          onClick={() => url && openViewer(m)}
                          sx={{
                            position: 'relative',
                            width: THUMB,
                            height: THUMB,
                            borderRadius: 1,
                            overflow: 'hidden',
                            cursor: url ? 'pointer' : 'default',
                            bgcolor: 'rgba(255,255,255,0.06)',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                          }}
                        >
                          {showImage ? (
                            <Box
                              component="img"
                              src={url}
                              alt={m.kind === 'video' ? 'Job video' : 'Job photo'}
                              sx={{ width: '100%', height: '100%', objectFit: 'cover' }}
                            />
                          ) : posterless ? (
                            <PlayCircleOutlineIcon sx={{ color: 'text.secondary' }} />
                          ) : (
                            <CircularProgress size={16} />
                          )}
                          {m.kind === 'video' && showImage && (
                            <PlayCircleOutlineIcon
                              sx={{
                                position: 'absolute',
                                top: '50%',
                                left: '50%',
                                transform: 'translate(-50%, -50%)',
                                color: 'common.white',
                                pointerEvents: 'none',
                              }}
                            />
                          )}
                          {m.kind === 'video' && m.duration_seconds != null && (
                            <Typography
                              variant="caption"
                              sx={{
                                position: 'absolute',
                                bottom: 2,
                                right: 3,
                                px: 0.5,
                                borderRadius: 0.5,
                                bgcolor: 'rgba(0,0,0,0.6)',
                                color: 'common.white',
                                fontVariantNumeric: 'tabular-nums',
                                pointerEvents: 'none',
                              }}
                            >
                              {formatStopwatch(m.duration_seconds * 1000)}
                            </Typography>
                          )}
                        </Box>
                      );
                    })}
                  </Box>
                )}

                {/* Auto-logged 'event' rows are system audit entries, not somebody's
                    contribution — there is nothing to endorse. */}
                {note.note_type === 'user' && (
                  <NoteReactions
                    companyId={companyId}
                    noteId={note.id}
                    authorId={note.author_id}
                    reactions={note.reactions}
                    memberId={operatorId}
                  />
                )}
              </Box>
              );
            })}
          </Box>
        )}
      </CardContent>

      {/* Correcting a recorded time, from the row that shows it. Mounted only
          while open so its state seeds fresh on each use, and it writes
          IMMEDIATELY — holding a correction in page state is how it gets lost.

          ONLY REACHABLE ON A CLOSED INTERVAL: FeedTimeEntry hides Adjust while
          the clock runs, so `effective_ended_at` is never null here. That is
          what makes the dialog's `duration <= 0` guard meaningful — with one end
          missing it has nothing to compare and silently permits an inversion,
          which is the client half of job_op_intervals_effective_ordered. */}
      {adjusting && (
        <AdjustTimesDialog
          open
          onClose={() => {
            setAdjusting(null);
            setAdjustError(null);
          }}
          saving={adjustSaving}
          saveError={adjustError}
          onSave={async (next) => {
            setAdjustSaving(true);
            setAdjustError(null);
            try {
              await adjustOperationInterval(adjusting.interval.id, {
                adjustedStartedAt: next.startedAt,
                adjustedEndedAt: next.endedAt,
              });
              setAdjusting(null);
              await reloadIntervals();
            } catch (err) {
              // STAYS OPEN. Closing here is what made a rejected write look
              // identical to a successful one — the message went to a state
              // nothing rendered and the operator's input was discarded with it.
              setAdjustError(err instanceof Error ? err.message : 'Could not save those times.');
            } finally {
              setAdjustSaving(false);
            }
          }}
          rawStartedAt={adjusting.interval.started_at}
          rawEndedAt={adjusting.interval.ended_at}
          effectiveStartedAt={adjusting.interval.effective_started_at}
          effectiveEndedAt={adjusting.interval.effective_ended_at}
        />
      )}

      {/* Full-size media viewer — an image or a clip, per `kind`. */}
      <Dialog open={!!viewer} onClose={() => setViewer(null)} fullScreen>
        <IconButton
          aria-label="Close"
          onClick={() => setViewer(null)}
          sx={{ position: 'absolute', right: 12, top: 12, zIndex: 1, color: 'common.white' }}
        >
          <CloseIcon />
        </IconButton>
        <DialogContent
          sx={{
            p: 0,
            bgcolor: 'background.default',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {viewer?.kind === 'video' ? (
            /* No autoPlay — see NoteMediaGallery. Tapping a thumbnail is not consent
               to spend tens of megabytes of cellular data. */
            <Box
              component="video"
              src={viewer.url}
              controls
              playsInline
              preload="metadata"
              sx={{ maxWidth: '100%', maxHeight: '100%' }}
            />
          ) : viewer ? (
            <Box
              component="img"
              src={viewer.url}
              alt="Job photo"
              sx={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
            />
          ) : null}
        </DialogContent>
      </Dialog>

      {editingNote && (
      <NoteEditDialog
        key={editingNote.id}
        open
        initialBody={editingNote.body}
        media={editingNote.media}
        saving={rowBusy}
        error={rowError}
        onClose={() => {
          setEditingNote(null);
          setRowError(null);
        }}
        onSave={async ({ body, removedMediaIds }) => {
          if (!editingNote) return;
          setRowBusy(true);
          setRowError(null);
          try {
            // Body first: it is the statement most likely to be refused (RLS, or
            // the billing gate on a lapsed shop), so it fails before anything
            // irreversible happens to the photos.
            await updateNoteBody(editingNote.id, body);
            for (const id of removedMediaIds) {
              const m = editingNote.media.find((x) => x.id === id);
              if (m) await deleteJobNoteMedia({
                id: m.id,
                storage_path: m.storage_path,
                // A clip's poster goes with it. Without this the row and the clip
                // disappear and the thumbnail stays in the bucket, named by nothing.
                thumbnail_path: m.thumbnail_path,
              });
            }
            setEditingNote(null);
            await load();
          } catch (err) {
            setRowError(err instanceof Error ? err.message : 'Could not save that change.');
          } finally {
            setRowBusy(false);
          }
        }}
      />
      )}

      <NoteDeleteDialog
        open={deletingNote !== null}
        deleting={rowBusy}
        error={rowError}
        onClose={() => {
          setDeletingNote(null);
          setRowError(null);
        }}
        onConfirm={async () => {
          if (!deletingNote) return;
          setRowBusy(true);
          setRowError(null);
          try {
            await deleteJobNote(deletingNote.id);
            setDeletingNote(null);
            // Also clears any optimistic copy still in pendingNotes: the merge
            // drops pending entries the reload no longer returns, so a deleted
            // note cannot linger as a ghost row.
            setPendingNotes((prev) => prev.filter((n) => n.id !== deletingNote.id));
            await load();
          } catch (err) {
            setRowError(err instanceof Error ? err.message : 'Could not delete that note.');
          } finally {
            setRowBusy(false);
          }
        }}
      />
      </Card>
    </>
  );
}
