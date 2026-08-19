'use client';

import Link from 'next/link';
import { usePathname, useParams } from 'next/navigation';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import StatusChip from '@/components/common/StatusChip';
import MenuIcon from '@mui/icons-material/Menu';
import PrecisionManufacturingIcon from '@mui/icons-material/PrecisionManufacturing';
import AccountMenu from '@/components/layout/AccountMenu';
import { useDemoMode } from '@/components/providers/DemoModeProvider';
import { usePageTitle } from './PageTitleProvider';
import { PARTS_SUBROUTES } from '@/lib/partsSubroutes';

function getPageTitle(pathname: string): string {
  const segments = pathname.split('/').filter(Boolean);
  // pathname like /dashboard/[companyId]/customers/new -> segments = ['dashboard', companyId, 'customers', 'new']

  // Unified data-import wizard: /dashboard/[companyId]/import (import right after companyId)
  if (segments[2] === 'import') return 'Import your data';

  // Check for quotes routes first
  if (segments.includes('quotes')) {
    if (segments.includes('new')) return 'New Quote';
    // Check if there's a quoteId (detail page)
    const quotesIndex = segments.indexOf('quotes');
    if (quotesIndex < segments.length - 1 && !['new'].includes(segments[quotesIndex + 1])) {
      return 'Quote Details';
    }
    return 'Quotes';
  }

  // Named sub-routes under /parts. A part ID is anything NOT in here, so a new
  // page added without a line below silently titles itself "Part Details" — which
  // is how /parts/drawings shipped calling itself that.
  if (segments.includes('parts')) {
    const partsIndex = segments.indexOf('parts');
    const child = segments[partsIndex + 1];
    if (child && child in PARTS_SUBROUTES) return PARTS_SUBROUTES[child];
    if (child) return 'Part Details';
    return 'Parts';
  }

  // Check for customers routes
  if (segments.includes('customers')) {
    if (segments.includes('new')) return 'New Customer';
    if (segments.includes('import')) return 'Import Customers';
    // Check if there's a customerId (detail page)
    const customersIndex = segments.indexOf('customers');
    if (customersIndex < segments.length - 1 && !['new', 'edit', 'import'].includes(segments[customersIndex + 1])) {
      return 'Customer Details';
    }
    return 'Customers';
  }

  // Check for operations routes
  if (segments.includes('operations')) {
    if (segments.includes('new')) return 'New Operation';
    if (segments.includes('edit')) return 'Edit Operation';
    if (segments.includes('import')) return 'Import Operations';
    return 'Operations';
  }

  // Check for jobs routes
  if (segments.includes('jobs')) {
    if (segments.includes('new')) return 'New Job';
    if (segments.includes('edit')) return 'Edit Job';
    const jobsIndex = segments.indexOf('jobs');
    if (jobsIndex < segments.length - 1 && !['new', 'edit'].includes(segments[jobsIndex + 1])) {
      return 'Job Details';
    }
    return 'Jobs';
  }

  // Inventory routes. Only two exist — `/inventory/count` and `/inventory/locations` —
  // and the locations page sets its own title via setTitle(), so `count` is the single
  // case this needs to handle.
  //
  // Six branches were removed here: 'New/Edit Inventory Item', 'Import Inventory' and an
  // itemId → 'Inventory Details' fallback all pointed at routes that never existed (part
  // create/edit lives under /parts), 'Material Shortages' pointed at the never-built
  // /inventory/shortages, and the bare 'Inventory' served the list page now folded into
  // /parts.
  if (segments.includes('count')) return 'Count Inventory';

  // Check for settings routes
  if (segments.includes('settings')) {
    return 'Settings';
  }

  // Check for vendors routes
  if (segments.includes('vendors')) {
    if (segments.includes('new')) return 'New Vendor';
    if (segments.includes('edit')) return 'Edit Vendor';
    if (segments.includes('import')) return 'Import Vendors';
    const vendorsIndex = segments.indexOf('vendors');
    if (vendorsIndex < segments.length - 1 && !['new', 'edit', 'import'].includes(segments[vendorsIndex + 1])) {
      return 'Vendor Details';
    }
    return 'Vendors';
  }

  // Check for work-centers routes
  if (segments.includes('work-centers')) {
    if (segments.includes('new')) return 'New Work Center';
    if (segments.includes('edit')) return 'Edit Work Center';
    if (segments.includes('import')) return 'Import Work Centers';
    const wcIndex = segments.indexOf('work-centers');
    if (wcIndex < segments.length - 1 && !['new', 'edit', 'import'].includes(segments[wcIndex + 1])) {
      return 'Work Center Details';
    }
    return 'Work Centers';
  }

  // Check for team routes
  if (segments.includes('team')) {
    return 'Team';
  }

  // Check for shipments routes
  if (segments.includes('shipments')) {
    if (segments.includes('new')) return 'New Shipment';
    return 'Shipments';
  }

  // Map other route segments to display titles
  const titleMap: Record<string, string> = { activity: 'Activity' };

  // Check from the end backwards for known segments
  for (let i = segments.length - 1; i >= 0; i--) {
    const segment = segments[i];
    if (titleMap[segment]) {
      return titleMap[segment];
    }
  }

  // Default to Dashboard
  return 'Dashboard';
}

