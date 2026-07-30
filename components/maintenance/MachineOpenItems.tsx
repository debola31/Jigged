'use client';

import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Divider from '@mui/material/Divider';
import Typography from '@mui/material/Typography';
import MachineEntry from '@/components/maintenance/MachineEntry';
import type { MachineNote } from '@/types/machineMaintenance';

/**
 * Things somebody flagged and nobody has fixed yet.
 *
 * ONE CONTAINER holding them all, and each appears EXACTLY ONCE on the screen.
 * They were separate cards with an even gap, which gave the group no boundary —
 * the space between two outstanding items matched the space before the log, so
 * the heading looked like it labelled only the first one. It used to
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

const openCardSx = {
  bgcolor: 'rgba(26, 31, 74, 0.55)',
  backdropFilter: 'blur(8px)',
  border: '1px solid rgba(255, 167, 38, 0.45)',
};

export default function MachineOpenItems({
  items,
  companyId,
  memberId,
  onLogFix,
  replyingToId = null,
  renderReply,
  readOnly = false,
}: {
  items: MachineNote[];
  companyId: string;
  memberId: string | null;
  /** Absent in read-only (office) rendering, where there is nothing to act on. */
  onLogFix?: (item: MachineNote) => void;
  /** Item whose reply composer is open, if any. */
  replyingToId?: string | null;
  /** Renders the inline reply composer, directly beneath its item. */
  renderReply?: () => React.ReactNode;
  readOnly?: boolean;
}) {
  // No empty state. A machine with nothing outstanding should look like a
  // machine with nothing outstanding, not like a section waiting to be filled.
  if (items.length === 0) return null;

  return (
    <Box sx={{ mb: 3 }} data-testid="machine-open-items">
      <Typography
        variant="overline"
        sx={{ display: 'block', mb: 0.5, color: 'warning.light' }}
      >
        Needs attention
      </Typography>

      {/* ONE container, not a card each. Separate cards with an even gap gave the
          group no boundary: the space between two outstanding items was the same
          as the space before the log, so equal spacing read as equal
          relationship and the heading looked like it labelled only the first
          one. Enclosing them says which rows the heading covers, and the amber
          edge carries the meaning so the state is legible before the words are.
          The bottom margin is larger than the gap inside, so the group is
          visibly nearer to itself than to what follows. */}
      <Card elevation={2} sx={openCardSx}>
        <CardContent>
          {items.map((item, idx) => (
            <Box key={item.id} data-testid="machine-open-item">
              {idx > 0 && <Divider sx={{ my: 1.5, borderColor: 'rgba(255,167,38,0.25)' }} />}
              <MachineEntry
                entry={item}
                companyId={companyId}
                memberId={memberId}
                isOpen
                hideAuthor
                // Hidden while its own reply is open: the composer sitting
                // right below IS the affordance, and two controls saying "Log
                // the fix" at once — one opening, one committing — is a coin
                // flip for somebody meeting this screen occasionally.
                onLogFix={
                  onLogFix && replyingToId !== item.id ? () => onLogFix(item) : undefined
                }
                readOnly={readOnly}
              />
              {/* Attached to the item it answers. A reply that sits where the
                  thing it replies to is needs no banner to say what it is
                  about, and no mode to remember. */}
              {replyingToId === item.id && renderReply && renderReply()}
            </Box>
          ))}
        </CardContent>
      </Card>
    </Box>
  );
}
