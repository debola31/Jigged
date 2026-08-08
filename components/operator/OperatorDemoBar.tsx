'use client';

/**
 * "You are in the demo company, and here is the way out."
 *
 * ## Why the operator surface needs its own
 *
 * The office has `components/demo/DemoModeBanner.tsx`, mounted in the dashboard layout. The
 * operator surface had NOTHING — no badge, no banner, no exit. An admin who entered demo mode in
 * the office and tapped "Shop floor" landed on a shop-floor screen showing fabricated jobs with
 * nothing saying so, and the header's "Office" button pushes `/dashboard/{companyId}` using the
 * raw route param, so it carried them back into the demo dashboard rather than out. Now that an
 * operator can enter demo mode from their own phone, an exit is not a nicety.
 *
 * ## Same name and same styling as the office, deliberately
 *
 * `severity="info"` Alert with `borderRadius: 0`, exactly like `DemoModeBanner` — so the two
 * surfaces read as one feature rather than two that happen to overlap. It also means the colours
 * come from the theme's Alert palette instead of being hand-picked here, which is what the first
 * version got wrong (it hard-coded amber, and the message inherited `body2`'s `#C8CCD4` for a
 * measured 1.9:1 contrast).
 *
 * An earlier revision gave the shop floor its own name for this, on the argument that a demo is
 * something you show a buyer. **Withdrawn.** One company, one feature, one name: two names is a
 * support problem the moment an admin tells an operator to "go into demo mode" and the operator
 * cannot find those words anywhere on their screen.
 *
 * ## Wording, and why it is shorter than the office's
 *
 * The office says "You're in demo mode. Changes here won't affect your real company." The second
 * sentence does not fit beside a 48px Leave button at 375px — it wraps to three lines and doubles
 * the height of fixed chrome on a phone. The first clause carries the load on its own; the
 * reassurance about real data matters most to the admin deciding whether to click, which is the
 * office's audience, not the operator already standing in it.
 *
 * ## Why it lives inside the AppBar
 *
 * The AppBar is `position: fixed` and auto-sizes, so a second row inside it is one fixed element
 * rather than two that have to be kept in sync. The cost is that the layout's `main` offset stops
 * being the constant `48px` — see the note there; it is the single place that has to know, and
 * `DEMO_BAR_HEIGHT` is pinned below rather than left to the Alert's intrinsic size so the two
 * cannot drift.
 *
 * ## 48px, which is the house floor rather than a design preference
 *
 * The operator surface holds every tap target at ≥48px (Material's 48dp; WCAG 2.5.8 measures
 * centre-to-centre). Leaving demo mode mid-task because the bar was cramped enough to mis-tap
 * would be the worst possible failure of a control whose whole job is orientation, so the BAR is
 * sized around the button (56px, giving a 48px Leave 4px of clearance) rather than the button
 * being shrunk to fit a bar. The office's equivalent is a bare `size="small"` button, which is
 * fine on a mouse and is not fine here — that is the one place these two deliberately differ.
 */

import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import { useRouter } from 'next/navigation';

import { useOperatorCompany } from '@/components/operator/OperatorCompanyContext';

/**
 * Height of the bar. Exported because the layout's `main` offset has to add it.
 * 56 = a 48px Leave button plus 4px of clearance either side.
 */
export const DEMO_BAR_HEIGHT = 56;

export default function OperatorDemoBar() {
  const router = useRouter();
  const { isDemo, realCompanyId } = useOperatorCompany();

  if (!isDemo) return null;

  return (
    <Alert
      severity="info"
      // `role="status"`, not the Alert default `role="alert"`: this is standing context for
      // as long as the operator is in the demo company, and an assertive live region would
      // interrupt a screen reader on every navigation.
      role="status"
      sx={{
        borderRadius: 0,
        // Paddings zeroed and the height pinned so the bar is exactly DEMO_BAR_HEIGHT — the
        // layout offsets `main` by that constant, and an Alert left to size itself around a
        // 48px button would quietly disagree with it.
        py: 0,
        minHeight: DEMO_BAR_HEIGHT,
        alignItems: 'center',
        '& .MuiAlert-message': {
          py: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          width: '100%',
          gap: 1,
          minWidth: 0,
        },
        // Let the row shrink to the message rather than the message forcing the row wider
        // than a 375px screen.
        '& .MuiAlert-icon': { py: 0, alignItems: 'center' },
      }}
    >
      You&apos;re in demo mode
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
        sx={{ flexShrink: 0, minHeight: 48, px: 2, textTransform: 'none', fontWeight: 600 }}
      >
        Leave
      </Button>
    </Alert>
  );
}
