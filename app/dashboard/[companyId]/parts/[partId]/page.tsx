import { Suspense } from 'react';
import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
import PartWorkspace from '@/components/parts/workspace/PartWorkspace';

/**
 * Part detail route. The full experience lives in PartWorkspace (a client
 * component); this thin wrapper provides the Suspense boundary that Next 16
 * requires around `useSearchParams` (the workspace reads `?tab=`, `?back=`,
 * `?from=`).
 */
export default function PartDetailPage() {
  return (
    <Suspense
      fallback={
        <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: 400 }}>
          <CircularProgress />
        </Box>
      }
    >
      <PartWorkspace />
    </Suspense>
  );
}
