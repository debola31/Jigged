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
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';

import { useLoad } from '@/hooks/useLoad';
import { jiggedAgGridTheme } from '@/lib/agGridTheme';
import { getStorageOnHand, type OnHandRow } from '@/utils/inventoryOnHandAccess';
import { getLocations } from '@/utils/inventoryLocationsAccess';
import { gapSentence, locationAndDescendants, summariseOnHand } from '@/lib/inventoryOnHand';
import { computePathNames } from '@/lib/locationTree';

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
  /** Pre-selects the Where filter, so a place on the board can link straight into its own rows. */
  initialLocationId?: string;
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
  initialLocationId,
}: StorageInventoryTableProps) {
  const gridRef = useRef<AgGridReact<OnHandRow>>(null);
  const [search, setSearch] = useState('');
  const [locationId, setLocationId] = useState<string>(initialLocationId ?? '');
  const [onlyUncosted, setOnlyUncosted] = useState(false);
  const loggedRef = useRef(false);

  const { data, loading, error } = useLoad(
    () => Promise.all([getStorageOnHand(companyId), getLocations(companyId)]),
    [companyId],
  );
  const onHand = data?.[0];
  const rows = onHand?.rows ?? EMPTY_ROWS;
  const truncated = onHand?.truncated ?? false;
  const locations = useMemo(() => data?.[1] ?? [], [data]);

  /** The Where options, as full paths so "Shelf A" under two racks is not two identical lines. */
  const locationOptions = useMemo(() => {
    const byId = new Map(locations.map((l) => [l.id, l] as const));
    return locations
      .map((l) => ({ id: l.id, label: computePathNames(l.id, byId).join(' › ') }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [locations]);

  /**
   * Where, INCLUDING everything underneath.
   *
   * Stock only ever sits at a leaf (20260806160053: a location with children holds none), so
   * picking a rack has to mean its bins — filtering on the rack alone would return nothing, which
   * looks exactly like an empty rack and is actually a bug.
   */
  const allowedLocationIds = useMemo(
    () => (locationId ? locationAndDescendants(locations, locationId) : null),
    [locations, locationId],
  );

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (allowedLocationIds && !allowedLocationIds.has(r.locationId)) return false;
      if (onlyUncosted && r.gap === null) return false;
      if (!needle) return true;
      return (
        r.partName.toLowerCase().includes(needle) ||
        r.locationName.toLowerCase().includes(needle) ||
        (r.heatNumber ?? '').toLowerCase().includes(needle)
      );
    });
  }, [rows, allowedLocationIds, onlyUncosted, search]);

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
      { field: 'locationName', headerName: 'Place', flex: 1, minWidth: 120 },
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
  }, [costEnabled]);

  const gridHeight = useMemo(() => {
    if (loading || filtered.length === 0) return 480;
    return Math.max(56 + 52 * Math.min(filtered.length, 25) + 56, 400);
  }, [loading, filtered.length]);

  if (error) {
    return <Alert severity="error">Could not load what is in storage. Reload to try again.</Alert>;
  }

  return (
    <Box>
      <Stack direction="row" spacing={1.5} alignItems="center" sx={{ mb: 2, flexWrap: 'wrap' }}>
        <TextField
          size="small"
          label="Search"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            onFilter('search', e.target.value.trim().length > 0);
          }}
          sx={{ minWidth: 220 }}
        />
        <TextField
          select
          size="small"
          label="Where"
          value={locationId}
          onChange={(e) => {
            setLocationId(e.target.value);
            onFilter('where', e.target.value !== '');
          }}
          sx={{ minWidth: 220 }}
          helperText={locationId ? 'Includes everything inside it' : ' '}
        >
          <MenuItem value="">Everywhere</MenuItem>
          {locationOptions.map((o) => (
            <MenuItem key={o.id} value={o.id}>
              {o.label}
            </MenuItem>
          ))}
        </TextField>
        {onlyUncosted && (
          <Chip
            label="Only without a cost"
            onDelete={() => setOnlyUncosted(false)}
            color="primary"
            variant="outlined"
          />
        )}
        <Box sx={{ flex: 1 }} />
        {(search || locationId || onlyUncosted) && (
          <Button
            onClick={() => {
              setSearch('');
              setLocationId('');
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
