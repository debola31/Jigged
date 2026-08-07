import { Suspense } from 'react';
import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
import PartWorkspace from '@/components/parts/workspace/PartWorkspace';
import SubscriptionRequiredNotice from '@/components/billing/SubscriptionRequiredNotice';

/**
 * New-part route. Renders the same PartWorkspace as the detail page in create
 * mode — so the create view is the saved view. On create, the workspace
 * redirects into /parts/[id]. Suspense wraps the client component's
 * useSearchParams (?source, ?stocked, ?returnTo, ?from).
 */
export default function NewPartPage() {
  return (
    <Suspense
      fallback={
        <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: 400 }}>
          <CircularProgress />
        </Box>
      }
    >
      <Box sx={{ maxWidth: 900, mx: 'auto' }}>
        <SubscriptionRequiredNotice entityPlural="parts" />
      </Box>
      <PartWorkspace mode="create" />
    </Suspense>
  );
}
