'use client';

import { useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import ThumbUpAltIcon from '@mui/icons-material/ThumbUpAlt';
import ThumbUpOffAltIcon from '@mui/icons-material/ThumbUpOffAlt';
import * as Sentry from '@sentry/nextjs';
import { addReaction, removeReaction } from '@/utils/operatorAccess';
import type { NoteReaction } from '@/types/operator';

/**
 * "Helpful" on a note — the voluntary half of the read-back loop.
 *
 * The deliberate opposite of view logging. A view is involuntary and private: a
 * record that someone needed to look something up, which is why note_views has no
 * client read path at any level. A reaction is a claim someone chose to make, so
 * it is public inside the shop and carries the reactor's name.
 *
 * THERE IS NO THUMBS DOWN, and this is not a deferral — `kind` is CHECK-limited
 * to ('helpful','confirmed') in the database, so there is no slot for a negative.
 * An inaccurate note is corrected (corrects_note_id) or superseded, never
 * publicly judged: nobody on a fifteen-person floor writes a second note after
 * being downvoted by a colleague they see every morning.
 *
 * NOT SHOWN ON YOUR OWN NOTES. The RLS INSERT policy forbids self-reaction, so
 * rendering the control there would make every tap a guaranteed 42501 that reads
 * as a broken button. On My work the same component renders read-only, where
 * reactions are reception rather than an available action.
 *
 * WHAT THIS MUST NEVER BECOME: a per-person total. Reactions are safe because
 * they attach to a NOTE. "Diego has 47 thumbs-ups" is a leaderboard and "Priya
 * gave 3" is a participation score — both are the operator-comparative metrics
 * the whole workstream refuses. Count and names both derive from the one array
 * below, which is why no denormalized reaction counter exists to be summed.
 */

/** Up to this many names inline; the rest collapse to "+N". */
const MAX_NAMES = 3;

function summarise(names: string[]): string {
  const shown = names.slice(0, MAX_NAMES);
  const rest = names.length - shown.length;
  const list = shown.join(', ');
  return rest > 0 ? `${list} +${rest}` : list;
}

interface NoteReactionsProps {
  companyId: string;
  noteId: string;
  /** Note's author. The control is hidden when this is the current member. */
  authorId: string | null;
  reactions: NoteReaction[];
  /** Current member's user_company_access id; null until resolved. */
  memberId: string | null;
  /**
   * Read-only rendering (My work): show what came back, offer no action. Also the
   * automatic behaviour on your own notes.
   */
  readOnly?: boolean;
}

export default function NoteReactions({
  companyId,
  noteId,
  authorId,
  reactions,
  memberId,
  readOnly = false,
}: NoteReactionsProps) {
  // Optimistic local overlay. On shop wifi a thumbs-up that waits for a round
  // trip before moving reads as a broken button, so the UI commits immediately
  // and rolls back if the write fails.
  const [override, setOverride] = useState<NoteReaction[] | null>(null);
  const [busy, setBusy] = useState(false);

  const helpful = (override ?? reactions).filter((r) => r.kind === 'helpful');
  const mine = memberId != null && helpful.some((r) => r.reactor_id === memberId);
  const isOwnNote = authorId != null && memberId != null && authorId === memberId;
  const names = helpful.map((r) => r.name).filter((n): n is string => Boolean(n));

  const interactive = !readOnly && !isOwnNote && memberId != null;

  const toggle = async () => {
    if (!interactive || busy) return;
    const before = override ?? reactions;
    const next = mine
      ? before.filter((r) => !(r.kind === 'helpful' && r.reactor_id === memberId))
      : [...before, { kind: 'helpful' as const, reactor_id: memberId, name: null }];

    setOverride(next);
    setBusy(true);
    try {
      if (mine) await removeReaction(companyId, noteId);
      else await addReaction(companyId, noteId);
    } catch (err) {
      // Roll back rather than leaving a lie on screen. No toast: the button
      // snapping back is the message, and an operator mid-job does not need a
      // dialog about a thumbs-up.
      setOverride(before);
      Sentry.captureException(err, { tags: { area: 'note_reactions' } });
    } finally {
      setBusy(false);
    }
  };

  // Nothing to show and nothing to offer.
  if (!interactive && helpful.length === 0) return null;

  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap', mt: 0.5 }}>
      {interactive ? (
        <Button
          size="small"
          onClick={toggle}
          disabled={busy}
          startIcon={mine ? <ThumbUpAltIcon /> : <ThumbUpOffAltIcon />}
          sx={{
            minHeight: 40,
            color: mine ? 'success.light' : 'text.secondary',
            textTransform: 'none',
          }}
        >
          {/* The word carries the meaning; the count alone would read as a score. */}
          {helpful.length > 0 ? `Helpful · ${helpful.length}` : 'Helpful'}
        </Button>
      ) : (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
          <ThumbUpAltIcon sx={{ fontSize: 16, color: 'success.light' }} />
          <Typography variant="caption" sx={{ color: 'success.light' }}>
            {helpful.length}
          </Typography>
        </Box>
      )}

      {/* Names, not just a number. Reactions are public by design, so there is
          nothing to hide behind a second tap — and attribution is the point of
          the whole workstream. */}
      {names.length > 0 && (
        <Typography variant="caption" color="text.secondary">
          {summarise(names)}
        </Typography>
      )}
    </Box>
  );
}
