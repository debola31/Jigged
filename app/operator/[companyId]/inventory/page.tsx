'use client';

import { useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useLoad } from '@/hooks/useLoad';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Stack from '@mui/material/Stack';
import Alert from '@mui/material/Alert';
import CircularProgress from '@mui/material/CircularProgress';
import WarehouseOutlinedIcon from '@mui/icons-material/WarehouseOutlined';

import { getLocationBoard, buildLocationTree } from '@/utils/inventoryLocationsAccess';
import { rollUpOccupancy } from '@/utils/locationOccupancy';
import LocationBoard, { boardOrder } from '@/components/inventory/locations/board/LocationBoard';
import OperatorPartLookup from '@/components/operator/OperatorPartLookup';
import type { InventoryLocation } from '@/types/inventoryLocations';

// Stable empty fallbacks so the tree/occupancy memos don't churn while the first load runs.
const EMPTY_LOCATIONS: InventoryLocation[] = [];
const EMPTY_COUNTS: ReadonlyMap<string, number> = new Map();
const EMPTY_URLS: ReadonlyMap<string, string> = new Map();

/**
 * Operator "warehouse home" — the root of the Inventory tab.
 *
 * ## Why this is the same board the owner sees
 *
 * It used to be a plain list of names, kinds and codes, while the owner's Storage page drew
 * each unit with its compartments, its photo and its fill state. That split was backwards:
 * the person who most needs to *recognise* a physical place is the one standing in front of
 * it, and `CAB3-A` is not recognisable. §5.5 decision 1's promise — "what you preview is what
 * you live with" — has to extend to the people at the shelf, so this renders `LocationBoard`
 * directly rather than a parallel implementation that would drift.
 *
 * Two deliberate differences from the owner's board:
 *
 * - **No "Add storage" tile.** Creating places is an owner's job. An operator adding one
 *   mid-shift is exactly how `MISC 8-25-21` gets into a location table (§5.5 finding 2).
 * - **No detail sheet.** Tapping a unit navigates into the existing bin view, which already
 *   owns the take/return actions, rather than opening a second actions surface on top of it.
 *
 * Scanning is no longer here either: it's a tab-bar action in the operator layout, where it
 * resolves both location labels *and* job travelers. A button on this one page could only
 * ever read locations, and only if you'd already navigated here.
 */
export default function OperatorWarehouseHomePage() {
  const params = useParams();
  const router = useRouter();
  const companyId = params.companyId as string;

  const [error, setError] = useState<string | null>(null);

  // getLocationBoard, not getLocations: the board needs per-location part counts for fill
  // state and one batched set of signed photo URLs. Same single request pair the owner's page
  // makes, so the two can't disagree about what's in a place.
  const { data: boardData, loading } = useLoad(() => getLocationBoard(companyId), [companyId], {
    onError: (e) => {
      setError(e instanceof Error ? e.message : 'Could not load the warehouse.');
    },
  });

  const locations = boardData?.locations ?? EMPTY_LOCATIONS;
  const directPartCounts = boardData?.directPartCounts ?? EMPTY_COUNTS;
  const photoUrls = boardData?.photoUrls ?? EMPTY_URLS;

  // Sorted with the same comparator as the owner's board, so `Unassigned` lands last in both.
  const tree = useMemo(() => buildLocationTree(locations).sort(boardOrder), [locations]);
  // Rolled up: a cabinet whose shelves hold stock must read as occupied, or an operator gets
  // sent to fill a shelf that's already full.
  const occupancy = useMemo(() => rollUpOccupancy(tree, directPartCounts), [tree, directPartCounts]);

  return (
    <Box sx={{ pb: 4 }}>
      <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 0.5 }}>
        <WarehouseOutlinedIcon color="primary" />
        <Typography variant="h5" sx={{ fontWeight: 700 }}>
          Inventory
        </Typography>
      </Stack>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Look up a part to find where it is, or browse the places below. Scan jumps straight to a
        place from its label.
      </Typography>

      {/*
        Search leads; the board is the fallback.

        The tab is called Inventory, and inventory means ITEMS — but this page opened as a board of
        PLACES, which is Storage content under an Inventory label. Browsing place-by-place only
        helps someone who already knows which place to open, and the commonest operator question is
        the other way round: "we have this part somewhere — where?"

        It also keeps Scan and Inventory from competing. Scan is a router — "take me to the thing
        I'm holding". Inventory is a destination — "let me find something". Leading with a board
        made this page a second way to navigate, which is Scan's job and it does it faster.
      */}
      <OperatorPartLookup
        companyId={companyId}
        onOpenLocation={(locationId) =>
          router.push(`/operator/${companyId}/inventory/locations/${locationId}`)
        }
      />

      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}

      {loading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
          <CircularProgress />
        </Box>
      ) : tree.length === 0 ? (
        <Card elevation={2}>
          <CardContent sx={{ textAlign: 'center', py: 6 }}>
            <WarehouseOutlinedIcon sx={{ fontSize: 44, color: 'text.disabled', mb: 1 }} />
            <Typography color="text.secondary">
              No storage locations yet. Once they&apos;re set up, you can browse them here.
            </Typography>
          </CardContent>
        </Card>
      ) : (
        <>
          <Typography variant="overline" color="text.secondary">
            Browse places
          </Typography>
          <LocationBoard
            tree={tree}
            occupancy={occupancy}
            photoUrls={photoUrls}
            onOpen={(node) =>
              router.push(`/operator/${companyId}/inventory/locations/${node.id}`)
            }
          />
        </>
      )}
    </Box>
  );
}
