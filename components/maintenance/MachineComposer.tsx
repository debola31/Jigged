'use client';

import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Typography from '@mui/material/Typography';
import NoteCaptureFields from '@/components/operator/NoteCaptureFields';
import { MAINTENANCE_KINDS } from '@/types/machineMaintenance';
import type { MaintenanceKind, MachineNote } from '@/types/machineMaintenance';
import type { NoteCapture } from '@/hooks/useNoteCapture';

const cardSx = { bgcolor: 'rgba(26, 31, 74, 0.55)', backdropFilter: 'blur(8px)' };

/**
 * Write something down about the machine you are standing at.
 *
 * The text field, the photo picker, the dictation hint and the whole iOS
 * unreadable-file mitigation come from NoteCaptureFields — the same component
 * the step composer renders, not a copy of it. Only the kind chip is new here,
 * and it lives in this component rather than in NoteCaptureFields precisely
 * because a maintenance verb means nothing on a step note.
 *
 * THE CHIP IS OPTIONAL AND DESELECTABLE. Tapping the selected value clears it.
 * Somebody who cannot decide whether they cleaned or adjusted a thing must be
 * able to write the sentence anyway — a forced taxonomy at capture time is the
 * thing that stops capture, and an unclassified entry is still knowledge.
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
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
            Optional
          </Typography>
          <ToggleButtonGroup
            value={kind}
            exclusive
            // MUI hands back null when the selected button is tapped again, which
            // is exactly the clearing gesture we want — pass it straight through.
            onChange={(_e, next: MaintenanceKind | null) => onKindChange(next)}
            size="small"
            sx={{ flexWrap: 'wrap' }}
          >
            {MAINTENANCE_KINDS.map((k) => (
              <ToggleButton key={k} value={k} sx={{ minHeight: 40, textTransform: 'none' }}>
                {k}
              </ToggleButton>
            ))}
          </ToggleButtonGroup>
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
