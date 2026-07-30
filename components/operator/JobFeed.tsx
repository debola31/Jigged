'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useLoad } from '@/hooks/useLoad';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Divider from '@mui/material/Divider';
import IconButton from '@mui/material/IconButton';
import CircularProgress from '@mui/material/CircularProgress';
import Alert from '@mui/material/Alert';
import Dialog from '@mui/material/Dialog';
import DialogContent from '@mui/material/DialogContent';
import DynamicFeedIcon from '@mui/icons-material/DynamicFeed';
import CloseIcon from '@mui/icons-material/Close';
import { getJobNotes, getCurrentMember } from '@/utils/operatorAccess';
import NoteReactions from '@/components/operator/NoteReactions';
import { getJobNoteMediaUrl } from '@/utils/jobNoteMediaAccess';
import { useNoteDwell } from '@/hooks/useNoteDwell';
import { useNoteCapture, useStepNoteWriter } from '@/hooks/useNoteCapture';
import NoteCaptureFields from '@/components/operator/NoteCaptureFields';
import type { JobNote, JobNoteMedia } from '@/types/operator';

const cardSx = { bgcolor: 'rgba(26, 31, 74, 0.55)', backdropFilter: 'blur(8px)' };
const THUMB = 76;

// Stable empty fallback so the merge memo doesn't churn while the first load runs.
const EMPTY_NOTES: JobNote[] = [];

/**
 * Context the operation page passes so the composer auto-tags every capture to
 * the step the operator is working — no step selector. The traveler omits this
 * (read-only) and renders the same rolled-up feed.
 */
export interface JobFeedOperationContext {
  jobPartId: string;
  jobOperationId: string;
}

