'use client';

import { useState } from 'react';
import Accordion from '@mui/material/Accordion';
import AccordionSummary from '@mui/material/AccordionSummary';
import AccordionDetails from '@mui/material/AccordionDetails';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Chip from '@mui/material/Chip';
import Divider from '@mui/material/Divider';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogContent from '@mui/material/DialogContent';
import IconButton from '@mui/material/IconButton';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import HistoryIcon from '@mui/icons-material/History';
import CloseIcon from '@mui/icons-material/Close';
import { getPreviousRunForPart } from '@/utils/operatorAccess';
import { getJobNoteMediaUrl } from '@/utils/jobNoteMediaAccess';
import type { PreviousRun, JobNoteMedia } from '@/types/operator';

const cardSx = { bgcolor: 'rgba(26, 31, 74, 0.55)', backdropFilter: 'blur(8px)' };
const THUMB = 72;

interface PreviousRunCardProps {
  partId: string;
  companyId: string;
  /** Exclude the current job so it never shows as its own "last time". */
  excludeJobId: string;
  /** When set, scopes the guidance to this step ("last time, this step"). */
  jobOperationId?: string;
  title: string;
}

function formatDate(value: string | null): string {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatTimestamp(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/**
 * "Last time we ran this part" guidance for operators. Collapsed by default;
 * lazy-loads the most recent completed prior run's notes + setup photos on
 * expand (fetch in the handler, not an effect). Part-centric, read-only, no
 * operator time metrics. When `jobOperationId` is set, it's scoped to that step.
 */
export default function PreviousRunCard({
  partId,
  companyId,
  excludeJobId,
  jobOperationId,
  title,
}: PreviousRunCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [run, setRun] = useState<PreviousRun | null>(null);
  const [mediaUrls, setMediaUrls] = useState<Record<string, string>>({});
  const [viewerUrl, setViewerUrl] = useState<string | null>(null);

  const handleExpand = async (_e: React.SyntheticEvent, isExpanded: boolean) => {
    setExpanded(isExpanded);
    if (!isExpanded || loaded) return;
    setLoading(true);
    try {
      const r = await getPreviousRunForPart(partId, companyId, { excludeJobId, jobOperationId });
      setRun(r);
      if (r) {
        const media = r.notes.flatMap((n) => n.media);
        const pairs = await Promise.all(
          media.map(async (m) => {
            try {
              return [m.id, await getJobNoteMediaUrl(m.thumbnail_path ?? m.storage_path)] as const;
            } catch {
              return null;
            }
          }),
        );
        const urls: Record<string, string> = {};
        for (const p of pairs) if (p) urls[p[0]] = p[1];
        setMediaUrls(urls);
      }
    } catch {
      setRun(null);
    } finally {
      setLoading(false);
      setLoaded(true);
    }
  };

  const openViewer = async (media: JobNoteMedia) => {
    try {
      setViewerUrl(await getJobNoteMediaUrl(media.storage_path));
    } catch {
      /* ignore — thumbnail stays */
    }
  };

  const emptyMessage = jobOperationId
    ? 'No notes recorded for this step last time.'
    : 'The last run had no notes.';

  return (
    <Accordion
      expanded={expanded}
      onChange={handleExpand}
      elevation={2}
      disableGutters
      sx={{ ...cardSx, '&:before': { display: 'none' }, borderRadius: '8px !important' }}
    >
      <AccordionSummary expandIcon={<ExpandMoreIcon />} sx={{ minHeight: 56 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <HistoryIcon fontSize="small" color="action" />
          <Typography variant="subtitle1" color="text.secondary">
            {title}
          </Typography>
        </Box>
      </AccordionSummary>
      <AccordionDetails sx={{ pt: 0 }}>
        {loading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 2 }}>
            <CircularProgress size={20} />
          </Box>
        ) : !run ? (
          <Typography variant="body2" color="text.secondary">
            No previous runs of this part.
          </Typography>
        ) : (
          <Box>
            <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 1 }}>
              {run.jobNumber}
              {run.completedAt ? ` · completed ${formatDate(run.completedAt)}` : ''}
            </Typography>

            {run.notes.length === 0 ? (
              <Typography variant="body2" color="text.secondary">
                {emptyMessage}
              </Typography>
            ) : (
              <Box sx={{ display: 'flex', flexDirection: 'column' }}>
                {run.notes.map((note, idx) => (
                  <Box key={note.id}>
                    {idx > 0 && <Divider sx={{ my: 1 }} />}
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.25 }}>
                      <Typography variant="subtitle2" fontWeight={700} noWrap>
                        {note.author_name || 'Unknown'}
                      </Typography>
                      {note.operation_label && (
                        <Chip size="small" label={note.operation_label} variant="outlined" />
                      )}
                      <Box sx={{ flex: 1 }} />
                      <Typography variant="caption" color="text.secondary">
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
                    )}
                  </Box>
                ))}
              </Box>
            )}
          </Box>
        )}
      </AccordionDetails>

      <Dialog open={!!viewerUrl} onClose={() => setViewerUrl(null)} fullScreen>
        <IconButton
          aria-label="Close"
          onClick={() => setViewerUrl(null)}
          sx={{ position: 'absolute', right: 12, top: 12, zIndex: 1, color: 'common.white' }}
        >
          <CloseIcon />
        </IconButton>
        <DialogContent
          sx={{ p: 0, bgcolor: 'background.default', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
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
    </Accordion>
  );
}
