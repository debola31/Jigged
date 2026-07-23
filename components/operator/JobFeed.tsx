'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useLoad } from '@/hooks/useLoad';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import TextField from '@mui/material/TextField';
import Chip from '@mui/material/Chip';
import Divider from '@mui/material/Divider';
import IconButton from '@mui/material/IconButton';
import CircularProgress from '@mui/material/CircularProgress';
import Alert from '@mui/material/Alert';
import Dialog from '@mui/material/Dialog';
import DialogContent from '@mui/material/DialogContent';
import DynamicFeedIcon from '@mui/icons-material/DynamicFeed';
import PhotoCameraIcon from '@mui/icons-material/PhotoCamera';
import CloseIcon from '@mui/icons-material/Close';
import { getJobNotes, addJobNote, getCurrentMember } from '@/utils/operatorAccess';
import { addJobNoteMedia, getJobNoteMediaUrl } from '@/utils/jobNoteMediaAccess';
import { compressPhoto } from '@/utils/imageCompression';
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
  /** Set on the operation page to show the composer + auto-tag captures. */
  operationContext?: JobFeedOperationContext;
  /**
   * Bumped by the operation page each time a step is completed. On a *new*
   * value, if the composer is active and the operator hasn't captured anything
   * on this job yet, we show a one-time "add a photo/note?" offer. Completion
   * has already been persisted before this changes, so the offer is purely
   * additive and never blocks or risks the completion. Ignored when 0/undefined.
   */
  captureOfferSignal?: number;
}

// --- Dictation (keyboard-mic) hint: a quiet, contextual, capped one-liner. ---
// Shown in the composer where operators type notes; capped so repeat users don't
// get nagged (the documented failure mode of built-in tips). Per-device, since
// the subject is the device's own keyboard mic.
const MIC_HINT_KEY = 'jigged:composer-mic-hint';
const MIC_HINT_MAX_SHOWS = 5;

interface MicHintState {
  shows: number;
  dismissed: boolean;
}

function readMicHint(): MicHintState {
  if (typeof window === 'undefined') return { shows: 0, dismissed: true };
  try {
    const raw = window.localStorage.getItem(MIC_HINT_KEY);
    if (!raw) return { shows: 0, dismissed: false };
    const parsed = JSON.parse(raw) as Partial<MicHintState>;
    return { shows: Number(parsed.shows) || 0, dismissed: !!parsed.dismissed };
  } catch {
    return { shows: 0, dismissed: false };
  }
}

function writeMicHint(state: MicHintState): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(MIC_HINT_KEY, JSON.stringify(state));
  } catch {
    /* private mode / quota — the hint is best-effort, never block on it */
  }
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

