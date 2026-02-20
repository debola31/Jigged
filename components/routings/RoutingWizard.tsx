'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import {
  Box,
  Button,
  TextField,
  Typography,
  Alert,
  CircularProgress,
  Card,
  CardContent,
  FormControlLabel,
  Checkbox,
} from '@mui/material';
import Grid from '@mui/material/Grid';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import ArrowForwardIcon from '@mui/icons-material/ArrowForward';
import SaveIcon from '@mui/icons-material/Save';
import SearchableSelect, { type SelectOption } from '@/components/common/SearchableSelect';
import WizardStepIndicator from './WizardStepIndicator';
import RoutingWorkflowBuilder, { type PendingNode, type PendingEdge } from './RoutingWorkflowBuilder';
import {
  type RoutingFormData,
  type RoutingWithGraph,
  EMPTY_ROUTING_FORM,
  routingToFormData,
} from '@/types/routings';
import {
  getRoutingWithGraph,
  checkRoutingNameExists,
} from '@/utils/routingsAccess';
import { getAllParts } from '@/utils/partsAccess';
import type { Part } from '@/types/part';

const WIZARD_STEPS = ['Routing Information', 'Build Workflow'];

interface RoutingWizardProps {
  companyId: string;
  routingId?: string; // If provided, edit mode; otherwise create mode
  initialPartId?: string; // Pre-fill part selection (e.g., from quote conversion flow)
}

/**
 * Two-step wizard for creating/editing routings.
 * Step 1: Routing Information (name, part, description)
 * Step 2: Build Workflow (operations and connections)
 */
