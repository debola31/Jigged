'use client';

import { useState } from 'react';
import IconButton from '@mui/material/IconButton';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import Tooltip from '@mui/material/Tooltip';
import AttachFileIcon from '@mui/icons-material/AttachFile';

import { useLoad } from '@/hooks/useLoad';
import { listJobAttachments } from '@/utils/jobAttachmentsAccess';
import JobAttachmentViewerDialog from './JobAttachmentViewerDialog';
import type { JobAttachment } from '@/types/job';

/**
 * A paperclip beside the Customer PO that opens the file, when there is one.
 *
 * REPLACES A WHOLE ATTACHMENTS BLOCK in the Job Details card. That block spent
 * two lines saying "Attachments — None" on the many jobs that have none, and on
 * the jobs that DO have one it was a list of a single customer PO sitting three
 * rows below the PO number it belongs to. The file is an attribute of the PO;
 * putting it on the PO says so in one glyph.
 *
 * RENDERS NOTHING when the job has no attachments, which is the whole saving —
 * an affordance that appears only when there is something behind it. Uploading
 * and removing stay on the Edit screen; this is the read path.
 */
export default function JobAttachmentsInline({ jobId }: { jobId: string }) {
  const [viewing, setViewing] = useState<JobAttachment | null>(null);
  const [menuAnchor, setMenuAnchor] = useState<null | HTMLElement>(null);

  const { data } = useLoad(() => listJobAttachments(jobId), [jobId]);
  const attachments = data ?? [];

  if (attachments.length === 0) return null;

  const only = attachments.length === 1 ? attachments[0] : null;
  const label =
    attachments.length === 1
      ? `Open ${attachments[0].file_name}`
      : `Open one of ${attachments.length} attached files`;

  return (
    <>
      <Tooltip title={label}>
        <IconButton
          size="small"
          aria-label={label}
          data-testid="job-attachment-open"
          onClick={(e) => {
            // One file opens straight away; several need a choice first. Making
            // the common case a two-step menu of one item would be worse than
            // the block this replaced.
            if (only) setViewing(only);
            else setMenuAnchor(e.currentTarget);
          }}
          sx={{ color: 'text.secondary', p: 0.25 }}
        >
          <AttachFileIcon sx={{ fontSize: 16 }} />
        </IconButton>
      </Tooltip>

      <Menu anchorEl={menuAnchor} open={menuAnchor !== null} onClose={() => setMenuAnchor(null)}>
        {attachments.map((att) => (
          <MenuItem
            key={att.id}
            onClick={() => {
              setMenuAnchor(null);
              setViewing(att);
            }}
          >
            {att.file_name}
          </MenuItem>
        ))}
      </Menu>

      <JobAttachmentViewerDialog attachment={viewing} onClose={() => setViewing(null)} />
    </>
  );
}
