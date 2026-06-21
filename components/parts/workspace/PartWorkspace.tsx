'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import { useParams, useRouter, usePathname, useSearchParams } from 'next/navigation';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import Alert from '@mui/material/Alert';
import CircularProgress from '@mui/material/CircularProgress';
import Divider from '@mui/material/Divider';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import MuiLink from '@mui/material/Link';
import NextLink from 'next/link';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import DeleteIcon from '@mui/icons-material/Delete';

import {
  getPartWithRelations,
  deletePart,
  getPartUnitConversions,
  getPartNamesByIds,
  getPartCostExplain,
} from '@/utils/partsAccess';
import { parseBackChain } from '@/lib/partNavStack';
import type { Part, PartFormData, PartUnitConversion } from '@/types/part';
import type { InventoryTransactionType } from '@/types/partTransaction';
import PartTransactionModal from '@/components/parts/PartTransactionModal';
import { usePageTitle } from '@/components/layout/PageTitleProvider';

import PartIdentitySection from './PartIdentitySection';
import PartHeaderBar, { type PartTabDescriptor } from './PartHeaderBar';
import { getPartSetupStatus, type PartSetupStatus } from './partSetupStatus';
import WorkspaceTab from './tabs/WorkspaceTab';
import InventoryTab from './tabs/InventoryTab';
import UsageTab from './tabs/UsageTab';
import HistoryTab from './tabs/HistoryTab';

const formatDate = (s: string | null): string => {
  if (!s) return '—';
  return new Date(s).toLocaleString();
};

/**
 * The part workspace: a maturity-adaptive record that leads with the
 * type-specific setup (Workspace tab) and surfaces accumulating record data
 * (Inventory, Usage) as deep-linkable tabs under a sticky identity header.
 *
 * This is the orchestrator — it owns the data fetch, refresh keys, breadcrumb
 * chain, completeness/priceability signal, the transaction + delete modals,
 * and the `?tab=` routing. The individual tab panels are presentational and
 * reuse the existing part panels verbatim.
 */
