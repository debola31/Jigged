'use client';

/**
 * "New since you last looked" — the named half of the read-back loop.
 *
 * ## Why this exists, and why it names people
 *
 * The login banner already reports that reactions happened, but it reports a NUMBER and
 * deliberately carries no names, because it sits on the jobs screen where it is readable
 * by anyone walking past. A count is not the thing that motivates. What the evidence
 * supports is directed gratitude — one person, named, thanking you for one specific
 * thing — with the mediator being perceived social worth rather than self-efficacy
 * (Grant & Gino 2010). "3 people found your notes helpful" has no giver; "Sam Carter
 * found this helpful" does.
 *
 * The closest field experiment to this artefact is a peer-given, symbolic, publicly
 * attributed award left on the recipient's OWN page, which raised retention for a year
 * after a single one-time award (Gallus 2017). This tab is that page — which is also
 * what resolves the privacy tension: names belong on the surface the author opens about
 * themselves, not on a glanceable one.
 *
 * ## The note is the unit, never the person
 *
 * Three people marking one note is ONE item naming three people. Several individuals
 * re-described as a single audience is what keeps the signal at single-target strength
 * instead of fading as the count grows (Västfjäll et al. 2014) — and it is the only
 * shape that respects the standing rule that reactions attach to a note and are never
 * summed per person. A per-person total is a leaderboard, and it is also the shape
 * measured to backfire: an award implying you did more than your peers demotivates
 * (Robinson et al. 2021).
 *
 * ## Dismissal destroys nothing
 *
 * "Got it" advances a cursor and nothing else. Every reaction stays on its note in the
 * list below, permanently, because the record and the prompt are different objects. This
 * is not a hypothetical: this shop has already lost recognition to a control where the
 * nag and the reward were the same thing — an operator who dismissed the weekly banner on
 * Monday at "1 person" never saw Friday's larger number.
 *
 * No timer, and no auto-clear on render. Auto-dismissal is a WCAG 2.2.1 failure and was
 * rejected for this audience already; and with gloves on a phone in bright light, a
 * scroll-past is not a read.
 */

import { useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import ButtonBase from '@mui/material/ButtonBase';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import ThumbUpAltIcon from '@mui/icons-material/ThumbUpAlt';

import { MAX_HELPFUL_NAMES } from '@/utils/operatorAccess';
import type { NewHelpful } from '@/types/operator';

/**
 * "Sam Carter", "Sam Carter and Dee Novak", "Sam, Dee and Ray", then "…and 2 more".
 *
 * The overflow is a real tap target rather than a hover or a press-and-hold: both of
 * those are documented touch failures, and this surface has no hover at all.
 */
function names(all: string[], expanded: boolean): { text: string; hidden: number } {
  const shown = expanded ? all : all.slice(0, MAX_HELPFUL_NAMES);
  const hidden = all.length - shown.length;
  if (shown.length === 0) return { text: 'Someone', hidden: 0 };
  if (shown.length === 1) return { text: shown[0]!, hidden };
  const text = `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`;
  return { text, hidden };
}

function HelpfulRow({ item }: { item: NewHelpful }) {
  const [expanded, setExpanded] = useState(false);
  const { text, hidden } = names(item.names, expanded);

  return (
    <Box component="li" sx={{ display: 'block', mb: 2, '&:last-of-type': { mb: 0 } }}>
      {/* The note leads, in the operator's own words — a summary that carries only a
          count cannot tell them WHICH note, and the specificity is the whole point.
          It is marked as a QUOTATION rather than set in bold: bold made it read as the
          block's own headline, so the one thing the surface has to convey — that this is
          something YOU wrote — was the thing it did not say. The rule and indent carry
          that visually; "your note" below carries it in words, for a screen reader and
          for anyone who reads the sentence before the styling. */}
      {item.body && (
        <Typography
          component="blockquote"
          variant="body2"
          sx={{
            m: 0,
            pl: 1.25,
            borderLeft: '3px solid',
            // Neutral rather than another green: the panel is already tinted, and a
            // second accent would read as status rather than as quotation.
            borderColor: 'rgba(255, 255, 255, 0.28)',
            whiteSpace: 'pre-wrap',
          }}
        >
          {item.body}
        </Typography>
      )}
      <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
        {/* Reads correctly for one name or several, so no plural branch. "your note"
            rather than "it" — with several notes in the block, "it" has no antecedent. */}
        {text} found your note helpful
        {hidden > 0 && (
          <>
            {', and '}
            <ButtonBase
              onClick={() => setExpanded(true)}
              sx={{
                minHeight: 40,
                px: 0.5,
                mx: -0.5,
                borderRadius: 1,
                color: 'primary.light',
                textDecoration: 'underline',
                verticalAlign: 'baseline',
              }}
            >
              {hidden} more
            </ButtonBase>
          </>
        )}
        {item.reference ? ` · ${item.reference}` : ''}
      </Typography>
    </Box>
  );
}

export default function NewHelpfulBlock({
  items,
  onDismiss,
}: {
  items: NewHelpful[];
  /** Receives the newest reaction instant actually shown, so nothing unseen is skipped. */
  onDismiss: (seenThrough: string) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

  // Nothing at zero. An empty recognition surface is a standing reminder that nobody
  // cares, which is worse than silence — the same reason the login banner renders null.
  if (items.length === 0) return null;

  const seenThrough = items.reduce(
    (latest, i) => (i.latest_at > latest ? i.latest_at : latest),
    items[0]!.latest_at,
  );

  return (
    <Paper
      elevation={0}
      sx={{
        p: 2,
        mb: 3,
        bgcolor: 'rgba(16, 185, 129, 0.08)',
        border: '1px solid',
        borderColor: 'rgba(16, 185, 129, 0.35)',
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1.5 }}>
        <ThumbUpAltIcon sx={{ fontSize: 18, color: 'success.light' }} />
        <Typography component="h2" sx={{ fontSize: '1rem', fontWeight: 600 }}>
          New since you last looked
        </Typography>
      </Box>

      <Box component="ul" sx={{ listStyle: 'none', p: 0, m: 0 }}>
        {items.map((i) => (
          <HelpfulRow key={i.note_id} item={i} />
        ))}
      </Box>

      {error && (
        <Alert severity="error" sx={{ mt: 1.5 }}>
          Could not save that. Try again.
        </Alert>
      )}

      {/* One explicit control, ≥48px. Never a timer, never cleared by scrolling past. */}
      <Button
        onClick={async () => {
          setBusy(true);
          setError(false);
          try {
            await onDismiss(seenThrough);
          } catch {
            setError(true);
          } finally {
            setBusy(false);
          }
        }}
        disabled={busy}
        sx={{ mt: 1.5, minHeight: 48, textTransform: 'none' }}
      >
        Got it
      </Button>
    </Paper>
  );
}
