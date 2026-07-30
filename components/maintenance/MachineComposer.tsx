'use client';

import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Checkbox from '@mui/material/Checkbox';
import FormControlLabel from '@mui/material/FormControlLabel';
import NoteCaptureFields from '@/components/operator/NoteCaptureFields';
import type { MaintenanceKind, MachineNote } from '@/types/machineMaintenance';
import type { NoteCapture } from '@/hooks/useNoteCapture';

/**
 * The composer is the one card on this screen you can act on — every other one
 * is a record you can only read — and it looked identical to them.
 *
 * Differentiated by EDGE, not by fill. The theme is explicit that cards are deep
 * translucent panels and that "a pale surface goes washed-out/muddy" on the lit
 * canvas, so lightening this one would fight the design language. A steel-blue
 * hairline — the app's primary/interactive colour — marks it as the place you
 * do something, while it stays the same substantial panel as its neighbours.
 */
const composerSx = {
  bgcolor: 'rgba(26, 31, 74, 0.55)',
  backdropFilter: 'blur(8px)',
  border: '1px solid rgba(70, 130, 180, 0.85)',
};

/**
 * Write something down about the machine you are standing at.
 *
 * The text field, the photo picker, the dictation hint and the whole iOS
 * unreadable-file mitigation come from NoteCaptureFields — the same component
 * the step composer renders, not a copy of it. Only the flag is new here,
 * and it lives in this component rather than in NoteCaptureFields because
 * "is this outstanding?" means nothing on a step note.
 *
 * ONE FLAG, NOT A TAXONOMY. An earlier draft offered five verbs (cleaned,
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
    <Card elevation={2} sx={{ ...composerSx, mb: 2 }}>
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

        {/* A CHECKBOX, matching "Show completed" on the operator jobs list — the
            one binary control operators already meet, down to the high-contrast
            styling that reads on this dark background.

            Not a Chip, which is what this was: everywhere else in the app a Chip
            is a READ-ONLY LABEL (the flag on an entry card, "Internal" on a work
            center, job statuses), so a tappable stateful one fights a meaning
            people have already learned and reads as a label that wandered next to
            a button. Not a Switch either: a switch says "applies now", and
            nothing here happens until Add to log. A checkbox is exactly the
            deferred, optional attribute of a form being filled in.

            The label carries the colour when checked; the box alone is a small
            state change to notice across a shop. */}
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: 1 }}>
          <FormControlLabel
            control={
              <Checkbox
                checked={kind === 'noticed'}
                onChange={(e) => onKindChange(e.target.checked ? 'noticed' : null)}
                sx={{
                  color: 'rgba(255,255,255,0.6)',
                  '&.Mui-checked': { color: 'warning.light' },
                }}
              />
            }
            label="Needs attention"
            sx={{
              mr: 0,
              minHeight: 48,
              '& .MuiFormControlLabel-label': {
                color: kind === 'noticed' ? 'warning.light' : 'text.secondary',
              },
            }}
          />
          <Box sx={{ flex: 1 }} />
          <Button
            variant="contained"
            onClick={submit}
            disabled={!capture.hasContent || capture.saving}
            // MUI's default disabled contained button is near-invisible on this
            // dark panel — it reads as broken rather than as waiting for you to
            // type, and "readable in bright environments" is a design principle
            // here, not a nicety. Tinted with the primary and given legible
            // label contrast, it stays obviously inactive while still looking
            // like the button it is about to become.
            sx={{
              minHeight: 48,
              '&.Mui-disabled': {
                bgcolor: 'rgba(70, 130, 180, 0.22)',
                color: 'rgba(255, 255, 255, 0.55)',
              },
            }}
          >
            {capture.saving ? 'Saving…' : 'Add to log'}
          </Button>
        </Box>
      </CardContent>
    </Card>
  );
}
