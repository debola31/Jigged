'use client';

import { useState, useEffect, useMemo } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useLoad } from '@/hooks/useLoad';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Card from '@mui/material/Card';
import CardActionArea from '@mui/material/CardActionArea';
import CardContent from '@mui/material/CardContent';
import Button from '@mui/material/Button';
import Stack from '@mui/material/Stack';
import Chip from '@mui/material/Chip';
import Alert from '@mui/material/Alert';
import CircularProgress from '@mui/material/CircularProgress';
import KeyboardArrowRightIcon from '@mui/icons-material/KeyboardArrowRight';
import AddIcon from '@mui/icons-material/Add';
import RemoveIcon from '@mui/icons-material/Remove';
import TuneIcon from '@mui/icons-material/Tune';
import AddCircleOutlineIcon from '@mui/icons-material/AddCircleOutline';
import Inventory2OutlinedIcon from '@mui/icons-material/Inventory2Outlined';

import { resolveScan } from '@/utils/inventoryLocationsAccess';
import { getCurrentOperator } from '@/utils/operatorAccess';
import { useSetOperatorChrome } from '@/components/operator/OperatorChromeContext';
import { getStandardUnitsForUnit } from '@/lib/unitPresets';
import type { LocationContent } from '@/types/inventoryLocations';
import OperatorLocationActionModal, {
  type OperatorLocationAction,
} from '@/components/operator/OperatorLocationActionModal';
import OperatorReceivePartModal from '@/components/operator/OperatorReceivePartModal';

const num = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 4 });

