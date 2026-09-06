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
import type { PartUnitConversion } from '@/types/part';
import type {
  InventoryLocation,
  PartLocationBalanceWithLocation,
} from '@/types/inventoryLocations';
import {
  createLocation,
  getBalancesForPart,
  getLocations,
  setPartLotTracking,
} from '@/utils/inventoryLocationsAccess';
import { stockDestinationOptions } from '@/utils/locationDestinations';
import { getStandardUnitsForUnit } from '@/lib/unitPresets';
import { compareLocationNames } from '@/lib/locationTree';
import PartLocationActionModal, {
  type LocationAction,
  type LocationOption,
  type LocationBalanceOption,
} from './PartLocationActionModal';

// Stable empty fallbacks so derived memos don't churn while the first load runs.
const EMPTY_BALANCES: PartLocationBalanceWithLocation[] = [];
const EMPTY_LOCATIONS: InventoryLocation[] = [];

// The private `pathLabel` that used to live here is gone: it was the fourth copy of the same
// ancestry walk, and `stockDestinationOptions` now builds the labelled list.

interface PartLocationInventoryProps {
  part: Part;
  /** The part's defined conversions, so a unit it can be bought in is offered here too. */
  unitConversions: PartUnitConversion[];
  partId: string;
  companyId: string;
  /** Refresh the parent part (rollup quantity + history) after a change. */
  onStockChanged: () => void | Promise<void>;
}

