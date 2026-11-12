'use client';

/**
 * The part page's Buying tab — bought parts only (plan §3.8, §3.13; criteria V1–V3, L4).
 *
 * Who the part is bought from and at what price (the approved vendor list with each vendor's price
 * sheet, the preferred star, "Use as part cost"), and what is on order for it.
 *
 * ONE REFRESH for the tab (interaction-standards §2, invariant 3): every write re-reads the list
 * and what is on order in place. A write that changes the PART ITSELF — the preferred vendor, or
 * its cost through "Use as part cost" — also calls the workspace's own refresh, so the Workspace
 * tab's identity and pricing are never left stale.
 *
 * An open price-sheet editor with changes reports itself under the key `buying`, so leaving the
 * tab asks first rather than throwing the edit away (invariant 2, the exit guard).
 */
import { useCallback, useMemo, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import CircularProgress from '@mui/material/CircularProgress';

import ApprovedVendorsCard from '@/components/parts/ApprovedVendorsCard';
import PartPurchaseHistoryCard from '@/components/parts/PartPurchaseHistoryCard';
import LoadFailedState from '@/components/common/LoadFailedState';
import { useLoad } from '@/hooks/useLoad';
import { todayLocalISODate } from '@/lib/localDate';
import { listPartVendors } from '@/utils/partVendorsAccess';
import { getOnOrderForParts } from '@/utils/vendorPoAccess';
import type { Part } from '@/types/part';

interface BuyingTabProps {
  part: Part;
  companyId: string;
  partId: string;
  /** The workspace's refresh key: a refresh started elsewhere on the page reloads this tab too. */
  refreshKey: number;
  /** The part record changed — its preferred vendor, or its cost. The workspace's refresh. */
  onPartChanged: () => void;
  /** Reports staged work (an open, changed vendor editor) to the workspace's exit guard. */
  onDirtyChange?: (key: string, dirty: boolean) => void;
}

export default function BuyingTab({ part, companyId, partId, refreshKey, onPartChanged, onDirtyChange }: BuyingTabProps) {
  const [today] = useState(() => todayLocalISODate());

  const vendors = useLoad(() => listPartVendors(partId, { today }), [partId, today, refreshKey]);
  const onOrder = useLoad(
    () => getOnOrderForParts(companyId, [partId]).then((byPart) => byPart.get(partId) ?? null),
    [companyId, partId, refreshKey],
  );
  const { refresh: refreshVendors } = vendors;
  const { refresh: refreshOnOrder } = onOrder;

  const refreshAfterWrite = useCallback(
    ({ partChanged }: { partChanged: boolean }) => {
      void refreshVendors();
      void refreshOnOrder();
      if (partChanged) onPartChanged();
    },
    [refreshVendors, refreshOnOrder, onPartChanged],
  );
  const reportDirty = useCallback((dirty: boolean) => onDirtyChange?.('buying', dirty), [onDirtyChange]);

  const list = vendors.data;
  const vendorNames = useMemo(
    () => new Map((list?.rows ?? []).map((r) => [r.vendorId, r.vendorName])),
    [list],
  );

  if (vendors.loading && !list) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
        <CircularProgress />
      </Box>
    );
  }
  if (vendors.error && !list) {
    return (
      <Card>
        <CardContent sx={{ textAlign: 'center', py: 6 }}>
          <LoadFailedState error={vendors.error} entity="this part's vendors" onRetry={() => void vendors.reload()} />
        </CardContent>
      </Card>
    );
  }
  if (!list) {
    return <Alert severity="error">This part isn&apos;t available.</Alert>;
  }

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <ApprovedVendorsCard
        companyId={companyId}
        partId={partId}
        partName={part.part_name}
        list={list}
        today={today}
        onChanged={refreshAfterWrite}
        onCostApplied={() => refreshAfterWrite({ partChanged: true })}
        onDirtyChange={reportDirty}
      />
      <PartPurchaseHistoryCard
        companyId={companyId}
        partId={partId}
        stockUnit={list.part.stockUnit}
        preferredVendorId={list.part.preferredVendorId}
        vendorNames={vendorNames}
        onOrder={onOrder.data}
        loading={onOrder.loading}
        error={onOrder.error}
        onRetry={() => void onOrder.reload()}
      />
    </Box>
  );
}
