'use client';

import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Typography from '@mui/material/Typography';
import MachineEntry from '@/components/maintenance/MachineEntry';
import type { MachineNote } from '@/types/machineMaintenance';

/**
 * Things somebody flagged and nobody has fixed yet.
 *
 * EACH ONE IS ITS OWN CARD, and appears EXACTLY ONCE on the screen. It used to
 * render here as a thin summary row AND again in the log below as a full card,
 * which was the same fact twice with different chrome — and it hid the entry's
 * photo, which on "the way cover is dragging" is most of the message.
 *
 * It sits BELOW the composer. Above it, a machine with six outstanding items
 * pushed the composer off the top of the phone, so the one thing this screen
 * exists to make easy became the thing you had to scroll to find.
 *
 * NO AUTHOR while an item is open — see the hideAuthor prop on MachineEntry.
 * There is no assignment, no priority and no due date either: each of those
 * needs a second person to mean anything, and at a shop this size the person who
 * notices, decides and fixes is the same person.
 */

const cardSx = { bgcolor: 'rgba(26, 31, 74, 0.55)', backdropFilter: 'blur(8px)' };

export default function MachineOpenItems({
  items,
  companyId,
  memberId,
  onLogFix,
  readOnly = false,
}: {
  items: MachineNote[];
  companyId: string;
  memberId: string | null;
  /** Absent in read-only (office) rendering, where there is nothing to act on. */
  onLogFix?: (item: MachineNote) => void;
  readOnly?: boolean;
}) {
  // No empty state. A machine with nothing outstanding should look like a
  // machine with nothing outstanding, not like a section waiting to be filled.
  if (items.length === 0) return null;

  return (
    <Box sx={{ mb: 2 }} data-testid="machine-open-items">
      <Typography
        variant="overline"
        color="text.secondary"
        sx={{ display: 'block', mb: 0.5 }}
      >
        Needs attention
      </Typography>

      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
        {items.map((item) => (
          <Card key={item.id} elevation={2} sx={cardSx}>
            <CardContent sx={{ py: 1.5 }}>
              <MachineEntry
                entry={item}
                companyId={companyId}
                memberId={memberId}
                isOpen
                hideAuthor
                onLogFix={onLogFix ? () => onLogFix(item) : undefined}
                readOnly={readOnly}
              />
            </CardContent>
          </Card>
        ))}
      </Box>
    </Box>
  );
}
