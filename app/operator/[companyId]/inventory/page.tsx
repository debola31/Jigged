'use client';

/**
 * The operator Inventory tab — item-first, which is what makes its own label true.
 *
 * ## What it used to be, and why that was wrong
 *
 * It rendered the owner's `LocationBoard`: a drawn map of *locations*, read-only. That is Storage
 * content under an Inventory label, and industry usage is consistent — *inventory* means items and
 * quantities, *storage* means where they are. Every action an operator actually takes here is an
 * **item** action: find one, store one, take one out. The tab now matches the noun.
 *
 * Dropping the board cost less than it looks. With 12–18 locations you are standing among, walking
 * beats scrolling a picture of furniture three feet away — and Scan already reaches one faster
 * *and* proves you are at it, so the board was competing with the better tool. The one thing the
 * board did that nothing else does — reach a bin whose label has come off — survives as the tap
 * target on every activity row.
 *
 * ## Two modes, never both
 *
 * Idle → the shop-wide feed. Part selected → that part's locations, feed hidden. The feed is the
 * genuinely phone-shaped thing here: what a phone knows that you do not is what changed while you
 * were somewhere else. Mid-lookup it is noise, and showing both is how this screen becomes a wall.
 *
 * ## `?part=` — why the selection lives in the URL
 *
 * It used to be local state, and that made Back land in the wrong place. Tapping a location the
 * part is in navigates to that bin; pressing Back there returned to this route with the lookup
 * empty, so the answer you had just found was gone and you searched for it again. A page is only
 * "where you came from" if it can be rebuilt, and nothing about the selection was written down.
 *
 * `router.replace`, never `push` — a same-page URL update must not add a history entry, or Back
 * would step through every part you had looked at. Same rule the operator chrome states for
 * `?scope=` on the jobs list.
 */

import { Suspense, useCallback, useState } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useLoad } from '@/hooks/useLoad';
import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
import Typography from '@mui/material/Typography';
import Stack from '@mui/material/Stack';
import Alert from '@mui/material/Alert';
import WarehouseOutlinedIcon from '@mui/icons-material/WarehouseOutlined';

import { getRecentActivity } from '@/utils/inventoryLocationsAccess';
import { useOperatorNav } from '@/components/operator/OperatorChromeContext';
import OperatorPartLookup from '@/components/operator/OperatorPartLookup';
import BinHistory from '@/components/operator/BinHistory';
import type { PartSelectOption } from '@/utils/partsAccess';

function OperatorWarehouseHomeContent() {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const nav = useOperatorNav();
  const companyId = params.companyId as string;

  const [error, setError] = useState<string | null>(null);
  /**
   * Two modes, never both at once.
   *
   * With a part chosen you are mid-task — the shop-wide feed underneath becomes noise, and showing
   * it is exactly how this screen would turn into a wall. Idle, the feed IS the page.
   */
  const [selectedPart, setSelectedPart] = useState<PartSelectOption | null>(null);
  const initialPartId = searchParams.get('part');

  const { data: activity, loading } = useLoad(() => getRecentActivity(companyId), [companyId], {
    onError: (e) => {
      setError(e instanceof Error ? e.message : 'Could not load recent activity.');
    },
  });

  /**
   * `nav.push`, not `router.push`.
   *
   * The header back button pops real history when the chrome knows there is in-app history behind
   * it, and climbs the location tree when there is not — the QR deep-link case. Only `nav.push`
   * tells it which of those you are in. Using the raw router here left the counter at zero, so
   * Back took the deep-link branch and walked UP from the bin you had just opened, landing on its
   * parent rather than on the part you opened it from.
   */
  const openLocation = useCallback(
    (locationId: string) => nav.push(`/operator/${companyId}/inventory/locations/${locationId}`),
    [nav, companyId],
  );

  /** Mirror the selection into the URL so returning here rebuilds it. See the header. */
  const rememberSelection = useCallback(
    (part: PartSelectOption | null) => {
      setSelectedPart(part);
      const next = part
        ? `/operator/${companyId}/inventory?part=${part.id}`
        : `/operator/${companyId}/inventory`;
      router.replace(next, { scroll: false });
    },
    [router, companyId],
  );

  return (
    <Box sx={{ pb: 4 }}>
      <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 0.5 }}>
        <WarehouseOutlinedIcon color="primary" />
        <Typography variant="h5" sx={{ fontWeight: 700 }}>
          Inventory
        </Typography>
      </Stack>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Look up a part to find where it is. Scan a label to go straight there.
      </Typography>

      <OperatorPartLookup
        companyId={companyId}
        initialPartId={initialPartId}
        onOpenLocation={openLocation}
        onSelectionChange={rememberSelection}
      />

      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}

      {/*
        Recent activity replaces the drawn board that used to sit here.

        A board is a map of locations you are standing among — with 12–18 of them, walking beats
        scrolling a picture of furniture that is three feet away, and it competed with Scan, which
        reaches one faster and proves you are actually at it. What a phone genuinely knows that you
        do not is WHAT CHANGED WHILE YOU WERE ELSEWHERE. Every row taps through to its location, so
        this is also how you reach a bin whose label has come off.
      */}
      {!selectedPart && (
        <Box sx={{ mt: 1 }}>
          <Typography variant="overline" color="text.secondary">
            Recent activity
          </Typography>
          <Box sx={{ mt: 0.5 }}>
            <BinHistory
              entries={activity}
              loading={loading}
              showPlace
              onOpenLocation={openLocation}
              emptyText="No stock has moved yet. Scan a label to store something."
            />
          </Box>
        </Box>
      )}
    </Box>
  );
}

export default function OperatorWarehouseHomePage() {
  // useSearchParams requires a Suspense boundary (matches the jobs list and app/login).
  return (
    <Suspense
      fallback={
        <Box
          sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '40vh' }}
        >
          <CircularProgress />
        </Box>
      }
    >
      <OperatorWarehouseHomeContent />
    </Suspense>
  );
}
