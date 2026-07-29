'use client';

import { useState } from 'react';
import { useLoad } from '@/hooks/useLoad';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';
import HistoryIcon from '@mui/icons-material/History';
import { countPartAttachments } from '@/utils/partAttachmentsAccess';
import { countPartPreviousNotes } from '@/utils/operatorAccess';
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
 * drawing exists by tapping a bare icon. The Playbook is a lighter, optional
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

  // Eager count so the Files button can signal that a drawing exists.
  const { data: fileCount } = useLoad(() => countPartAttachments(partId), [partId]);
  const hasFiles = (fileCount ?? 0) > 0;

  // Notes now carry a count too. They used to be lazy on the grounds that they
  // were an optional reference and a heavier query — but that left the affordance
  // as a bare label, so an operator had NO WAY to tell whether anything was behind
  // it. Files sat right beside it showing "Files · 3"; notes showed nothing
  // whether the part had ten notes or none. Prior knowledge that nobody knows
  // exists is not reachable, whatever the tap count says.
  //
  // The cost is one server-side count (head request, no rows transferred), which
  // is what makes the eager fetch affordable now.
  const { data: noteCount } = useLoad(
    () => countPartPreviousNotes(partId, { excludeJobId }),
    [partId, excludeJobId],
  );
  const hasNotes = (noteCount ?? 0) > 0;

  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap', mb: 3 }}>
      {/* Both outlined so they read as one family (per the design system —
          grouped actions share a variant). Files leads via bolder weight + a
          count, not by being the only one with a border. */}
      <Button
        variant="outlined"
        startIcon={<FolderOpenIcon />}
        onClick={() => setFilesOpen(true)}
        sx={{ minHeight: 48, fontWeight: 700 }}
      >
        {hasFiles ? `Files · ${fileCount}` : 'Files'}
      </Button>
      <Button
        variant="outlined"
        startIcon={<HistoryIcon />}
        onClick={() => setNotesOpen(true)}
        sx={{ minHeight: 48, fontWeight: hasNotes ? 700 : 400 }}
      >
        {hasNotes ? `Playbook · ${noteCount}` : 'Playbook'}
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
