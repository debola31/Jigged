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
  /** Label for the current step, e.g. "Op 20 · Mill", shown on the composer. */
  operationLabel?: string | null;
}

interface JobFeedProps {
  jobId: string;
  companyId: string;
  /** Read-only feed (traveler). When true, no composer is shown. */
  readOnly?: boolean;
  /** Set on the operation page to show the composer + auto-tag captures. */
  operationContext?: JobFeedOperationContext;
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
export default function JobFeed({ jobId, companyId, readOnly, operationContext }: JobFeedProps) {
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

  const fileInputRef = useRef<HTMLInputElement | null>(null);

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

  const handlePickPhotos = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (files.length === 0) return;
    setComposerError(null);
    setPending((prev) => [
      ...prev,
      ...files.map((file, i) => ({
        id: `${Date.now()}-${i}-${file.name}`,
        file,
        previewUrl: URL.createObjectURL(file),
      })),
    ]);
  };

  const removePending = (id: string) => {
    setPending((prev) => {
      const target = prev.find((p) => p.id === id);
      if (target) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((p) => p.id !== id);
    });
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
            {operationContext?.operationLabel && (
              <Typography variant="caption" color="text.secondary">
                Adding to {operationContext.operationLabel}
              </Typography>
            )}
            <TextField
              multiline
              minRows={2}
              placeholder="Add a note or photo for this step…"
              value={noteDraft}
              onChange={(e) => setNoteDraft(e.target.value)}
              fullWidth
              size="small"
            />

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

            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              capture="environment"
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