/** A pending photo the operator picked but hasn't posted yet. */
interface PendingPhoto {
  id: string;
  file: File;
  previewUrl: string;
}

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
  captureOfferSignal,
}: JobFeedProps) {
  const [error, setError] = useState<string | null>(null);
  // Notes posted optimistically (prepended before the next full load). Deduped
  // out of the merged list once they show up in a fresh load by id.
  const [pendingNotes, setPendingNotes] = useState<JobNote[]>([]);

  const [operatorId, setOperatorId] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState('');
  const [pending, setPending] = useState<PendingPhoto[]>([]);
  const [saving, setSaving] = useState(false);
  const [composerError, setComposerError] = useState<string | null>(null);

  // Signed URLs for media thumbnails, keyed by media id (fetched on demand).
  const [mediaUrls, setMediaUrls] = useState<Record<string, string>>({});
  // Full-size viewer.
  const [viewerUrl, setViewerUrl] = useState<string | null>(null);

  // Post-completion "add a photo/note?" offer + the dictation hint.
  const [offerOpen, setOfferOpen] = useState(false);
  const [showMicHint, setShowMicHint] = useState(false);
  const offerRef = useRef<HTMLDivElement | null>(null);
  const lastOfferSignal = useRef<number | undefined>(undefined);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const noteFieldRef = useRef<HTMLInputElement | null>(null);
  // Monotonic id source for pending picks — avoids the id collisions that
  // Date.now()+filename produced for rapid same-name camera captures.
  const pendingIdRef = useRef(0);

  const showComposer = !readOnly && !!operationContext;

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

  // Has the operator captured anything real on this job yet? Only human 'user'
  // notes with text or a photo count — auto-logged 'event' notes (e.g. the
  // order-qty audit trail) must NOT suppress the offer.
  const hasUserCapture = useMemo(
    () =>
      notes.some(
        (n) =>
          n.note_type === 'user' &&
          ((n.body?.trim().length ?? 0) > 0 || n.media.length > 0),
      ),
    [notes],
  );

  useEffect(() => {
    if (!showComposer) return;
    let active = true;
    getCurrentMember(companyId).then((op) => {
      if (active && op) setOperatorId(op.id);
    });
    return () => {
      active = false;
    };
  }, [showComposer, companyId]);

  // Post-completion capture offer: fire ONCE per completion event. Only react to
  // a *new* signal value (ignore the initial undefined/0), and only offer when
  // the composer is active and nothing has been captured yet. The parent bumps
  // the signal strictly after completeOperation resolves, so completion is
  // already durable — a client death while this is open loses nothing.
  useEffect(() => {
    if (!captureOfferSignal) return;
    if (captureOfferSignal === lastOfferSignal.current) return;
    lastOfferSignal.current = captureOfferSignal;
    if (showComposer && !hasUserCapture) setOfferOpen(true);
  }, [captureOfferSignal, showComposer, hasUserCapture]);

  // Scroll the offer into view when it opens (it sits above a composer that may
  // be below the fold on a phone).
  useEffect(() => {
    if (offerOpen) offerRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' });
  }, [offerOpen]);

  // Decide the dictation hint once per composer mount, counting the show. Shown
  // while not dismissed and under the cap; increments the stored show count.
  useEffect(() => {
    if (!showComposer) return;
    const state = readMicHint();
    if (state.dismissed || state.shows >= MIC_HINT_MAX_SHOWS) return;
    setShowMicHint(true);
    writeMicHint({ shows: state.shows + 1, dismissed: false });
  }, [showComposer]);

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

  // Revoke object URLs for pending previews on unmount.
  useEffect(() => {
    return () => {
      pending.forEach((p) => URL.revokeObjectURL(p.previewUrl));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handlePickPhotos = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const input = e.target;
    const files = Array.from(input.files ?? []);
    input.value = '';
    if (files.length === 0) return;
    setComposerError(null);

    // iOS "new photo → nothing attached" mitigation (UNCONFIRMED — see PR notes;
    // not reproducible on desktop). A camera-origin `File` can become unreadable
    // by the time it's compressed/uploaded at Post, yielding a zero-byte blob.
    // Copy the bytes into a stable File *now*, while the reference is fresh, and
    // drop any pick that reads back empty rather than silently posting nothing.
    const prepared: PendingPhoto[] = [];
    for (const file of files) {
      let stable = file;
      try {
        const buf = await file.arrayBuffer();
        stable = new File([buf], file.name || 'photo.jpg', {
          type: file.type || 'image/jpeg',
          lastModified: file.lastModified,
        });
      } catch {
        // Copy failed — fall through with the original reference and the size
        // guard below decides whether it's usable.
      }
      if (stable.size === 0) continue;
      prepared.push({
        id: `pp-${pendingIdRef.current++}`,
        file: stable,
        previewUrl: URL.createObjectURL(stable),
      });
    }

    if (prepared.length === 0) {
      setComposerError('That photo could not be read. Please try taking or picking it again.');
      return;
    }
    setPending((prev) => [...prev, ...prepared]);
  };

  const removePending = (id: string) => {
    setPending((prev) => {
      const target = prev.find((p) => p.id === id);
      if (target) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((p) => p.id !== id);
    });
  };

  // Offer actions. "Add photo" is the prominent path (the observed failure was
  // photos stuck in the camera roll): close the offer and open the picker, which
  // now surfaces the photo library too. "Add note" focuses the composer; "Skip"
  // just dismisses. All three are terminal for this completion event.
  const handleOfferAddPhoto = () => {
    setOfferOpen(false);
    fileInputRef.current?.click();
  };
  const handleOfferAddNote = () => {
    setOfferOpen(false);
    noteFieldRef.current?.focus();
  };
  const handleOfferSkip = () => setOfferOpen(false);

  const dismissMicHint = () => {
    setShowMicHint(false);
    writeMicHint({ ...readMicHint(), dismissed: true });
  };

  const canPost = (noteDraft.trim().length > 0 || pending.length > 0) && !saving;

  const handlePost = async () => {
    if (!operationContext) return;
    const body = noteDraft.trim();
    if (!body && pending.length === 0) return;
    if (!operatorId) {
      setComposerError('Could not identify your account — reload and try again.');
      return;
    }
    setSaving(true);
    setComposerError(null);
    try {
      const note = await addJobNote(jobId, companyId, operatorId, body || null, {
        jobPartId: operationContext.jobPartId,
        jobOperationId: operationContext.jobOperationId,
      });

      const media: JobNoteMedia[] = [];
      for (const p of pending) {
        const prepared = await compressPhoto(p.file);
        media.push(
          await addJobNoteMedia(companyId, jobId, note.id, prepared.file, {
            dims: prepared.dims,
          }),
        );
      }

      setPendingNotes((prev) => [{ ...note, media }, ...prev]);
      pending.forEach((p) => URL.revokeObjectURL(p.previewUrl));
      setPending([]);
      setNoteDraft('');
    } catch (err) {
      setComposerError(err instanceof Error ? err.message : 'Could not post. Please try again.');
      // The note may have been created with partial media — refresh to show truth.
      load();
    } finally {
      setSaving(false);
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
            {offerOpen && (
              <Box
                ref={offerRef}
                sx={{
                  p: 1.5,
                  borderRadius: 1,
                  border: '1px solid',
                  borderColor: 'primary.main',
                  bgcolor: 'rgba(99, 102, 241, 0.10)',
                }}
              >
                <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1 }}>
                  <Typography variant="body2" sx={{ flex: 1 }}>
                    Step complete. Got a setup photo or a note? Add it before you go —
                    it stays with the job.
                  </Typography>
                  <IconButton
                    size="small"
                    aria-label="Dismiss"
                    onClick={handleOfferSkip}
                    sx={{ mt: -0.5, mr: -0.5 }}
                  >
                    <CloseIcon fontSize="small" />
                  </IconButton>
                </Box>
                <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, mt: 1 }}>
                  <Button
                    variant="contained"
                    startIcon={<PhotoCameraIcon />}
                    onClick={handleOfferAddPhoto}
                    sx={{ minHeight: 44 }}
                  >
                    Add photo
                  </Button>
                  <Button variant="text" onClick={handleOfferAddNote} sx={{ minHeight: 44 }}>
                    Add note
                  </Button>
                  <Box sx={{ flex: 1 }} />
                  <Button variant="text" color="inherit" onClick={handleOfferSkip} sx={{ minHeight: 44 }}>
                    Skip
                  </Button>
                </Box>
              </Box>
            )}
            <TextField
              multiline
              minRows={2}
              placeholder="Add a note or photo for this step…"
              value={noteDraft}
              onChange={(e) => setNoteDraft(e.target.value)}
              inputRef={noteFieldRef}
              fullWidth
              size="small"
            />

            {showMicHint && (
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                <Typography variant="caption" color="text.secondary" sx={{ flex: 1 }}>
                  ※ Tip: tap the{' '}
                  {/* The iOS keyboard's dictation glyph (outlined mic + cradle +
                      stem + base bar), so it reads as the exact key operators
                      tap — not a generic emoji. */}
                  <Box
                    component="svg"
                    viewBox="0 0 24 24"
                    aria-hidden="true"
                    sx={{
                      width: '1.05em',
                      height: '1.05em',
                      verticalAlign: '-0.2em',
                      mx: '1px',
                      fill: 'none',
                      stroke: 'currentColor',
                      strokeWidth: 1.6,
                      strokeLinecap: 'round',
                      strokeLinejoin: 'round',
                    }}
                  >
                    <rect x="9.5" y="3" width="5" height="10" rx="2.5" />
                    <path d="M6.5 11a5.5 5.5 0 0 0 11 0" />
                    <path d="M12 16.5V19" />
                    <path d="M8.5 19h7" />
                  </Box>{' '}
                  on your keyboard to talk instead of type.
                </Typography>
                <IconButton
                  size="small"
                  aria-label="Dismiss tip"
                  onClick={dismissMicHint}
                  sx={{ p: 0.25 }}
                >
                  <CloseIcon sx={{ fontSize: 14 }} />
                </IconButton>
              </Box>
            )}

            {pending.length > 0 && (
              <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
                {pending.map((p) => (
                  <Box key={p.id} sx={{ position: 'relative' }}>
                    <Box
                      component="img"
                      src={p.previewUrl}
                      alt="Pending photo"
                      sx={{
                        width: THUMB,
                        height: THUMB,
                        objectFit: 'cover',
                        borderRadius: 1,
                        display: 'block',
                      }}
                    />
                    <IconButton
                      size="small"
                      aria-label="Remove photo"
                      onClick={() => removePending(p.id)}
                      sx={{
                        position: 'absolute',
                        top: -8,
                        right: -8,
                        bgcolor: 'background.paper',
                        '&:hover': { bgcolor: 'background.paper' },
                      }}
                    >
                      <CloseIcon fontSize="small" />
                    </IconButton>
                  </Box>
                ))}
              </Box>
            )}

            {composerError && <Alert severity="error">{composerError}</Alert>}

            {/* No `capture` attribute: on iOS/Android this makes the OS present
                the full native sheet (Photo Library / Take Photo / Choose File),
                so operators can attach an EXISTING photo from the camera roll —
                the observed failure mode was setup photos stuck in the roll —
                not only shoot a new one. `capture="environment"` would force the
                camera and hide the library. */}
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              hidden
              onChange={handlePickPhotos}
            />
            <Box sx={{ display: 'flex', gap: 1, justifyContent: 'space-between' }}>
              <Button
                variant="outlined"
                startIcon={<PhotoCameraIcon />}
                onClick={() => fileInputRef.current?.click()}
                disabled={saving}
                sx={{ minHeight: 48 }}
              >
                Add photo
              </Button>
              <Button
                variant="contained"
                onClick={handlePost}
                disabled={!canPost}
                sx={{ minHeight: 48 }}
              >
                {saving ? <CircularProgress size={20} /> : 'Post'}
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

                {note.body && (
                  <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>
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