export default function PartLocationInventory({
  part,
  unitConversions,
  partId,
  companyId,
  onStockChanged,
}: PartLocationInventoryProps) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [action, setAction] = useState<LocationAction | null>(null);
  const [untracking, setUntracking] = useState(false);

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

  /**
   * One-place mode: the shop has never built a place, so the auto-managed `Unassigned` bucket is
   * the only one there is.
   *
   * This is a DATA condition, not a flag — since 20260802015837 every part has a place, and the
   * `inventory_locations` flag that used to also gate this tab was retired Aug 2026. What it must
   * not do is show a places UI with nothing behind it: a "Move" button with nowhere to move to,
   * and a dropdown containing exactly one option. A shop that has never built a place still hits
   * this branch, which is the case that matters.
   */
  const onePlace = locations.length === 1 && locations[0].kind === 'system';

  // Leaves only: since 20260806160053 a place with sub-locations cannot hold stock, so offering a
  // cabinet here would put an error behind a legitimate-looking choice. `kind` rides along so the
  // picker can also drop the auto-managed `Unassigned` bucket without knowing how it's identified.
  const locationOptions = useMemo<LocationOption[]>(
    () => stockDestinationOptions(locations),
    [locations],
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
   * Move sources: the locations where this part has stock — which, since 20260802144310, is simply
   * the rows it has.
   *
   * The `> 0` is kept as a belt-and-braces restatement of the table's CHECK, not as a filter that
   * does work. It earned its place historically: balances used to survive at zero for every place
   * a part had passed through, and offering one as a move source got you as far as the RPC before
   * it failed with "Insufficient stock at source location (have 0, need N)".
   */
  const sourceBalances = useMemo<LocationBalanceOption[]>(() => {
    /*
     * One entry per PLACE, summed across heats.
     *
     * A balance row is (place, lot) since heat tracking landed, so mapping rows straight to
     * options listed a two-heat shelf twice under one name and one id — an unpickable pair, and
     * each carrying half the stock that is actually there. The modal asks which heat AFTER a
     * place is chosen (`getLotsAtLocationForPart`), so the place is what belongs here and the
     * total is what "have N" means when you are standing in front of it.
     */
    const byPlace = new Map<string, LocationBalanceOption>();
    for (const b of balances) {
      const quantity = Number(b.quantity ?? 0);
      if (quantity <= 0) continue;
      const existing = byPlace.get(b.location_id);
      if (existing) existing.quantity += quantity;
      else
        byPlace.set(b.location_id, {
          id: b.location_id,
          label: b.path.join(' › ') || b.location_name,
          quantity,
        });
    }
    return [...byPlace.values()].sort((a, b) => compareLocationNames(a.label, b.label));
  }, [balances]);

  /**
   * A part in one place is not "split"; counting it there is counting it everywhere.
   *
   * Distinct PLACES, not balance rows: two heats on one shelf are two rows and one shelf, and
   * counting rows offered "Count all 2 locations" for a part that lives in exactly one.
   */
  const placesWithStock = useMemo(
    () =>
      new Set(
        balances.filter((b) => Number(b.quantity ?? 0) > 0).map((b) => b.location_id),
      ).size,
    [balances],
  );

  /**
   * The units you may type a movement in.
   *
   * The part's own conversions are unioned in, which they were not before: `PartUnitConversionsEditor`
   * sits a few hundred pixels below this on the same tab and lets a shop define "1 bar = 12 ft",
   * and the dropdown then refused to offer `bar`. You could define a conversion you could not use.
   * `convertToBaseUnit` inside the RPC wrapper has always accepted them — only the picker did not.
   */
  const unitOptions = useMemo(
    () =>
      Array.from(
        new Set([
          primaryUnit,
          ...getStandardUnitsForUnit(primaryUnit),
          ...unitConversions.map((c) => c.from_unit),
        ]),
      ).filter(Boolean),
    [primaryUnit, unitConversions],
  );

  const onActionDone = async () => {
    await reload();
    await onStockChanged();
  };

  /**
   * Turn heat tracking off for this part.
   *
   * `onStockChanged` rather than `reload`, because the flag lives on the PART and this panel is
   * handed it as a prop — reloading the balances would leave the banner on screen asserting
   * something that is no longer true until the page happened to refetch.
   */
  const stopTrackingHeats = async () => {
    setUntracking(true);
    setError(null);
    try {
      await setPartLotTracking(partId, false);
      await onStockChanged();
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not stop tracking heats for this part.');
    } finally {
      setUntracking(false);
    }
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
        {/* Nowhere to move to when the shop has one bucket — the button would open a modal
            whose source and destination are the same place. */}
        {!onePlace && (
          <Button variant="outlined" startIcon={<SwapHorizIcon />} onClick={() => setAction('move')}>
            Move
          </Button>
        )}
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
            Count all {placesWithStock} locations
          </Button>
        )}
      </Stack>

      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}

      {/*
        Why this is here at all.

        Heat tracking turns itself ON — recording a heat on a receipt is the decision to trace the
        part, so nobody visits a setting to start it. That is the right default and it leaves one
        trap: type a heat by mistake and this part demands one on every removal forever, with no
        visible reason and nothing to undo it. So the state is stated where someone would come
        looking ("why is it asking me which heat?"), and the way back out is beside it.

        Switching off does NOT merge the split balances back together. Picking a survivor and
        silently adding the others to it would destroy the record of what is physically on the
        shelf — the flag stops future enforcement, it is not an instruction to forget.
      */}
      {part.lot_tracked && (
        <Alert
          severity="info"
          sx={{ mb: 2 }}
          action={
            <Button
              size="small"
              color="inherit"
              disabled={untracking}
              onClick={stopTrackingHeats}
            >
              {untracking ? 'Stopping…' : 'Stop tracking'}
            </Button>
          }
        >
          Heat-tracked. Stock is held per heat, and taking any of it asks which heat it came from.
        </Alert>
      )}

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
            /*
              Keyed by (place, LOT), not by place.
              A heat-tracked bar holding two heats on one shelf is two balance rows, so a
              place-only key renders the same shelf twice under one React key — and reads as two
              locations with two different numbers and no way to tell which bar either is.
            */
            <Paper
              key={`${b.location_id}:${b.lot_id ?? 'none'}`}
              variant="outlined"
              sx={{ px: 2, py: 1, display: 'flex', alignItems: 'center' }}
            >
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Typography noWrap>{b.path.join(' › ') || b.location_name}</Typography>
                {b.lot_id && (
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                    {b.heat_number ? `Heat ${b.heat_number}` : b.lot_code}
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
