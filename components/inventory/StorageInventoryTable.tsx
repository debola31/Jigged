'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import posthog from 'posthog-js';
import { AgGridReact } from 'ag-grid-react';
import {
  ModuleRegistry,
  AllCommunityModule,
  type ColDef,
  type ValueFormatterParams,
} from 'ag-grid-community';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Link from '@mui/material/Link';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';

import { useLoad } from '@/hooks/useLoad';
import { jiggedAgGridTheme } from '@/lib/agGridTheme';
import { getStorageOnHand, type OnHandRow } from '@/utils/inventoryOnHandAccess';
import { getLocations } from '@/utils/inventoryLocationsAccess';
import { stockDestinationOptions } from '@/utils/locationDestinations';
import { gapSentence, summariseOnHand } from '@/lib/inventoryOnHand';
import { computePathNames } from '@/lib/locationTree';
import PartPlacesDrawer from '@/components/inventory/locations/place/PartPlacesDrawer';

ModuleRegistry.registerModules([AllCommunityModule]);

const EMPTY_ROWS: OnHandRow[] = [];

const money = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

interface StorageInventoryTableProps {
  companyId: string;
  /**
   * Whether the cost figures render.
   *
   * A PROP, never a hook read here: `useCompanyFeatures` has no shared cache, so a second consumer
   * on the same screen is a second `getCompany` per page load. The page ANDs the tenant flag with
   * the viewer being an admin, and passes false while the flags are still loading — a dollar total
   * that appears and then vanishes on a shared screen is worse than one that never appeared.
   */
  costEnabled: boolean;
  /**
   * Walk to a place: leave this tab and select that storage UNIT on the board.
   *
   * Given a root id, because that is what the board's `?unit=` selects. The drawer hands back the
   * leaf bin the stock sits in, and this component resolves it upward before crossing over.
   */
  onOpenPlace: (unitId: string) => void;
}

/**
 * The Storage page's Inventory tab: every balance in the shop, with what it cost us.
 *
 * ONE ROW PER BALANCE — (part, place, lot). A bar on two shelves is two rows, each with its own
 * heat. That is the real shape of the data, and it is what makes a Where filter and a per-place
 * total mean anything; rolling to one row per part would be a second copy of the Parts list.
 *
 * **THE FOOTER DESCRIBES THE ROWS ABOVE IT, NOT THE SHOP.** Filtering narrows the total with the
 * table. That is why the totals are summed here rather than aggregated in SQL, and why the reader
 * loads the complete set: a total that silently omitted a shelf is a number an owner would act on.
 *
 * What this deliberately never renders: a summed QUANTITY across parts (40 bearings + 3 castings is
 * dimensionless — the reason `locationOccupancy.ts` refuses roll-ups; money is different in kind,
 * because `cost_per_unit` is dollars per that part's own unit, so the multiplication IS the unit
 * conversion), a fill percentage (no capacity column exists to be the denominator), and `$0` in
 * place of "nothing here has a cost on file".
 */
