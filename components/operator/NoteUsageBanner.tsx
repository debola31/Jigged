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

/** The running total already shown; 0 on a fresh device or any bad/absent value. */
function readAcknowledged(): number {
  if (typeof window === 'undefined') return 0;
  try {
    const n = Number(window.localStorage.getItem(SEEN_KEY));
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    // Private mode, quota, or a hand-mangled value. Showing the banner is the
    // safe failure: the loop survives, at worst one extra impression.
    return 0;
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
  const [acknowledged, setAcknowledged] = useState(readAcknowledged);

  // Both the ✕ and a tap-through count as "I have seen this". Tapping through
  // especially: coming back from My work to the same banner you just acted on
  // reads as if nothing happened.
  const acknowledge = (total: number) => {
    writeAcknowledged(total);
    setAcknowledged(total);
  };

  const { data: total } = useLoad(async () => {
    const { data, error } = await getSupabase().rpc('my_note_view_digest');
    // Silent on failure: a broken digest must not put an error in front of an
    // operator who was only trying to start work.
    if (error) return 0;
    return (data as number | null) ?? 0;
  }, [companyId]);

  const runningTotal = total ?? 0;
  // Both counters are monotonic, so this can never go negative.
  const fresh = runningTotal - acknowledged;
  if (fresh <= 0) return null;

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
          acknowledge(runningTotal);
        }}
        {...(onOpenDetail
          ? {
              onClick: () => {
                acknowledge(runningTotal);
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
