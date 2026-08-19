'use client';

import Button from '@mui/material/Button';
import Box from '@mui/material/Box';
import ArrowForwardIcon from '@mui/icons-material/ArrowForward';
import { useParams, useRouter } from 'next/navigation';

/**
 * Entry point to the ONE data-import flow, shown on module empty states
 * (Parts/Vendors/Work centers/Customers) for the "new to Jigged, bring everything in at
 * once" case. Since the per-entity import wizards were retired, this is the only in-page
 * import affordance on those modules — the sidebar "Import data" item is the durable home.
 */
export default function ImportAllDataLink({ sx }: { sx?: object }) {
  const params = useParams();
  const router = useRouter();
  const companyId = params.companyId as string;

  return (
    <Box sx={{ mt: 1.5, ...sx }}>
      <Button
        variant="text"
        size="small"
        endIcon={<ArrowForwardIcon />}
        onClick={() => router.push(`/dashboard/${companyId}/import`)}
      >
        New to Jigged? Import all your data at once
      </Button>
    </Box>
  );
}