interface HeaderProps {
  isMobile?: boolean;
  onMenuClick?: () => void;
}

export default function Header({ isMobile = false, onMenuClick }: HeaderProps) {
  const pathname = usePathname();
  const params = useParams();
  const companyId = params.companyId as string | undefined;
  const { isDemoMode } = useDemoMode();
  // A page may override the title (e.g. the part page shows the part number) so
  // the record identity stays visible in the sticky app bar while scrolling.
  const { title: overrideTitle } = usePageTitle();
  const pageTitle = overrideTitle ?? getPageTitle(pathname);

  return (
    <Box
      component="header"
      sx={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        px: 3,
        py: 1,
        borderBottom: '1px solid rgba(255, 255, 255, 0.1)',
        bgcolor: 'rgba(26, 31, 74, 0.55)',
        backdropFilter: 'blur(8px)',
        minHeight: 48,
        position: 'sticky',
        top: 0,
        zIndex: 1100,
      }}
    >
      {/* `minWidth: 0` lets this cluster shrink below its content width, which is what
          allows the title to truncate instead of shoving the controls on the right off
          the edge. Titles run long ("Work Center Details") and the right side gained a
          second control, so on a 375px phone the two sides genuinely compete. */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, minWidth: 0 }}>
        {isMobile && (
          <IconButton
            onClick={onMenuClick}
            sx={{ color: 'white', mr: 0.5, flexShrink: 0 }}
            aria-label="Open navigation menu"
          >
            <MenuIcon />
          </IconButton>
        )}
        <Typography
          variant="h5"
          component="h1"
          noWrap
          sx={{ fontWeight: 600, color: 'white', minWidth: 0 }}
        >
          {pageTitle}
        </Typography>
        {isDemoMode && (
          <StatusChip
            label="DEMO"
            color="warning"
            sx={{ fontWeight: 600, letterSpacing: 0.5 }}
          />
        )}
      </Box>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexShrink: 0 }}>
        {/* The way to the shop floor, from every office page.

            The sidebar carries the same destination, but on a phone the sidebar is
            behind a hamburger — and a phone is exactly where an owner-operator reaches
            for the shop floor. So this is the control that actually solves the problem;
            the sidebar item is its desktop counterpart. Kept labelled at both sizes:
            an unlabelled icon here asks the viewer to already know the app has two
            surfaces, which is the thing they don't know. */}
        {companyId && (
          <Button
            component={Link}
            href={`/operator/${companyId}`}
            size={isMobile ? 'small' : 'medium'}
            startIcon={<PrecisionManufacturingIcon />}
            sx={{
              color: 'rgba(255, 255, 255, 0.7)',
              textTransform: 'none',
              flexShrink: 0,
              whiteSpace: 'nowrap',
              '&:hover': {
                bgcolor: 'rgba(70, 130, 180, 0.16)',
                color: 'white',
              },
            }}
          >
            Shop floor
          </Button>
        )}
        {/* Who you are signed in as, and the account actions that belong with it — including the
            sign-out this slot used to hold bare. See components/layout/AccountMenu.tsx for why the
            name rides on screen beside the avatar rather than living only inside the menu. */}
        <AccountMenu isMobile={isMobile} />
      </Box>
    </Box>
  );
}
