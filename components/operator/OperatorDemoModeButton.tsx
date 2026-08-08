'use client';

/**
 * Lets an operator step into the shop's demo company from their own phone.
 *
 * ## Why this exists
 *
 * Demo mode is not a flag — it is a second, hidden `company_id` you navigate into. Its only
 * control lived on the office Settings page behind `AdminGuard`, on a route `AuthGuard` bounces
 * `operator`-role users off before they can reach it. So an operator could not enter demo mode
 * at all, and `docs/modules/demo-mode.md` claimed the opposite ("operators … enter via Settings
 * like everyone else") for months. The only route in was an admin pasting a
 * `/operator/{demoCompanyId}` URL into a message.
 *
 * ## Entering, not creating — and the difference is enforced in the database
 *
 * `create_demo_company` raises `Access denied: must be admin of source company`, which stays.
 * This button therefore renders NOTHING until an admin has set the demo up: a control whose only
 * outcome is a permission error is worse than no control. `hasDemo` is the gate, and it costs no
 * request — `companies.demo_company_id` rides on the company row the operator shell already
 * fetched.
 *
 * `syncDemoAccess` before navigating is not optional. Membership is mirrored into the demo when it
 * is created, so an operator hired AFTER that has no access row in the demo company and the
 * layout's membership check would sign them out on arrival. The sync adds them; it is the same
 * call the office provider makes on every entry, and the reason it exists.
 *
 * ## Placement is a constraint, not a preference
 *
 * A SIBLING of the "Me" tab's identity row, beside Give feedback and Switch company — never inside
 * it. That row's invariant is that Log out is the only thing in it you can tap, so a habituated
 * thumb has nothing to slip from; see the header of `OperatorAccountBlock.tsx`, and the test
 * `leaves Log out with no neighbouring tap target to slip from` that fails if you move it. Styling
 * mirrors `OperatorCompanySwitcher` exactly, because these are peers: both answer "where am I
 * working", both are benign, and both are safe neighbours for each other.
 *
 * ## The label matches the office's verb
 *
 * "Enter demo mode", against Settings' "Enter Demo Mode" — sentence case to match this row's
 * neighbours. An earlier revision gave the shop floor its own name for this and was withdrawn:
 * one company, one feature, one name. Two names is a support problem the moment an admin says
 * "go into demo mode" and the operator cannot find those words anywhere on their screen.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import posthog from 'posthog-js';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import ScienceOutlinedIcon from '@mui/icons-material/ScienceOutlined';

import { useOperatorCompany } from '@/components/operator/OperatorCompanyContext';
import { syncDemoAccess } from '@/utils/demoAccess';

export default function OperatorDemoModeButton() {
  const router = useRouter();
  const { isDemo, hasDemo, demoCompanyId, realCompanyId } = useOperatorCompany();
  const [entering, setEntering] = useState(false);

  // Already in the demo — the bar at the top of every screen owns the way out, and a
  // second control for the same context here would compete with it.
  if (isDemo) return null;
  // No demo exists, or the ids have not resolved yet. Either way there is nowhere to go.
  if (!hasDemo || !demoCompanyId || !realCompanyId) return null;

  const handleEnter = async () => {
    setEntering(true);
    try {
      await syncDemoAccess(realCompanyId, demoCompanyId);
    } catch (err) {
      // Deliberately not fatal. The sync only ADDS members and converges flags; an
      // operator who was already mirrored (the common case — everyone present when the
      // demo was created) can enter perfectly well without it. Blocking on it would
      // turn a shop-wifi blip into "demo mode is broken", and the layout's own
      // membership check is the real gate on arrival.
      console.error('Could not sync demo access before entering demo mode:', err);
    }

    // `/jobs`, not the current page. The office provider preserves page context on
    // entry, which is right for an office user who was mid-task; here the operator is
    // standing on the "Me" tab and the demo experience begins at the station picker
    // and the dispatch list. A Me tab rendered against demo data is just confusing.
    posthog.capture('demo entered', { surface: 'operator' });
    router.push(`/operator/${demoCompanyId}/jobs`);
  };

  return (
    <Button
      onClick={handleEnter}
      disabled={entering}
      startIcon={
        entering ? <CircularProgress size={16} /> : <ScienceOutlinedIcon fontSize="small" />
      }
      size="small"
      sx={{
        minHeight: 40,
        px: 0.5,
        textTransform: 'none',
        color: 'text.secondary',
        '&:hover': { bgcolor: 'transparent', color: 'primary.light' },
      }}
    >
      {entering ? 'Opening…' : 'Enter demo mode'}
    </Button>
  );
}
