'use client';

/**
 * The identity and account half of the operator's "Me" tab.
 *
 * Two exports, meant to sandwich the operator's own work:
 *
 *   <OperatorIdentityRow />      one compact row — who you are
 *   … the operator's notes …     the reason the tab exists
 *   <OperatorAccountActions />   feedback, then Log out last
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
 * ## Why Log out is last, and why there is no confirm dialog
 *
 * Log out sits at the very end, in its own visually distinct block, separated from the benign
 * action above it. NN/g's proximity guidance explicitly endorses using distance to make a
 * consequential action slightly slower to reach, because operators repeating the same taps
 * every shift slip into automaticity — and a mis-tap here is a *slip*, not a mistake, so no
 * amount of clearer labelling fixes it. Only layout does.
 *
 * It is deliberately NOT behind a confirmation dialog: logging out is recoverable by logging
 * back in, and a dialog on a recoverable action is the confirmation-fatigue trap that strips
 * the dialogs that matter of their force.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Alert from '@mui/material/Alert';
import Avatar from '@mui/material/Avatar';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Divider from '@mui/material/Divider';
import Snackbar from '@mui/material/Snackbar';
import Typography from '@mui/material/Typography';
import FeedbackIcon from '@mui/icons-material/Feedback';
import LogoutIcon from '@mui/icons-material/Logout';

import FeedbackDialog from '@/components/feedback/FeedbackDialog';
// `getTypedSupabase`, not `getSupabase` — new code uses the typed client (issue #573). Only
// `auth.signOut` is used here, which is schema-independent.
import { getTypedSupabase } from '@/lib/supabase';
import { clearStoredStation } from '@/components/operator/OperatorStationContext';

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

export function OperatorIdentityRow({ identity }: { identity: OperatorIdentity | null }) {
  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 1.5,
        mb: 2,
        minHeight: 48,
      }}
    >
      <Avatar sx={{ bgcolor: 'primary.main', width: 40, height: 40 }}>
        {initials(identity?.name ?? '')}
      </Avatar>
      <Box sx={{ minWidth: 0 }}>
        <Typography sx={{ fontWeight: 600 }} noWrap>
          {identity?.name || 'You'}
        </Typography>
        {identity?.companyName && (
          <Typography variant="body2" color="text.secondary" noWrap>
            {identity.companyName}
          </Typography>
        )}
      </Box>
    </Box>
  );
}

export function OperatorAccountActions({
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
    // Clears the persisted station (localStorage) on explicit logout — same store
    // OperatorStationContext uses.
    clearStoredStation();
    const supabase = getTypedSupabase();
    // Local scope — sign out ONLY this device. An operator logging out here must not revoke
    // their session on their other devices (which surfaced as a forced re-login when marking
    // a job complete).
    await supabase.auth.signOut({ scope: 'local' });
    router.push(`/operator/${companyId}/login`);
  };

  return (
    <Box sx={{ mt: 4 }}>
      <Divider sx={{ mb: 2 }} />

      <Button
        variant="outlined"
        startIcon={<FeedbackIcon />}
        onClick={() => setFeedbackOpen(true)}
        fullWidth
        sx={{ minHeight: 48 }}
      >
        Give feedback
      </Button>

      {/* The email lives down here rather than in the identity row: it is the least useful
          thing on the page to an operator who already knows who they are, and it is the thing
          a support conversation occasionally needs. */}
      {identity?.email && (
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ display: 'block', mt: 2, textAlign: 'center' }}
        >
          Signed in as {identity.email}
        </Typography>
      )}

      {/* Log out, last and set apart — see the note at the top of this file. The gap above is
          the point, not spacing for its own sake. */}
      <Box sx={{ mt: 3 }}>
        <Divider sx={{ mb: 2 }} />
        <Button
          variant="outlined"
          color="error"
          startIcon={<LogoutIcon />}
          onClick={handleLogout}
          fullWidth
          sx={{ minHeight: 48 }}
        >
          Log out
        </Button>
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
    </Box>
  );
}
