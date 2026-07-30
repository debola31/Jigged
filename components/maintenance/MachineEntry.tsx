'use client';

import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import NoteMediaGallery from '@/components/operator/NoteMediaGallery';
import NoteReactions from '@/components/operator/NoteReactions';
import type { MachineNote } from '@/types/machineMaintenance';

/**
 * One entry's CONTENT, with no container of its own.
 *
 * Two callers wrap it differently, because they are answering different
 * questions. MachineOpenItems gives each one its own card — those are things to
 * act on, and a card is what makes each a separate object with a separate
 * button. The log wraps a run of them in ONE card separated by dividers, which
 * is exactly how the job feed renders notes: same content type, same shape, and
 * a sentence like "wiped it down" no longer costs a whole card plus a gap.
 *
 * WHAT IS NOT HERE, and must not arrive later:
 *
 *   usage_count — counts distinct JOBS a note was consulted on, and a machine
 *     read carries no job, so it is permanently zero. The access layer does not
 *     even fetch it (§8), and "used on 0 jobs" beside real knowledge would read
 *     as a verdict on the entry rather than a gap in the instrument.
 *   any per-person total — reactions attach to an ENTRY. "Diego has 12 helpfuls"
 *     is a leaderboard and "Priya logged 9 items" is a participation score; both
 *     are the operator-comparative metrics this product refuses to build.
 */

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

export default function MachineEntry({
  entry,
  companyId,
  memberId,
  isOpen,
  onLogFix,
  hideAuthor = false,
  readOnly = false,
}: {
  entry: MachineNote;
  companyId: string;
  /** Current member's user_company_access id; null until resolved. */
  memberId: string | null;
  /** True for a flagged entry nothing has resolved yet. */
  isOpen?: boolean;
  /** Offered only on an open item. Absent in read-only (office) rendering. */
  onLogFix?: () => void;
  /**
   * Suppress the author line. Set while an entry is pinned as outstanding.
   *
   * §5, and the reason it is a prop rather than a decision made here: a list of
   * open items with names down the side is a list of who reports the most
   * problems, read straight down the column — the shape of every operator
   * scorecard this product has refused to build. The name is not lost, it is
   * deferred: once somebody logs the fix the entry moves into the log below and
   * carries its author like every other entry, where it reads as attribution
   * rather than as a tally.
   */
  hideAuthor?: boolean;
  readOnly?: boolean;
}) {
  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap', mb: 0.5 }}>
        {!hideAuthor && (
          <Typography variant="body2" sx={{ fontWeight: 600 }}>
            {entry.author_name ?? 'Someone'}
          </Typography>
        )}
        <Typography variant="caption" color="text.secondary">
          {formatWhen(entry.created_at)}
        </Typography>
        <Box sx={{ flex: 1 }} />
        {/* Right-aligned outlined button, the same affordance in the pinned block
            and in the log. It was a bare text link in the log and a button when
            pinned — one action wearing two costumes, which reads as two
            different things to somebody who meets this screen once a fortnight. */}
        {isOpen && onLogFix && !readOnly && (
          <Button
            size="small"
            variant="outlined"
            onClick={onLogFix}
            sx={{ minHeight: 44, flexShrink: 0 }}
          >
            Log the fix
          </Button>
        )}
      </Box>

      {entry.body && (
        <Typography variant="body1" sx={{ whiteSpace: 'pre-wrap', mb: entry.media.length ? 1 : 0 }}>
          {entry.body}
        </Typography>
      )}

      {entry.media.length > 0 && <NoteMediaGallery media={entry.media} />}

      <NoteReactions
        companyId={companyId}
        noteId={entry.id}
        authorId={entry.author_id}
        reactions={entry.reactions}
        memberId={memberId}
        readOnly={readOnly}
      />
    </Box>
  );
}