export default function StorageInventoryTable({
  companyId,
  costEnabled,
  onOpenPlace,
}: StorageInventoryTableProps) {
  const gridRef = useRef<AgGridReact<OnHandRow>>(null);
  const [search, setSearch] = useState('');
  const [onlyUncosted, setOnlyUncosted] = useState(false);
  const [drawerPart, setDrawerPart] = useState<{
    id: string;
    name: string;
    unit: string | null;
  } | null>(null);
  const loggedRef = useRef(false);

  const { data, loading, error, reload } = useLoad(
    () => Promise.all([getStorageOnHand(companyId), getLocations(companyId)]),
    [companyId],
  );
  const onHand = data?.[0];
  const rows = onHand?.rows ?? EMPTY_ROWS;
  const truncated = onHand?.truncated ?? false;
  const locations = useMemo(() => data?.[1] ?? [], [data]);

  /**
   * Each place as its FULL path — "Raw stock rack › Row A › A-1".
   *
   * Load-bearing for the search, not decoration. Stock only ever sits at a leaf
   * (20260806160053: a location with children holds none), so a search that matched only the leaf
   * name would answer "Raw stock rack" with nothing at all — indistinguishable from an empty rack,
   * and the exact trap the old Where filter's descendant walk existed to avoid. Matching the path
   * gets the same answer from the one box, because every bin under a rack carries the rack's name.
   */
  const pathById = useMemo(() => {
    const byId = new Map(locations.map((l) => [l.id, l] as const));
    return new Map(locations.map((l) => [l.id, computePathNames(l.id, byId).join(' › ')] as const));
  }, [locations]);

  /**
   * The storage unit a bin belongs to.
   *
   * The board selects UNITS, and stock sits in leaves, so walking from a part to its place has to
   * climb first. Guarded against a parent chain that loops, which the schema should prevent but
   * this walk must survive rather than hang the page.
   */
  const rootOf = useMemo(() => {
    const parentOf = new Map(locations.map((l) => [l.id, l.parent_id] as const));
    return (id: string) => {
      const seen = new Set<string>();
      let current = id;
      for (;;) {
        const parent = parentOf.get(current);
        if (!parent || seen.has(parent)) return current;
        seen.add(parent);
        current = parent;
      }
    };
  }, [locations]);

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (onlyUncosted && r.gap === null) return false;
      if (!needle) return true;
      return (
        r.partName.toLowerCase().includes(needle) ||
        (pathById.get(r.locationId) ?? r.locationName).toLowerCase().includes(needle) ||
        (r.heatNumber ?? '').toLowerCase().includes(needle)
      );
    });
  }, [rows, onlyUncosted, search, pathById]);

  const summary = useMemo(() => summariseOnHand(filtered), [filtered]);
  const gap = gapSentence(summary);

  /*
   * Fires once per load, after the rows are in.
   *
   * In an EFFECT, not in render: capturing is a side effect, and a ref read during render is the
   * thing `react-hooks/refs` exists to stop — under a re-render it would fire more than once, or
   * not at all.
   *
   * Reports the SHAPE of the shop's cost data, never an amount, because that is what says whether
   * the total means anything. Summed over ALL rows rather than the filtered ones: this describes
   * the shop, not whatever someone happened to type first.
   */
  useEffect(() => {
    if (loading || !onHand || loggedRef.current) return;
    loggedRef.current = true;
    const all = summariseOnHand(onHand.rows);
    posthog.capture('storage inventory loaded', {
      part_count: all.partCount,
      balance_count: all.balanceCount,
      no_cost_tier_part_count: all.noCostTierParts,
      made_part_count: all.madeParts,
      below_min_part_count: all.belowMinParts,
      cost_visible: costEnabled,
      truncated: onHand.truncated,
    });
  }, [loading, onHand, costEnabled]);

  const onFilter = useCallback((filter: string, active: boolean) => {
    if (active) posthog.capture('storage inventory filtered', { filter, scope: 'inventory' });
  }, []);

  const columnDefs = useMemo<ColDef<OnHandRow>[]>(() => {
    const cols: ColDef<OnHandRow>[] = [
      { field: 'partName', headerName: 'Part', flex: 2.2, minWidth: 200 },
      {
        field: 'locationName',
        headerName: 'Place',
        flex: 1.4,
        minWidth: 160,
        // The PATH, not the leaf. The search matches on the path, so showing only "A-1" would mean
        // typing a rack's name filtered the table by something the table never displayed.
        valueGetter: (p) => (p.data ? (pathById.get(p.data.locationId) ?? p.data.locationName) : ''),
      },
      {
        field: 'heatNumber',
        headerName: 'Heat',
        flex: 1,
        minWidth: 110,
        valueFormatter: (p: ValueFormatterParams<OnHandRow>) =>
          p.value ?? (p.data?.lotCode ? p.data.lotCode : '—'),
      },
      {
        field: 'quantity',
        headerName: 'On hand',
        flex: 1,
        minWidth: 120,
        type: 'rightAligned',
        valueFormatter: (p: ValueFormatterParams<OnHandRow>) =>
          `${Number(p.value ?? 0).toLocaleString(undefined, { maximumFractionDigits: 4 })} ${
            p.data?.primaryUnit ?? ''
          }`.trim(),
      },
    ];

    if (costEnabled) {
      cols.push(
        {
          field: 'costPerUnit',
          headerName: 'Cost / unit',
          flex: 1,
          minWidth: 130,
          type: 'rightAligned',
          // An em dash, never $0.00: no cost on file and a cost of nothing are different facts.
          valueFormatter: (p: ValueFormatterParams<OnHandRow>) =>
            p.value === null || p.value === undefined
              ? '—'
              : `$${Number(p.value).toLocaleString(undefined, {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 2,
                })}`,
        },
        {
          field: 'onHandCost',
          headerName: 'Value',
          flex: 1,
          minWidth: 130,
          type: 'rightAligned',
          sort: 'desc',
          valueFormatter: (p: ValueFormatterParams<OnHandRow>) =>
            p.value === null || p.value === undefined ? '—' : money.format(Number(p.value)),
        },
      );
    }

    return cols;
    // `pathById` is read inside the Place column's valueGetter, so it belongs here: the locations
    // resolve after the first render, and without it the column would keep the empty map it closed
    // over and show blank places forever.
  }, [costEnabled, pathById]);

  /*
   * A VIEWPORT-BOUND height, so the footer is always on screen.
   *
   * The alternative — moving the totals above the table — puts a figure before the rows it sums
   * and re-creates the scorecard strip this design deliberately dropped. Keeping them in the footer
   * is what makes them describe the rows above them; the grid scrolls internally instead, so the
   * total never leaves the screen no matter how many rows there are.
   *
   * A shorter list still shrinks to fit rather than leaving dead space under it.
   */
  const gridHeight = useMemo(() => {
    if (loading || filtered.length === 0) return '320px';
    // header + rows + pagination bar, capped by what is left of the viewport under the page
    // chrome (app header, tabs, toolbar) and the footer itself.
    const rowsHeight = 56 + 52 * Math.min(filtered.length, 25) + 56;
    // CSS rather than `useMediaQuery`: jsdom has no `matchMedia`, so a JS branch here would be
    // untestable — the house rule is that responsive behaviour is written as CSS.
    return `min(${rowsHeight}px, max(320px, calc(100vh - 380px)))`;
  }, [loading, filtered.length]);

  if (error) {
    return <Alert severity="error">Could not load what is in storage. Reload to try again.</Alert>;
  }

  return (
    <Box>
      {/*
        ONE box, and it is the only filter.

        It replaced a `Search` field beside a `Where` select — which were misaligned (the select
        carried helper text and the search did not) and, more to the point, were two controls for
        one question. The box matches the part, the heat, and the place's FULL PATH, so typing a
        rack's name still narrows the table and the total to that rack. One search per tab: this
        one finds what is on the shelves, and the Places tab's finds places.
      */}
      <Stack direction="row" spacing={1.5} alignItems="center" sx={{ mb: 2, flexWrap: 'wrap' }}>
        <TextField
          size="small"
          label="Search parts, places or heats"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            onFilter('search', e.target.value.trim().length > 0);
          }}
          sx={{ minWidth: 300 }}
        />
        {onlyUncosted && (
          <Chip
            label="Only without a cost"
            onDelete={() => setOnlyUncosted(false)}
            color="primary"
            variant="outlined"
          />
        )}
        <Box sx={{ flex: 1 }} />
        {(search || onlyUncosted) && (
          <Button
            onClick={() => {
              setSearch('');
              setOnlyUncosted(false);
            }}
          >
            Clear filters
          </Button>
        )}
      </Stack>

      {truncated && (
        // Refuse the total rather than print a short one. A number quietly missing a shelf is worse
        // than no number, because it is the one an owner would act on.
        <Alert severity="warning" sx={{ mb: 2 }}>
          This shop holds more than this table can total. The rows below are the first{' '}
          {rows.length.toLocaleString()} — filter to a place to get a figure you can trust.
        </Alert>
      )}

      <Card>
        <Box sx={{ height: gridHeight, width: '100%' }}>
          {loading ? (
            <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%' }}>
              <CircularProgress />
            </Box>
          ) : (
            <AgGridReact<OnHandRow>
              ref={gridRef}
              rowData={filtered}
              columnDefs={columnDefs}
              theme={jiggedAgGridTheme}
              defaultColDef={{ sortable: true, resizable: true }}
              pagination
              paginationPageSize={25}
              paginationPageSizeSelector={[25, 50, 100]}
              domLayout="normal"
              getRowId={(params) => params.data.balanceId}
              enableCellTextSelection
              suppressCellFocus={false}
              // A row is a part somewhere, so clicking one opens that PART — everywhere it is,
              // with Add / Remove / Move / Adjust against each place. The same drawer the Places
              // board used to open from its search, which is where it belongs now that the parts
              // half of that search lives on this tab.
              onRowClicked={(e) =>
                e.data &&
                setDrawerPart({
                  id: e.data.partId,
                  name: e.data.partName,
                  unit: e.data.primaryUnit,
                })
              }
            />
          )}
        </Box>

        {/*
          THE FOOTER, and it describes the rows above it.

          Not a scorecard strip at the top: the number belongs where the rows it sums are, and a
          card above the table would keep saying the shop's figure while the table showed one
          cabinet.
        */}
        <Box
          sx={{
            px: 2,
            py: 1.5,
            borderTop: '2px solid',
            borderColor: 'rgba(255, 255, 255, 0.20)',
            display: 'flex',
            alignItems: 'center',
            gap: 2,
            flexWrap: 'wrap',
          }}
        >
          <Typography sx={{ fontWeight: 600 }}>
            {summary.partCount.toLocaleString()} {summary.partCount === 1 ? 'part' : 'parts'} ·{' '}
            {summary.balanceCount.toLocaleString()}{' '}
            {summary.balanceCount === 1 ? 'balance' : 'balances'}
          </Typography>
          <Box sx={{ flex: 1 }} />
          {costEnabled && !truncated && (
            <>
              <Typography variant="body2" color="text.secondary">
                Total at our cost
              </Typography>
              <Typography variant="h5" sx={{ fontWeight: 600 }}>
                {/* NULL, not zero: "nothing here has a cost on file" is not "this is worth nothing". */}
                {summary.costedTotal === null ? 'No costs on file' : money.format(summary.costedTotal)}
              </Typography>
            </>
          )}
        </Box>
      </Card>

      {/*
        Shown whether or not the money is. How complete a shop's cost data is, is not itself a
        dollar figure — and a shop that cannot see the gap cannot close it.
      */}
      <PartPlacesDrawer
        part={drawerPart}
        companyId={companyId}
        // Leaves only: a place with children cannot hold stock, so offering a cabinet would put an
        // error behind a legitimate-looking choice.
        moveDestinations={stockDestinationOptions(locations)}
        onClose={() => setDrawerPart(null)}
        onOpenPlace={(locationId) => {
          setDrawerPart(null);
          onOpenPlace(rootOf(locationId));
        }}
        onChanged={reload}
      />

      {gap && (
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1.5 }}>
          {summary.noCostTierParts > 0 ? (
            <Link
              component="button"
              type="button"
              underline="always"
              onClick={() => {
                setOnlyUncosted(true);
                posthog.capture('storage inventory gap opened', {
                  no_cost_tier_part_count: summary.noCostTierParts,
                });
              }}
              sx={{ color: 'primary.light' }}
            >
              {gap}
            </Link>
          ) : (
            gap
          )}
        </Typography>
      )}
    </Box>
  );
}
