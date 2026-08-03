'use client';

import { useParams, useRouter, usePathname } from 'next/navigation';
import { useState, useEffect, useRef } from 'react';
import Box from '@mui/material/Box';
import AppBar from '@mui/material/AppBar';
import Toolbar from '@mui/material/Toolbar';
import Typography from '@mui/material/Typography';
import IconButton from '@mui/material/IconButton';
import BottomNavigation from '@mui/material/BottomNavigation';
import BottomNavigationAction from '@mui/material/BottomNavigationAction';
import Paper from '@mui/material/Paper';
import CircularProgress from '@mui/material/CircularProgress';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import ListItemText from '@mui/material/ListItemText';
import WorkIcon from '@mui/icons-material/Work';
import WarehouseOutlinedIcon from '@mui/icons-material/WarehouseOutlined';
import BuildOutlinedIcon from '@mui/icons-material/BuildOutlined';
import StickyNote2OutlinedIcon from '@mui/icons-material/StickyNote2Outlined';
import QrCodeScannerIcon from '@mui/icons-material/QrCodeScanner';
import LocationScanner from '@/components/scanner/LocationScanner';
import { scanDestination } from '@/lib/jiggedScan';
import ArrowDropDownIcon from '@mui/icons-material/ArrowDropDown';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import DashboardIcon from '@mui/icons-material/Dashboard';
import { getSupabase } from '@/lib/supabase';
import AppAmbientBackdrop from '@/components/layout/AppAmbientBackdrop';
import { useCompanyFeatures } from '@/hooks/useCompanyFeatures';
import { OperatorStationProvider, useStationContext } from '@/components/operator/OperatorStationContext';
import { OperatorChromeProvider, useOperatorChrome, useOperatorNav } from '@/components/operator/OperatorChromeContext';
import JiggedIcon from '@/components/branding/JiggedIcon';
import { logOperatorEvent } from '@/utils/operatorEventsAccess';
import type { AuthChangeEvent } from '@supabase/supabase-js';

/**
 * Operator View layout.
 *
 * Mobile-first layout with:
 * - Top header with station picker and (for non-operators) a dashboard shortcut. Deliberately
 *   exactly one icon button — see the note where the second one used to be.
 * - Bottom navigation: Jobs · Inventory · Scan · Maintenance · Me. Five is the ceiling, which is
 *   why Scan took Profile's slot and Profile's contents moved into Me.
 * - No sidebar (unlike admin dashboard)
 * - Uses Supabase Auth for session management
 * - OperatorStationProvider for shared station state
 */
