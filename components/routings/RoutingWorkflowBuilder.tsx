'use client';

import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import {
  ReactFlow,
  Controls,
  Background,
  MiniMap,
  useNodesState,
  useEdgesState,
  addEdge,
  Connection,
  ReactFlowInstance,
  BackgroundVariant,
  MarkerType,
  SelectionMode,
  ConnectionLineType,
  type Node,
  type Edge,
  type OnNodesChange,
  type OnEdgesChange,
  type NodeTypes,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import dagre from 'dagre';
import {
  Box,
  Button,
  Typography,
  Alert,
  CircularProgress,
  Chip,
  Dialog,
  DialogTitle,
  DialogContent,
  TextField,
  List,
  ListItem,
  ListItemText,
  ListItemIcon,
  Accordion,
  AccordionSummary,
  AccordionDetails,
  InputAdornment,
  IconButton,
} from '@mui/material';
import Popover from '@mui/material/Popover';
import Tooltip from '@mui/material/Tooltip';
import AutoFixHighIcon from '@mui/icons-material/AutoFixHigh';
import AddIcon from '@mui/icons-material/Add';
import CloseIcon from '@mui/icons-material/Close';
import SearchIcon from '@mui/icons-material/Search';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import BuildIcon from '@mui/icons-material/Build';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import LinkIcon from '@mui/icons-material/Link';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import MouseIcon from '@mui/icons-material/Mouse';
import OpenWithIcon from '@mui/icons-material/OpenWith';
import ZoomInIcon from '@mui/icons-material/ZoomIn';
import OperationNode from './OperationNode';
import OperationsSidebar from './OperationsSidebar';
import NodeEditModal from './NodeEditModal';
import {
  getRoutingWithGraph,
  createRoutingNode,
  updateRoutingNode,
  deleteRoutingNode,
  createRoutingEdge,
  deleteRoutingEdge,
} from '@/utils/routingsAccess';
import { getOperationsGrouped } from '@/utils/operationsAccess';
import type {
  RoutingWithGraph,
  OperationNodeData,
  RoutingNodeFormData,
} from '@/types/routings';
import {
  toFlowElements as convertToFlowElements,
  calculateRoutingTime as calcTime,
  formatTime as fmtTime,
} from '@/types/routings';
import type { OperationsGroupedResponse } from '@/types/operations';

/**
 * Pending node data for memory mode.
 */
export interface PendingNode {
  tempId: string;
  operationTypeId: string;
  operationName: string;
  resourceGroupName: string | null;
  laborRate: number | null;
  runTimePerUnit: number | null;
  instructions: string | null;
  materials: unknown[];
}

/**
 * Pending edge data for memory mode.
 */
export interface PendingEdge {
  tempId: string;
  sourceNodeId: string;
  targetNodeId: string;
}

/** Generate a temporary ID for memory mode */
const generateTempId = (prefix: 'node' | 'edge') => `temp-${prefix}-${crypto.randomUUID()}`;

/** Convert pending nodes to React Flow nodes */
function pendingNodesToFlowNodes(pendingNodes: PendingNode[]): Node[] {
  return pendingNodes.map((pn, index) => ({
    id: pn.tempId,
    type: 'operation',
    position: { x: index * 250, y: 100 }, // Will be overwritten by auto-layout
    data: {
      nodeId: pn.tempId,
      operationTypeId: pn.operationTypeId,
      operationName: pn.operationName,
      resourceGroupName: pn.resourceGroupName,
      runTimePerUnit: pn.runTimePerUnit,
      instructions: pn.instructions,
      laborRate: pn.laborRate,
      materials: pn.materials || [],
    } as OperationNodeData,
  }));
}

/** Convert pending edges to React Flow edges */
function pendingEdgesToFlowEdges(pendingEdges: PendingEdge[]): Edge[] {
  return pendingEdges.map((pe) => ({
    id: pe.tempId,
    source: pe.sourceNodeId,
    target: pe.targetNodeId,
    type: 'smoothstep',
    animated: false,
    style: { stroke: '#4682B4', strokeWidth: 2 },
    markerEnd: { type: MarkerType.ArrowClosed, color: '#4682B4' },
  }));
}

// Define custom node types
const nodeTypes: NodeTypes = {
  operation: OperationNode,
};

// Dagre layout configuration
const dagreGraph = new dagre.graphlib.Graph();
dagreGraph.setDefaultEdgeLabel(() => ({}));

const NODE_WIDTH = 200;
const NODE_HEIGHT = 100;

/**
 * Apply dagre auto-layout to position nodes.
 */
function getLayoutedElements(
  nodes: Node[],
  edges: Edge[],
  direction: 'LR' | 'TB' = 'LR'
): { nodes: Node[]; edges: Edge[] } {
  const isHorizontal = direction === 'LR';
  dagreGraph.setGraph({ rankdir: direction, nodesep: 80, ranksep: 120 });

  nodes.forEach((node) => {
    dagreGraph.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  });

  edges.forEach((edge) => {
    dagreGraph.setEdge(edge.source, edge.target);
  });

  dagre.layout(dagreGraph);

  const layoutedNodes = nodes.map((node) => {
    const nodeWithPosition = dagreGraph.node(node.id);
    return {
      ...node,
      position: {
        x: nodeWithPosition.x - NODE_WIDTH / 2,
        y: nodeWithPosition.y - NODE_HEIGHT / 2,
      },
    };
  });

  return { nodes: layoutedNodes, edges };
}

// --- Add Operation Dialog ---
interface AddOperationDialogProps {
  open: boolean;
  onClose: () => void;
  companyId: string;
  onSelect: (operation: {
    id: string;
    name: string;
    laborRate: number | null;
    resourceGroupName: string | null;
  }) => void;
}

function AddOperationDialog({ open, onClose, companyId, onSelect }: AddOperationDialogProps) {
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [data, setData] = useState<OperationsGroupedResponse>({ groups: [], ungrouped: [] });
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setSearch('');
    getOperationsGrouped(companyId)
      .then((result) => {
        setData(result);
        const allIds = new Set(result.groups.map((g) => g.id));
        if (result.ungrouped.length > 0) allIds.add('ungrouped');
        setExpandedGroups(allIds);
      })
      .catch((err) => console.error('Failed to load operations:', err))
      .finally(() => setLoading(false));
  }, [open, companyId]);

  const filtered = useMemo(() => {
    if (!search.trim()) return data;
    const s = search.toLowerCase();
    return {
      groups: data.groups
        .map((g) => ({ ...g, operations: g.operations.filter((op) => op.name.toLowerCase().includes(s)) }))
        .filter((g) => g.operations.length > 0),
      ungrouped: data.ungrouped.filter((op) => op.name.toLowerCase().includes(s)),
    };
  }, [data, search]);

  const total = filtered.groups.reduce((sum, g) => sum + g.operations.length, 0) + filtered.ungrouped.length;

  const handleSelect = (opId: string, opName: string, laborRate: number | null, resourceGroupName: string | null) => {
    onSelect({ id: opId, name: opName, laborRate, resourceGroupName });
    onClose();
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth PaperProps={{ sx: { bgcolor: 'rgba(17, 20, 57, 0.98)', maxHeight: '70vh' } }}>
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', pb: 1 }}>
        <Typography variant="h6">Add Operation</Typography>
        <IconButton size="small" onClick={onClose}><CloseIcon /></IconButton>
      </DialogTitle>
      <DialogContent sx={{ px: 2, pb: 2 }}>
        <TextField
          size="small"
          placeholder="Search operations..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          fullWidth
          autoFocus
          InputProps={{
            startAdornment: (
              <InputAdornment position="start">
                <SearchIcon sx={{ fontSize: 18, color: 'text.secondary' }} />
              </InputAdornment>
            ),
          }}
          sx={{ mb: 1.5, '& .MuiOutlinedInput-root': { bgcolor: 'rgba(255, 255, 255, 0.05)' } }}
        />
        {loading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}><CircularProgress size={24} /></Box>
        ) : total === 0 ? (
          <Box sx={{ textAlign: 'center', py: 4 }}>
            <BuildIcon sx={{ fontSize: 40, color: 'text.disabled', mb: 1 }} />
            <Typography color="text.secondary" variant="body2">
              {search ? 'No matching operations' : 'No operations defined'}
            </Typography>
          </Box>
        ) : (
          <>
            {filtered.groups.map((group) => (
              <Accordion
                key={group.id}
                expanded={expandedGroups.has(group.id)}
                onChange={() => setExpandedGroups((prev) => { const next = new Set(prev); next.has(group.id) ? next.delete(group.id) : next.add(group.id); return next; })}
                disableGutters
                elevation={0}
                sx={{ bgcolor: 'transparent', '&:before': { display: 'none' }, '& .MuiAccordionSummary-root': { minHeight: 40, px: 1 } }}
              >
                <AccordionSummary expandIcon={<ExpandMoreIcon sx={{ fontSize: 18 }} />}>
                  <Typography variant="body2" sx={{ fontWeight: 500 }}>{group.name}</Typography>
                  <Typography variant="caption" color="text.secondary" sx={{ ml: 1 }}>({group.operations.length})</Typography>
                </AccordionSummary>
                <AccordionDetails sx={{ p: 0 }}>
                  <List dense disablePadding>
                    {group.operations.map((op) => (
                      <ListItem
                        key={op.id}
                        component="div"
                        onClick={() => handleSelect(op.id, op.name, op.labor_rate, group.name)}
                        sx={{ cursor: 'pointer', borderRadius: 1, mx: 0.5, mb: 0.5, bgcolor: 'rgba(255, 255, 255, 0.05)', '&:hover': { bgcolor: 'rgba(70, 130, 180, 0.2)' } }}
                      >
                        <ListItemIcon sx={{ minWidth: 28 }}>
                          <AddIcon sx={{ fontSize: 16, color: 'primary.main' }} />
                        </ListItemIcon>
                        <ListItemText
                          primary={op.name}
                          secondary={op.labor_rate ? `$${op.labor_rate.toFixed(2)}/hr` : null}
                          primaryTypographyProps={{ variant: 'body2', noWrap: true }}
                          secondaryTypographyProps={{ variant: 'caption' }}
                        />
                      </ListItem>
                    ))}
                  </List>
                </AccordionDetails>
              </Accordion>
            ))}
            {filtered.ungrouped.length > 0 && (
              <Accordion
                expanded={expandedGroups.has('ungrouped')}
                onChange={() => setExpandedGroups((prev) => { const next = new Set(prev); next.has('ungrouped') ? next.delete('ungrouped') : next.add('ungrouped'); return next; })}
                disableGutters
                elevation={0}
                sx={{ bgcolor: 'transparent', '&:before': { display: 'none' }, '& .MuiAccordionSummary-root': { minHeight: 40, px: 1 } }}
              >
                <AccordionSummary expandIcon={<ExpandMoreIcon sx={{ fontSize: 18 }} />}>
                  <Typography variant="body2" sx={{ fontWeight: 500, fontStyle: 'italic' }}>Ungrouped</Typography>
                  <Typography variant="caption" color="text.secondary" sx={{ ml: 1 }}>({filtered.ungrouped.length})</Typography>
                </AccordionSummary>
                <AccordionDetails sx={{ p: 0 }}>
                  <List dense disablePadding>
                    {filtered.ungrouped.map((op) => (
                      <ListItem
                        key={op.id}
                        component="div"
                        onClick={() => handleSelect(op.id, op.name, op.labor_rate, null)}
                        sx={{ cursor: 'pointer', borderRadius: 1, mx: 0.5, mb: 0.5, bgcolor: 'rgba(255, 255, 255, 0.05)', '&:hover': { bgcolor: 'rgba(70, 130, 180, 0.2)' } }}
                      >
                        <ListItemIcon sx={{ minWidth: 28 }}>
                          <AddIcon sx={{ fontSize: 16, color: 'primary.main' }} />
                        </ListItemIcon>
                        <ListItemText
                          primary={op.name}
                          secondary={op.labor_rate ? `$${op.labor_rate.toFixed(2)}/hr` : null}
                          primaryTypographyProps={{ variant: 'body2', noWrap: true }}
                          secondaryTypographyProps={{ variant: 'caption' }}
                        />
                      </ListItem>
                    ))}
                  </List>
                </AccordionDetails>
              </Accordion>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

interface RoutingWorkflowBuilderProps {
  routingId: string;
  companyId: string;
  onRoutingUpdate?: () => void;
  /** Mode: 'persisted' saves to DB immediately, 'memory' stores in parent state */
  mode?: 'persisted' | 'memory';
  /** Pending nodes for memory mode */
  pendingNodes?: PendingNode[];
  /** Pending edges for memory mode */
  pendingEdges?: PendingEdge[];
  /** Callback when nodes change (memory mode) */
  onPendingNodesChange?: (nodes: PendingNode[]) => void;
  /** Callback when edges change (memory mode) */
  onPendingEdgesChange?: (edges: PendingEdge[]) => void;
}

/**
 * Visual workflow builder for routing operations using React Flow.
 * Supports drag-and-drop from sidebar, connecting operations, and editing.
 */
export default function RoutingWorkflowBuilder({
  routingId,
  companyId,
  onRoutingUpdate,
  mode = 'persisted',
  pendingNodes: externalPendingNodes,
  pendingEdges: externalPendingEdges,
  onPendingNodesChange,
  onPendingEdgesChange,
}: RoutingWorkflowBuilderProps) {
  const isMemoryMode = mode === 'memory';
  const reactFlowWrapper = useRef<HTMLDivElement>(null);
  const [reactFlowInstance, setReactFlowInstance] = useState<ReactFlowInstance | null>(null);

  // State
  const [routing, setRouting] = useState<RoutingWithGraph | null>(null);
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Modal state
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [editingNode, setEditingNode] = useState<OperationNodeData | null>(null);
  const [editingNodeId, setEditingNodeId] = useState<string | null>(null);

  // Add Operation dialog state
  const [addDialogOpen, setAddDialogOpen] = useState(false);

  // Edge selection state (for delete hint)
  const [edgeSelected, setEdgeSelected] = useState(false);

  // Help popover state
  const [helpAnchorEl, setHelpAnchorEl] = useState<HTMLElement | null>(null);
  const helpOpen = Boolean(helpAnchorEl);

  // Auto-show help on first visit
  const helpButtonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const key = 'jigged_hasSeenRoutingHelp';
    if (typeof window !== 'undefined' && !localStorage.getItem(key)) {
      // Small delay so the toolbar renders first
      const timer = setTimeout(() => {
        if (helpButtonRef.current) {
          setHelpAnchorEl(helpButtonRef.current);
          localStorage.setItem(key, 'true');
        }
      }, 800);
      return () => clearTimeout(timer);
    }
  }, []);

  // Miro-style navigation: spacebar + drag to pan
  const [spacebarPressed, setSpacebarPressed] = useState(false);

  // Keyboard listener for spacebar pan mode
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !e.repeat) {
        // Only prevent default if we're focused on the canvas area
        const target = e.target as HTMLElement;
        if (target.tagName !== 'INPUT' && target.tagName !== 'TEXTAREA') {
          e.preventDefault();
          setSpacebarPressed(true);
        }
      }
    };
    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        setSpacebarPressed(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, []);

  // Load routing data (persisted mode) or initialize from pending data (memory mode)
  useEffect(() => {
    if (isMemoryMode) {
      // Memory mode: initialize from external pending nodes/edges
      const flowNodes = pendingNodesToFlowNodes(externalPendingNodes || []);
      const flowEdges = pendingEdgesToFlowEdges(externalPendingEdges || []);

      if (flowNodes.length > 0) {
        const layouted = getLayoutedElements(flowNodes, flowEdges);
        setNodes(layouted.nodes);
        setEdges(layouted.edges);
      } else {
        setNodes([]);
        setEdges([]);
      }
      setLoading(false);
      return;
    }

    // Persisted mode: load from database
    async function loadRouting() {
      if (!routingId) {
        setLoading(false);
        return;
      }
      try {
        const data = await getRoutingWithGraph(routingId);
        if (data) {
          setRouting(data);
          const { nodes: flowNodes, edges: flowEdges } = convertToFlowElements(
            data.nodes,
            data.edges
          );
          // Apply auto-layout
          const layouted = getLayoutedElements(flowNodes, flowEdges);
          setNodes(layouted.nodes);
          setEdges(layouted.edges);
        }
      } catch (err) {
        console.error('Failed to load routing:', err);
        setError('Failed to load routing data');
      } finally {
        setLoading(false);
      }
    }
    loadRouting();
  }, [routingId, setNodes, setEdges, isMemoryMode, externalPendingNodes, externalPendingEdges]);

  // Calculate time totals
  const timeTotals = useMemo(() => {
    if (isMemoryMode) {
      if (!externalPendingNodes?.length) return null;
      const runTime = externalPendingNodes.reduce(
        (sum, n) => sum + (n.runTimePerUnit || 0),
        0
      );
      return { runTime };
    }
    if (!routing) return null;
    return calcTime(routing.nodes);
  }, [isMemoryMode, externalPendingNodes, routing]);

  // Handle new edge connection
  const onConnect = useCallback(
    async (connection: Connection) => {
      if (!connection.source || !connection.target) return;

      if (isMemoryMode) {
        // Memory mode: add to pending edges via callback
        const newEdgeId = generateTempId('edge');
        const newPendingEdge: PendingEdge = {
          tempId: newEdgeId,
          sourceNodeId: connection.source,
          targetNodeId: connection.target,
        };

        // Update local React Flow state
        setEdges((eds) =>
          addEdge(
            {
              ...connection,
              id: newEdgeId,
              type: 'smoothstep',
              animated: false,
              style: { stroke: '#4682B4', strokeWidth: 2 },
              markerEnd: { type: MarkerType.ArrowClosed, color: '#4682B4' },
            },
            eds
          )
        );

        // Notify parent of change
        onPendingEdgesChange?.([...(externalPendingEdges || []), newPendingEdge]);
        return;
      }

      // Persisted mode: save to database
      try {
        const newEdge = await createRoutingEdge(
          routingId,
          connection.source,
          connection.target
        );

        setEdges((eds) =>
          addEdge(
            {
              ...connection,
              id: newEdge.id,
              type: 'smoothstep',
              animated: false,
              markerEnd: { type: MarkerType.ArrowClosed, color: '#4682B4' },
            },
            eds
          )
        );
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Failed to create connection';
        setError(message);
      }
    },
    [routingId, setEdges, isMemoryMode, externalPendingEdges, onPendingEdgesChange]
  );

  // Shared helper: add an operation node at a given position
  const addOperationNode = useCallback(
    async (
      operationTypeId: string,
      operationName: string,
      laborRate: number | null,
      resourceGroupName: string | null,
      position: { x: number; y: number }
    ) => {
      if (isMemoryMode) {
        const newNodeId = generateTempId('node');
        const newPendingNode: PendingNode = {
          tempId: newNodeId,
          operationTypeId,
          operationName,
          resourceGroupName,
          laborRate,
          runTimePerUnit: null,
          instructions: null,
          materials: [],
        };

        const flowNode: Node = {
          id: newNodeId,
          type: 'operation',
          position,
          data: {
            nodeId: newNodeId,
            operationTypeId,
            operationName,
            resourceGroupName,
            runTimePerUnit: null,
            instructions: null,
            laborRate,
            materials: [],
          } as OperationNodeData,
        };

        setNodes((nds) => [...nds, flowNode]);
        onPendingNodesChange?.([...(externalPendingNodes || []), newPendingNode]);

        // Auto-open edit modal for the new node
        setTimeout(() => {
          setEditingNode(flowNode.data as OperationNodeData);
          setEditingNodeId(newNodeId);
          setEditModalOpen(true);
        }, 50);
        return;
      }

      // Persisted mode: save to database
      try {
        const newNode = await createRoutingNode(routingId, {
          operation_type_id: operationTypeId,
          run_time_per_unit: '',
          instructions: '',
          materials: [],
        });

        const flowNode: Node = {
          id: newNode.id,
          type: 'operation',
          position,
          data: {
            nodeId: newNode.id,
            operationTypeId,
            operationName,
            resourceGroupName,
            runTimePerUnit: null,
            instructions: null,
            laborRate,
            materials: [],
          } as OperationNodeData,
        };

        setNodes((nds) => [...nds, flowNode]);

        if (routing) {
          setRouting({
            ...routing,
            nodes: [
              ...routing.nodes,
              {
                ...newNode,
                operation_type: {
                  id: operationTypeId,
                  name: operationName,
                  labor_rate: laborRate,
                  resource_group_id: null,
                },
              },
            ],
          });
        }

        setTimeout(() => {
          setEditingNode(flowNode.data as OperationNodeData);
          setEditingNodeId(newNode.id);
          setEditModalOpen(true);
        }, 50);
      } catch (err) {
        console.error('Failed to create node:', err);
        setError('Failed to add operation');
      }
    },
    [routingId, routing, setNodes, isMemoryMode, externalPendingNodes, onPendingNodesChange]
  );

  // Handle "Add Operation" dialog selection
  const handleAddOperationSelect = useCallback(
    (operation: { id: string; name: string; laborRate: number | null; resourceGroupName: string | null }) => {
      // Position at center of current viewport
      if (reactFlowInstance && reactFlowWrapper.current) {
        const { width, height } = reactFlowWrapper.current.getBoundingClientRect();
        const center = reactFlowInstance.screenToFlowPosition({
          x: width / 2,
          y: height / 2,
        });
        // Offset slightly so multiple adds don't stack exactly
        const offset = nodes.length * 20;
        addOperationNode(operation.id, operation.name, operation.laborRate, operation.resourceGroupName, {
          x: center.x + offset,
          y: center.y + offset,
        });
      }
    },
    [reactFlowInstance, nodes.length, addOperationNode]
  );

  // Handle dropping new operation from sidebar
  const onDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  }, []);

  const onDrop = useCallback(
    async (event: React.DragEvent) => {
      event.preventDefault();

      const type = event.dataTransfer.getData('application/reactflow');
      if (type !== 'operation') return;

      const operationTypeId = event.dataTransfer.getData('operationTypeId');
      const operationName = event.dataTransfer.getData('operationName');
      const laborRateStr = event.dataTransfer.getData('laborRate');
      const laborRate = laborRateStr ? parseFloat(laborRateStr) : null;
      const resourceGroupName = event.dataTransfer.getData('resourceGroupName') || null;

      if (!operationTypeId || !reactFlowInstance || !reactFlowWrapper.current) return;

      const position = reactFlowInstance.screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      });

      addOperationNode(operationTypeId, operationName, laborRate, resourceGroupName, position);
    },
    [reactFlowInstance, addOperationNode]
  );

  // Handle node edit
  const handleNodeEdit = useCallback(
    (nodeId: string) => {
      const node = nodes.find((n) => n.id === nodeId);
      if (node && node.data) {
        setEditingNode(node.data as OperationNodeData);
        setEditingNodeId(nodeId);
        setEditModalOpen(true);
      }
    },
    [nodes]
  );

  // Handle node delete
  const handleNodeDelete = useCallback(
    async (nodeId: string) => {
      if (isMemoryMode) {
        // Memory mode: remove from pending nodes via callback
        setNodes((nds) => nds.filter((n) => n.id !== nodeId));

        // Also remove connected edges
        const connectedEdgeIds = new Set<string>();
        setEdges((eds) => {
          const remaining = eds.filter((e) => {
            if (e.source === nodeId || e.target === nodeId) {
              connectedEdgeIds.add(e.id);
              return false;
            }
            return true;
          });
          return remaining;
        });

        // Notify parent of changes
        onPendingNodesChange?.(
          (externalPendingNodes || []).filter((n) => n.tempId !== nodeId)
        );
        onPendingEdgesChange?.(
          (externalPendingEdges || []).filter((e) => !connectedEdgeIds.has(e.tempId))
        );
        return;
      }

      // Persisted mode: delete from database
      try {
        await deleteRoutingNode(nodeId);
        setNodes((nds) => nds.filter((n) => n.id !== nodeId));
        // Also remove connected edges
        setEdges((eds) => eds.filter((e) => e.source !== nodeId && e.target !== nodeId));

        // Update routing data
        if (routing) {
          setRouting({
            ...routing,
            nodes: routing.nodes.filter((n) => n.id !== nodeId),
            edges: routing.edges.filter(
              (e) => e.source_node_id !== nodeId && e.target_node_id !== nodeId
            ),
          });
        }
      } catch (err) {
        console.error('Failed to delete node:', err);
        setError('Failed to delete operation');
      }
    },
    [routing, setNodes, setEdges, isMemoryMode, externalPendingNodes, externalPendingEdges, onPendingNodesChange, onPendingEdgesChange]
  );

  // Handle edge delete
  const onEdgesDelete = useCallback(
    async (edgesToDelete: Edge[]) => {
      if (isMemoryMode) {
        // Memory mode: remove from pending edges via callback
        const deletedIds = new Set(edgesToDelete.map((e) => e.id));
        onPendingEdgesChange?.(
          (externalPendingEdges || []).filter((e) => !deletedIds.has(e.tempId))
        );
        return;
      }

      // Persisted mode: delete from database
      for (const edge of edgesToDelete) {
        try {
          await deleteRoutingEdge(edge.id);
        } catch (err) {
          console.error('Failed to delete edge:', err);
        }
      }
    },
    [isMemoryMode, externalPendingEdges, onPendingEdgesChange]
  );

  // Handle node update from modal
  const handleNodeSave = useCallback(
    async (formData: RoutingNodeFormData) => {
      if (!editingNodeId) return;

      const runTimePerUnit = formData.run_time_per_unit
        ? parseFloat(formData.run_time_per_unit)
        : null;
      const instructions = formData.instructions || null;
      const materials = formData.materials || [];

      setNodes((nds) =>
        nds.map((n) => {
          if (n.id === editingNodeId) {
            const data = n.data as OperationNodeData;
            return {
              ...n,
              data: {
                ...data,
                runTimePerUnit,
                instructions,
                materials,
              } as OperationNodeData,
            };
          }
          return n;
        })
      );

      if (isMemoryMode) {
        onPendingNodesChange?.(
          (externalPendingNodes || []).map((n) => {
            if (n.tempId === editingNodeId) {
              return {
                ...n,
                runTimePerUnit,
                instructions,
                materials,
              };
            }
            return n;
          })
        );
        return;
      }

      try {
        await updateRoutingNode(editingNodeId, formData);

        if (routing) {
          setRouting({
            ...routing,
            nodes: routing.nodes.map((n) => {
              if (n.id === editingNodeId) {
                return {
                  ...n,
                  run_time_per_unit: runTimePerUnit,
                  instructions,
                  materials,
                };
              }
              return n;
            }),
          });
        }

        onRoutingUpdate?.();
      } catch (err) {
        console.error('Failed to update node:', err);
        throw err;
      }
    },
    [editingNodeId, routing, setNodes, onRoutingUpdate, isMemoryMode, externalPendingNodes, onPendingNodesChange]
  );

  // Apply auto-layout
  const handleAutoLayout = useCallback(() => {
    const layouted = getLayoutedElements(nodes, edges);
    setNodes(layouted.nodes);
  }, [nodes, edges, setNodes]);

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
    <Box sx={{ display: 'flex', height: '100%', minHeight: 500 }}>
      {/* Operations Sidebar */}
      <OperationsSidebar
        companyId={companyId}
        onDragStart={() => {}}
      />

      {/* Workflow Canvas */}
      <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', position: 'relative' }}>
        {/* Error Alert */}
        {error && (
          <Alert
            severity="error"
            onClose={() => setError(null)}
            sx={{ m: 1, mb: 0 }}
          >
            {error}
          </Alert>
        )}

        {/* Toolbar */}
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 2,
            p: 1.5,
            borderBottom: '1px solid rgba(255, 255, 255, 0.1)',
            bgcolor: 'rgba(17, 20, 57, 0.95)',
          }}
        >
          <Button
            variant="contained"
            size="small"
            startIcon={<AddIcon />}
            onClick={() => setAddDialogOpen(true)}
          >
            Add Operation
          </Button>

          <Button
            variant="outlined"
            size="small"
            startIcon={<AutoFixHighIcon />}
            onClick={handleAutoLayout}
          >
            Auto Layout
          </Button>

          <Tooltip title="How to use this editor">
            <IconButton
              ref={helpButtonRef}
              size="small"
              onClick={(e) => setHelpAnchorEl(e.currentTarget)}
              sx={{ color: 'text.secondary' }}
            >
              <InfoOutlinedIcon fontSize="small" />
            </IconButton>
          </Tooltip>

          <Popover
            open={helpOpen}
            anchorEl={helpAnchorEl}
            onClose={() => setHelpAnchorEl(null)}
            anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
            transformOrigin={{ vertical: 'top', horizontal: 'left' }}
            PaperProps={{ sx: { bgcolor: 'rgba(17, 20, 57, 0.98)', border: '1px solid rgba(255, 255, 255, 0.1)', p: 2, maxWidth: 320 } }}
          >
            <Typography variant="subtitle2" sx={{ fontWeight: 600, mb: 1.5 }}>
              Workflow Editor Guide
            </Typography>
            {[
              { icon: <AddIcon sx={{ fontSize: 18 }} />, text: 'Click "Add Operation" or drag from sidebar' },
              { icon: <LinkIcon sx={{ fontSize: 18 }} />, text: 'Drag from a dot handle to another to connect' },
              { icon: <DeleteOutlineIcon sx={{ fontSize: 18 }} />, text: 'Click a connection, then press Delete' },
              { icon: <MouseIcon sx={{ fontSize: 18 }} />, text: 'Double-click an operation to edit details' },
              { icon: <OpenWithIcon sx={{ fontSize: 18 }} />, text: 'Hold Space + drag to pan the canvas' },
              { icon: <ZoomInIcon sx={{ fontSize: 18 }} />, text: 'Pinch or scroll to zoom in/out' },
              { icon: <AutoFixHighIcon sx={{ fontSize: 18 }} />, text: 'Click "Auto Layout" to rearrange neatly' },
            ].map((item, i) => (
              <Box key={i} sx={{ display: 'flex', alignItems: 'center', gap: 1.5, mb: i < 6 ? 1 : 0 }}>
                <Box sx={{ color: 'primary.main', display: 'flex' }}>{item.icon}</Box>
                <Typography variant="body2" color="text.secondary">{item.text}</Typography>
              </Box>
            ))}
          </Popover>

          <Box sx={{ flex: 1 }} />

          {/* Edge delete hint */}
          {edgeSelected && (
            <Chip
              icon={<DeleteOutlineIcon sx={{ fontSize: 16 }} />}
              label="Press Delete to remove connection"
              size="small"
              color="error"
              variant="outlined"
              sx={{ animation: 'fadeIn 0.2s ease-in' }}
            />
          )}

          {/* Time Summary */}
          {timeTotals && (
            <Box sx={{ display: 'flex', gap: 1 }}>
              <Chip
                label={`Run: ${fmtTime(timeTotals.runTime)}/unit`}
                size="small"
                variant="outlined"
              />
            </Box>
          )}

          <Typography variant="body2" color="text.secondary">
            {nodes.length} operation{nodes.length !== 1 ? 's' : ''}
          </Typography>
        </Box>

        {/* React Flow Canvas */}
        <Box
          ref={reactFlowWrapper}
          sx={{
            flex: 1,
            // Style React Flow controls for dark theme
            '& .react-flow__controls': {
              backgroundColor: 'rgba(17, 20, 57, 0.95)',
              border: '1px solid rgba(255, 255, 255, 0.1)',
              borderRadius: 1,
            },
            '& .react-flow__controls-button': {
              backgroundColor: 'transparent',
              border: 'none',
              borderBottom: '1px solid rgba(255, 255, 255, 0.1)',
              color: '#fff',
              '&:hover': {
                backgroundColor: 'rgba(70, 130, 180, 0.3)',
              },
              '&:last-child': {
                borderBottom: 'none',
              },
              '& svg': {
                fill: '#fff',
              },
            },
            // Edge hover: blue glow to signal interactivity
            '& .react-flow__edge:hover .react-flow__edge-path': {
              stroke: '#6ba3d1',
              strokeWidth: 4,
              cursor: 'pointer',
              filter: 'drop-shadow(0 0 4px rgba(70, 130, 180, 0.6))',
            },
            // Edge selected: red with animated dash + glow
            '& .react-flow__edge.selected .react-flow__edge-path': {
              stroke: '#ef4444',
              strokeWidth: 4,
              strokeDasharray: '8 4',
              filter: 'drop-shadow(0 0 6px rgba(239, 68, 68, 0.5))',
              animation: 'edgeDashFlow 0.6s linear infinite',
            },
            '@keyframes edgeDashFlow': {
              to: { strokeDashoffset: '-12' },
            },
            // Selection box styling
            '& .react-flow__selection': {
              backgroundColor: 'rgba(70, 130, 180, 0.15)',
              border: '1px dashed #4682B4',
            },
          }}
        >
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onEdgesDelete={onEdgesDelete}
            onSelectionChange={({ edges: selectedEdges }) => {
              setEdgeSelected(selectedEdges.length > 0);
            }}
            onInit={setReactFlowInstance}
            onDrop={onDrop}
            onDragOver={onDragOver}
            nodeTypes={nodeTypes}
            onNodeDoubleClick={(_, node) => handleNodeEdit(node.id)}
            fitView
            fitViewOptions={{ padding: 0.2 }}
            // Miro-style navigation: spacebar + drag to pan, otherwise drag to select
            panOnDrag={spacebarPressed}
            selectionOnDrag={!spacebarPressed}
            selectionMode={SelectionMode.Partial}
            selectNodesOnDrag={true}
            // Trackpad support: two-finger scroll pans, pinch zooms
            panOnScroll={true}
            zoomOnScroll={false}
            zoomOnPinch={true}
            // Connection line styling
            connectionLineStyle={{ stroke: '#4682B4', strokeWidth: 2 }}
            connectionLineType={ConnectionLineType.SmoothStep}
            defaultEdgeOptions={{
              type: 'smoothstep',
              animated: false,
              style: { stroke: '#4682B4', strokeWidth: 2 },
              markerEnd: { type: MarkerType.ArrowClosed, color: '#4682B4' },
              selectable: true,
            }}
            style={{
              backgroundColor: '#0a0c1a',
              cursor: spacebarPressed ? 'grab' : 'default',
            }}
            proOptions={{ hideAttribution: true }}
          >
            <Controls />
            <MiniMap
              style={{
                backgroundColor: 'rgba(17, 20, 57, 0.9)',
              }}
              nodeColor="#4682B4"
              maskColor="rgba(0, 0, 0, 0.5)"
            />
            <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="#333" />
          </ReactFlow>
        </Box>

        {/* Empty state */}
        {nodes.length === 0 && (
          <Box
            sx={{
              position: 'absolute',
              top: '50%',
              left: '50%',
              transform: 'translate(-50%, -50%)',
              textAlign: 'center',
            }}
          >
            <Typography variant="h6" color="text.secondary" gutterBottom>
              No operations yet
            </Typography>
            <Typography variant="body2" color="text.disabled" sx={{ mb: 2 }}>
              Add operations to build your workflow
            </Typography>
            <Button
              variant="contained"
              startIcon={<AddIcon />}
              onClick={() => setAddDialogOpen(true)}
            >
              Add Operation
            </Button>
          </Box>
        )}
      </Box>

      {/* Edit Modal */}
      <NodeEditModal
        open={editModalOpen}
        onClose={() => {
          setEditModalOpen(false);
          setEditingNode(null);
          setEditingNodeId(null);
        }}
        onSave={handleNodeSave}
        nodeData={editingNode}
        companyId={companyId}
      />

      {/* Add Operation Dialog */}
      <AddOperationDialog
        open={addDialogOpen}
        onClose={() => setAddDialogOpen(false)}
        companyId={companyId}
        onSelect={handleAddOperationSelect}
      />
    </Box>
  );
}
