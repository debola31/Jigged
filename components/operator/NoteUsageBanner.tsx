'use client';

import { useState } from 'react';
import { useLoad } from '@/hooks/useLoad';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import VisibilityOutlinedIcon from '@mui/icons-material/VisibilityOutlined';
import ThumbUpAltIcon from '@mui/icons-material/ThumbUpAlt';
import { getTypedSupabase as getSupabase } from '@/lib/supabase';

/**
 * "2 people found your notes helpful · 3 new views."
 *
 * The return half of the loop. An operator writes something down and, without
 * this, nothing comes back — no way to know whether it was read, no reason to
 * believe writing it did anything. This is the smallest honest signal that it did.
 *
 * TWO SIGNALS, AND HELPFUL LEADS
 *   A view is someone needing to look something up. A helpful is a colleague
 *   choosing to say it was worth reading. The second is the stronger claim, so it
 *   goes first when both are present. Whether views earn their place at all is an
 *   open question for the shop, not one to settle by argument — both are shown
 *   until a usability session says otherwise.
 *
 * NEW SINCE YOU LAST LOOKED, NOT "THIS WEEK"
 *   my_note_digest() returns RUNNING TOTALS across the caller's own notes. This
 *   component stores the totals it last acknowledged and renders the differences. So the banner appears exactly when something has happened and
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

// The running totals this device has already shown the operator. A fresh key each
// time the stored shape changes, so a value written by an older preview build is
// simply ignored rather than needing a parse fallback.
const SEEN_KEY = 'jigged:note-digest-acknowledged';

interface Totals {
  views: number;
  helpful: number;
}

/**
 * The totals already shown on THIS device, or null if it has never shown any —
 * a distinction that matters, because null means "adopt them silently", not
 * "everything is new". See the first-run note in the component.
 */
function readAcknowledged(): Totals | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(SEEN_KEY);
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as Partial<Totals>;
    // A mangled value is treated as absent rather than as zeros: zeros would
    // announce the entire history as new.
    if (typeof parsed?.views !== 'number' || typeof parsed?.helpful !== 'number') return null;
    return { views: parsed.views, helpful: parsed.helpful };
  } catch {
    return null; // private mode / quota — the banner is best-effort
  }
}

function writeAcknowledged(t: Totals): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(SEEN_KEY, JSON.stringify(t));
  } catch {
    /* ignore */
  }
}

/** Helpful leads: it is the stronger claim of the two. */
function summarise(freshHelpful: number, freshViews: number): string {
  const parts: string[] = [];
  if (freshHelpful > 0) {
    parts.push(
      freshHelpful === 1
        ? 'Someone found one of your notes helpful'
        : `${freshHelpful} people found your notes helpful`,
    );
  }
  if (freshViews > 0) {
    parts.push(freshViews === 1 ? '1 new view' : `${freshViews} new views`);
  }
  return `${parts.join(' · ')}.`;
}

interface NoteUsageBannerProps {
  companyId: string;
  /** Tapping through goes to the author's own notes; omitted until My Work ships. */
  onOpenDetail?: () => void;
}

export default function NoteUsageBanner({ companyId, onOpenDetail }: NoteUsageBannerProps) {
  const [banked, setBanked] = useState(false);

  const { data } = useLoad(async () => {
    const empty = { totals: { views: 0, helpful: 0 }, fresh: { views: 0, helpful: 0 } };
    const { data: rows, error } = await getSupabase().rpc('my_note_digest');
    // Silent on failure: a broken digest must not put an error in front of an
    // operator who was only trying to start work.
    if (error) return empty;
    const row = (rows as Totals[] | null)?.[0];
    const totals: Totals = { views: row?.views ?? 0, helpful: row?.helpful ?? 0 };

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
      writeAcknowledged(totals);
      return { totals, fresh: { views: 0, helpful: 0 } };
    }
    // viewer_count is monotonic. helpful is NOT — a colleague can take a mark
    // back — so clamp at zero rather than rendering a negative "new" count.
    return {
      totals,
      fresh: {
        views: Math.max(0, totals.views - prior.views),
        helpful: Math.max(0, totals.helpful - prior.helpful),
      },
    };
  }, [companyId]);

  const totals = data?.totals ?? { views: 0, helpful: 0 };
  const fresh = data?.fresh ?? { views: 0, helpful: 0 };
  const anything = fresh.helpful + fresh.views;

  // Both the ✕ and a tap-through count as "I have seen this". Tapping through
  // especially: coming back from My work to the same banner you just acted on
  // reads as if nothing happened.
  const acknowledge = () => {
    writeAcknowledged(totals);
    setBanked(true);
  };

  if (banked || anything <= 0) return null;

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
        // Matches whichever signal leads the sentence, so the icon is never
        // describing something the text does not say.
        icon={
          fresh.helpful > 0 ? (
            <ThumbUpAltIcon fontSize="inherit" />
          ) : (
            <VisibilityOutlinedIcon fontSize="inherit" />
          )
        }
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
        {summarise(fresh.helpful, fresh.views)}
      </Alert>
    </Box>
  );
}
