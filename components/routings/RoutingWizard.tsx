'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import {
  Box,
  Button,
  Alert,
  CircularProgress,
  Card,
} from '@mui/material';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import SaveIcon from '@mui/icons-material/Save';
import RoutingWorkflowBuilder, { type PendingNode, type PendingEdge } from './RoutingWorkflowBuilder';
import { getRoutingForPart } from '@/utils/routingsAccess';

interface RoutingWizardProps {
  companyId: string;
  partId: string;
  mode: 'create' | 'edit';
}

/**
 * Workflow builder for creating/editing routings.
 * Goes straight to the workflow builder (operations and connections).
 * Routing name is auto-generated as "Routing - {part_number}".
 */
export default function RoutingWizard({ companyId, partId, mode }: RoutingWizardProps) {
  const router = useRouter();
  const isEditMode = mode === 'edit';

  // Workflow state
  const [pendingNodes, setPendingNodes] = useState<PendingNode[]>([]);
  const [pendingEdges, setPendingEdges] = useState<PendingEdge[]>([]);

  // For edit mode: track original IDs to detect deletions
  const [originalNodeIds, setOriginalNodeIds] = useState<Set<string>>(new Set());
  const [originalEdgeIds, setOriginalEdgeIds] = useState<Set<string>>(new Set());

  // The routing ID discovered in edit mode
  const [routingId, setRoutingId] = useState<string | null>(null);

  // Loading and error state
  const [loading, setLoading] = useState(isEditMode);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load existing routing data (edit mode) by looking up routing for the part
  useEffect(() => {
    if (!isEditMode) return;

    async function loadRouting() {
      try {
        const data = await getRoutingForPart(partId);
        if (data) {
          setRoutingId(data.id);

          // Convert existing nodes to pending format
          const nodes: PendingNode[] = data.nodes.map((n) => ({
            tempId: n.id, // Use real ID as tempId for existing nodes
            operationTypeId: n.operation_type_id,
            operationName: n.operation_type?.name || 'Unknown',
            resourceGroupName: n.operation_type?.resource_group?.name || null,
            laborRate: n.operation_type?.labor_rate || null,
            runTimePerUnit: n.run_time_per_unit,
            instructions: n.instructions,
            materials: n.materials || [],
          }));
          setPendingNodes(nodes);

          // Convert existing edges to pending format
          const edges: PendingEdge[] = data.edges.map((e) => ({
            tempId: e.id, // Use real ID as tempId for existing edges
            sourceNodeId: e.source_node_id,
            targetNodeId: e.target_node_id,
          }));
          setPendingEdges(edges);

          // Track original IDs
          setOriginalNodeIds(new Set(data.nodes.map((n) => n.id)));
          setOriginalEdgeIds(new Set(data.edges.map((e) => e.id)));
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

  // Validate workflow - must have at least one operation
  const validateWorkflow = (): boolean => {
    if (pendingNodes.length === 0) {
      setError('At least one operation is required. Add an operation to the workflow before saving.');
      return false;
    }
    return true;
  };

  // Handle cancel
  const handleCancel = () => {
    router.back();
  };

  // Handle save
  const handleSave = async () => {
    setError(null);

    if (!validateWorkflow()) return;

    setSaving(true);
    try {
      const { saveRoutingWithGraph } = await import('@/utils/routingsAccess');
      await saveRoutingWithGraph(
        companyId,
        partId,
        routingId,
        pendingNodes,
        pendingEdges,
        isEditMode ? originalNodeIds : new Set(),
        isEditMode ? originalEdgeIds : new Set()
      );

      // Navigate to the part detail page
      router.push(`/dashboard/${companyId}/parts/${partId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save routing');
    } finally {
      setSaving(false);
    }
  };

  // Handle pending nodes change from workflow builder
  const handlePendingNodesChange = useCallback((nodes: PendingNode[]) => {
    setPendingNodes(nodes);
  }, []);

  // Handle pending edges change from workflow builder
  const handlePendingEdgesChange = useCallback((edges: PendingEdge[]) => {
    setPendingEdges(edges);
  }, []);

  if (loading) {
    return (
      <Box
        sx={{
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          height: 400,
        }}
      >
        <CircularProgress />
      </Box>
    );
  }

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 120px)' }}>
      {/* Header with Back button and action buttons */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 2 }}>
        <Button
          startIcon={<ArrowBackIcon />}
          onClick={handleCancel}
          sx={{ color: 'text.secondary' }}
        >
          Back
        </Button>

        {/* Spacer */}
        <Box sx={{ flex: 1 }} />

        {/* Action buttons */}
        <Button variant="outlined" onClick={handleCancel} disabled={saving}>
          Cancel
        </Button>

        <Button
          variant="contained"
          onClick={handleSave}
          disabled={saving}
          startIcon={saving ? <CircularProgress size={16} /> : <SaveIcon />}
        >
          {saving ? 'Saving...' : 'Save Routing'}
        </Button>
      </Box>

      {/* Error Alert */}
      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      {/* Workflow Builder */}
      <Box sx={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <Card
          elevation={2}
          sx={{
            flex: 1,
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            '&:hover': { transform: 'none' }  // Disable hover lift for workspace
          }}
        >
          <RoutingWorkflowBuilder
            routingId={routingId || ''}
            companyId={companyId}
            mode="memory"
            pendingNodes={pendingNodes}
            pendingEdges={pendingEdges}
            onPendingNodesChange={handlePendingNodesChange}
            onPendingEdgesChange={handlePendingEdgesChange}
          />
        </Card>
      </Box>
    </Box>
  );
}