export default function OperatorLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const params = useParams();
  const router = useRouter();
  const pathname = usePathname();
  const companyId = params.companyId as string;

  const [userRole, setUserRole] = useState<string>('operator');
  const [navValue, setNavValue] = useState<string>('jobs');
  const [isLoading, setIsLoading] = useState(true);

  const supabase = getSupabase();

  // Whether we're on the login screen. Derived to a BOOLEAN on purpose: the auth effect
  // below keys off this rather than off `pathname`, so it re-runs only when you cross the
  // login boundary — not on every tap of the bottom bar. See the note on the effect.
  const isAuthPage = Boolean(pathname?.includes('/login'));

  // The companyId we have already validated in this mount. Guards against a re-run
  // repeating the network work (React's development double-invoke, or a bounce out to
  // login and back). Cleared on sign-out and when we land on login, so a NEW session
  // always re-validates.
  const validatedFor = useRef<string | null>(null);

  /**
   * Validate the session once per company, NOT once per navigation.
   *
   * `pathname` used to be in this dependency list, so every in-app navigation re-ran the
   * whole check: another `auth.getSession()`, another `user_company_access` round trip,
   * another `app_opened`. That mattered because `supabase-js` serialises `getSession()`
   * behind a `navigator.locks` acquisition and can refresh the token inside that lock —
   * so on a page that already fans out several session reads (Me was the worst: four),
   * navigating added one more contender to a queue that was already the slowest thing on
   * screen. Operators saw it as the Me tab hanging.
   *
   * It also fixes `app_opened`, which is documented below as top-of-funnel — one per
   * session. Counting a tab tap as an app open inflated every ratio measured against it.
   */
  useEffect(() => {
    const checkAuth = async () => {
      // Skip auth check on login page. Clearing the guard here is what makes a fresh
      // sign-in re-validate rather than inherit the previous user's answer.
      if (isAuthPage) {
        validatedFor.current = null;
        setIsLoading(false);
        return;
      }

      if (validatedFor.current === companyId) return;

      // 1. Get Supabase session
      const { data: { session } } = await supabase.auth.getSession();

      if (!session) {
        router.push(`/operator/${companyId}/login`);
        return;
      }

      // 2. Validate user has access to this company (uses user_company_access)
      const { data: operatorAccess } = await supabase
        .from('user_company_access')
        .select('id, name, role')
        .eq('user_id', session.user.id)
        .eq('company_id', companyId)
        .single();

      if (!operatorAccess) {
        // Local scope — only clear this device's bad session; don't revoke the
        // user's sessions on other devices.
        await supabase.auth.signOut({ scope: 'local' });
        router.push(`/operator/${companyId}/login`);
        return;
      }

      validatedFor.current = companyId;
      setUserRole(operatorAccess.role || 'operator');

      // Top of the funnel. Everything else is measured against this: if
      // app_opened is near zero, no downstream number is interpretable and the
      // problem is deployment, not the product. Fired after membership is
      // confirmed so a bounced sign-in is not counted as a session — and, since
      // this effect no longer re-runs per navigation, once per session rather
      // than once per screen.
      logOperatorEvent(companyId, 'app_opened');

      setIsLoading(false);
    };

    checkAuth();

    // Listen for auth state changes
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event: AuthChangeEvent) => {
      if (event === 'SIGNED_OUT') {
        // Drop the validation answer — it was about a user who is no longer signed in.
        // (`getCurrentMember` needs no equivalent: it only ever caches a request that is
        // still in flight, so it has nothing that can outlive a session.)
        validatedFor.current = null;
        router.push(`/operator/${companyId}/login`);
      }
    });

    return () => {
      subscription.unsubscribe();
    };
  }, [companyId, router, isAuthPage, supabase]);

  // Update nav value based on current path.
  //
  // `/profile` now redirects to `/my-work` (the "Me" tab), so it needs no branch of its own —
  // the redirect lands on a path that already matches below. Keeping a `'profile'` branch here
  // would have set a nav value no tab owns, which reads as "no tab selected".
  useEffect(() => {
    if (pathname?.includes('/inventory')) setNavValue('inventory');
    else if (pathname?.includes('/maintenance')) setNavValue('maintenance');
    else if (pathname?.includes('/my-work')) setNavValue('my-work');
    else setNavValue('jobs');
  }, [pathname]);

  /** Scan opens over whatever you were doing; every other tab is a route. */
  const [scanning, setScanning] = useState(false);

  const handleNavChange = (_event: React.SyntheticEvent, newValue: string) => {
    // Scan is a modal action wearing a tab's clothes. Deliberately does NOT become the
    // selected tab: you're still on Jobs (or wherever) with a scanner over the top, and
    // leaving the selection where it was is what makes closing the dialog feel like
    // dismissing something rather than navigating back.
    if (newValue === 'scan') {
      setScanning(true);
      return;
    }

    setNavValue(newValue);
    if (newValue === 'inventory') router.push(`/operator/${companyId}/inventory`);
    else if (newValue === 'maintenance') router.push(`/operator/${companyId}/maintenance`);
    else if (newValue === 'my-work') router.push(`/operator/${companyId}/my-work`);
    else router.push(`/operator/${companyId}/jobs`);
  };

  /**
   * Where each kind of Jigged QR goes.
   *
   * Both are deep links the printed paper already encodes, so this mirrors what the login
   * passthrough would have done — minus the camera-app round trip and the interstitial. The
   * mapping itself lives in `scanDestination` so it is testable without mounting this layout, and
   * so it can be compared against `postLoginPath` rather than silently drifting from it.
   */
  const handleScanLocation = (locationId: string) => {
    setScanning(false);
    router.push(scanDestination(companyId, { kind: 'location', locationId }));
  };

  const handleScanTraveler = ({
    jobId,
    jobPartId,
    operationId,
  }: {
    jobId: string;
    jobPartId: string;
    operationId?: string;
  }) => {
    setScanning(false);
    router.push(scanDestination(companyId, { kind: 'traveler', jobId, jobPartId, operationId }));
  };

  // Don't show header/nav on login page — same `isAuthPage` the auth effect keys off.
  if (isAuthPage) {
    return (
      <Box
        sx={{
          minHeight: '100vh',
          display: 'flex',
          flexDirection: 'column',
          bgcolor: 'background.default',
        }}
      >
        {children}
      </Box>
    );
  }

  // Show loading while checking auth
  if (isLoading) {
    return (
      <Box
        sx={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          bgcolor: 'background.default',
        }}
      >
        <CircularProgress />
      </Box>
    );
  }

  return (
    <OperatorStationProvider>
      <OperatorChromeProvider>
        <OperatorShell
          userRole={userRole}
          companyId={companyId}
          navValue={navValue}
          onNavChange={handleNavChange}
        >
          {children}
        </OperatorShell>

        {/*
          Lives at the layout level, not on a page, because the tab bar owns it — so it opens
          over whatever screen you were on and closing it returns you there. A Dialog portals
          out of this position anyway, so being a sibling of the shell costs nothing.

          Both handlers mirror the login passthrough's `postLoginPath`, which is what the
          printed QR would have gone through: same destination, minus the camera-app round trip
          and the login interstitial.
        */}
        <LocationScanner
          open={scanning}
          onClose={() => setScanning(false)}
          onScan={handleScanLocation}
          onScanTraveler={handleScanTraveler}
          /* Without this, a label printed by ANOTHER shop decodes fine and both handlers below
             push the route regardless — the operator lands on someone else's job or bin and gets
             an RLS error page instead of "that isn't yours". The scanner now refuses it before
             either handler runs. */
          expectedCompanyId={companyId}
          title="Scan a Jigged label"
        />
      </OperatorChromeProvider>
    </OperatorStationProvider>
  );
}

