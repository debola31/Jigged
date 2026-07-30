'use client';

import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Typography from '@mui/material/Typography';
import type { MachineNote } from '@/types/machineMaintenance';

/**
 * Things somebody noticed and nobody has fixed yet, pinned above the timeline.
 *
 * THE AUTHOR IS NOT SHOWN HERE, and that is a deliberate trade rather than an
 * oversight. A list of open items with names down the side is a list of who
 * reports the most problems, read straight down the column — the shape of every
 * operator scorecard this product has refused to build. The name is one tap away
 * on the entry's own card, where it reads as attribution instead of a tally.
 *
 * The cost is that this list carries less context than it could. The cost of the
 * alternative is that filing a noticed becomes an admission.
 *
 * There is no assignment, no priority and no due date either. Each of those needs
 * a second person to mean anything, and at a shop this size the person who
 * notices, decides and fixes is the same person.
 */

const cardSx = { bgcolor: 'rgba(26, 31, 74, 0.55)', backdropFilter: 'blur(8px)' };

function formatDay(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export default function MachineOpenItems({
  items,
  onLogFix,
}: {
  items: MachineNote[];
  /** Absent in read-only (office) rendering, where there is nothing to act on. */
  onLogFix?: (item: MachineNote) => void;
}) {
  // No empty state. A machine with nothing outstanding should look like a
  // machine with nothing outstanding, not like a section waiting to be filled.
  if (items.length === 0) return null;

  return (
    <Card elevation={2} sx={{ ...cardSx, mb: 2 }} data-testid="machine-open-items">
      <CardContent sx={{ py: 1.5 }}>
        <Typography variant="overline" color="text.secondary">
          Open
        </Typography>
        {items.map((item) => (
          <Box
            key={item.id}
            sx={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 1,
              py: 1,
              borderTop: '1px solid rgba(255,255,255,0.06)',
            }}
          >
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Typography variant="body1">{item.body ?? 'Photo only'}</Typography>
              <Typography variant="caption" color="text.secondary">
                {formatDay(item.created_at)}
              </Typography>
            </Box>
            {onLogFix && (
              <Button
                size="small"
                variant="outlined"
                onClick={() => onLogFix(item)}
                sx={{ minHeight: 44, flexShrink: 0 }}
              >
                Log the fix
              </Button>
            )}
          </Box>
        ))}
      </CardContent>
    </Card>
  );
}
