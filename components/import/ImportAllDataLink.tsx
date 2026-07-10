'use client';

import Button from '@mui/material/Button';
import Box from '@mui/material/Box';
import ArrowForwardIcon from '@mui/icons-material/ArrowForward';
import { useParams, useRouter } from 'next/navigation';
import { useCompanyFeatures } from '@/hooks/useCompanyFeatures';

/**
 * Secondary entry point to the ONE unified data-import flow, shown on module empty states
 * (Parts/Vendors/etc.). It's a link to the single importer — not a separate wizard —
 * for the "new to Jigged, bring everything in at once" case. Gated by the same flag as
 * the import flow; renders nothing when disabled. The module's own per-entity "Import CSV"
 * button stays as the working single-entity path until unified ingestion (Phase 2) lands.
 */
export default function ImportAllDataLink({ sx }: { sx?: object }) {
  const params = useParams();
  const router = useRouter();
  const { features } = useCompanyFeatures();
  const companyId = params.companyId as string;

  if (!features.data_import) return null;

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