export default function RoutingWizard({ companyId, routingId, initialPartId }: RoutingWizardProps) {
  const router = useRouter();
  const isEditMode = !!routingId;

  // Wizard state
  const [currentStep, setCurrentStep] = useState(0);

  // Form state (Step 1) - initialize with initialPartId if provided
  const [formData, setFormData] = useState<RoutingFormData>(() => ({
    ...EMPTY_ROUTING_FORM,
    part_id: initialPartId || '',
  }));
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  // Workflow state (Step 2)
  const [pendingNodes, setPendingNodes] = useState<PendingNode[]>([]);
  const [pendingEdges, setPendingEdges] = useState<PendingEdge[]>([]);

  // For edit mode: track original IDs to detect deletions
  const [originalNodeIds, setOriginalNodeIds] = useState<Set<string>>(new Set());
  const [originalEdgeIds, setOriginalEdgeIds] = useState<Set<string>>(new Set());

  // Parts for dropdown
  const [parts, setParts] = useState<Part[]>([]);
  const [loadingParts, setLoadingParts] = useState(true);

  // Loading and error state
  const [loading, setLoading] = useState(isEditMode);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load parts for dropdown
  useEffect(() => {
    async function loadParts() {
      try {
        const data = await getAllParts(companyId);
        setParts(data);
      } catch (err) {
        console.error('Failed to load parts:', err);
      } finally {
        setLoadingParts(false);
      }
    }
    loadParts();
  }, [companyId]);

  // Load existing routing data (edit mode)
  useEffect(() => {
    if (!routingId) return;

    const id = routingId;
    async function loadRouting() {
      try {
        const data = await getRoutingWithGraph(id);
        if (data) {
          setFormData(routingToFormData(data));

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
  }, [routingId]);

  // Handle form field changes
  const handleFormChange = useCallback(
    (field: keyof RoutingFormData, value: string | boolean) => {
      setFormData((prev) => ({ ...prev, [field]: value }));
      // Clear field error when user types
      if (fieldErrors[field]) {
        setFieldErrors((prev) => {
          const next = { ...prev };
          delete next[field];
          return next;
        });
      }
    },
    [fieldErrors]
  );

  // Validate Step 1
  const validateStep1 = async (): Promise<boolean> => {
    const errors: Record<string, string> = {};

    if (!formData.name.trim()) {
      errors.name = 'Name is required';
    } else {
      const exists = await checkRoutingNameExists(
        companyId,
        formData.name.trim(),
        routingId
      );
      if (exists) {
        errors.name = 'A routing with this name already exists';
      }
    }

    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  };

  // Validate Step 2 - must have at least one operation
  const validateStep2 = (): boolean => {
    if (pendingNodes.length === 0) {
      setError('At least one operation is required. Add an operation to the workflow before saving.');
      return false;
    }
    return true;
  };

  // Handle step navigation
  const handleStepClick = (step: number) => {
    setCurrentStep(step);
  };

  const handleNext = async () => {
    if (currentStep === 0) {
      const isValid = await validateStep1();
      if (!isValid) return;
    }
    setCurrentStep((prev) => Math.min(prev + 1, WIZARD_STEPS.length - 1));
  };

  // Handle cancel
  const handleCancel = () => {
    router.back();
  };

  // Handle save
  const handleSave = async () => {
    setError(null);

    // Validate Step 1 before saving
    const isValid = await validateStep1();
    if (!isValid) {
      setCurrentStep(0); // Go back to Step 1 to show errors
      return;
    }

    // Validate Step 2 - must have at least one operation
    if (!validateStep2()) {
      setCurrentStep(1); // Go to Step 2 to show error
      return;
    }

    setSaving(true);
    try {
      const { saveRoutingWithGraph } = await import('@/utils/routingsAccess');
      await saveRoutingWithGraph(
        companyId,
        routingId || null,
        formData,
        pendingNodes,
        pendingEdges,
        isEditMode ? originalNodeIds : new Set(),
        isEditMode ? originalEdgeIds : new Set()
      );

      // Navigate back to routings list
      router.push(`/dashboard/${companyId}/routings`);
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

  // Part options for dropdown
  const partOptions: SelectOption[] = parts.map((p) => ({
    id: p.id,
    label: `${p.part_number}${p.description ? ` - ${p.description}` : ''}`,
  }));

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

        {currentStep < WIZARD_STEPS.length - 1 ? (
          <Button
            variant="contained"
            onClick={handleNext}
            disabled={saving}
            endIcon={<ArrowForwardIcon />}
          >
            Next
          </Button>
        ) : (
          <Button
            variant="contained"
            onClick={handleSave}
            disabled={saving}
            startIcon={saving ? <CircularProgress size={16} /> : <SaveIcon />}
          >
            {saving ? 'Saving...' : 'Save Routing'}
          </Button>
        )}
      </Box>

      {/* Step Indicator */}
      <WizardStepIndicator
        steps={WIZARD_STEPS}
        activeStep={currentStep}
        onStepClick={handleStepClick}
        clickable={true}
      />

      {/* Error Alert */}
      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      {/* Step Content */}
      <Box sx={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        {currentStep === 0 && (
          /* Step 1: Routing Information */
          <Card elevation={2}>
            <CardContent sx={{ p: 3 }}>
              <Typography variant="h6" sx={{ fontWeight: 600, mb: 3 }}>
                Routing Information
              </Typography>
              <Grid container spacing={3}>
                <Grid size={{ xs: 12, sm: 6 }}>
                  <TextField
                    label="Name"
                    value={formData.name}
                    onChange={(e) => handleFormChange('name', e.target.value)}
                    required
                    fullWidth
                    disabled={saving}
                    error={!!fieldErrors.name}
                    helperText={fieldErrors.name || 'e.g., Standard Widget Process'}
                  />
                </Grid>
                <Grid size={{ xs: 12, sm: 6 }}>
                  <SearchableSelect
                    options={partOptions}
                    value={formData.part_id}
                    onChange={(value) => handleFormChange('part_id', value)}
                    label="Part"
                    disabled={saving || loadingParts}
                    loading={loadingParts}
                    allowNone
                    noneLabel="No Part (Standalone Routing)"
                    helperText="Link this routing to a specific part"
                  />
                </Grid>
                <Grid size={{ xs: 12, sm: 6 }}>
                  <FormControlLabel
                    control={
                      <Checkbox
                        checked={formData.is_default}
                        onChange={(e) => handleFormChange('is_default', e.target.checked)}
                        disabled={saving || !formData.part_id}
                      />
                    }
                    label="Set as default routing for this part"
                  />
                </Grid>
                <Grid size={{ xs: 12 }}>
                  <TextField
                    label="Description"
                    value={formData.description}
                    onChange={(e) => handleFormChange('description', e.target.value)}
                    fullWidth
                    multiline
                    rows={3}
                    disabled={saving}
                    helperText="Additional notes about this routing"
                  />
                </Grid>
              </Grid>
            </CardContent>
          </Card>
        )}

        {currentStep === 1 && (
          /* Step 2: Build Workflow */
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
        )}
      </Box>
    </Box>
  );
}
