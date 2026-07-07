'use client';

import { useState } from 'react';
import { useLoad } from '@/hooks/useLoad';
import Dialog from '@mui/material/Dialog';
import AppBar from '@mui/material/AppBar';
import Toolbar from '@mui/material/Toolbar';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import IconButton from '@mui/material/IconButton';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import Chip from '@mui/material/Chip';
import Alert from '@mui/material/Alert';
import CircularProgress from '@mui/material/CircularProgress';
import CloseIcon from '@mui/icons-material/Close';
import AttachFileIcon from '@mui/icons-material/AttachFile';
import VisibilityIcon from '@mui/icons-material/Visibility';
import ViewInArIcon from '@mui/icons-material/ViewInAr';
import DownloadIcon from '@mui/icons-material/Download';
import { listPartAttachments, getPartAttachmentUrl } from '@/utils/partAttachmentsAccess';
import {
  KIND_LABEL,
  KIND_CHIP_COLOR,
  isPreviewable,
} from '@/components/parts/workspace/tabs/attachmentKindMeta';
import AttachmentViewerModal from '@/components/parts/workspace/tabs/AttachmentViewerModal';
import type { PartAttachment } from '@/types/part';

interface PartFilesSheetProps {
  open: boolean;
  onClose: () => void;
  partId: string;
  partName?: string | null;
}

function formatBytes(bytes: number | null): string {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Icon hinting what a tap does: 3D for STEP, view for PDF, download otherwise. */
function trailingIcon(kind: PartAttachment['kind']) {
  if (kind === 'step') return <ViewInArIcon color="action" />;
  if (isPreviewable(kind)) return <VisibilityIcon color="action" />;
  return <DownloadIcon color="action" />;
}

/**
 * Full-screen sheet listing a part's engineering files (drawings, STEP models,
 * DWG) for operators. Read-only — no upload/delete (the operator-vs-admin
 * difference). Tapping a previewable file opens the shared AttachmentViewerModal
 * (PDF inline, STEP in the same 3D viewer the admin uses); DWG/other download.
 *
 * Scope is the current part only — no PO / quote / financial docs (per product
 * decision). Reuses listPartAttachments + AttachmentViewerModal verbatim; RLS
 * already lets an operator read their company's part_attachments and sign URLs.
 */
export default function PartFilesSheet({ open, onClose, partId, partName }: PartFilesSheetProps) {
  const [selected, setSelected] = useState<PartAttachment | null>(null);

  const { data, loading, error } = useLoad(() => listPartAttachments(partId), [partId]);
  const files = data ?? [];

  const handleOpen = async (att: PartAttachment) => {
    if (isPreviewable(att.kind)) {
      setSelected(att);
      return;
    }
    // DWG / other → open the signed URL in a new tab to download.
    try {
      const url = await getPartAttachmentUrl(att.storage_path);
      window.open(url, '_blank', 'noopener');
    } catch {
      /* ignore — the row stays; the operator can retry */
    }
  };

  return (
    <Dialog open={open} onClose={onClose} fullScreen>
      <AppBar position="relative" elevation={0} sx={{ bgcolor: 'rgba(17, 20, 57, 0.98)' }}>
        <Toolbar>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography variant="h6" noWrap>
              Files
            </Typography>
            {partName && (
              <Typography variant="caption" color="text.secondary" noWrap component="div">
                {partName}
              </Typography>
            )}
          </Box>
          <IconButton edge="end" aria-label="Close" onClick={onClose}>
            <CloseIcon />
          </IconButton>
        </Toolbar>
      </AppBar>

      <Box sx={{ p: 2 }}>
        {loading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
            <CircularProgress />
          </Box>
        ) : error ? (
          <Alert severity="error">Could not load files. Try again.</Alert>
        ) : files.length === 0 ? (
          <Box sx={{ textAlign: 'center', py: 8, px: 2 }}>
            <Typography variant="h6" color="text.secondary" gutterBottom>
              No files for this part
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Drawings and 3D models attached to this part will show up here.
            </Typography>
          </Box>
        ) : (
          <List disablePadding>
            {files.map((att) => (
              <ListItem key={att.id} disablePadding sx={{ mb: 1 }}>
                <ListItemButton
                  onClick={() => handleOpen(att)}
                  sx={{ borderRadius: 1, minHeight: 64, bgcolor: 'rgba(26, 31, 74, 0.55)' }}
                >
                  <ListItemIcon sx={{ minWidth: 40 }}>
                    <AttachFileIcon />
                  </ListItemIcon>
                  <ListItemText
                    primary={att.file_name}
                    secondary={formatBytes(att.size_bytes)}
                    primaryTypographyProps={{ noWrap: true }}
                  />
                  <Chip
                    size="small"
                    label={KIND_LABEL[att.kind]}
                    color={KIND_CHIP_COLOR[att.kind]}
                    sx={{ mx: 1, flexShrink: 0 }}
                  />
                  {trailingIcon(att.kind)}
                </ListItemButton>
              </ListItem>
            ))}
          </List>
        )}
      </Box>

      {/* Reused verbatim: PDF → iframe, STEP → 3D viewer, DWG/other → download.
          key remounts it per selection so the signed-URL fetch resets. */}
      <AttachmentViewerModal
        key={selected?.id}
        open={!!selected}
        attachment={selected}
        onClose={() => setSelected(null)}
      />
    </Dialog>
  );
}
