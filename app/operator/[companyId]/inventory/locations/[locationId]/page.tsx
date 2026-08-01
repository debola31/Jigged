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
import Link from '@mui/material/Link';
import KeyboardArrowRightIcon from '@mui/icons-material/KeyboardArrowRight';
import AddIcon from '@mui/icons-material/Add';
import RemoveIcon from '@mui/icons-material/Remove';
import TuneIcon from '@mui/icons-material/Tune';
import SwapHorizIcon from '@mui/icons-material/SwapHoriz';
import AddCircleOutlineIcon from '@mui/icons-material/AddCircleOutline';
import Inventory2OutlinedIcon from '@mui/icons-material/Inventory2Outlined';

import { resolveScan, getLocations, getLocationHistory } from '@/utils/inventoryLocationsAccess';
import type { InventoryLocation } from '@/types/inventoryLocations';
import { getCurrentMember } from '@/utils/operatorAccess';
import { useSetOperatorChrome } from '@/components/operator/OperatorChromeContext';
import { getStandardUnitsForUnit } from '@/lib/unitPresets';
import type { LocationContent } from '@/types/inventoryLocations';
import OperatorLocationActionModal, {
  type OperatorLocationAction,
} from '@/components/operator/OperatorLocationActionModal';
import OperatorReceivePartModal from '@/components/operator/OperatorReceivePartModal';
import BinHistory from '@/components/operator/BinHistory';

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
    getCurrentMember(companyId)
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
  const moveDestinations = useMemo(() => {
    const list = allLocations ?? [];
    const byId = new Map(list.map((l) => [l.id, l] as const));
    const pathOf = (id: string): string => {
      const names: string[] = [];
      let cursor: string | null = id;
      const guard = new Set<string>();
      while (cursor && byId.has(cursor) && !guard.has(cursor)) {
        guard.add(cursor);
        const n: InventoryLocation = byId.get(cursor)!;
        names.unshift(n.name);
        cursor = n.parent_id;
      }
      return names.join(' › ');
    };
    // The current location and the `Unassigned` bucket are both dropped by `LocationPicker` now
    // (`excludeId` / `excludeSystem`), so this only has to build the labelled list.
    return list
      .map((l) => ({ id: l.id, label: pathOf(l.id), kind: l.kind }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [allLocations]);

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
  const contentsTotal = scan?.contentsTotal ?? 0;

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
            {/* The list is capped. Saying so beats the silent `max_rows` clip this read used to
                take — an operator seeing 200 of 9,428 needs to know the rest exist. */}
            {/* The instruction is back, and now it points somewhere real.
                It once read "Scan or search a part to reach one that isn't listed", when neither
                route existed — no part search anywhere on the operator app, and a scanner that
                resolves location labels and job travellers but never a part. It was stripped to
                "ask the office" rather than keep promising two impossible things. J11 shipped
                2026-07-31, so the honest version is a link to it — the lookup answers "where is
                this?" for any part, including one below this cap. */}
            {contentsTotal > contents.length && (
              <Alert severity="info">
                Showing the {contents.length} largest of {num(contentsTotal)} parts here. The rest
                are still counted —{' '}
                <Link
                  component="button"
                  type="button"
                  onClick={() => router.push(`/operator/${companyId}/inventory`)}
                >
                  look a part up
                </Link>{' '}
                to find one that isn&apos;t listed.
              </Alert>
            )}
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
                  {/* Same four verbs, same words, as the admin part page.
                      ORDER is fixed across both surfaces — Add, Remove, Move, Adjust — so a
                      control is always in the same place. WEIGHT is what varies: Remove is the
                      primary here (stock arrives in bulk once, and put-away is really
                      receiving's job; it leaves in small amounts every job, all shift), while
                      the admin page emphasises Add. Position serves the operator who knows
                      where to reach; fill serves the one who doesn't yet.
                      None of the four is red — reversible bookkeeping, not destruction. */}
                  <Stack direction="row" spacing={1} sx={{ mt: 1.5, flexWrap: 'wrap', gap: 1 }}>
                    <Button
                      variant="outlined"
                      startIcon={<AddIcon />}
                      onClick={() => setModal({ action: 'add', part })}
                      sx={{ flex: 1, minWidth: 120 }}
                    >
                      Add
                    </Button>
                    <Button
                      variant="contained"
                      startIcon={<RemoveIcon />}
                      onClick={() => setModal({ action: 'deplete', part })}
                      sx={{ flex: 1, minWidth: 120 }}
                    >
                      Remove
                    </Button>
                    <Button
                      variant="outlined"
                      startIcon={<SwapHorizIcon />}
                      onClick={() => setModal({ action: 'move', part })}
                      sx={{ flex: 1, minWidth: 120 }}
                    >
                      Move
                    </Button>
                    <Button
                      variant="outlined"
                      startIcon={<TuneIcon />}
                      onClick={() => setModal({ action: 'adjust', part })}
                      sx={{ flex: 1, minWidth: 120 }}
                    >
                      Adjust
                    </Button>
                  </Stack>
                </CardContent>
              </Card>
            ))}
          </Stack>
        )}
      </Box>

      {/* Recent movements, last. The contents above answer "what is here now"; this answers
          "what happened here", including the photo whoever moved it left behind. Before this there
          was no operator-side ledger view at all, which is what made a movement photo write-only. */}
      <Box sx={{ mt: 4 }}>
        <Typography variant="overline" color="text.secondary">
          Recent activity
        </Typography>
        <Box sx={{ mt: 0.5 }}>
          <BinHistory entries={history} loading={historyLoading} />
        </Box>
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
          moveDestinations={moveDestinations}
          operatorId={operatorId}
          onClose={() => setModal(null)}
          onDone={reloadAll}
        />
      )}

      <OperatorReceivePartModal
        open={receiveOpen}
        companyId={companyId}
        locationId={node.id}
        locationName={node.name}
        excludePartIds={contents.map((c) => c.part_id)}
        operatorId={operatorId}
        onClose={() => setReceiveOpen(false)}
        onDone={reloadAll}
      />
    </Box>
  );
}
