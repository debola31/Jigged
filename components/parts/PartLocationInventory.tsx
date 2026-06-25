'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import CircularProgress from '@mui/material/CircularProgress';
import Alert from '@mui/material/Alert';
import AddIcon from '@mui/icons-material/Add';
import RemoveIcon from '@mui/icons-material/Remove';
import TuneIcon from '@mui/icons-material/Tune';
import SwapHorizIcon from '@mui/icons-material/SwapHoriz';

import type { Part } from '@/types/part';
import type {
  InventoryLocation,
  PartLocationBalanceWithLocation,
} from '@/types/inventoryLocations';
import { getBalancesForPart, getLocations } from '@/utils/inventoryLocationsAccess';
import { getStandardUnitsForUnit } from '@/lib/unitPresets';
import PartLocationActionModal, {
  type LocationAction,
  type LocationOption,
  type LocationBalanceOption,
} from './PartLocationActionModal';

function pathLabel(id: string, byId: Map<string, InventoryLocation>): string {
  const names: string[] = [];
  let cursor: string | null = id;
  const guard = new Set<string>();
  while (cursor && byId.has(cursor) && !guard.has(cursor)) {
    guard.add(cursor);
    const node: InventoryLocation = byId.get(cursor)!;
    names.unshift(node.name);
    cursor = node.parent_id;
  }
  return names.join(' › ');
}

interface PartLocationInventoryProps {
  part: Part;
  partId: string;
  companyId: string;
  /** Refresh the parent part (rollup quantity + history) after a change. */
  onStockChanged: () => void | Promise<void>;
}

export default function PartLocationInventory({
  part,
  partId,
  companyId,
  onStockChanged,
}: PartLocationInventoryProps) {
  const [balances, setBalances] = useState<PartLocationBalanceWithLocation[]>([]);
  const [locations, setLocations] = useState<InventoryLocation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [action, setAction] = useState<LocationAction | null>(null);

  const primaryUnit = part.primary_unit ?? '';

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [b, locs] = await Promise.all([getBalancesForPart(partId), getLocations(companyId)]);
      setBalances(b);
      setLocations(locs);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load location balances.');
    } finally {
      setLoading(false);
    }
  }, [partId, companyId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const byId = useMemo(() => new Map(locations.map((l) => [l.id, l] as const)), [locations]);

  const locationOptions = useMemo<LocationOption[]>(
    () =>
      locations
        .map((l) => ({ id: l.id, label: pathLabel(l.id, byId) }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    [locations, byId],
  );

  // Move sources: only the locations where this part actually has stock.
  const sourceBalances = useMemo<LocationBalanceOption[]>(
    () =>
      balances
        .map((b) => ({ id: b.location_id, label: b.path.join(' › ') || b.location_name, quantity: b.quantity }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    [balances],
  );

  const unitOptions = useMemo(
    () => Array.from(new Set([primaryUnit, ...getStandardUnitsForUnit(primaryUnit)])).filter(Boolean),
    [primaryUnit],
  );

  const onActionDone = async () => {
    await reload();
    await onStockChanged();
  };

  return (
    <Box sx={{ textAlign: 'left' }}>
      <Stack direction="row" spacing={1} sx={{ mb: 2, flexWrap: 'wrap', gap: 1 }}>
        <Button variant="contained" color="success" startIcon={<AddIcon />} onClick={() => setAction('add')}>
          Add
        </Button>
        <Button variant="contained" color="error" startIcon={<RemoveIcon />} onClick={() => setAction('deplete')}>
          Remove
        </Button>
        <Button variant="outlined" startIcon={<SwapHorizIcon />} onClick={() => setAction('move')}>
          Move
        </Button>
        <Button variant="outlined" color="info" startIcon={<TuneIcon />} onClick={() => setAction('adjust')}>
          Adjust
        </Button>
      </Stack>

      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}

      {loading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}>
          <CircularProgress size={28} />
        </Box>
      ) : balances.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          No stock placed yet. Use Add to place stock at a location.
        </Typography>
      ) : (
        <Stack spacing={1}>
          {balances.map((b) => (
            <Paper key={b.location_id} variant="outlined" sx={{ px: 2, py: 1, display: 'flex', alignItems: 'center' }}>
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Typography noWrap>{b.path.join(' › ') || b.location_name}</Typography>
                {b.location_code && (
                  <Typography variant="caption" color="text.secondary">
                    {b.location_code}
                  </Typography>
                )}
              </Box>
              <Typography sx={{ fontWeight: 600 }}>
                {b.quantity.toLocaleString(undefined, { maximumFractionDigits: 4 })} {primaryUnit}
              </Typography>
            </Paper>
          ))}
        </Stack>
      )}

      {action && (
        <PartLocationActionModal
          open={Boolean(action)}
          action={action}
          partId={partId}
          primaryUnit={primaryUnit}
          unitOptions={unitOptions}
          locations={locationOptions}
          sourceBalances={sourceBalances}
          onClose={() => setAction(null)}
          onDone={onActionDone}
        />
      )}
    </Box>
  );
}