export default function PartWorkspace({
  mode = 'existing',
}: {
  mode?: 'create' | 'existing';
}) {
  const params = useParams();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const companyId = params.companyId as string;
  // Undefined in create mode (/parts/new has no [partId] segment).
  const partId = params.partId as string | undefined;
  const { setTitle } = usePageTitle();

  // Breadcrumb root reflects where the user entered from (Parts vs Inventory).
  const partsListHref = useMemo(() => {
    const from = searchParams.get('from');
    if (from === 'inventory') return `/dashboard/${companyId}/inventory`;
    return `/dashboard/${companyId}/parts`;
  }, [companyId, searchParams]);

  const partsListLabel = useMemo(
    () => (searchParams.get('from') === 'inventory' ? 'Inventory' : 'Parts'),
    [searchParams],
  );

  // BOM drill-down chain from `?back=id1,id2,id3` (oldest → most recent).
  const currentChain = useMemo(() => parseBackChain(searchParams), [searchParams]);

  const [chainNames, setChainNames] = useState<Map<string, string>>(new Map());
  useEffect(() => {
    // Empty chain → nothing to look up; stale names are never rendered (the
    // breadcrumb only maps over currentChain), so no synchronous reset needed.
    if (currentChain.length === 0) return;
    let cancelled = false;
    getPartNamesByIds(currentChain)
      .then((map) => {
        if (!cancelled) setChainNames(map);
      })
      .catch((err) => {
        if (!cancelled) console.warn('Failed to load breadcrumb part names:', err);
      });
    return () => {
      cancelled = true;
    };
  }, [currentChain]);

  const [part, setPart] = useState<Part | null>(null);
  const [unitConversions, setUnitConversions] = useState<PartUnitConversion[]>([]);

  const [loading, setLoading] = useState(mode === 'existing');
  const [actionLoading, setActionLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);

  // Bumped after every routing/BOM save so cost breakdown + pricing tiers
  // (and the priceability signal) reload.
  const [refreshKey, setRefreshKey] = useState(0);
  // Bumped after each stock transaction so the history table reloads.
  const [transactionsRefreshKey, setTransactionsRefreshKey] = useState(0);

  const [txnModalOpen, setTxnModalOpen] = useState(false);
  const [txnModalType, setTxnModalType] = useState<InventoryTransactionType>('addition');

  // Priceability — the same compute_part_cost machinery the parts list uses,
  // so the completeness chip can't disagree with the list ✓/⚠ column. null
  // while loading. Recomputed when refreshKey bumps (routing/pricing changed).
  const [isPriceable, setIsPriceable] = useState<boolean | null>(null);

  /**
   * Fetch the part + its side-loads. `silent` skips the loading flag so a
   * post-mutation refetch swaps data in place without spinnering the page.
   */
  const fetchPart = useCallback(
    async (silent = false) => {
      if (!partId) return;
      try {
        if (!silent) setLoading(true);
        const data = await getPartWithRelations(partId);
        setPart(data);
        setError(null);

        if (data) {
          try {
            const conversions = await getPartUnitConversions(partId);
            setUnitConversions(conversions);
          } catch (err) {
            console.warn('Failed to load unit conversions:', err);
            setUnitConversions([]);
          }
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load part');
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [partId],
  );

  useEffect(() => {
    fetchPart();
  }, [fetchPart]);

  useEffect(() => {
    if (!partId) return;
    let cancelled = false;
    getPartCostExplain(partId, 1)
      .then(({ unit_cost }) => {
        if (!cancelled) setIsPriceable(unit_cost !== null);
      })
      .catch((err) => {
        // Non-fatal — the chip just stays hidden rather than guessing.
        if (!cancelled) {
          console.warn('Failed to compute part cost:', err);
          setIsPriceable(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [partId, refreshKey]);

  // Surface the part number in the global app bar (always visible while
  // scrolling) instead of a second in-page header. Cleared on unmount so other
  // pages fall back to their pathname title.
  useEffect(() => {
    if (mode === 'create' || !part) return;
    setTitle(`Part Details — ${part.part_name}`);
    return () => setTitle(null);
  }, [mode, part, setTitle]);

  const refreshAfterMutation = useCallback(async () => {
    await fetchPart(true);
    setRefreshKey((k) => k + 1);
  }, [fetchPart]);

  const handleDelete = async () => {
    if (!partId) return;
    setActionLoading(true);
    try {
      await deletePart(partId);
      router.push(partsListHref);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete part');
      setActionLoading(false);
      setDeleteDialogOpen(false);
    }
  };

  const openTxnModal = useCallback((type: InventoryTransactionType) => {
    setTxnModalType(type);
    setTxnModalOpen(true);
  }, []);

  const handleTxnSuccess = async () => {
    await fetchPart(true);
    setTransactionsRefreshKey((k) => k + 1);
  };

  // --- Tabs (URL-addressable via ?tab=) ---
  const visibleTabs = useMemo<PartTabDescriptor[]>(() => {
    const tabs: PartTabDescriptor[] = [{ slug: 'workspace', label: 'Workspace' }];
    if (part?.is_stocked) tabs.push({ slug: 'inventory', label: 'Inventory' });
    tabs.push({ slug: 'usage', label: 'Usage' });
    tabs.push({ slug: 'history', label: 'Notes & Activity' });
    return tabs;
  }, [part?.is_stocked]);

  const tabParam = searchParams.get('tab') ?? 'workspace';
  const activeTab = visibleTabs.some((t) => t.slug === tabParam) ? tabParam : 'workspace';

  const handleTabChange = useCallback(
    (slug: string) => {
      const next = new URLSearchParams(searchParams.toString());
      // Keep the default tab out of the URL for clean links.
      if (slug === 'workspace') next.delete('tab');
      else next.set('tab', slug);
      const qs = next.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [router, pathname, searchParams],
  );

  const setupStatus = useMemo<PartSetupStatus | null>(() => {
    if (!part || isPriceable === null) return null;
    return getPartSetupStatus(part, isPriceable);
  }, [part, isPriceable]);

  // --- Create mode: the same identity surface as the saved view, gated to
  // create the row. On create we redirect into the live page (preserving the
  // quote return + list-origin context) — so the create view IS the saved view.
  if (mode === 'create') {
    const createDefaults: Partial<PartFormData> = {};
    if (searchParams.get('source') === 'bought') createDefaults.source = 'bought';
    if (searchParams.get('stocked') === '1') createDefaults.is_stocked = true;

    const handleCreated = (created: Part) => {
      const next = new URLSearchParams();
      const from = searchParams.get('from');
      if (from) next.set('from', from);
      const returnTo = searchParams.get('returnTo');
      if (returnTo) next.set('returnTo', returnTo);
      const qs = next.toString();
      router.replace(`/dashboard/${companyId}/parts/${created.id}${qs ? `?${qs}` : ''}`);
    };

    return (
      <Box sx={{ maxWidth: 900, mx: 'auto' }}>
        <Box sx={{ mb: 3 }}>
          <MuiLink
            component={NextLink}
            href={partsListHref}
            underline="hover"
            color="text.secondary"
            sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5 }}
          >
            <ArrowBackIcon fontSize="small" /> Back to {partsListLabel}
          </MuiLink>
        </Box>
        <PartIdentitySection
          mode="create"
          companyId={companyId}
          initialDefaults={createDefaults}
          onCreated={handleCreated}
        />
      </Box>
    );
  }

  // --- Existing mode below — the [partId] route guarantees a part id. ---
  if (!partId) return null;

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: 400 }}>
        <CircularProgress />
      </Box>
    );
  }

  if (!part) {
    return (
      <Box>
        <Alert severity="error">Part not found</Alert>
      </Box>
    );
  }

  const quotesCount = part.quotes_count ?? 0;
  const jobsCount = part.jobs_count ?? 0;
  const bomParentsCount = part.bom_parents_count ?? 0;

  // Delete is gated by anything that references this part. The DB also blocks
  // via FK, but disabling up-front beats waiting for a raw error.
  const hasReferences = quotesCount > 0 || jobsCount > 0 || bomParentsCount > 0;

  return (
    <Box>
      <PartHeaderBar
        companyId={companyId}
        partName={part.part_name}
        partsListHref={partsListHref}
        partsListLabel={partsListLabel}
        currentChain={currentChain}
        chainNames={chainNames}
        tabs={visibleTabs}
        activeTab={activeTab}
        onTabChange={handleTabChange}
        onDelete={() => setDeleteDialogOpen(true)}
        hasReferences={hasReferences}
        actionLoading={actionLoading}
      />

      {error && (
        <Alert severity="error" sx={{ mb: 3 }} onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      {/* Quote create→return: came here to make a part for a quote in progress. */}
      {searchParams.get('returnTo') && (
        <Alert
          severity="info"
          sx={{ mb: 3 }}
          action={
            <Button
              color="inherit"
              size="small"
              onClick={() => {
                const returnTo = searchParams.get('returnTo');
                if (!returnTo) return;
                const sep = returnTo.includes('?') ? '&' : '?';
                router.push(`${returnTo}${sep}newPartId=${partId}`);
              }}
            >
              Return to quote
            </Button>
          }
        >
          Set this part up (or add an estimate price on the quote), then return to your quote.
        </Alert>
      )}

      {activeTab === 'workspace' && (
        <WorkspaceTab
          part={part}
          companyId={companyId}
          partId={partId}
          refreshKey={refreshKey}
          currentChain={currentChain}
          refreshAfterMutation={refreshAfterMutation}
          setupStatus={setupStatus}
        />
      )}

      {activeTab === 'inventory' && part.is_stocked && (
        <InventoryTab
          part={part}
          partId={partId}
          companyId={companyId}
          transactionsRefreshKey={transactionsRefreshKey}
          openTxnModal={openTxnModal}
          onConversionsChanged={setUnitConversions}
        />
      )}

      {activeTab === 'usage' && (
        <UsageTab part={part} partId={partId} companyId={companyId} currentChain={currentChain} />
      )}

      {activeTab === 'history' && <HistoryTab partId={partId} companyId={companyId} />}

      {/* Footer metadata strip — always visible below the active tab. */}
      <Box sx={{ mt: 4 }}>
        <Divider sx={{ mb: 2 }} />
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center' }}>
          <Box>
            <Typography variant="body2" color="text.secondary">
              Created
            </Typography>
            <Typography variant="body2">{formatDate(part.created_at)}</Typography>
          </Box>
          <Box>
            <Typography variant="body2" color="text.secondary">
              Updated
            </Typography>
            <Typography variant="body2">{formatDate(part.updated_at)}</Typography>
          </Box>
          {part.legacy_id && (
            <Box>
              <Typography variant="body2" color="text.secondary">
                Legacy ID
              </Typography>
              <Typography variant="body2" fontFamily="monospace">
                {part.legacy_id}
              </Typography>
            </Box>
          )}
        </Box>
      </Box>

      {/* Stock transaction modal (owned here; triggered from the Inventory tab) */}
      {part.is_stocked && (
        <PartTransactionModal
          open={txnModalOpen}
          onClose={() => setTxnModalOpen(false)}
          part={part}
          unitConversions={unitConversions}
          defaultType={txnModalType}
          onSuccess={handleTxnSuccess}
        />
      )}

      {/* Delete confirmation */}
      <Dialog open={deleteDialogOpen} onClose={() => setDeleteDialogOpen(false)}>
        <DialogTitle>Delete Part?</DialogTitle>
        <DialogContent>
          <Typography>
            Are you sure you want to delete <strong>{part.part_name}</strong>? This action cannot be
            undone.
          </Typography>
          {hasReferences && (
            <Alert severity="warning" sx={{ mt: 2 }}>
              This part is referenced by{' '}
              {[
                quotesCount > 0 ? `${quotesCount} quote${quotesCount === 1 ? '' : 's'}` : null,
                jobsCount > 0 ? `${jobsCount} job${jobsCount === 1 ? '' : 's'}` : null,
                bomParentsCount > 0
                  ? `${bomParentsCount} other part${bomParentsCount === 1 ? '' : 's'}' BOM${bomParentsCount === 1 ? '' : 's'}`
                  : null,
              ]
                .filter(Boolean)
                .join(', ')}
              . Remove those references before deleting.
            </Alert>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteDialogOpen(false)} disabled={actionLoading}>
            Cancel
          </Button>
          <Button
            onClick={handleDelete}
            color="error"
            variant="contained"
            disabled={actionLoading || hasReferences}
            startIcon={actionLoading ? <CircularProgress size={16} color="inherit" /> : <DeleteIcon />}
          >
            {actionLoading ? 'Deleting...' : 'Delete'}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
