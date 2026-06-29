'use client';

import { useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useLoad } from '@/hooks/useLoad';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Card from '@mui/material/Card';
import CardActionArea from '@mui/material/CardActionArea';
import CardContent from '@mui/material/CardContent';
import Stack from '@mui/material/Stack';
import Chip from '@mui/material/Chip';
import Alert from '@mui/material/Alert';
import CircularProgress from '@mui/material/CircularProgress';
import KeyboardArrowRightIcon from '@mui/icons-material/KeyboardArrowRight';
import QrCodeScannerIcon from '@mui/icons-material/QrCodeScanner';
import WarehouseOutlinedIcon from '@mui/icons-material/WarehouseOutlined';

import { getLocations } from '@/utils/inventoryLocationsAccess';
import type { InventoryLocation } from '@/types/inventoryLocations';

// Stable empty fallback so the roots memo doesn't churn while the first load runs.
const EMPTY_LOCATIONS: InventoryLocation[] = [];

/**
 * Operator "warehouse home" — the root of the Inventory tab. Lists the
 * top-level storage locations to browse (drill down into the bin view), so the
 * warehouse is reachable and orientable without a physical QR scan. Scanning a
 * printed label still jumps straight to a bin (the fast path).
 */
export default function OperatorWarehouseHomePage() {
  const params = useParams();
  const router = useRouter();
  const companyId = params.companyId as string;

  const [error, setError] = useState<string | null>(null);

  const { data: locationsData, loading } = useLoad(
    () => getLocations(companyId),
    [companyId],
    {
      onError: (e) => {
        setError(e instanceof Error ? e.message : 'Could not load the warehouse.');
      },
    },
  );
  const locations = locationsData ?? EMPTY_LOCATIONS;

  // Top-level locations are the warehouse roots to browse from.
  const roots = useMemo(() => locations.filter((l) => l.parent_id === null), [locations]);

  return (
    <Box sx={{ pb: 4 }}>
      <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 0.5 }}>
        <WarehouseOutlinedIcon color="primary" />
        <Typography variant="h5" sx={{ fontWeight: 700 }}>
          Inventory
        </Typography>
      </Stack>
      <Stack direction="row" spacing={0.5} alignItems="center" sx={{ mb: 3, color: 'text.secondary' }}>
        <QrCodeScannerIcon fontSize="small" />
        <Typography variant="body2">Scan a printed label to jump straight to a bin.</Typography>
      </Stack>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}

      {loading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
          <CircularProgress />
        </Box>
      ) : roots.length === 0 ? (
        <Card elevation={2}>
          <CardContent sx={{ textAlign: 'center', py: 6 }}>
            <WarehouseOutlinedIcon sx={{ fontSize: 44, color: 'text.disabled', mb: 1 }} />
            <Typography color="text.secondary">
              No storage locations yet. Once they&apos;re set up, you can browse them here.
            </Typography>
          </CardContent>
        </Card>
      ) : (
        <Stack spacing={1}>
          {roots.map((loc) => (
            <Card key={loc.id} elevation={2}>
              <CardActionArea
                onClick={() => router.push(`/operator/${companyId}/inventory/locations/${loc.id}`)}
                sx={{ minHeight: 56 }}
              >
                <CardContent sx={{ display: 'flex', alignItems: 'center', gap: 1, py: 1.5 }}>
                  <Box sx={{ flex: 1, minWidth: 0 }}>
                    <Typography sx={{ fontWeight: 600 }}>{loc.name}</Typography>
                    {loc.kind && (
                      <Typography variant="caption" color="text.secondary">
                        {loc.kind}
                      </Typography>
                    )}
                  </Box>
                  {loc.code && <Chip size="small" label={loc.code} variant="outlined" />}
                  <KeyboardArrowRightIcon color="action" />
                </CardContent>
              </CardActionArea>
            </Card>
          ))}
        </Stack>
      )}
    </Box>
  );
}
