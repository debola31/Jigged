'use client';

import { useRouter, usePathname } from 'next/navigation';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import LogoutIcon from '@mui/icons-material/Logout';
import { useAuth } from '@/components/providers/AuthProvider';

function getPageTitle(pathname: string): string {
  const segments = pathname.split('/').filter(Boolean);
  // pathname like /dashboard/[companyId]/customers/new -> segments = ['dashboard', companyId, 'customers', 'new']

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

  // Check for parts routes first (more specific matching)
  if (segments.includes('parts')) {
    if (segments.includes('new')) return 'New Part';
    if (segments.includes('edit')) return 'Edit Part';
    if (segments.includes('import')) return 'Import Parts';
    // Check if there's a partId (detail page)
    const partsIndex = segments.indexOf('parts');
    if (partsIndex < segments.length - 1 && !['new', 'edit', 'import'].includes(segments[partsIndex + 1])) {
      return 'Part Details';
    }
    return 'Parts';
  }

  // Check for customers routes
  if (segments.includes('customers')) {
    if (segments.includes('new')) return 'New Customer';
    if (segments.includes('edit')) return 'Edit Customer';
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

  // Check for routings routes
  if (segments.includes('routings')) {
    if (segments.includes('new')) return 'New Routing';
    if (segments.includes('edit')) return 'Edit Routing';
    // Check if there's a routingId (detail page)
    const routingsIndex = segments.indexOf('routings');
    if (routingsIndex < segments.length - 1 && !['new', 'edit'].includes(segments[routingsIndex + 1])) {
      return 'Routing Details';
    }
    return 'Routings';
  }

  // Check for inventory routes
  if (segments.includes('inventory')) {
    if (segments.includes('new')) return 'New Inventory Item';
    if (segments.includes('edit')) return 'Edit Inventory Item';
    if (segments.includes('import')) return 'Import Inventory';
    // Check if there's an itemId (detail page)
    const inventoryIndex = segments.indexOf('inventory');
    if (inventoryIndex < segments.length - 1 && !['new', 'edit', 'import'].includes(segments[inventoryIndex + 1])) {
      return 'Inventory Details';
    }
    return 'Inventory';
  }

  // Map other route segments to display titles
  const titleMap: Record<string, string> = {};

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

export default function Header() {
  const router = useRouter();
  const pathname = usePathname();
  const { signOut } = useAuth();
  const pageTitle = getPageTitle(pathname);

  const handleSignOut = async () => {
    await signOut();
    router.replace('/login');
  };

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
      <Typography variant="h5" component="h1" sx={{ fontWeight: 600, color: 'white' }}>
        {pageTitle}
      </Typography>
      <Button
        onClick={handleSignOut}
        startIcon={<LogoutIcon />}
        sx={{
          color: 'rgba(255, 255, 255, 0.7)',
          textTransform: 'none',
          '&:hover': {
            bgcolor: 'rgba(239, 68, 68, 0.1)',
            color: 'error.main',
          },
        }}
      >
        Sign Out
      </Button>
    </Box>
  );
}
