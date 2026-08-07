'use client';

/**
 * The identity and account half of the operator's "Me" tab.
 *
 * One export, above the operator's own work:
 *
 *   <OperatorIdentityRow />      who you are, the way out, the way to reach us, and — only for the
 *                                rare operator who works for two shops — the way between them
 *   … the operator's notes …     the reason the tab exists
 *
 * It used to be two, sandwiching the work, with Give feedback and then Log out below the
 * note list. That stopped being tenable once the list paged: an action below an unbounded
 * (and now paged) list is not "slightly slower to reach", it is unreachable, and a pilot's
 * feedback channel that only appears after a Show more is a channel nobody uses.
 *
 * ## Why identity is one row and not a card
 *
 * Material's bottom-navigation guidance rules out a settings/preferences tab outright, so the
 * old `Profile` tab was never something the guidance allowed — which is also why losing it to
 * Scan costs nothing. What *is* allowed is a top-level destination of equal importance, and
 * "the operator's own work" qualifies where "name, email, company, Log out" does not.
 *
 * So the work has to lead. NN/g measured navigation hidden behind an icon at 44–56% usage
 * against 89% for visible navigation, which is what made burying "My work" the wrong trade —
 * the fix is to keep the tab slot and put the work at the top of it, not to demote the work.
 * YouTube's "You" and Strava's "You" both do exactly this: one compact identity row, then
 * activity for the rest of the scroll. Strava's merged Profile *and* Training, which is the
 * direct answer to "this treats My work as spare real estate" — the merge is what gave the
 * work surface its reason to own a tab.
 *
 * The row carries the email as its third line. It used to sit near the bottom as "Signed in as
 * …", on the reasoning that it is the least useful thing here to an operator who already knows
 * who they are. True, but it is still identity, and identity belongs in the identity row — the
 * caption was a second, worse place for the same fact, parked behind a scroll.
 *
 * ## Why Log out is an isolated icon at the top, and why there is no confirm dialog
 *
 * It used to be a full-width button at the very end of the page, deliberately set apart: NN/g's
 * proximity guidance endorses using distance to make a consequential action slower to reach,
 * because operators repeating the same taps every shift slip into automaticity, and a mis-tap
 * here is a *slip* rather than a mistake — no amount of clearer labelling fixes a slip, only
 * layout does.
 *
 * That argument is now served by ISOLATION instead of distance, because distance stopped being
 * affordable. Log out sat below the operator's entire note list, which is unbounded, so the only
 * way to reach it was to scroll past everything they had ever written. An action you cannot
 * reach is not a safe action, it is a broken one.
 *
 * The slip risk the old placement guarded against came specifically from Log out sitting
 * ADJACENT to a benign button an operator taps often. At the end of a row whose only other
 * content is static text, there is nothing to slip from: it is the sole tap target in its row,
 * ≥48px, and its neighbours are the header's dashboard shortcut roughly 64px above and the
 * Give feedback link below and hard left — diagonally opposite, never beside. Both clear WCAG
 * 2.5.8's 24px centre-to-centre floor and Material's 8dp by a wide margin. That is the same
 * reasoning `app/operator/[companyId]/layout.tsx` uses to forbid a second icon button in the
 * header, applied rather than contradicted.
 *
 * This is a real constraint on future edits, not decoration: Give feedback is deliberately a
 * SIBLING of the identity row rather than a child of it. Moving it inside — to sit next to the
 * icon, which is the obvious tidy-up — reintroduces exactly the adjacency this is avoiding.
 * The test `leaves Log out with no neighbouring tap target to slip from` fails if you do.
 *
 * It is deliberately NOT behind a confirmation dialog, and moving it up does not change that:
 * logging out is recoverable by logging back in, and a dialog on a recoverable action is the
 * confirmation-fatigue trap that strips the dialogs that matter of their force.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Alert from '@mui/material/Alert';
import Avatar from '@mui/material/Avatar';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import Snackbar from '@mui/material/Snackbar';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import FeedbackIcon from '@mui/icons-material/Feedback';
import LogoutIcon from '@mui/icons-material/Logout';

import FeedbackDialog from '@/components/feedback/FeedbackDialog';
// `getSupabase`, not `getSupabase` — new code uses the typed client (issue #573). Only
// `auth.signOut` is used here, which is schema-independent.
import { getSupabase } from '@/lib/supabase';
import { clearStoredStation } from '@/components/operator/OperatorStationContext';
import OperatorCompanySwitcher from '@/components/operator/OperatorCompanySwitcher';

export interface OperatorIdentity {
  name: string;
  email: string;
  companyName: string;
  userId: string;
}

/** First letters of the name, for the avatar. Falls back to a person-shaped blank. */
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '';
  return parts
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('');
}

