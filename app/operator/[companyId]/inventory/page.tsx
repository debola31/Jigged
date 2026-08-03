'use client';

/**
 * The operator Inventory tab — item-first, which is what makes its own label true.
 *
 * ## What it used to be, and why that was wrong
 *
 * It rendered the owner's `LocationBoard`: a drawn map of *places*, read-only. That is Storage
 * content under an Inventory label, and industry usage is consistent — *inventory* means items and
 * quantities, *storage* means places. Every action an operator actually takes here is an **item**
 * action: find one, put one away, take one out. The tab now matches the noun.
 *
 * Dropping the board cost less than it looks. With 12–18 places you are standing among, walking
 * beats scrolling a picture of furniture three feet away — and Scan already reaches a place faster
 * *and* proves you are at it, so the board was competing with the better tool. The one thing the
 * board did that nothing else does — reach a bin whose label has come off — survives as the tap
 * target on every activity row.
 *
 * ## Two modes, never both
 *
 * Idle → the shop-wide feed. Part selected → that part's places, feed hidden. The feed is the
 * genuinely phone-shaped thing here: what a phone knows that you do not is what changed while you
 * were somewhere else. Mid-lookup it is noise, and showing both is how this screen becomes a wall.
 */

import { useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useLoad } from '@/hooks/useLoad';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Stack from '@mui/material/Stack';
import Alert from '@mui/material/Alert';
import WarehouseOutlinedIcon from '@mui/icons-material/WarehouseOutlined';

import { getRecentActivity } from '@/utils/inventoryLocationsAccess';
import OperatorPartLookup from '@/components/operator/OperatorPartLookup';
import BinHistory from '@/components/operator/BinHistory';
import type { PartSelectOption } from '@/components/parts/PartAutocomplete';

export default function OperatorWarehouseHomePage() {
  const params = useParams();
  const router = useRouter();
  const companyId = params.companyId as string;

  const [error, setError] = useState<string | null>(null);
  /**
   * Two modes, never both at once.
   *
   * With a part chosen you are mid-task — the shop-wide feed underneath becomes noise, and showing
   * it is exactly how this screen would turn into a wall. Idle, the feed IS the page.
   */
  const [selectedPart, setSelectedPart] = useState<PartSelectOption | null>(null);

  const { data: activity, loading } = useLoad(() => getRecentActivity(companyId), [companyId], {
    onError: (e) => {
      setError(e instanceof Error ? e.message : 'Could not load recent activity.');
    },
  });

  const openLocation = (locationId: string) =>
    router.push(`/operator/${companyId}/inventory/locations/${locationId}`);

  return (
    <Box sx={{ pb: 4 }}>
      <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 0.5 }}>
        <WarehouseOutlinedIcon color="primary" />
        <Typography variant="h5" sx={{ fontWeight: 700 }}>
          Inventory
        </Typography>
      </Stack>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Look up a part to find where it is. Scan a shelf label to go straight there.
      </Typography>

      <OperatorPartLookup
        companyId={companyId}
        onOpenLocation={openLocation}
        onSelectionChange={setSelectedPart}
      />

      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}

      {/*
        Recent activity replaces the drawn board that used to sit here.

        A board is a map of places you are standing among — with 12–18 of them, walking beats
        scrolling a picture of furniture that is three feet away, and it competed with Scan, which
        reaches a place faster and proves you are actually at it. What a phone genuinely knows that
        you do not is WHAT CHANGED WHILE YOU WERE ELSEWHERE. Every row taps through to its place,
        so this is also how you reach a bin whose label has come off.
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
              emptyText="No stock has moved yet. Scan a shelf label to put something away."
            />
          </Box>
        </Box>
      )}
    </Box>
  );
}
