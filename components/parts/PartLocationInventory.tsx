'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useLoad } from '@/hooks/useLoad';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import CircularProgress from '@mui/material/CircularProgress';
import Alert from '@mui/material/Alert';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import AddIcon from '@mui/icons-material/Add';
import FactCheckOutlinedIcon from '@mui/icons-material/FactCheckOutlined';
import RemoveIcon from '@mui/icons-material/Remove';
import TuneIcon from '@mui/icons-material/Tune';
import SwapHorizIcon from '@mui/icons-material/SwapHoriz';

import type { Part } from '@/types/part';
import type {
  InventoryLocation,
  PartLocationBalanceWithLocation,
} from '@/types/inventoryLocations';
import { createLocation, getBalancesForPart, getLocations } from '@/utils/inventoryLocationsAccess';
import { getStandardUnitsForUnit } from '@/lib/unitPresets';
import PartLocationActionModal, {
  type LocationAction,
  type LocationOption,
  type LocationBalanceOption,
} from './PartLocationActionModal';

// Stable empty fallbacks so derived memos don't churn while the first load runs.
const EMPTY_BALANCES: PartLocationBalanceWithLocation[] = [];
const EMPTY_LOCATIONS: InventoryLocation[] = [];

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
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [action, setAction] = useState<LocationAction | null>(null);

  const primaryUnit = part.primary_unit ?? '';

  const {
    data: inventoryData,
    loading,
    reload,
  } = useLoad(
    () => Promise.all([getBalancesForPart(partId), getLocations(companyId)]),
    [partId, companyId],
    {
      onError: (e) => {
        setError(e instanceof Error ? e.message : 'Failed to load location balances.');
      },
    },
  );
  const balances = inventoryData?.[0] ?? EMPTY_BALANCES;
  const locations = inventoryData?.[1] ?? EMPTY_LOCATIONS;

  const byId = useMemo(() => new Map(locations.map((l) => [l.id, l] as const)), [locations]);

  // `kind` rides along so the picker can drop the auto-managed `Unassigned` bucket from
  // destination lists without needing to know how it's identified.
  const locationOptions = useMemo<LocationOption[]>(
    () =>
      locations
        .map((l) => ({ id: l.id, label: pathLabel(l.id, byId), kind: l.kind }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    [locations, byId],
  );

  /**
   * Create a top-level location from a name typed into the picker.
   *
   * No kind and no code: the name is the identity, and a code is display-only (QR payloads carry
   * the UUID). Someone naming a shelf mid-move shouldn't have to fill a form — and if they want a
   * code later, the board's Rename does that.
   */
  const createLocationFromPicker = async (name: string): Promise<LocationOption> => {
    const created = await createLocation(companyId, { name });
    await reload();
    return { id: created.id, label: created.name, kind: created.kind };
  };

  /**
   * Move sources: only the locations where this part actually has stock.
   *
   * The `> 0` is the part that was missing — this comment claimed the filter for months while the
   * code mapped every balance row. Balances are never deleted (`transfer_stock` decrements,
   * `bulk_put_away` sets 0), so every place the part has ever passed through survives at zero and
   * was offered as a source. Picking one gets you as far as the RPC before it fails with
   * "Insufficient stock at source location (have 0, need N)".
   */
  const sourceBalances = useMemo<LocationBalanceOption[]>(
    () =>
      balances
        .filter((b) => Number(b.quantity ?? 0) > 0)
        .map((b) => ({ id: b.location_id, label: b.path.join(' › ') || b.location_name, quantity: b.quantity }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    [balances],
  );

  /** A part in one place is not "split"; counting it there is counting it everywhere. */
  const placesWithStock = useMemo(
    () => balances.filter((b) => Number(b.quantity ?? 0) > 0).length,
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
        <Button variant="contained" color="primary" startIcon={<AddIcon />} onClick={() => setAction('add')}>
          Add
        </Button>
        {/* Not red: removing stock is reversible and writes an append-only ledger row rather
            than destroying one, so it isn't destructive. Add keeps the primary weight on THIS
            surface — until receiving (J6) exists, the part page is how stock gets in, and an
            owner here isn't the one consuming it. The operator bin view inverts that. */}
        <Button variant="outlined" startIcon={<RemoveIcon />} onClick={() => setAction('deplete')}>
          Remove
        </Button>
        <Button variant="outlined" startIcon={<SwapHorizIcon />} onClick={() => setAction('move')}>
          Move
        </Button>
        <Button variant="outlined" startIcon={<TuneIcon />} onClick={() => setAction('adjust')}>
          Adjust
        </Button>
        {/* Only once the stock is actually split. With everything in one place the per-row
            "Count here" beside it already IS counting it everywhere, and two controls that do
            the same thing is worse than one. */}
        {placesWithStock > 1 && (
          <Button
            variant="outlined"
            startIcon={<FactCheckOutlinedIcon />}
            onClick={() =>
              router.push(`/dashboard/${companyId}/inventory/count?part=${partId}`)
            }
          >
            Count all {placesWithStock} places
          </Button>
        )}
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
              {/*
                The door counting never had from a part.

                Place-scoped counting has worked since 2026-07-30, but both its entry points were
                on the Storage board — so the obvious move, "I don't believe this number, count
                it", had no route from the number you are doubting.

                On EVERY row including zero ones: "the system says zero and I am holding twelve"
                is the most valuable thing a count discovers, and the one-row sheet reads the
                balance rather than assuming it, so a zero row is countable.
              */}
              <Tooltip title={`Count ${part.part_name} in ${b.location_name}`}>
                <IconButton
                  aria-label={`Count in ${b.location_name}`}
                  onClick={() =>
                    router.push(
                      `/dashboard/${companyId}/inventory/count?location=${b.location_id}&part=${partId}`,
                    )
                  }
                  // The theme has no MuiIconButton size override, so 48px is set here rather
                  // than assumed.
                  sx={{ ml: 1, width: 48, height: 48 }}
                >
                  <FactCheckOutlinedIcon />
                </IconButton>
              </Tooltip>
            </Paper>
          ))}
        </Stack>
      )}

      {action && (
        <PartLocationActionModal
          open={Boolean(action)}
          action={action}
          companyId={companyId}
          partId={partId}
          primaryUnit={primaryUnit}
          unitOptions={unitOptions}
          locations={locationOptions}
          sourceBalances={sourceBalances}
          onCreateLocation={createLocationFromPicker}
          onClose={() => setAction(null)}
          onDone={onActionDone}
        />
      )}
    </Box>
  );
}
