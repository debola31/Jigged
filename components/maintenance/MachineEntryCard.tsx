'use client';

import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import Typography from '@mui/material/Typography';
import NoteMediaGallery from '@/components/operator/NoteMediaGallery';
import NoteReactions from '@/components/operator/NoteReactions';
import type { MachineNote } from '@/types/machineMaintenance';

/**
 * One entry on a machine's timeline.
 *
 * WHAT IS NOT HERE, and must not arrive later:
 *
 *   usage_count — counts distinct JOBS a note was consulted on, and a machine
 *     read carries no job, so it is permanently zero here. The access layer does
 *     not even fetch it (§8), and "used on 0 jobs" beside real knowledge would
 *     read as a verdict on the entry rather than a gap in the instrument.
 *   any per-person total — reactions attach to an ENTRY. "Diego has 12 helpfuls"
 *     is a leaderboard; "Priya logged 9 items" is a participation score. Both are
 *     the operator-comparative metrics this product refuses to build.
 */

const cardSx = { bgcolor: 'rgba(26, 31, 74, 0.55)', backdropFilter: 'blur(8px)' };

function formatWhen(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export default function MachineEntryCard({
  entry,
  companyId,
  memberId,
  isOpen,
  resolvedBy,
  onLogFix,
  readOnly = false,
}: {
  entry: MachineNote;
  companyId: string;
  /** Current member's user_company_access id; null until resolved. */
  memberId: string | null;
  /** True for a 'noticed' entry nothing has resolved yet. */
  isOpen?: boolean;
  /** Author of the entry that resolved this one, when there is one. */
  resolvedBy?: string | null;
  /** Offered only on an open item. Absent in read-only (office) rendering. */
  onLogFix?: () => void;
  readOnly?: boolean;
}) {
  return (
    <Card elevation={2} sx={cardSx}>
      <CardContent sx={{ py: 1.5 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap', mb: 0.5 }}>
          {/* The author IS shown here. The open-items list is where the name is
              withheld, because a list of open items with names down the side is
              a list of who reports the most problems. On the entry's own card it
              is attribution — the point of the whole system. */}
          <Typography variant="body2" sx={{ fontWeight: 600 }}>
            {entry.author_name ?? 'Someone'}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {formatWhen(entry.created_at)}
          </Typography>
          {/* The flag is shown as STATE, not as a label. Rendering the stored
              value too would put "noticed" next to "Needs attention" on the same
              row, saying one thing twice; and on a resolved entry the bare word
              "noticed" would read as its category rather than as its history,
              which "Fixed by …" below already tells better. */}
          {isOpen && <Chip label="Needs attention" size="small" color="warning" />}
        </Box>

        {entry.body && (
          <Typography variant="body1" sx={{ whiteSpace: 'pre-wrap', mb: entry.media.length ? 1 : 0 }}>
            {entry.body}
          </Typography>
        )}

        {entry.media.length > 0 && <NoteMediaGallery media={entry.media} />}

        {resolvedBy && (
          <Typography variant="caption" color="success.light" sx={{ display: 'block', mt: 0.5 }}>
            Fixed by {resolvedBy}
          </Typography>
        )}

        <NoteReactions
          companyId={companyId}
          noteId={entry.id}
          authorId={entry.author_id}
          reactions={entry.reactions}
          memberId={memberId}
          readOnly={readOnly}
        />

        {isOpen && onLogFix && !readOnly && (
          <Box sx={{ mt: 1 }}>
            <Typography
              component="button"
              onClick={onLogFix}
              variant="button"
              sx={{
                background: 'none',
                border: 'none',
                color: 'primary.main',
                cursor: 'pointer',
                p: 0,
                minHeight: 40,
                textTransform: 'none',
              }}
            >
              Log the fix
            </Typography>
          </Box>
        )}
      </CardContent>
    </Card>
  );
}