export function OperatorIdentityRow({
  companyId,
  identity,
}: {
  companyId: string;
  identity: OperatorIdentity | null;
}) {
  const router = useRouter();
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [feedbackSuccess, setFeedbackSuccess] = useState(false);

  const handleLogout = async () => {
    // Clears the persisted station (localStorage) on explicit logout — for every
    // company, not just this one, since the device may change hands.
    clearStoredStation();
    const supabase = getSupabase();
    // Local scope — sign out ONLY this device. An operator logging out here must not revoke
    // their session on their other devices (which surfaced as a forced re-login when marking
    // a job complete).
    await supabase.auth.signOut({ scope: 'local' });
    router.push(`/operator/${companyId}/login`);
  };

  return (
    <>
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 1.5,
        minHeight: 48,
      }}
    >
      <Avatar sx={{ bgcolor: 'primary.main', width: 40, height: 40, flexShrink: 0 }}>
        {initials(identity?.name ?? '')}
      </Avatar>
      {/* minWidth: 0 is what lets the three noWrap lines actually truncate instead of
          forcing the row wider and pushing Log out off a 375px screen. */}
      <Box sx={{ minWidth: 0, flex: 1 }}>
        <Typography sx={{ fontWeight: 600 }} noWrap>
          {identity?.name || 'You'}
        </Typography>
        {identity?.companyName && (
          <Typography variant="body2" color="text.secondary" noWrap>
            {identity.companyName}
          </Typography>
        )}
        {identity?.email && (
          <Typography variant="caption" color="text.secondary" noWrap sx={{ display: 'block' }}>
            {identity.email}
          </Typography>
        )}
      </Box>

      {/* The only tap target in this row — see the note at the top of this file for why
          that isolation is what replaced the old "put it last" distance argument. */}
      <Tooltip title="Log out">
        <IconButton
          onClick={handleLogout}
          aria-label="Log out"
          sx={{
            flexShrink: 0,
            width: 48,
            height: 48,
            color: 'text.secondary',
            '&:hover': { bgcolor: 'rgba(239, 68, 68, 0.1)', color: 'error.main' },
          }}
        >
          <LogoutIcon />
        </IconButton>
      </Tooltip>
    </Box>

    {/*
      Give feedback, at the top and always on screen.

      It used to be a full-width button at the very bottom of the tab, under the
      operator's whole note list, which is the one place a pilot's feedback channel
      must not be: the people most likely to have something to say are the ones who
      never scrolled that far. Being small is the trade for being permanent — this is
      a secondary action that must be FINDABLE, not prominent, and a full-width button
      up here would outrank the operator's own work, which the tab exists for.

      A SIBLING of the identity row, not a child of it. Log out has to stay the only
      tap target in that row — that isolation is what replaced the old "put it last"
      distance argument (see the note at the top of this file), and a link sitting
      beside it would give a habituated thumb something to slip from. Here it is below
      and hard left, diagonally opposite the icon.
    */}
    <Box sx={{ mb: 2, pl: 7, display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
      <Button
        onClick={() => setFeedbackOpen(true)}
        startIcon={<FeedbackIcon fontSize="small" />}
        size="small"
        sx={{
          minHeight: 40,
          px: 0.5,
          textTransform: 'none',
          color: 'text.secondary',
          '&:hover': { bgcolor: 'transparent', color: 'primary.light' },
        }}
      >
        Give feedback
      </Button>

      {/*
        Renders nothing unless this operator actually belongs to more than one company, which
        almost none do. It sits HERE, beside Give feedback, for the same reason that button does:
        both are benign secondary actions, so they are safe neighbours for each other, and both
        must stay out of the identity row where Log out has to remain the only tap target.
      */}
      <OperatorCompanySwitcher companyId={companyId} userId={identity?.userId} />
    </Box>

    <FeedbackDialog
      open={feedbackOpen}
      onClose={() => setFeedbackOpen(false)}
      onSuccess={() => {
        setFeedbackOpen(false);
        setFeedbackSuccess(true);
      }}
      userId={identity?.userId}
    />
    <Snackbar
      open={feedbackSuccess}
      autoHideDuration={4000}
      onClose={() => setFeedbackSuccess(false)}
      anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
    >
      <Alert severity="success" onClose={() => setFeedbackSuccess(false)}>
        Thanks for your feedback!
      </Alert>
    </Snackbar>
    </>
  );
}

