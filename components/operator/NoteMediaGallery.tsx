'use client';

import { useState } from 'react';
import { useLoad } from '@/hooks/useLoad';
import Box from '@mui/material/Box';
import Dialog from '@mui/material/Dialog';
import DialogContent from '@mui/material/DialogContent';
import IconButton from '@mui/material/IconButton';
import CircularProgress from '@mui/material/CircularProgress';
import CloseIcon from '@mui/icons-material/Close';
import { getJobNoteMediaUrl } from '@/utils/jobNoteMediaAccess';
import type { JobNoteMedia } from '@/types/operator';

const THUMB = 72;

/**
 * Thumbnail grid + fullscreen viewer for a note's photos/videos. Shared media
 * viewer for note surfaces (the part-notes sheet) so there's one implementation,
 * not a copy per screen. Thumbnails load off thumbnail_path (falling back to
 * storage_path); tapping opens the full storage_path in a fullscreen dialog.
 *
 * Distinct from AttachmentViewerModal (engineering files) — job-note media is a
 * separate photo/video pipeline.
 */
export default function NoteMediaGallery({ media }: { media: JobNoteMedia[] }) {
  const [viewerUrl, setViewerUrl] = useState<string | null>(null);

  // Batch-load this note's thumbnail URLs once (a failed one just stays blank).
  const { data: urls } = useLoad(async () => {
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
  }, [media]);

  const openViewer = async (m: JobNoteMedia) => {
    try {
      setViewerUrl(await getJobNoteMediaUrl(m.storage_path));
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
                  alt="Past run photo"
                  sx={{ width: '100%', height: '100%', objectFit: 'cover' }}
                />
              ) : (
                <CircularProgress size={16} />
              )}
            </Box>
          );
        })}
      </Box>

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
              alt="Past run photo"
              sx={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
            />
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
