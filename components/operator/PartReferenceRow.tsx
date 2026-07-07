'use client';

import { useState } from 'react';
import { useLoad } from '@/hooks/useLoad';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';
import HistoryIcon from '@mui/icons-material/History';
import { countPartAttachments } from '@/utils/partAttachmentsAccess';
import PartFilesSheet from '@/components/operator/PartFilesSheet';
import PartNotesSheet from '@/components/operator/PartNotesSheet';

interface PartReferenceRowProps {
  companyId: string;
  partId: string;
  partName?: string | null;
  /** The current job — excluded from "previous" notes. */
  excludeJobId: string;
  /** Present on the operation page → enables the notes "This step" filter. */
  jobOperationId?: string;
}

/**
 * The operator's job-reference row.
 *
 * Files (drawings / STEP models) lead and show a count, because they're often
 * required to actually do the job — an operator shouldn't have to discover a
 * drawing exists by tapping a bare icon. Previous notes is a lighter, optional
 * reference. Both live in the content, deliberately apart from the header's
 * navigation and the account logout (which lives on the Profile tab), so a
 * frequent job-reference tap is never next to a destructive one — the mis-tap
 * hazard the iOS HIG warns about with crowded nav bars.
 */
export default function PartReferenceRow({
  companyId,
  partId,
  partName,
  excludeJobId,
  jobOperationId,
}: PartReferenceRowProps) {
  const [filesOpen, setFilesOpen] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);

  // Eager count so the Files button can signal that a drawing exists. Notes stay
  // lazy (optional reference, heavier query) — the sheet fetches them on open.
  const { data: fileCount } = useLoad(() => countPartAttachments(partId), [partId]);
  const hasFiles = (fileCount ?? 0) > 0;

  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap', mb: 3 }}>
      <Button
        variant={hasFiles ? 'contained' : 'outlined'}
        color={hasFiles ? 'primary' : 'inherit'}
        startIcon={<FolderOpenIcon />}
        onClick={() => setFilesOpen(true)}
        sx={{ minHeight: 48, fontWeight: 600 }}
      >
        {hasFiles ? `Files · ${fileCount}` : 'Files'}
      </Button>
      <Button
        variant="text"
        startIcon={<HistoryIcon />}
        onClick={() => setNotesOpen(true)}
        sx={{ minHeight: 48, color: 'text.secondary' }}
      >
        Previous notes
      </Button>

      {filesOpen && (
        <PartFilesSheet
          open
          onClose={() => setFilesOpen(false)}
          partId={partId}
          partName={partName}
        />
      )}
      {notesOpen && (
        <PartNotesSheet
          open
          onClose={() => setNotesOpen(false)}
          partId={partId}
          companyId={companyId}
          excludeJobId={excludeJobId}
          jobOperationId={jobOperationId}
          partName={partName}
        />
      )}
    </Box>
  );
}
