'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { Box, CircularProgress, Alert } from '@mui/material';
import SaveStatus from '@/components/common/SaveStatus';
import RoutingOperationsList from '@/components/routings/RoutingOperationsList';
import type { OperationRowData } from '@/components/routings/RoutingOperationRow';
import { getRoutingForPart, saveRoutingWithOperations } from '@/utils/routingsAccess';
import type { RoutingOperationWithWorkCenter } from '@/types/routings';

interface PartRoutingPanelProps {
  companyId: string;
  partId: string;
  /**
   * Fired after each successful save so the parent page can refresh siblings
   * (PartCostBreakdown, PartPricingTiers) that derive numbers from the routing.
   */
  onRoutingSaved?: () => void;
}

/**
 * Inline auto-save routing editor embedded in the part detail page.
 *
 *  - Materials are no longer routing-attached; BOM lives on the part itself
 *    (`parts_bom`) and is edited by `PartBomPanel` (PR 3).
 *  - First add (when the part has no routing yet) implicitly creates the
 *    routing record before persisting the new operation.
 *  - Each user action (modal save, reorder arrow, delete) writes the full
 *    operations list via `saveRoutingWithOperations`, then refetches so temp
 *    IDs become real IDs and the next change diffs correctly.
 *  - A subtle indicator in the header shows save state.
 */
function rowFromOperation(op: RoutingOperationWithWorkCenter): OperationRowData {
  return {
    tempId: op.id,
    workCenterId: op.work_center_id,
    workCenterName: op.work_center?.name ?? 'Unknown work center',
    workCenterKind: op.work_center?.kind ?? 'internal',
    vendorName: op.work_center?.vendor?.name ?? null,
    setupMinutes: op.setup_minutes,
    cycleMinutesPerUnit: op.cycle_minutes_per_unit,
    laborRateOverride: op.labor_rate_override,
    workCenterLaborRate: op.work_center?.labor_rate ?? null,
    externalUnitPrice: op.external_unit_price,
    instructions: op.instructions,
  };
}

export default function PartRoutingPanel({
  companyId,
  partId,
  onRoutingSaved,
}: PartRoutingPanelProps) {
  const [ops, setOps] = useState<OperationRowData[]>([]);
  const [routingId, setRoutingId] = useState<string | null>(null);
  const [originalOpIds, setOriginalOpIds] = useState<Set<string>>(new Set());

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Serialize persists so two rapid changes don't race.
  const queueRef = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getRoutingForPart(partId)
      .then((data) => {
        if (cancelled) return;
        if (data) {
          setRoutingId(data.id);
          setOps(data.operations.map(rowFromOperation));
          setOriginalOpIds(new Set(data.operations.map((op) => op.id)));
        }
      })
      .catch((err) => {
        if (cancelled) return;
        console.error('Failed to load routing:', err);
        setError('Failed to load routing data.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [partId]);

  /**
   * Persist the given operations to the database, then refetch so temp IDs
   * become real and subsequent diffs are correct. Calls are serialized via
   * a ref-held promise queue.
   */
  const persist = useCallback(
    (nextOps: OperationRowData[]) => {
      const job = queueRef.current.then(async () => {
        setSaving(true);
        setError(null);
        try {
          const routing = await saveRoutingWithOperations(
            companyId,
            partId,
            routingId,
            nextOps.map((o) => ({
              tempId: o.tempId,
              workCenterId: o.workCenterId,
              workCenterName: o.workCenterName,
              workCenterKind: o.workCenterKind,
              setupMinutes: o.setupMinutes,
              cycleMinutesPerUnit: o.cycleMinutesPerUnit,
              laborRateOverride: o.laborRateOverride,
              externalUnitPrice: o.externalUnitPrice,
              instructions: o.instructions,
            })),
            originalOpIds,
          );
          setRoutingId(routing.id);

          // Refetch so any newly-created rows have their real DB ids.
          const fresh = await getRoutingForPart(partId);
          if (fresh) {
            setOps(fresh.operations.map(rowFromOperation));
            setOriginalOpIds(new Set(fresh.operations.map((op) => op.id)));
          }
          setSavedAt(new Date());
          onRoutingSaved?.();
        } catch (err) {
          console.error('Failed to save routing:', err);
          setError(err instanceof Error ? err.message : 'Failed to save routing');
        } finally {
          setSaving(false);
        }
      });
      // Swallow rejections in the chain so one error doesn't poison the queue.
      queueRef.current = job.catch(() => undefined);
    },
    [companyId, partId, routingId, originalOpIds, onRoutingSaved],
  );

  const handleOpsChange = useCallback(
    (next: OperationRowData[]) => {
      setOps(next);
      persist(next);
    },
    [persist],
  );

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
        <CircularProgress />
      </Box>
    );
  }

  return (
    <Box>
      {/* Shared auto-save indicator (consistent across the part page). */}
      <Box sx={{ display: 'flex', justifyContent: 'flex-end', mb: 1 }}>
        <SaveStatus
          state={saving ? 'saving' : savedAt ? 'saved' : 'idle'}
          savedLabel="All changes saved"
        />
      </Box>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      <RoutingOperationsList
        rows={ops}
        onChange={handleOpsChange}
        companyId={companyId}
        disabled={saving}
      />
    </Box>
  );
}
