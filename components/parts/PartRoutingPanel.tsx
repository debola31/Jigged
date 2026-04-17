'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Box,
  Card,
  CardContent,
  Grid,
  CircularProgress,
  Alert,
  Typography,
  Fade,
} from '@mui/material';
import CloudDoneOutlinedIcon from '@mui/icons-material/CloudDoneOutlined';
import CloudSyncOutlinedIcon from '@mui/icons-material/CloudSyncOutlined';
import RoutingOperationsList from '@/components/routings/RoutingOperationsList';
import RoutingMaterialsList from '@/components/routings/RoutingMaterialsList';
import type { OperationRowData } from '@/components/routings/RoutingOperationRow';
import type { MaterialRowData } from '@/components/routings/RoutingMaterialRow';
import {
  getRoutingForPart,
  saveRoutingWithOperationsAndMaterials,
} from '@/utils/routingsAccess';

interface PartRoutingPanelProps {
  companyId: string;
  partId: string;
}

/**
 * Side-by-side Operations + Materials cards embedded in the part detail page.
 * Auto-saves to the database on every change — no "Save Routing" button.
 *
 *  - First add (when the part has no routing yet) implicitly creates the
 *    routing record before persisting the new node/material.
 *  - Each user action (modal save, reorder arrow, delete) writes the full
 *    routing state via saveRoutingWithOperationsAndMaterials, then refetches
 *    so temp IDs become real IDs and the next change diffs correctly.
 *  - A subtle indicator in the header shows save state.
 */
export default function PartRoutingPanel({ companyId, partId }: PartRoutingPanelProps) {
  const [ops, setOps] = useState<OperationRowData[]>([]);
  const [mats, setMats] = useState<MaterialRowData[]>([]);
  const [routingId, setRoutingId] = useState<string | null>(null);
  const [originalNodeIds, setOriginalNodeIds] = useState<Set<string>>(new Set());
  const [originalMaterialIds, setOriginalMaterialIds] = useState<Set<string>>(new Set());

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
          setOps(
            data.nodes.map((n) => ({
              tempId: n.id,
              operationTypeId: n.operation_type_id,
              operationName: n.operation_type?.name || 'Unknown',
              laborRate: n.operation_type?.labor_rate || null,
              runTimePerUnit: n.run_time_per_unit,
              setupTime: n.setup_time || 0,
              instructions: n.instructions,
            }))
          );
          setMats(
            data.materials.map((m) => ({
              tempId: m.id,
              inventoryItemId: m.inventory_item_id,
              itemName: m.inventory_item?.name || 'Unknown item',
              quantity: m.quantity,
              unit: m.unit,
            }))
          );
          setOriginalNodeIds(new Set(data.nodes.map((n) => n.id)));
          setOriginalMaterialIds(new Set(data.materials.map((m) => m.id)));
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
   * Persist the given operations + materials to the database, then refetch
   * so temp IDs become real and subsequent diffs are correct. Calls are
   * serialized via a ref-held promise queue.
   */
  const persist = useCallback(
    (nextOps: OperationRowData[], nextMats: MaterialRowData[]) => {
      const job = queueRef.current.then(async () => {
        setSaving(true);
        setError(null);
        try {
          const routing = await saveRoutingWithOperationsAndMaterials(
            companyId,
            partId,
            routingId,
            nextOps.map((o) => ({
              tempId: o.tempId,
              operationTypeId: o.operationTypeId,
              operationName: o.operationName,
              laborRate: o.laborRate,
              runTimePerUnit: o.runTimePerUnit,
              setupTime: o.setupTime,
              instructions: o.instructions,
            })),
            nextMats.map((m) => ({
              tempId: m.tempId,
              inventoryItemId: m.inventoryItemId,
              itemName: m.itemName,
              quantity: m.quantity,
              unit: m.unit,
            })),
            originalNodeIds,
            originalMaterialIds
          );
          setRoutingId(routing.id);

          // Refetch so any newly-created rows have their real DB ids.
          const fresh = await getRoutingForPart(partId);
          if (fresh) {
            setOps(
              fresh.nodes.map((n) => ({
                tempId: n.id,
                operationTypeId: n.operation_type_id,
                operationName: n.operation_type?.name || 'Unknown',
                laborRate: n.operation_type?.labor_rate || null,
                runTimePerUnit: n.run_time_per_unit,
                setupTime: n.setup_time || 0,
                instructions: n.instructions,
              }))
            );
            setMats(
              fresh.materials.map((m) => ({
                tempId: m.id,
                inventoryItemId: m.inventory_item_id,
                itemName: m.inventory_item?.name || 'Unknown item',
                quantity: m.quantity,
                unit: m.unit,
              }))
            );
            setOriginalNodeIds(new Set(fresh.nodes.map((n) => n.id)));
            setOriginalMaterialIds(new Set(fresh.materials.map((m) => m.id)));
          }
          setSavedAt(new Date());
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
    [companyId, partId, routingId, originalNodeIds, originalMaterialIds]
  );

  const handleOpsChange = useCallback(
    (next: OperationRowData[]) => {
      setOps(next);
      persist(next, mats);
    },
    [mats, persist]
  );

  const handleMatsChange = useCallback(
    (next: MaterialRowData[]) => {
      setMats(next);
      persist(ops, next);
    },
    [ops, persist]
  );

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
        <CircularProgress />
      </Box>
    );
  }

  return (
    <Box sx={{ position: 'relative' }}>
      {/* Save indicator floats over the top-right corner so it never reserves
          layout space — the Operations / Materials card titles speak for the
          section, no header needed. */}
      <Box
        sx={{
          position: 'absolute',
          top: -22,
          right: 0,
          display: 'flex',
          alignItems: 'center',
          color: 'text.secondary',
          pointerEvents: 'none',
        }}
      >
        {saving ? (
          <Fade in>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
              <CloudSyncOutlinedIcon fontSize="small" />
              <Typography variant="caption">Saving…</Typography>
            </Box>
          </Fade>
        ) : savedAt ? (
          <Fade in>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
              <CloudDoneOutlinedIcon fontSize="small" color="success" />
              <Typography variant="caption">All changes saved</Typography>
            </Box>
          </Fade>
        ) : null}
      </Box>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      <Grid container spacing={3}>
        <Grid size={{ xs: 12, md: 6 }}>
          <Card elevation={2}>
            <CardContent>
              <RoutingOperationsList
                rows={ops}
                onChange={handleOpsChange}
                companyId={companyId}
                disabled={saving}
              />
            </CardContent>
          </Card>
        </Grid>
        <Grid size={{ xs: 12, md: 6 }}>
          <Card elevation={2}>
            <CardContent>
              <RoutingMaterialsList
                rows={mats}
                onChange={handleMatsChange}
                companyId={companyId}
                disabled={saving}
              />
            </CardContent>
          </Card>
        </Grid>
      </Grid>
    </Box>
  );
}
