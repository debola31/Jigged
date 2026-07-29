'use client';

import { useState } from 'react';
import { useLoad } from '@/hooks/useLoad';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import VisibilityOutlinedIcon from '@mui/icons-material/VisibilityOutlined';
import { getTypedSupabase as getSupabase } from '@/lib/supabase';

/**
 * "3 new views on your notes."
 *
 * The return half of the loop. An operator writes something down and, without
 * this, nothing comes back — no way to know whether it was read, no reason to
 * believe writing it did anything. This is the smallest honest signal that it did.
 *
 * NEW SINCE YOU LAST LOOKED, NOT "THIS WEEK"
 *   my_note_view_digest() returns a RUNNING TOTAL of views across the caller's
 *   own notes. This component stores the total it last acknowledged and renders
 *   the difference. So the banner appears exactly when something has happened and
 *   goes quiet the moment it has been seen — no weekly window, which was always
 *   arbitrary, and no nag on every visit to the jobs list.
 *
 *   The earlier weekly version had a suppression bug worth remembering: the count
 *   climbed all week, so an operator who found the repetition annoying on Monday
 *   and dismissed at "1 person" never saw Friday's "6" — the largest and most
 *   motivating number of the week, silently swallowed. The nag and the reward
 *   were the same object, so killing one killed the other.
 *
 * WHY A COUNT AND NOT A TIMESTAMP
 *   Storing "last opened" as an instant would mean sending it back as a query
 *   window, and a caller-supplied window is a bisection oracle: narrow it
 *   repeatedly and you recover WHEN a note was read. Combined with note_viewers()
 *   naming the reader, that reconstructs "Kurtis had to look this up on Tuesday".
 *   A count is a number the server already told us, so sending nothing back keeps
 *   the RPC argument-free and there is no window to narrow.
 *
 * WHAT IT MUST NOT SAY
 *   No names. Who read what belongs to the author alone and lives behind
 *   note_viewers(); a banner is glanceable and public to anyone over a shoulder.
 *
 *   Nothing at zero. A standing "0 views" is a permanent reminder that nobody
 *   cares, which is worse than silence. It renders null.
 */

// The running total this device has already shown the operator. A fresh key each
// time the stored shape changes, so a value written by an older preview build is
// simply ignored rather than needing a parse fallback.
const SEEN_KEY = 'jigged:note-views-acknowledged';

/**
 * The running total already shown on THIS device, or null if it has never shown
 * one — a distinction that matters, because null means "adopt the total
 * silently", not "everything is new". See the first-run note in the component.
 */
function readAcknowledged(): number | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(SEEN_KEY);
    if (raw === null) return null;
    const n = Number(raw);
    // A mangled value is treated as absent rather than as zero: zero would
    // announce the entire history as new.
    return Number.isFinite(n) && n >= 0 ? n : null;
  } catch {
    return null; // private mode / quota — the banner is best-effort
  }
}

function writeAcknowledged(total: number): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(SEEN_KEY, String(total));
  } catch {
    /* ignore */
  }
}

interface NoteUsageBannerProps {
  companyId: string;
  /** Tapping through goes to the author's own notes; omitted until My Work ships. */
  onOpenDetail?: () => void;
}

export default function NoteUsageBanner({ companyId, onOpenDetail }: NoteUsageBannerProps) {
  const [banked, setBanked] = useState(false);

  const { data } = useLoad(async () => {
    const { data: total, error } = await getSupabase().rpc('my_note_view_digest');
    // Silent on failure: a broken digest must not put an error in front of an
    // operator who was only trying to start work.
    if (error) return { total: 0, fresh: 0 };
    const runningTotal = (total as number | null) ?? 0;

    const prior = readAcknowledged();
    if (prior === null) {
      // FIRST RUN ON THIS DEVICE. Adopt the total without announcing it. The
      // acknowledged mark lives in localStorage, so it does not follow the
      // person — sign in on a shop tablet, a replacement phone, a second
      // browser, or after clearing site data, and a zero default would render
      // the ENTIRE history as new: "312 new views on your notes" after a year.
      // The banner's whole credibility rests on its number being true, and in a
      // shop this size the author can simply ask someone and find out it wasn't.
      //
      // The cost is one missed announcement: views that accrued while this
      // device was away are never banner-announced. That is information delayed,
      // not lost — the full picture is on My work, one tap down. Announcing a
      // falsehood is worse than staying quiet.
      writeAcknowledged(runningTotal);
      return { total: runningTotal, fresh: 0 };
    }
    // Both counters are monotonic, so this can never go negative.
    return { total: runningTotal, fresh: runningTotal - prior };
  }, [companyId]);

  const runningTotal = data?.total ?? 0;
  const fresh = data?.fresh ?? 0;

  // Both the ✕ and a tap-through count as "I have seen this". Tapping through
  // especially: coming back from My work to the same banner you just acted on
  // reads as if nothing happened.
  const acknowledge = () => {
    writeAcknowledged(runningTotal);
    setBanked(true);
  };

  if (banked || fresh <= 0) return null;

  return (
    <Box sx={{ mb: 2 }}>
      <Alert
        severity="success"
        // The default success icon is a check circle — the vocabulary of "the
        // thing you just did worked". Nobody did anything here; this is ambient
        // news about other people. The eye ties it to the view counts on My work,
        // which is where tapping it lands, and stops the banner reading as a
        // confirmation of an action. Green stays: it is doing real work as the
        // reward signal, and that is the whole point of the banner.
        icon={<VisibilityOutlinedIcon fontSize="inherit" />}
        onClose={(e) => {
          // The close button sits INSIDE the tappable Alert, so without this the
          // click bubbles to onOpenDetail and dismissing navigates the operator
          // away from the screen they were trying to clear.
          e.stopPropagation();
          acknowledge();
        }}
        {...(onOpenDetail
          ? {
              onClick: () => {
                acknowledge();
                onOpenDetail();
              },
              sx: { cursor: 'pointer', minHeight: 48 },
            }
          : { sx: { minHeight: 48 } })}
      >
        {fresh === 1 ? '1 new view on your notes.' : `${fresh} new views on your notes.`}
      </Alert>
    </Box>
  );
}
