'use client';

import { useState, useEffect, useMemo } from 'react';
import {
  ReactFlow,
  Controls,
  Background,
  MiniMap,
  BackgroundVariant,
  MarkerType,
  type Node,
  type Edge,
  type NodeTypes,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import dagre from 'dagre';
import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
import Typography from '@mui/material/Typography';
import Alert from '@mui/material/Alert';
import Chip from '@mui/material/Chip';
import AccessTimeIcon from '@mui/icons-material/AccessTime';

import OperationNode from './OperationNode';
import { getRoutingWithGraph } from '@/utils/routingsAccess';
import type { RoutingWithGraph } from '@/types/routings';
import {
  toFlowElements as convertToFlowElements,
  calculateRoutingTime as calcTime,
  formatTime as fmtTime,
} from '@/types/routings';

// Define custom node types
const nodeTypes: NodeTypes = {
  operation: OperationNode,
};

// Dagre layout configuration
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
  const dagreGraph = new dagre.graphlib.Graph();
  dagreGraph.setDefaultEdgeLabel(() => ({}));
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

interface RoutingWorkflowViewerProps {
  routingId: string;
  companyId: string;
}

/**
 * Read-only viewer for routing workflow visualization.
 * Displays the workflow diagram without editing capabilities.
 */
export default function RoutingWorkflowViewer({
  routingId,
  companyId,
}: RoutingWorkflowViewerProps) {
  const [routing, setRouting] = useState<RoutingWithGraph | null>(null);
  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Load routing data
  useEffect(() => {
    async function loadRouting() {
      try {
        setLoading(true);
        setError(null);
        const data = await getRoutingWithGraph(routingId);
        if (!data) {
          setError('Routing not found');
          return;
        }
        setRouting(data);

        // Convert to React Flow elements
        const flowElements = convertToFlowElements(data.nodes || [], data.edges || []);

        // Apply edge styling
        const styledEdges: Edge[] = flowElements.edges.map((edge) => ({
          ...edge,
          style: { stroke: '#4682B4', strokeWidth: 2 },
          markerEnd: { type: MarkerType.ArrowClosed, color: '#4682B4' },
        }));

        // Apply dagre layout
        if (flowElements.nodes.length > 0) {
          const layouted = getLayoutedElements(flowElements.nodes, styledEdges);
          setNodes(layouted.nodes);
          setEdges(layouted.edges);
        } else {
          setNodes([]);
          setEdges([]);
        }
      } catch (err) {
        console.error('Error loading routing:', err);
        setError(err instanceof Error ? err.message : 'Failed to load routing');
      } finally {
        setLoading(false);
      }
    }

    loadRouting();
  }, [routingId, companyId]);

  // Calculate time totals
  const timeTotals = useMemo(() => {
    if (!routing?.nodes) return { runTime: 0, totalTime: 0 };
    return calcTime(routing.nodes);
  }, [routing]);

  if (loading) {
    return (
      <Box
        sx={{
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          height: '100%',
          minHeight: 400,
        }}
      >
        <CircularProgress />
      </Box>
    );
  }

  if (error) {
    return (
      <Box sx={{ p: 2 }}>
        <Alert severity="error">{error}</Alert>
      </Box>
    );
  }

  if (nodes.length === 0) {
    return (
      <Box
        sx={{
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          height: '100%',
          minHeight: 400,
        }}
      >
        <Typography color="text.secondary">No operations in this routing</Typography>
      </Box>
    );
  }

  return (
    <Box sx={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column' }}>
      {/* Time Summary */}
      <Box
        sx={{
          display: 'flex',
          gap: 2,
          p: 1.5,
          borderBottom: '1px solid rgba(255, 255, 255, 0.1)',
          bgcolor: 'rgba(0, 0, 0, 0.2)',
        }}
      >
        <Chip
          icon={<AccessTimeIcon />}
          label={`Run: ${fmtTime(timeTotals.runTime)}/unit`}
          size="small"
          variant="outlined"
        />
        <Typography variant="body2" color="text.secondary" sx={{ ml: 'auto' }}>
          {nodes.length} operation{nodes.length !== 1 ? 's' : ''}
        </Typography>
      </Box>

      {/* Workflow Canvas */}
      <Box sx={{ flex: 1, minHeight: 400 }}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          // Read-only settings
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          // Navigation enabled
          panOnDrag={true}
          zoomOnScroll={true}
          zoomOnPinch={true}
          // Initial view
          fitView
          fitViewOptions={{ padding: 0.2 }}
          // Styling
          style={{ background: '#0a0c1a' }}
        >
          <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="#1a1f3c" />
          <Controls
            showInteractive={false}
            style={{
              background: 'rgba(17, 20, 57, 0.9)',
              borderRadius: '8px',
              border: '1px solid rgba(255, 255, 255, 0.1)',
            }}
          />
          <MiniMap
            nodeColor="#4682B4"
            maskColor="rgba(0, 0, 0, 0.7)"
            style={{
              background: 'rgba(17, 20, 57, 0.9)',
              borderRadius: '8px',
              border: '1px solid rgba(255, 255, 255, 0.1)',
            }}
          />
        </ReactFlow>
      </Box>
    </Box>
  );
}
