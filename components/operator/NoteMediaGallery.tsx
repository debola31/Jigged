'use client';

import { useState } from 'react';
import { useLoad } from '@/hooks/useLoad';
import Box from '@mui/material/Box';
import Dialog from '@mui/material/Dialog';
import DialogContent from '@mui/material/DialogContent';
import IconButton from '@mui/material/IconButton';
import CircularProgress from '@mui/material/CircularProgress';
import CloseIcon from '@mui/icons-material/Close';
import BrokenImageOutlinedIcon from '@mui/icons-material/BrokenImageOutlined';
import PlayCircleOutlineIcon from '@mui/icons-material/PlayCircleOutline';
import Typography from '@mui/material/Typography';
import { getJobNoteMediaUrl } from '@/utils/jobNoteMediaAccess';
import { formatStopwatch } from '@/lib/duration';
import type { JobNoteMedia } from '@/types/operator';

const THUMB = 72;

/**
 * Thumbnail grid + fullscreen viewer for a note's photos and videos. Shared media
 * viewer for note surfaces (the part-notes sheet, the machine log) so there's one
 * implementation, not a copy per screen. Thumbnails load off thumbnail_path
 * (falling back to storage_path); tapping opens the full storage_path in a
 * fullscreen dialog, as an <img> or a <video> depending on `kind`.
 *
 * The fallback in that first sentence is why `posterless` exists below: it is
 * correct for a photo and actively harmful for a clip.
 *
 * Distinct from AttachmentViewerModal (engineering files) — job-note media is a
 * separate photo/video pipeline.
 */
export default function NoteMediaGallery({ media }: { media: JobNoteMedia[] }) {
  const [viewer, setViewer] = useState<{ url: string; kind: JobNoteMedia['kind'] } | null>(null);

  // Keyed on the ids, not the array — useLoad wants a primitive dep, and the
  // URLs resolve off thumbnail_path/storage_path, which are fixed per id. So a
  // parent re-rendering with a new array of the same photos costs nothing.
  const mediaKey = media.map((m) => m.id).join(',');

  // Batch-load this note's thumbnail URLs once.
  const { data: urls, loading } = useLoad(async () => {
    const pairs = await Promise.all(
      media.map(async (m) => {
        try {
          return [m.id, await getJobNoteMediaUrl(m.thumbnail_path ?? m.storage_path)] as const;
        } catch {
          return null;
        }
      }),
    );
    const map: Record<string, string> = {};
    for (const p of pairs) if (p) map[p[0]] = p[1];
    return map;
  }, [mediaKey]);

  const openViewer = async (m: JobNoteMedia) => {
    try {
      setViewer({ url: await getJobNoteMediaUrl(m.storage_path), kind: m.kind });
    } catch {
      /* ignore — the thumbnail stays */
    }
  };

  if (media.length === 0) return null;

  return (
    <>
      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, mt: 0.5 }}>
        {media.map((m) => {
          const url = urls?.[m.id];
          /**
           * A VIDEO WITH NO POSTER IS NOT AN IMAGE. The URL above resolves
           * `thumbnail_path ?? storage_path`, so a clip whose poster upload failed
           * would otherwise hand an <img> a signed URL for the whole file: nothing
           * renders, and the browser pulls tens of megabytes down a cellular link to
           * paint 72 pixels. Clips recorded before posters existed hit this too.
           */
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
              {/* A spinner means "still fetching". It must NOT be the resting
                  state for a URL that failed: signing can fail for reasons the
                  operator cannot do anything about (an expired session, a
                  missing storage read policy on a preview build), and a thumbnail
                  that spins forever reads as "the app is stuck" — so the photo
                  gets attached again, and again. A broken-image mark says the
                  photo is there and this device cannot show it, which is true. */}
              {showImage ? (
                <Box
                  component="img"
                  src={url}
                  alt={m.kind === 'video' ? 'Past run video' : 'Past run photo'}
                  sx={{ width: '100%', height: '100%', objectFit: 'cover' }}
                />
              ) : posterless ? (
                <PlayCircleOutlineIcon sx={{ color: 'text.secondary' }} />
              ) : loading ? (
                <CircularProgress size={16} />
              ) : (
                <BrokenImageOutlinedIcon
                  fontSize="small"
                  sx={{ color: 'text.disabled' }}
                  titleAccess="Photo could not be loaded"
                />
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
            /* `controls` and NOT `autoPlay`: starting a clip the instant a thumbnail is
               tapped spends tens of megabytes of somebody's own phone plan on a decision
               they have not made yet. `preload="metadata"` fetches enough to draw the
               scrub bar and no more; `playsInline` stops iOS taking the video fullscreen
               out from under the dialog that is already fullscreen. */
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
              alt="Past run photo"
              sx={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