interface JobFeedProps {
  jobId: string;
  companyId: string;
  /** Read-only feed (traveler). When true, no composer is shown. */
  readOnly?: boolean;
  /** Set on the operation page to auto-tag captures to the step. */
  operationContext?: JobFeedOperationContext;
  /**
   * Bumped by the parent after IT writes a note, so the feed reloads and shows
   * it. Replaces captureOfferSignal: capture now happens inside the completion
   * block, so the feed's job is to reflect a write rather than to prompt for one.
   */
  refreshSignal?: number;
  /**
   * Show the feed's OWN composer + Post button.
   *
   * False on the normal path, where the operation page renders the same capture
   * fields inside the completion block and one button commits both — the whole
   * point of merging them. True only where no completion block is left to attach
   * a note to: an already-complete step (so a photo can still be added
   * afterwards, which is the phone-camera-then-attach flow the audit found) and
   * an outside step, whose "sent to coater, back on the 16th" note the paperless
   * doc calls the highest-value note in the system.
   */
  standaloneCapture?: boolean;
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
  readOnly,
  operationContext,
  refreshSignal,
  standaloneCapture = false,
}: JobFeedProps) {
  const [error, setError] = useState<string | null>(null);
  // Notes posted optimistically (prepended before the next full load). Deduped
  // out of the merged list once they show up in a fresh load by id.
  const [pendingNotes, setPendingNotes] = useState<JobNote[]>([]);

  const [operatorId, setOperatorId] = useState<string | null>(null);

  // Signed URLs for media thumbnails, keyed by media id (fetched on demand).
  const [mediaUrls, setMediaUrls] = useState<Record<string, string>>({});
  // Full-size viewer.
  const [viewerUrl, setViewerUrl] = useState<string | null>(null);

  // The feed's own composer, only where nothing else owns capture — see the
  // standaloneCapture prop.
  const showComposer = !readOnly && !!operationContext && standaloneCapture;

  const writer = useStepNoteWriter({
    companyId,
    jobId,
    operatorId,
    context: operationContext ?? null,
  });
  const capture = useNoteCapture({ companyId, operatorId, writer, enabled: showComposer });

  // Read tracking. The feed is where an operator encounters other people's notes
  // in the course of a job, so it is the surface the whole loop is measuring.
  const { observe } = useNoteDwell(companyId, jobId);

  const {
    data: loadedNotesData,
    loading,
    reload: load,
  } = useLoad(() => getJobNotes(jobId, companyId), [jobId, companyId], {
    onError: (err) => {
      setError(err instanceof Error ? err.message : 'Could not load the feed.');
    },
  });
  const loadedNotes = loadedNotesData ?? EMPTY_NOTES;

  // Merge optimistic posts ahead of the loaded feed, dropping any that the
  // latest load already includes (matched by id) so there are no duplicates.
  const notes = useMemo(() => {
    if (pendingNotes.length === 0) return loadedNotes;
    const loadedIds = new Set(loadedNotes.map((n) => n.id));
    const stillPending = pendingNotes.filter((n) => !loadedIds.has(n.id));
    return [...stillPending, ...loadedNotes];
  }, [loadedNotes, pendingNotes]);

  // Resolved unconditionally, not just when the composer is shown: reactions need
  // the member id on the read-only traveler feed too, both to know whether the
  // reader has already reacted and to hide the control on their own notes.
  useEffect(() => {
    let active = true;
    getCurrentMember(companyId).then((op) => {
      if (active && op) setOperatorId(op.id);
    });
    return () => {
      active = false;
    };
  }, [companyId]);

  // Reflect a write the PARENT made. The completion block now owns capture on the
  // normal path, so when it posts a note this feed has to reload to show it —
  // which is all that is left of the old captureOfferSignal. Ignores the initial
  // undefined/0 so a mount does not double-load.
  const lastRefresh = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!refreshSignal) return;
    if (refreshSignal === lastRefresh.current) return;
    lastRefresh.current = refreshSignal;
    load();
  }, [refreshSignal, load]);

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

  // The photo pipeline, the dictation hint and the note+media write now live in
  // useNoteCapture, so this feed and the completion block share one
  // implementation. All that is left here is what "Post" means on THIS surface:
  // write it, then show it optimistically.
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
      setViewerUrl(await getJobNoteMediaUrl(media.storage_path));
    } catch {
      setError('Could not open the photo.');
    }
  };

  return (
    <Card elevation={2} sx={cardSx}>
      <CardContent>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1.5 }}>
          <DynamicFeedIcon fontSize="small" color="action" />
          <Typography variant="h6" color="text.secondary">
            Job Feed
          </Typography>
        </Box>

        {showComposer && (
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1, mb: 2 }}>
            {/* The post-completion "add a photo?" offer is gone. It existed to
                chase a note AFTER the fact, which is exactly the two-stage commit
                that lost photos; capture now sits inside the completion block and
                lands with it. This composer survives only on surfaces with no
                completion left to attach to. */}
            <NoteCaptureFields
              capture={capture}
              placeholder="Add a note or photo for this step…"
            />
            <Box sx={{ display: 'flex', justifyContent: 'flex-end' }}>
              <Button
                variant="contained"
                onClick={handlePost}
                disabled={!capture.hasContent || capture.saving}
                sx={{ minHeight: 48 }}
              >
                {capture.saving ? <CircularProgress size={20} /> : 'Post'}
              </Button>
            </Box>
          </Box>
        )}

        {error && (
          <Alert severity="error" sx={{ mb: 1 }} onClose={() => setError(null)}>
            {error}
          </Alert>
        )}

        {loading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 2 }}>
            <CircularProgress size={20} />
          </Box>
        ) : notes.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            No activity yet.
          </Typography>
        ) : (
          <Box sx={{ display: 'flex', flexDirection: 'column' }}>
            {notes.map((note, idx) => (
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
                  <Typography variant="caption" color="text.secondary" sx={{ flexShrink: 0 }}>
                    {formatTimestamp(note.created_at)}
                  </Typography>
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
                      return (
                        <Box
                          key={m.id}
                          onClick={() => url && openViewer(m)}
                          sx={{
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
                          {url ? (
                            <Box
                              component="img"
                              src={url}
                              alt="Job photo"
                              sx={{ width: '100%', height: '100%', objectFit: 'cover' }}
                            />
                          ) : (
                            <CircularProgress size={16} />
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
            ))}
          </Box>
        )}
      </CardContent>

      {/* Full-size photo viewer. */}
      <Dialog open={!!viewerUrl} onClose={() => setViewerUrl(null)} fullScreen>
        <IconButton
          aria-label="Close"
          onClick={() => setViewerUrl(null)}
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
          {viewerUrl && (
            <Box
              component="img"
              src={viewerUrl}
              alt="Job photo"
              sx={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
            />
          )}
        </DialogContent>
      </Dialog>
    </Card>
  );
}
