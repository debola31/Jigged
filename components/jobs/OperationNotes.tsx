'use client';

import { useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { formatStopwatch } from '@/lib/duration';
import Dialog from '@mui/material/Dialog';
import DialogContent from '@mui/material/DialogContent';
import IconButton from '@mui/material/IconButton';
import CloseIcon from '@mui/icons-material/Close';
import PlayCircleOutlineIcon from '@mui/icons-material/PlayCircleOutline';

import type { JobNote } from '@/types/operator';
import { getJobNoteMediaUrl } from '@/utils/jobNoteMediaAccess';
import NoteEditedMark from '@/components/notes/NoteEditedMark';

const THUMB = 64;

/**
 * Read-only display of the operator's step-tagged notes + photos for one
 * operation, shown when an operation is expanded on the job page (any status —
 * a pending op with notes expands too). The capture happens on the operator
 * view; this surfaces it for the office.
 */
export default function OperationNotes({ notes }: { notes: JobNote[] }) {
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [lightbox, setLightbox] = useState<{ url: string; kind: 'photo' | 'video' } | null>(null);

  useEffect(() => {
    let cancelled = false;
    const media = notes.flatMap((n) => n.media);
    if (media.length === 0) return;
    (async () => {
      const entries = await Promise.all(
        media.map(async (m) => {
          try {
            return [m.id, await getJobNoteMediaUrl(m.thumbnail_path ?? m.storage_path)] as const;
          } catch {
            return null;
          }
        }),
      );
      if (!cancelled) {
        setThumbs(Object.fromEntries(entries.filter(Boolean) as Array<readonly [string, string]>));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [notes]);

  const openFull = async (storagePath: string, kind: 'photo' | 'video') => {
    try {
      setLightbox({ url: await getJobNoteMediaUrl(storagePath), kind });
    } catch {
      /* signed-url failure: leave the lightbox closed */
    }
  };

  if (notes.length === 0) return null;

  return (
    <Box sx={{ mt: 2 }}>
      <Typography variant="caption" color="text.secondary" fontWeight={600}>
        Operator notes &amp; photos
      </Typography>
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5, mt: 0.5 }}>
        {notes.map((n) => (
          <Box key={n.id}>
            <Typography variant="caption" color="text.secondary">
              {n.author_name || 'Operator'} · {formatTimestamp(n.created_at)}
              {/* Marker only, no actions. This is the office's read-only view of
                  what the floor wrote; editing somebody else's note is not on
                  offer anywhere, and delete lives where the note is authored. */}
              <NoteEditedMark editedAt={n.edited_at} />
            </Typography>
            {n.body && (
              <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>
                {n.body}
              </Typography>
            )}
            {n.media.length > 0 && (
              <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', mt: 0.5 }}>
                {n.media.map((m) => (
                  <Box
                    key={m.id}
                    onClick={() => openFull(m.storage_path, m.kind)}
                    sx={{
                      position: 'relative',
                      width: THUMB,
                      height: THUMB,
                      borderRadius: 1,
                      overflow: 'hidden',
                      cursor: 'pointer',
                      bgcolor: 'rgba(255, 255, 255, 0.06)',
                      border: '1px solid rgba(255, 255, 255, 0.1)',
                    }}
                  >
                    {/* `thumbs` resolves thumbnail_path ?? storage_path, so a clip with
                        no poster would put a whole video file behind an <img> that can
                        never decode it. The badge alone is the honest tile. */}
                    {thumbs[m.id] && !(m.kind === 'video' && !m.thumbnail_path) && (
                      <Box
                        component="img"
                        src={thumbs[m.id]}
                        alt=""
                        sx={{ width: '100%', height: '100%', objectFit: 'cover' }}
                      />
                    )}
                    {m.kind === 'video' && (
                      <PlayCircleOutlineIcon
                        sx={{
                          position: 'absolute',
                          top: '50%',
                          left: '50%',
                          transform: 'translate(-50%, -50%)',
                          color: 'white',
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
                ))}
              </Box>
            )}
          </Box>
        ))}
      </Box>

      <Dialog open={!!lightbox} onClose={() => setLightbox(null)} maxWidth="lg">
        <IconButton
          onClick={() => setLightbox(null)}
          sx={{ position: 'absolute', right: 8, top: 8, color: 'white', zIndex: 1 }}
        >
          <CloseIcon />
        </IconButton>
        <DialogContent sx={{ p: 0, bgcolor: 'black' }}>
          {lightbox?.kind === 'video' ? (
            /* `autoPlay` is gone now that clips actually exist: this branch was
               written speculatively against a kind nothing could produce. Opening a
               note should not start playing sound in an office, and `preload` keeps
               it to the metadata until somebody presses play. */
            <Box
              component="video"
              src={lightbox.url}
              controls
              playsInline
              preload="metadata"
              sx={{ display: 'block', maxWidth: '90vw', maxHeight: '85vh' }}
            />
          ) : lightbox ? (
            <Box
              component="img"
              src={lightbox.url}
              alt=""
              sx={{ display: 'block', maxWidth: '90vw', maxHeight: '85vh' }}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </Box>
  );
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
