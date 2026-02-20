'use client';

import { memo } from 'react';
import { Handle, Position, type NodeProps, type Node } from '@xyflow/react';
import { Box, Typography, IconButton, Tooltip, Chip } from '@mui/material';
import DeleteIcon from '@mui/icons-material/Delete';
import EditIcon from '@mui/icons-material/Edit';
import AccessTimeIcon from '@mui/icons-material/AccessTime';
import type { OperationNodeData } from '@/types/routings';

// Define the node type for React Flow
type OperationNodeType = Node<OperationNodeData, 'operation'>;

interface OperationNodeProps {
  id: string;
  data: OperationNodeData;
  selected?: boolean;
}

function OperationNodeComponent({ id, data, selected }: OperationNodeProps) {
  return (
    <Box
      sx={{
        minWidth: 200,
        backgroundColor: selected
          ? 'rgba(70, 130, 180, 0.25)'
          : 'rgba(26, 31, 74, 0.95)',
        border: selected ? '2px solid #4682B4' : '1px solid rgba(255, 255, 255, 0.15)',
        borderRadius: 2,
        overflow: 'hidden',
        transition: 'border-color 0.2s ease, box-shadow 0.2s ease',
        '&:hover': {
          borderColor: 'rgba(70, 130, 180, 0.5)',
          boxShadow: '0 4px 12px rgba(0, 0, 0, 0.3)',
        },
      }}
    >
      {/* Input Handle (left side) */}
      <Handle
        type="target"
        position={Position.Left}
        style={{
          width: 12,
          height: 12,
          background: '#4682B4',
          border: '2px solid #111439',
        }}
      />

      {/* Header with resource group */}
      {data.resourceGroupName && (
        <Box
          sx={{
            px: 1.5,
            py: 0.5,
            backgroundColor: 'rgba(70, 130, 180, 0.3)',
            borderBottom: '1px solid rgba(255, 255, 255, 0.1)',
          }}
        >
          <Typography
            variant="caption"
            sx={{
              color: 'rgba(255, 255, 255, 0.7)',
              textTransform: 'uppercase',
              letterSpacing: 0.5,
              fontSize: '0.65rem',
            }}
          >
            {data.resourceGroupName}
          </Typography>
        </Box>
      )}

      {/* Main Content */}
      <Box sx={{ px: 1.5, py: 1.5 }}>
        {/* Operation Name */}
        <Typography
          variant="body2"
          sx={{
            fontWeight: 600,
            color: 'white',
            mb: 1,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {data.operationName}
        </Typography>

        {/* Time Estimate */}
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mb: 1 }}>
          <AccessTimeIcon
            sx={{ fontSize: 14, color: 'rgba(255, 255, 255, 0.5)' }}
          />
          <Typography
            variant="caption"
            sx={{ color: 'rgba(255, 255, 255, 0.7)' }}
          >
            {data.runTimePerUnit ? `${data.runTimePerUnit}m/unit` : 'No time set'}
          </Typography>
        </Box>

        {/* Materials count */}
        {data.materials && data.materials.length > 0 && (
          <Chip
            label={`${data.materials.length} material${data.materials.length !== 1 ? 's' : ''}`}
            size="small"
            sx={{
              height: 20,
              fontSize: '0.7rem',
              backgroundColor: 'rgba(70, 130, 180, 0.2)',
              color: '#4682B4',
              border: '1px solid rgba(70, 130, 180, 0.3)',
              mb: 0.5,
            }}
          />
        )}

        {/* Labor Rate */}
        {data.laborRate && (
          <Chip
            label={`$${data.laborRate.toFixed(2)}/hr`}
            size="small"
            sx={{
              height: 20,
              fontSize: '0.7rem',
              backgroundColor: 'rgba(16, 185, 129, 0.2)',
              color: '#10b981',
              border: '1px solid rgba(16, 185, 129, 0.3)',
            }}
          />
        )}
      </Box>

      {/* Output Handle (right side) */}
      <Handle
        type="source"
        position={Position.Right}
        style={{
          width: 12,
          height: 12,
          background: '#4682B4',
          border: '2px solid #111439',
        }}
      />
    </Box>
  );
}

export default memo(OperationNodeComponent);
