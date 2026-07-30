'use client';

import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import ToggleButton from '@mui/material/ToggleButton';
import ReportProblemOutlinedIcon from '@mui/icons-material/ReportProblemOutlined';
import NoteCaptureFields from '@/components/operator/NoteCaptureFields';
import type { MaintenanceKind, MachineNote } from '@/types/machineMaintenance';
import type { NoteCapture } from '@/hooks/useNoteCapture';

const cardSx = { bgcolor: 'rgba(26, 31, 74, 0.55)', backdropFilter: 'blur(8px)' };

/**
 * Write something down about the machine you are standing at.
 *
 * The text field, the photo picker, the dictation hint and the whole iOS
 * unreadable-file mitigation come from NoteCaptureFields — the same component
 * the step composer renders, not a copy of it. Only the one toggle is new here,
 * and it lives in this component rather than in NoteCaptureFields because
 * "is this outstanding?" means nothing on a step note.
 *
 * ONE TOGGLE, NOT A TAXONOMY. An earlier draft offered five verbs (cleaned,
 * repaired, replaced, adjusted, noticed). Four of them had no reader anywhere in
 * the product — nothing filtered, grouped, ranked or counted by them, and §4.2
 * forbids grouping the timeline by kind — so they were five choices presented to
 * somebody in a container whose entire risk is that nobody writes in it. They
 * also did not match the TPM frame §3 cites (cleaning, inspection, lubrication,
 * retightening), which is a sign they were invented rather than observed.
 *
 * What survives is the one value the system acts on. Flagging pins the entry to
 * the top of this machine until somebody logs a fix; it notifies nobody, and the
 * label says the condition rather than promising a response.
 *
 * DESELECTABLE, and off by default. Most entries are records of work already
 * done, and a person who is unsure must be able to write the sentence anyway —
 * a forced classification at capture time is the thing that stops capture.
 */
export default function MachineComposer({
  capture,
  kind,
  onKindChange,
  resolving,
  onCancelResolving,
}: {
  capture: NoteCapture<MachineNote>;
  kind: MaintenanceKind | null;
  onKindChange: (next: MaintenanceKind | null) => void;
  /** The open item this entry will resolve, when "Log the fix" started it. */
  resolving?: MachineNote | null;
  onCancelResolving?: () => void;
}) {
  const submit = async () => {
    try {
      await capture.submit();
    } catch {
      // useNoteCapture already put the message in the fields, next to the text
      // the operator is about to lose. A second surface for it would only make
      // the failure louder, not clearer.
    }
  };

  return (
    <Card elevation={2} sx={{ ...cardSx, mb: 2 }}>
      <CardContent sx={{ py: 1.5 }}>
        {resolving && (
          <Alert
            severity="info"
            sx={{ mb: 1.5 }}
            action={
              onCancelResolving && (
                <Button color="inherit" size="small" onClick={onCancelResolving}>
                  Cancel
                </Button>
              )
            }
          >
            Logging the fix for: {resolving.body ?? 'that item'}
          </Alert>
        )}

        <NoteCaptureFields
          capture={capture}
          placeholder="What did you do, or what did you notice?"
        />

        <Box sx={{ mt: 1.5 }}>
          <ToggleButton
            value="noticed"
            selected={kind === 'noticed'}
            onChange={() => onKindChange(kind === 'noticed' ? null : 'noticed')}
            size="small"
            sx={{ minHeight: 44, textTransform: 'none' }}
          >
            <ReportProblemOutlinedIcon fontSize="small" sx={{ mr: 0.75 }} />
            Needs attention
          </ToggleButton>
        </Box>

        <Box sx={{ mt: 1.5 }}>
          <Button
            variant="contained"
            onClick={submit}
            disabled={!capture.hasContent || capture.saving}
            sx={{ minHeight: 48 }}
          >
            {capture.saving ? 'Saving…' : 'Add to log'}
          </Button>
        </Box>
      </CardContent>
    </Card>
  );
}
