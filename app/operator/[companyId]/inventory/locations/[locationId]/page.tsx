'use client';

import { useState, useMemo } from 'react';
import { useParams } from 'next/navigation';
import { useLoad } from '@/hooks/useLoad';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import Stack from '@mui/material/Stack';
import Alert from '@mui/material/Alert';
import CircularProgress from '@mui/material/CircularProgress';

import {
  resolveScan,
  getLocations,
  getLocationHistory,
  getLocationOccupancy,
  buildLocationTree,
} from '@/utils/inventoryLocationsAccess';
import { rollUpOccupancy } from '@/utils/locationOccupancy';
import UnitGridView from '@/components/inventory/locations/UnitGridView';
import { stockDestinationOptions } from '@/utils/locationDestinations';
import { useOperatorNav, useSetOperatorChrome } from '@/components/operator/OperatorChromeContext';
import PlaceStockActionForm, {
  type PlaceStockAction,
} from '@/components/inventory/locations/place/PlaceStockActionForm';
import PlaceAdjustForm from '@/components/inventory/locations/place/PlaceAdjustForm';
import BinHistory from '@/components/operator/BinHistory';

const num = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 4 });

export default function OperatorBinViewPage() {
  const params = useParams();
  const nav = useOperatorNav();
  const companyId = params.companyId as string;
  const locationId = params.locationId as string;

  const [error, setError] = useState<string | null>(null);

  /** Which verb's form is open, exactly as the office drawer holds it. */
  const [openVerb, setOpenVerb] = useState<PlaceStockAction | 'adjust' | null>(null);

  const {
    data: scan,
    loading,
    reload,
  } = useLoad(() => resolveScan(locationId), [locationId], {
    onError: (e) => {
      setError(e instanceof Error ? e.message : 'Could not open this location.');
    },
  });

  /*
   * The author lookup used to live here, feeding the two operator modals. The shared forms fetch
   * their own — best-effort, so a failed lookup writes no name rather than blocking a stock
   * correction — which means attribution still happens and this page no longer has to arrange it.
   */

  const node = scan?.node ?? null;
  const path = scan?.path ?? [];
  const parent = path.length > 1 ? path[path.length - 2] : null;

  /**
   * The DEEP-LINK fallback, and only that.
   *
   * This used to be described — and to behave — as though back always climbed the location tree.
   * It did, but not by design: nothing on this branch went through `nav.push`, so the chrome's
   * depth counter never left zero and `goBack()` always took its no-history branch. Searching for
   * a part, tapping a location it was in, then pressing Back therefore landed on that location's
   * PARENT rather than back on the part.
   *
   * With the forward navigations fixed, this is what it was always meant to be: where to go when a
   * printed QR dropped someone straight here with nothing to pop. Climbing the tree is right then.
   */
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

  /**
   * Where a Move can go: every other location in the company, by full path.
   *
   * Loaded alongside the scan rather than lazily, because the whole point of this surface is
   * that the operator's context is already known — making them wait after tapping Move would
   * undo that. It's one small read of a tree a shop has a couple of dozen nodes in.
   */
  /**
   * Recent movements here. Keyed on the same `locationId` as the scan, and reloaded by the same
   * `reload` the action modals call — so a put-away you just recorded appears without a refresh,
   * which is the whole point of showing it to the person who made it.
   */
  const {
    data: history,
    loading: historyLoading,
    reload: reloadHistory,
  } = useLoad(() => getLocationHistory(locationId), [locationId]);

  /** Both, always: a movement changes the contents AND adds a history row. */
  const reloadAll = async () => {
    await Promise.all([reload(), reloadHistory()]);
  };

  const { data: allLocations } = useLoad(() => getLocations(companyId), [companyId]);

  /**
   * Fill state for the drawn grid.
   *
   * One aggregated read (`inventory_location_occupancy`), constant size whatever the tree — the
   * same view the office board uses, and the reason it is a view at all: counting
   * `part_location_stock` client-side would silently truncate at PostgREST's `max_rows`.
   */
  const { data: directPartCounts } = useLoad(() => getLocationOccupancy(companyId), [companyId]);

  /** The subtree rooted here, with occupancy rolled up, for `UnitGridView`. */
  const { gridUnit, gridOccupancy } = useMemo(() => {
    const roots = buildLocationTree(allLocations ?? []);
    const occ = rollUpOccupancy(roots, directPartCounts ?? new Map());
    const find = (nodes: typeof roots): (typeof roots)[number] | null => {
      for (const n of nodes) {
        if (n.id === locationId) return n;
        const hit = find(n.children);
        if (hit) return hit;
      }
      return null;
    };
    return { gridUnit: find(roots), gridOccupancy: occ };
  }, [allLocations, directPartCounts, locationId]);
  // Containers, the `Unassigned` pile and this bin itself are all dropped by the shared rule —
  // a container cannot hold stock, so moving stock into one would only raise on arrival.
  const moveDestinations = useMemo(
    () => stockDestinationOptions(allLocations ?? [], { excludeId: locationId }),
    [allLocations, locationId],
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
  const contentsTotal = scan?.contentsTotal ?? 0;

  return (
    <Box sx={{ pb: 4 }}>
      {/* Header: name + full path (back lives in the app header now). */}
      <Box sx={{ minWidth: 0, mb: 3 }}>
        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
          <Typography variant="h5" sx={{ fontWeight: 700 }}>
            {node.name}
          </Typography>
        </Stack>
        {path.length > 1 && (
          <Typography variant="body2" color="text.secondary">
            {path.map((p) => p.name).join(' › ')}
          </Typography>
        )}
      </Box>

      {/*
        Sub-locations, DRAWN.

        This was a vertical stack of cards — one per child — so scanning a 12 × 15 cabinet's label
        opened twelve cards, and each of those opened fifteen more. The operator's own model is
        spatial ("three rows down, five slots over"), and a card stack is the one shape that
        cannot express it.

        Same `UnitGridView` the office uses, at what is **already the QR target route**: a cell tap
        lands on exactly the bin view that exists now, at exactly the URL a bin's own label points
        to. No new route, no new payload shape, nothing to reprint.
      */}
      {children.length > 0 && gridUnit && (
        <Box sx={{ mb: 3 }}>
          <Typography variant="overline" color="text.secondary">
            Sub-locations
          </Typography>
          <Box sx={{ mt: 0.5 }}>
            <UnitGridView
              unit={gridUnit}
              occupancy={gridOccupancy}
              // `nav.push`, so drilling in and pressing Back retraces the taps you made rather
              // than climbing to whatever this cell's parent happens to be.
              onOpenCell={(id) => nav.push(`/operator/${companyId}/inventory/locations/${id}`)}
            />
          </Box>
        </Box>
      )}

      {/*
        A container has no "Stock here" section at all.

        It used to render one, with a "Stock a part" button, above the line "No stock recorded
        directly here — open a sub-location above." That line was describing a state the button
        beside it invited you to break, and since 20260806160053 the database refuses the write —
        so the button now leads to an error rather than a mistake. Neither is worth showing.
        The sub-locations above are the whole answer for a container, and one line under them says
        so instead.
      */}
      {children.length > 0 ? (
        <Typography variant="body2" color="text.secondary">
          Stock goes in the sub-locations above, not in {node.name} itself.
        </Typography>
      ) : (
      <Box>
        {/*
          THE SAME FLOW AS THE OFFICE, minus everything that configures storage.

          This was a card per part, each with four buttons opening a single-part dialog — so putting
          a delivery of six things away meant six dialogs, and none of the rules the office forms
          grew (a blank row is not an instruction; a partial batch disarms what landed; the job list
          narrows to jobs that could have used the part) applied here at all. The shop floor had the
          older, thinner version of the same job.

          It now renders the very same forms. Not a copy — the same components, so a rule fixed in
          one place is fixed on both surfaces, which is exactly how the two drifted in the first
          place.

          What it does NOT get: `Change layout`, `Rename`, `Delete`, `Add storage`, `Print QR`.
          Configuring storage is an office job; acting on the stock in it is not.
        */}
        <Typography variant="overline" color="text.secondary">
          Stock here
        </Typography>

        <Box sx={{ mt: 0.5, mb: 2 }}>
          {contents.length === 0 ? (
            <Typography variant="body2" color="text.secondary">
              No parts recorded here.
            </Typography>
          ) : (
            <Stack spacing={0.5}>
              {contentsTotal > contents.length && (
                <Alert severity="info" sx={{ mb: 0.5 }}>
                  Showing the {contents.length} largest of {num(contentsTotal)} parts here.
                </Alert>
              )}
              {contents.map((part) => (
                <Box
                  key={part.part_id}
                  sx={{ display: 'flex', alignItems: 'baseline', gap: 1, minHeight: 32 }}
                >
                  <Typography variant="body2" sx={{ flex: 1, minWidth: 0 }} noWrap>
                    {part.part_name}
                  </Typography>
                  <Typography
                    variant="body2"
                    sx={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}
                  >
                    {num(part.quantity)}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    {part.primary_unit ?? ''}
                  </Typography>
                </Box>
              ))}
            </Stack>
          )}
        </Box>

        {/*
          The four verbs, in the order fixed across both surfaces. Full-width and 48px on a phone:
          four of them fit one row at 390px only because the words are short.
        */}
        <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
          {(
            [
              ['add', 'Add', false],
              ['deplete', 'Remove', true],
              ['move', 'Move', true],
              ['adjust', 'Adjust', false],
            ] as const
          ).map(([v, label, needsStock]) => (
            <Button
              key={v}
              variant={openVerb === v ? 'contained' : 'outlined'}
              disabled={needsStock && contents.length === 0}
              aria-expanded={openVerb === v}
              onClick={() => setOpenVerb((cur) => (cur === v ? null : v))}
              sx={{ minHeight: 48 }}
            >
              {label}
            </Button>
          ))}
        </Stack>

        {openVerb === 'adjust' ? (
          <PlaceAdjustForm
            companyId={companyId}
            locationId={locationId}
            locationName={node.name}
            onCancel={() => setOpenVerb(null)}
            onDone={reloadAll}
          />
        ) : openVerb ? (
          <PlaceStockActionForm
            key={openVerb}
            action={openVerb}
            companyId={companyId}
            locationId={locationId}
            locationName={node.name}
            moveDestinations={moveDestinations}
            // The shop floor's removal has always been graceful: the material is already off the
            // shelf, so a stale count must not refuse the write. The RPC floors at zero and writes
            // the shortfall into the ledger note instead.
            graceful
            onCancel={() => setOpenVerb(null)}
            onDone={reloadAll}
          />
        ) : null}
      </Box>
      )}

      <Box sx={{ mt: 4 }}>
        <Typography variant="overline" color="text.secondary">
          Recent activity
        </Typography>
        <Box sx={{ mt: 0.5 }}>
          <BinHistory entries={history} loading={historyLoading} />
        </Box>
      </Box>


    </Box>
  );
}
