'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import {
  Box,
  Button,
  Alert,
  CircularProgress,
} from '@mui/material';
import useMediaQuery from '@mui/material/useMediaQuery';
import { useTheme } from '@mui/material/styles';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import SaveIcon from '@mui/icons-material/Save';
import RoutingBuilder from './RoutingBuilder';
import type { OperationRowData } from './RoutingOperationRow';
import type { MaterialRowData } from './RoutingMaterialRow';
import { getRoutingForPart } from '@/utils/routingsAccess';

interface RoutingWizardProps {
  companyId: string;
  partId: string;
  mode: 'create' | 'edit';
  returnTo?: string;
}

/**
 * Linear routing builder wizard.
 *  - Operations + Materials are edited in-memory and saved atomically.
 *  - Routing name is auto-generated as "Routing - {part_name}".
 */
export default function RoutingWizard({ companyId, partId, mode, returnTo }: RoutingWizardProps) {
  const router = useRouter();
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('sm'));
  const isEditMode = mode === 'edit';

  // In-memory state
  const [operations, setOperations] = useState<OperationRowData[]>([]);
  const [materials, setMaterials] = useState<MaterialRowData[]>([]);

  // Track which IDs existed when we loaded (used to compute deletions on save)
  const [originalNodeIds, setOriginalNodeIds] = useState<Set<string>>(new Set());
  const [originalMaterialIds, setOriginalMaterialIds] = useState<Set<string>>(new Set());

  const [routingId, setRoutingId] = useState<string | null>(null);

  const [loading, setLoading] = useState(isEditMode);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isEditMode) return;

    async function loadRouting() {
      try {
        const data = await getRoutingForPart(partId);
        if (data) {
          setRoutingId(data.id);

          const opsRows: OperationRowData[] = data.nodes.map((n) => ({
            tempId: n.id,
            operationTypeId: n.operation_type_id,
            operationName: n.operation_type?.name || 'Unknown',
            resourceGroupName: n.operation_type?.resource_group?.name || null,
            laborRate: n.operation_type?.labor_rate || null,
            runTimePerUnit: n.run_time_per_unit,
            setupTime: n.setup_time || 0,
            instructions: n.instructions,
          }));
          setOperations(opsRows);

          const matRows: MaterialRowData[] = data.materials.map((m) => ({
            tempId: m.id,
            inventoryItemId: m.inventory_item_id,
            itemName: m.inventory_item?.name || 'Unknown item',
            quantity: m.quantity,
            unit: m.unit,
          }));
          setMaterials(matRows);

          setOriginalNodeIds(new Set(data.nodes.map((n) => n.id)));
          setOriginalMaterialIds(new Set(data.materials.map((m) => m.id)));
        }
      } catch (err) {
        console.error('Failed to load routing:', err);
        setError('Failed to load routing data');
      } finally {
        setLoading(false);
      }
    }
    loadRouting();
  }, [isEditMode, partId]);

  const validate = (): boolean => {
    if (operations.length === 0) {
      setError('At least one operation is required.');
      return false;
    }
    for (const op of operations) {
      if (!op.operationTypeId) {
        setError('Every operation must have an operation type selected.');
        return false;
      }
    }
    for (const mat of materials) {
      if (!mat.inventoryItemId) {
        setError('Every material must have an inventory item selected.');
        return false;
      }
      if (!(mat.quantity > 0)) {
        setError('Every material must have a quantity greater than 0.');
        return false;
      }
      if (!mat.unit) {
        setError('Every material must have a unit.');
        return false;
      }
    }
    return true;
  };

  const handleCancel = () => {
    if (returnTo) {
      router.push(returnTo);
    } else {
      router.back();
    }
  };

  const handleSave = async () => {
    setError(null);
    if (!validate()) return;

    setSaving(true);
    try {
      const { saveRoutingWithOperationsAndMaterials } = await import('@/utils/routingsAccess');
      await saveRoutingWithOperationsAndMaterials(
        companyId,
        partId,
        routingId,
        operations.map((o) => ({
          tempId: o.tempId,
          operationTypeId: o.operationTypeId,
          operationName: o.operationName,
          resourceGroupName: o.resourceGroupName,
          laborRate: o.laborRate,
          runTimePerUnit: o.runTimePerUnit,
          setupTime: o.setupTime,
          instructions: o.instructions,
        })),
        materials.map((m) => ({
          tempId: m.tempId,
          inventoryItemId: m.inventoryItemId,
          itemName: m.itemName,
          quantity: m.quantity,
          unit: m.unit,
        })),
        isEditMode ? originalNodeIds : new Set(),
        isEditMode ? originalMaterialIds : new Set()
      );

      if (returnTo) {
        router.push(returnTo);
      } else {
        router.push(`/dashboard/${companyId}/parts/${partId}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save routing');
    } finally {
      setSaving(false);
    }
  };

  const handleOperationsChange = useCallback((next: OperationRowData[]) => {
    setOperations(next);
  }, []);
  const handleMaterialsChange = useCallback((next: MaterialRowData[]) => {
    setMaterials(next);
  }, []);

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: 400 }}>
        <CircularProgress />
      </Box>
    );
  }

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
        <Button
          startIcon={<ArrowBackIcon />}
          onClick={handleCancel}
          sx={{ color: 'text.secondary' }}
        >
          Back
        </Button>
        <Box sx={{ flex: 1 }} />
        {!isMobile && (
          <Button variant="outlined" onClick={handleCancel} disabled={saving}>
            Cancel
          </Button>
        )}
        <Button
          variant="contained"
          onClick={handleSave}
          disabled={saving}
          startIcon={saving ? <CircularProgress size={16} /> : <SaveIcon />}
        >
          {saving ? 'Saving…' : isMobile ? 'Save' : 'Save Routing'}
        </Button>
      </Box>

      {returnTo && (
        <Alert severity="info">
          Create a routing for this part to continue with job creation. You&apos;ll return to the{' '}
          {returnTo.includes('/quotes/') ? 'quote' : 'job form'} after saving.
        </Alert>
      )}

      {error && (
        <Alert severity="error" onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      <RoutingBuilder
        companyId={companyId}
        operations={operations}
        materials={materials}
        onOperationsChange={handleOperationsChange}
        onMaterialsChange={handleMaterialsChange}
        disabled={saving}
      />
    </Box>
  );
}