/**
 * Inner shell component that can access station context.
 */
function OperatorShell({
  userRole,
  companyId,
  navValue,
  onNavChange,
  children,
}: {
  userRole: string;
  companyId: string;
  navValue: string;
  onNavChange: (event: React.SyntheticEvent, newValue: string) => void;
  children: React.ReactNode;
}) {
  const { stationId, stationName, stations, setStation } = useStationContext();
  const chrome = useOperatorChrome();
  const nav = useOperatorNav();
  const { features } = useCompanyFeatures();
  const pathname = usePathname();
  const router = useRouter();
  /**
   * ⚠️ Both of these hide a tab, which is a KNOWN DEVIATION from Apple's guidance: "Don't disable
   * or hide tab bar buttons, even when their content is unavailable. Having tab bar buttons
   * available in some cases but not others makes your app's interface appear unstable and
   * unpredictable. If a section is empty, explain why its content is unavailable."
   *
   * Taken deliberately: these are not empty sections but genuine entitlement boundaries — a shop
   * without the locations flag has no places at all, and `/inventory/locations` redirects. Showing
   * a tab that explains why it doesn't work would be worse than not showing it.
   *
   * The cost is real, though, and it is why the tab ORDER is constrained: because MUI distributes
   * slots evenly, changing the tab COUNT moves every tab's physical position. Keeping one optional
   * tab on each side of Scan is what bounds that (see the note above the bar).
   */
  const showInventory = Boolean(features.inventory_locations);
  // A machine IS a station, so the logbook only exists once one is selected —
  // deliberately NOT added to the navVisible escape list below, unlike inventory
  // and my-work. Without a station there is no machine to have a tab for.
  //
  // Note this one can flip DURING a session, when a station is picked or cleared — so the bar
  // reflows mid-shift, unlike the flag-only gate above. The station is normally chosen once at
  // login, before real work, which is what makes that acceptable.
  const showMaintenance = Boolean(features.machine_maintenance) && Boolean(stationId);
  // The warehouse is station-independent, so keep the nav (and a way out) on
  // inventory routes even before a station is picked.
  const isInventoryRoute = pathname?.includes('/inventory') ?? false;
  // Same reason as inventory: what you've written isn't tied to a station, and
  // this is the destination the login banner points at — it must be reachable
  // before a station is picked.
  const isMyWorkRoute = pathname?.includes('/my-work') ?? false;
  const navVisible = Boolean(stationId) || isInventoryRoute || isMyWorkRoute;
  const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);

  const handleStationMenuOpen = (event: React.MouseEvent<HTMLElement>) => {
    setAnchorEl(event.currentTarget);
  };

  const handleStationMenuClose = () => {
    setAnchorEl(null);
  };

  const handleStationSelect = (stationId: string) => {
    setStation(stationId);
    setAnchorEl(null);
    router.push(`/operator/${companyId}/jobs`);
  };

  return (
    <Box
      sx={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        bgcolor: 'background.default',
      }}
    >
      {/* Same lit gradient canvas as the dashboard shell, for a consistent app look.
          The fixed AppBar/BottomNav (high z-index) and the main content (z-index 1 below)
          sit above it. */}
      <AppAmbientBackdrop />

      {/* Top App Bar */}
      <AppBar
        position="fixed"
        elevation={0}
        sx={{
          bgcolor: 'rgba(17, 20, 57, 0.95)',
          backdropFilter: 'blur(8px)',
          borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
        }}
      >
        <Toolbar sx={{ minHeight: '48px !important', px: 1 }}>
          {/* Left: back on detail pages, JIG logo on back-less roots — which is every
              tab the bottom bar owns. A tab root has no "back": the nav bar already IS
              the way between them, so an arrow there just re-enters a sibling tab and
              reads as though the operator has gone somewhere they need to leave.

              32px, not the 20px this started at. It alternates in the same slot as the
              `size="small"` back IconButton (~34px including its ripple), so anything
              much smaller made the header visibly lurch as you moved between a traveler
              and a tab root — and at 20px the mark was too small to read as branding at
              arm's length on a shop floor. 32 clears the 48px Toolbar by 8px either side.
              `ml` matches the IconButton's own padding so the left edge doesn't shift. */}
          {chrome.back ? (
            <IconButton
              color="inherit"
              size="small"
              aria-label={chrome.back.label ?? 'Back'}
              onClick={() => nav.goBack()}
            >
              <ArrowBackIcon fontSize="small" />
            </IconButton>
          ) : (
            <Box sx={{ display: 'flex', alignItems: 'center', ml: 0.5 }}>
              <JiggedIcon size={32} />
            </Box>
          )}

          {/* Center: station name + dropdown, centered between the clusters (the
              iOS "title" slot). Kept in a stable spot so it doesn't jump as the
              operator navigates; truncates rather than colliding with the icons. */}
          <Box sx={{ flex: 1, display: 'flex', justifyContent: 'center', minWidth: 0, px: 1 }}>
            {stationId && (
              <Box
                onClick={handleStationMenuOpen}
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  cursor: 'pointer',
                  minHeight: 48,
                  maxWidth: '100%',
                  overflow: 'hidden',
                  borderRadius: 1,
                  px: 0.75,
                  '&:hover': { bgcolor: 'rgba(212, 135, 42, 0.08)' },
                }}
              >
                <Typography
                  variant="body1"
                  component="span"
                  sx={{
                    color: '#D4872A',
                    fontWeight: 600,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {stationName || 'Select Station'}
                </Typography>
                <ArrowDropDownIcon sx={{ color: '#D4872A', fontSize: 20, ml: 0.25, flexShrink: 0 }} />
              </Box>
            )}
          </Box>

          {/* Right: dashboard shortcut for non-operators (admins/leads viewing
              the operator view). */}
          {userRole !== 'operator' && (
            <IconButton
              color="inherit"
              onClick={() => router.push(`/dashboard/${companyId}`)}
              aria-label="Go to dashboard"
              size="small"
              sx={{ ml: 0.5 }}
            >
              <DashboardIcon fontSize="small" />
            </IconButton>
          )}

          {/*
            NO second header icon button here.

            An interim version of this change put Profile here as an IconButton next to the
            dashboard one above, which put two small targets side by side with almost no gap.
            That is the worst case in Fitts's law — small target, near-zero distance — and
            because touch platforms resolve a tap to the *closest* control, missing one doesn't
            do nothing, it fires the other. WCAG 2.5.8 measures this as centre-to-centre spacing
            rather than visible gap, and Material asks for ≥8dp of clearance; a mis-tap here is a
            slip, which no clearer label or tooltip can fix — only layout can.

            Profile's contents moved into the "Me" tab instead, which removes the target rather
            than shrinking the odds of hitting the wrong one.
          */}
        </Toolbar>

        {/* Station Selector Menu */}
        <Menu
          anchorEl={anchorEl}
          open={Boolean(anchorEl)}
          onClose={handleStationMenuClose}
          slotProps={{
            paper: {
              sx: {
                maxHeight: 300,
                minWidth: 200,
              },
            },
          }}
        >
          {stations.map((station) => (
            <MenuItem
              key={station.id}
              onClick={() => handleStationSelect(station.id)}
              sx={{ minHeight: 48 }}
            >
              <ListItemText primary={station.name} />
            </MenuItem>
          ))}
        </Menu>
      </AppBar>

      {/*
        Main content. THE DOCUMENT SCROLLS — this box must not.

        It used to be `flex: 1` + `overflow: 'auto'`, which made it a private scroll
        container: every sibling here is `position: fixed`, so it was the only in-flow
        item, its flex basis resolved to 0, and it settled at exactly
        `100vh - 48px - (56px + inset)` with its own scrollbar. Two bugs came out of that,
        and both read to an operator as "the page is stuck":

          1. `scrollTop` survived tab switches. This layout never unmounts on a client
             navigation and Next's scroll restoration only touches `window`, so tapping Me
             from a scrolled jobs list dropped you into the middle of the new page.

          2. The end of the page was unreachable on a phone. `100vh` is the LARGE viewport
             (browser chrome hidden) while the fixed bottom bar tracks the SMALL one, so at
             maximum scroll the last chunk of content sat below the fold with no way to
             reach it. On the Me tab that chunk was Give feedback and Log out.

        Letting the document scroll fixes both for free: native scroll restoration works,
        and `100vh` stops being load-bearing for anything you have to be able to reach.
      */}
      <Box
        component="main"
        sx={{
          position: 'relative',
          zIndex: 1, // above the fixed ambient backdrop
          flexGrow: 1, // fill the viewport so the background reaches the bottom on short pages
          mt: '48px', // Single-row AppBar height
          // BottomNavigation height plus whatever the device reserves at the bottom (the iOS home
          // indicator). `viewportFit: 'cover'` in the root layout is what makes the inset non-zero.
          mb: navVisible ? 'calc(56px + env(safe-area-inset-bottom))' : 0,
          p: 2,
        }}
      >
        {/*
          The operator surface is a phone, and nothing was enforcing that.
          On a desktop browser every card stretched to the full window — a four-line movement row
          rendered ~1,900px wide with the text in the leftmost fifth, which is what made the
          activity feed look sparse and unreadable rather than dense. A phone-width column is the
          honest rendering of a phone-first app in a big window, and it costs one rule here
          instead of a `maxWidth` on each of the pages inside.

          Applies to every operator screen, deliberately — Jobs and Me had the same problem and
          nobody had noticed because nobody opens them on a monitor.
        */}
        <Box sx={{ maxWidth: 680, mx: 'auto' }}>{children}</Box>
      </Box>

      {/* Bottom Navigation — hidden only on the bare station-selection screen */}
      {navVisible && (
        <Paper
          sx={{
            position: 'fixed',
            bottom: 0,
            left: 0,
            right: 0,
            zIndex: 1000,
            // Pad BELOW the tabs rather than shifting them up, so the bar's background still
            // reaches the bottom edge of the screen. Without this the tabs sit under the iOS home
            // indicator once the app is on a home screen — a 48px touch target you can't fully
            // reach. Zero on every device without an inset, so desktop is unaffected.
            pb: 'env(safe-area-inset-bottom)',
          }}
          elevation={3}
        >
          {/*
            ⚠️ This bar is FULL. At the full complement it carries five slots —
            Jobs · Inventory · Scan · Maintenance · Me — which is the documented Material Design
            ceiling for bottom navigation (3–5). Both Inventory and Maintenance are flag-gated, so
            many shops see three or four.

            A sixth needs something to leave, not another slot. Profile's contents already moved
            into Me for exactly this reason; the next candidate is whichever destination turns out
            to be visited least, measured rather than guessed.

            ORDER, left to right, and why:
              Jobs   — leftmost is the default landing and where a shift starts.
              Scan   — the middle, because it is the most frequent gesture of the five and the
                       centre of the bottom edge is the easiest place on a phone to hit. It is
                       also an ACTION rather than a destination, which is the conventional use of
                       a centre slot.
              Me     — rightmost, the near-universal home for account/self.
              Inventory / Maintenance fill the remaining two, both flag-gated.

            ⚠️ minWidth: 0 on every action is LOAD-BEARING, not tidying. MUI defaults
            `BottomNavigationAction` to `minWidth: 80` with `flex: 1`, and `min-width` blocks
            flex-shrink — so five tabs demand 400px. Measured at a 375px viewport (iPhone SE, 12
            mini, plenty of Androids) before this: the bar overflowed by 13px, `Jobs` began at
            x = -12 with its icon partly off-screen, and `Me` ran past the right edge. Both damaged
            slots were the ENDS, which is precisely where the default and the account live.
            With minWidth: 0 the five share the width evenly and nothing clips.
          */}
          <BottomNavigation
            value={navValue}
            onChange={onNavChange}
            showLabels
            sx={{
              bgcolor: 'rgba(17, 20, 57, 0.98)',
              '& .MuiBottomNavigationAction-root': {
                color: 'rgba(255, 255, 255, 0.5)',
                /**
                 * `'0px'`, NOT the 80 this used to carry (which was MUI's own default restated).
                 *
                 * `BottomNavigationAction` is `flex: 1`, and `min-width` blocks flex-shrink — so at
                 * five slots the bar demanded 5 × 80 = 400px. Measured at a 375px viewport (iPhone
                 * SE, 12 mini, plenty of Androids): the bar overflowed by 13px, `Jobs` began at
                 * x = -12 with its icon partly off-screen, and `Me` ran past the right edge. Both
                 * damaged slots were the ENDS — exactly where the default destination and the
                 * account live.
                 *
                 * Note this had to change HERE and not on each action's own `sx`: this descendant
                 * selector outranks the element's own class, so a per-action override is silently
                 * ignored.
                 *
                 * Touch targets stay compliant — `minHeight: 56` on each action carries the 48px
                 * floor vertically, and five slots across 375px is 75px each, still well above the
                 * 48px minimum horizontally.
                 */
                minWidth: '0px',
                '&.Mui-selected': {
                  color: 'primary.main',
                },
              },
            }}
          >
            <BottomNavigationAction
              label="Jobs"
              value="jobs"
              icon={<WorkIcon />}
              sx={{ minHeight: 56 }}
            />
            {showInventory && (
              <BottomNavigationAction
                label="Inventory"
                value="inventory"
                icon={<WarehouseOutlinedIcon />}
                sx={{ minHeight: 56 }}
              />
            )}
            {/*
              Scan is a tab, not a button buried on one screen.

              It is the operator's most frequent physical gesture — you arrive at a shelf or
              pick up a traveler sheet holding a piece of paper with a QR on it. Previously
              the only in-app scanner lived on the inventory page and read location labels
              only, so a traveler meant leaving the app for the phone's camera: a different
              gesture for a near-identical piece of paper. One scanner, both kinds.

              It opens a dialog rather than navigating, so scanning never loses the screen
              you were on — which matters for the continuous flows (a count session, receiving
              a pallet) that motivated an in-app scanner at all.

              **Placed third deliberately, on the best-evidenced finding in this layout.** Not
              "where the thumb rests" — the popular thumb-zone heat maps rest on a one-handed-use
              claim Hoober himself walked back ("there's hardly any one-handed use for actually
              touching the screen"; the 49% figure describes *holding*, not tapping). The finding
              that survives is about accuracy, from millions of measured touches: **7 mm at the
              centre of the screen versus 12 mm at the corners**, with taps also faster and more
              confident toward the centre — partly device digitiser error, not thumb geometry. So
              the most frequent gesture goes in the middle.

              **Keep one flag-gated tab on EACH side of Scan.** Both Inventory and Maintenance are
              optional, so the bar has four shapes. Flanking holds Scan within half a slot of
              centre in every one of them, and it is the only arrangement that does — grouping the
              optional pair together would pin Scan at position 2, off-centre always.

              **Why it looks different from its neighbours.** Apple is explicit that "a tab bar
              [is] to support navigation, not to provide actions", and Scan is an action. Material 3
              sanctions the way out: a FAB for "the most important action on a screen" may be
              "nested within" the navigation bar. So Scan wears a filled disc rather than a bare
              glyph — enough to read as the action, without the raised protruding FAB that would
              fight "professional, not trendy". Combined with not taking the tab selection, the
              deviation is coherent rather than a violation.

              Note the disc is VISUAL only: the hit area is the whole 75×56 slot either way, well
              past the 48px floor. What it buys is a target that is easier to aim at, which is
              precisely what the accuracy figures above are about.
            */}
            <BottomNavigationAction
              label="Scan"
              value="scan"
              icon={
                <Box
                  sx={{
                    width: 34,
                    height: 34,
                    borderRadius: '50%',
                    bgcolor: 'primary.main',
                    display: 'grid',
                    placeItems: 'center',
                    // The parent sx dims every action to 50% white; Scan's glyph must stay full
                    // strength against the filled disc. Scan is also never `Mui-selected` (it
                    // opens a dialog), so it would otherwise be permanently dimmed.
                    color: 'common.white',
                  }}
                >
                  <QrCodeScannerIcon fontSize="small" />
                </Box>
              }
              sx={{ minHeight: 56 }}
            />
            {showMaintenance && (
              <BottomNavigationAction
                label="Maintenance"
                value="maintenance"
                icon={<BuildOutlinedIcon />}
                sx={{ minHeight: 56 }}
              />
            )}
            {/* "Me" — the operator's own contribution surface, with identity and account
                actions folded in beneath it. Today the work is notes and photos. What it must
                NOT grow into is a record of completions — see the header of the my-work page.

                WHY THIS IS A MERGE AND NOT A DEMOTION. An interim version kept "My work" as its
                own tab and pushed Profile into a header icon, on the argument that merging would
                bury a primary daily surface behind a second tap. The measurement backs the
                worry — NN/g found navigation hidden behind an icon used 44–56% of the time
                against 89% for visible navigation — but it points at the wrong fix. Material's
                bottom-nav guidance rules out a settings tab outright, so Profile never had a
                legitimate claim on a slot, and the bar is capped at five. Keeping the slot and
                putting the WORK at the top of it protects the surface; YouTube's and Strava's
                "You" tabs are the same move, and Strava's merged Profile *and* Training.

                The route stays `/my-work` deliberately — renaming routes is churn for no
                user-visible gain (same call as keeping `/inventory/*`), and it keeps the Jobs
                page's link and the E2E spec working.

                The label is "Me", not "You": the app already says "My work", and mixing first
                and second person across one surface is the inconsistency to avoid. The text
                label always shows — an eye-tracking study in this audience's age band found
                icon+text erases the recognition penalty that icon-only carries. */}
            <BottomNavigationAction
              label="Me"
              value="my-work"
              icon={<StickyNote2OutlinedIcon />}
              sx={{ minHeight: 56 }}
            />
          </BottomNavigation>
        </Paper>
      )}
    </Box>
  );
}
