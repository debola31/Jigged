'use client';

import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
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

        {/* `compact`: the field grows as it fills and the camera is an adjacent
            icon, which is the shape the step composer already uses. The full
            layout's outlined "Add photo" button was the widest thing on the
            screen and sat above the fold on a phone, pushing the log itself
            down — for a secondary action on a surface people are meant to
            SCROLL, that is the wrong thing to be biggest. */}
        <NoteCaptureFields
          capture={capture}
          placeholder="What did you do, or what did you notice?"
          compact
        />

        {/* One row: the flag and the commit. Two stacked full-width controls
            cost three lines of a phone screen to say very little. */}
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: 1.5 }}>
          <Chip
            icon={<ReportProblemOutlinedIcon />}
            label="Needs attention"
            onClick={() => onKindChange(kind === 'noticed' ? null : 'noticed')}
            color={kind === 'noticed' ? 'warning' : 'default'}
            variant={kind === 'noticed' ? 'filled' : 'outlined'}
            // 48, not the Chip default: this is a tap target on a shop floor,
            // often with gloves on, and it sits next to a 48px button.
            sx={{ height: 48, borderRadius: 3, px: 0.5 }}
          />
          <Box sx={{ flex: 1 }} />
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