export default function OperatorBinViewPage() {
  const params = useParams();
  const router = useRouter();
  const companyId = params.companyId as string;
  const locationId = params.locationId as string;

  const [operatorId, setOperatorId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [modal, setModal] = useState<{ action: OperatorLocationAction; part: LocationContent } | null>(
    null,
  );
  const [receiveOpen, setReceiveOpen] = useState(false);

  const {
    data: scan,
    loading,
    reload,
  } = useLoad(() => resolveScan(locationId), [locationId], {
    onError: (e) => {
      setError(e instanceof Error ? e.message : 'Could not open this location.');
    },
  });

  // Operator id stamps the ledger; best-effort, never blocks the view.
  useEffect(() => {
    let cancelled = false;
    getCurrentOperator(companyId)
      .then((op) => {
        if (!cancelled) setOperatorId(op?.id ?? null);
      })
      .catch(() => {
        if (!cancelled) setOperatorId(null);
      });
    return () => {
      cancelled = true;
    };
  }, [companyId]);

  const node = scan?.node ?? null;
  const path = scan?.path ?? [];
  const parent = path.length > 1 ? path[path.length - 2] : null;

  // Header back drills UP the location tree (to the parent bin, or the inventory
  // root at the top level). Re-registers as the parent resolves from the scan.
  useSetOperatorChrome(
    {
      back: {
        href: parent
          ? `/operator/${companyId}/inventory/locations/${parent.id}`
          : `/operator/${companyId}/inventory`,
        label: 'Back',
      },
    },
    [companyId, parent?.id],
  );

  const modalUnit = modal?.part.primary_unit || 'ea';
  const unitOptions = useMemo(
    () => Array.from(new Set([modalUnit, ...getStandardUnitsForUnit(modalUnit)])).filter(Boolean),
    [modalUnit],
  );

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '50vh' }}>
        <CircularProgress />
      </Box>
    );
  }

  if (error || !node) {
    return (
      <Box>
        <Alert severity="error">{error ?? 'Location not found.'}</Alert>
      </Box>
    );
  }

  const children = scan?.children ?? [];
  const contents = scan?.contents ?? [];

  return (
    <Box sx={{ pb: 4 }}>
      {/* Header: name + full path (back lives in the app header now). */}
      <Box sx={{ minWidth: 0, mb: 3 }}>
        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
          <Typography variant="h5" sx={{ fontWeight: 700 }}>
            {node.name}
          </Typography>
          {node.code && <Chip size="small" label={node.code} variant="outlined" />}
        </Stack>
        {path.length > 1 && (
          <Typography variant="body2" color="text.secondary">
            {path.map((p) => p.name).join(' › ')}
          </Typography>
        )}
      </Box>

      {/* Sub-locations: drill down */}
      {children.length > 0 && (
        <Box sx={{ mb: 3 }}>
          <Typography variant="overline" color="text.secondary">
            Sub-locations
          </Typography>
          <Stack spacing={1} sx={{ mt: 0.5 }}>
            {children.map((child) => (
              <Card key={child.id} elevation={2}>
                <CardActionArea
                  onClick={() => router.push(`/operator/${companyId}/inventory/locations/${child.id}`)}
                  sx={{ minHeight: 56 }}
                >
                  <CardContent sx={{ display: 'flex', alignItems: 'center', gap: 1, py: 1.5 }}>
                    <Box sx={{ flex: 1, minWidth: 0 }}>
                      <Typography sx={{ fontWeight: 600 }}>{child.name}</Typography>
                      {child.code && (
                        <Typography variant="caption" color="text.secondary">
                          {child.code}
                        </Typography>
                      )}
                    </Box>
                    <KeyboardArrowRightIcon color="action" />
                  </CardContent>
                </CardActionArea>
              </Card>
            ))}
          </Stack>
        </Box>
      )}

      {/* Stock here: act on each part */}
      <Box>
        <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 0.5 }}>
          <Typography variant="overline" color="text.secondary" sx={{ flex: 1 }}>
            Stock here
          </Typography>
          <Button size="small" startIcon={<AddCircleOutlineIcon />} onClick={() => setReceiveOpen(true)}>
            Stock a part
          </Button>
        </Stack>
        {contents.length === 0 ? (
          <Card elevation={2} sx={{ mt: 0.5 }}>
            <CardContent sx={{ textAlign: 'center', py: 4 }}>
              <Inventory2OutlinedIcon sx={{ fontSize: 40, color: 'text.disabled', mb: 1 }} />
              <Typography color="text.secondary">
                {children.length > 0
                  ? 'No stock recorded directly here — open a sub-location above.'
                  : 'Nothing stored here yet.'}
              </Typography>
            </CardContent>
          </Card>
        ) : (
          <Stack spacing={1} sx={{ mt: 0.5 }}>
            {contents.map((part) => (
              <Card key={part.part_id} elevation={2}>
                <CardContent>
                  <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1, flexWrap: 'wrap' }}>
                    <Typography sx={{ fontWeight: 600, flex: 1, minWidth: 0 }}>
                      {part.part_name}
                    </Typography>
                    <Typography variant="h5" sx={{ fontWeight: 700 }}>
                      {num(part.quantity)}
                    </Typography>
                    <Typography variant="body2" color="text.secondary">
                      {part.primary_unit ?? ''}
                    </Typography>
                  </Box>
                  <Stack direction="row" spacing={1} sx={{ mt: 1.5 }}>
                    <Button
                      fullWidth
                      variant="contained"
                      color="success"
                      startIcon={<AddIcon />}
                      onClick={() => setModal({ action: 'add', part })}
                    >
                      Add
                    </Button>
                    <Button
                      fullWidth
                      variant="contained"
                      color="error"
                      startIcon={<RemoveIcon />}
                      onClick={() => setModal({ action: 'deplete', part })}
                    >
                      Remove
                    </Button>
                    <Button
                      fullWidth
                      variant="outlined"
                      color="info"
                      startIcon={<TuneIcon />}
                      onClick={() => setModal({ action: 'adjust', part })}
                    >
                      Set
                    </Button>
                  </Stack>
                </CardContent>
              </Card>
            ))}
          </Stack>
        )}
      </Box>

      {modal && (
        <OperatorLocationActionModal
          open
          action={modal.action}
          companyId={companyId}
          partId={modal.part.part_id}
          partName={modal.part.part_name}
          currentQuantity={modal.part.quantity}
          primaryUnit={modalUnit}
          unitOptions={unitOptions}
          locationId={node.id}
          locationName={node.name}
          operatorId={operatorId}
          onClose={() => setModal(null)}
          onDone={reload}
        />
      )}

      <OperatorReceivePartModal
        open={receiveOpen}
        companyId={companyId}
        locationId={node.id}
        locationName={node.name}
        excludePartIds={contents.map((c) => c.part_id)}
        onClose={() => setReceiveOpen(false)}
        onDone={reload}
      />
    </Box>
  );
}
