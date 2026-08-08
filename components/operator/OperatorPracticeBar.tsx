'use client';

/**
 * "You are in the practice shop, and here is the way out."
 *
 * ## Why the operator surface needs its own
 *
 * The office has `components/demo/DemoModeBanner.tsx`, mounted in the dashboard layout. The
 * operator surface had NOTHING — no badge, no banner, no exit. An admin who entered demo mode in
 * the office and tapped "Shop floor" landed on a shop-floor screen showing fabricated jobs with
 * nothing saying so, and the header's "Office" button pushes `/dashboard/{companyId}` using the
 * raw route param, so it carried them back into the demo dashboard rather than out. Now that an
 * operator can enter practice mode from their own phone, an exit is not a nicety.
 *
 * ## "Practice", not "demo" — a deliberate divergence
 *
 * The office says "demo mode". A demo is something you show a buyer; an operator handed a phone to
 * learn on is practising, and "practice" is the word a shop already uses for that. The two surfaces
 * have different audiences and the same underlying company, which is exactly the case where one
 * name for both would be worse. Recorded in `docs/modules/demo-mode.md` so the next reader does not
 * "fix" the inconsistency.
 *
 * ## Why it lives inside the AppBar
 *
 * The AppBar is `position: fixed` and auto-sizes, so a second row inside it is one fixed element
 * rather than two that have to be kept in sync. The cost is that the layout's `main` offset stops
 * being the constant `48px` — see the note there; it is the single place that has to know.
 *
 * ## 48px, which is the house floor rather than a design preference
 *
 * The operator surface holds every tap target at ≥48px (Material's 48dp; WCAG 2.5.8 measures
 * centre-to-centre). Leaving practice mode mid-task because the bar was cramped enough to mis-tap
 * would be the worst possible failure of a control whose whole job is orientation, so the bar is
 * sized to let Leave be a real target rather than shrinking the bar and arguing for an exception.
 * That makes the fixed chrome 96px while practising — acceptable, because practising is not
 * production work and the bar is absent the rest of the time.
 *
 * The message truncates and Leave never does: on a 375px screen the first two words carry the
 * signal on their own, and an exit you cannot see is the one thing this must not become.
 */

import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import ScienceOutlinedIcon from '@mui/icons-material/ScienceOutlined';
import { useRouter } from 'next/navigation';

import { useOperatorCompany } from '@/components/operator/OperatorCompanyContext';

/** Height of the bar. Exported because the layout's `main` offset has to add it. */
export const PRACTICE_BAR_HEIGHT = 48;

export default function OperatorPracticeBar() {
  const router = useRouter();
  const { isDemo, realCompanyId } = useOperatorCompany();

  if (!isDemo) return null;

  return (
    <Box
      // `role="status"`, not `role="alert"`: this is standing context for as long as the
      // operator is in the practice shop, and an assertive live region would interrupt a
      // screen reader on every navigation.
      role="status"
      sx={{
        height: PRACTICE_BAR_HEIGHT,
        display: 'flex',
        alignItems: 'center',
        gap: 1,
        // No right padding: Leave fills the bar's full height and sits flush to the
        // edge, which is what lets it be a true 48px target inside a 48px bar rather
        // than a 40px one floating in it.
        pl: 1.5,
        pr: 0,
        bgcolor: 'warning.main',
        borderTop: '1px solid rgba(0, 0, 0, 0.15)',
      }}
    >
      <ScienceOutlinedIcon sx={{ fontSize: 20, flexShrink: 0, color: 'common.black' }} />
      <Typography
        variant="body2"
        sx={{
          /**
           * ON THE TYPOGRAPHY, NOT INHERITED FROM THE ROW — and that is load-bearing.
           *
           * The palette's warning is a mid amber (#f59e0b), so dark text is what carries
           * contrast on it, unlike everywhere else in this dark-themed shell. But the theme
           * sets `body2` colour EXPLICITLY (`#C8CCD4`, lib/theme.ts), and a variant's own
           * colour beats a parent's inherited one — so setting `color` on the row silently
           * did nothing here. Measured in the browser before this was moved: light grey on
           * amber, about 1.9:1, against WCAG AA's 4.5:1 floor. It looked plausibly dark in a
           * screenshot, which is exactly why it needed measuring rather than eyeballing.
           *
           * Any Typography added to this bar needs the same treatment.
           */
          color: 'common.black',
          fontWeight: 600,
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        Practice mode — nothing here is real
      </Typography>
      <Button
        onClick={() => {
          // Null only when the reverse lookup for the source company failed — a dropped
          // request, not a missing company. `/operator` has no company-less route to fall
          // back to, so the honest move is to leave the button inert for that beat rather
          // than push somewhere wrong; the next resolve fills it in.
          if (realCompanyId) router.push(`/operator/${realCompanyId}/jobs`);
        }}
        disabled={!realCompanyId}
        variant="contained"
        size="small"
        sx={{
          ml: 'auto',
          flexShrink: 0,
          minHeight: PRACTICE_BAR_HEIGHT,
          px: 2.5,
          borderRadius: 0,
          textTransform: 'none',
          fontWeight: 600,
          bgcolor: 'common.black',
          color: 'common.white',
          '&:hover': { bgcolor: 'rgba(0, 0, 0, 0.8)' },
        }}
      >
        Leave
      </Button>
    </Box>
  );
}
