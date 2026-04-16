'use client';

import { useState, useEffect, useMemo } from 'react';
import {
  Box,
  Typography,
  TextField,
  List,
  ListItem,
  ListItemText,
  ListItemIcon,
  Accordion,
  AccordionSummary,
  AccordionDetails,
  CircularProgress,
  InputAdornment,
  Tooltip,
} from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import DragIndicatorIcon from '@mui/icons-material/DragIndicator';
import BuildIcon from '@mui/icons-material/Build';
import { getOperationsGrouped } from '@/utils/operationsAccess';
import type { OperationsGroupedResponse } from '@/types/operations';

interface OperationsSidebarProps {
  companyId: string;
  onDragStart: (
    event: React.DragEvent,
    operationTypeId: string,
    operationName: string,
    laborRate: number | null
  ) => void;
}

/**
 * Sidebar component showing available operations that can be dragged onto the workflow.
 * Operations are grouped by resource group for organization.
 */
export default function OperationsSidebar({
  companyId,
  onDragStart,
}: OperationsSidebarProps) {
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [data, setData] = useState<OperationsGroupedResponse>({
    groups: [],
    ungrouped: [],
  });
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());

  // Load operations on mount
  useEffect(() => {
    async function loadOperations() {
      try {
        const result = await getOperationsGrouped(companyId);
        setData(result);
        // Expand all groups by default
        const allGroupIds = new Set(result.groups.map((g) => g.id));
        if (result.ungrouped.length > 0) {
          allGroupIds.add('ungrouped');
        }
        setExpandedGroups(allGroupIds);
      } catch (err) {
        console.error('Failed to load operations:', err);
      } finally {
        setLoading(false);
      }
    }
    loadOperations();
  }, [companyId]);

  // Filter operations based on search
  const filteredData = useMemo(() => {
    if (!search.trim()) return data;

    const searchLower = search.toLowerCase();

    const filteredGroups = data.groups
      .map((group) => ({
        ...group,
        operations: group.operations.filter((op) =>
          op.name.toLowerCase().includes(searchLower)
        ),
      }))
      .filter((group) => group.operations.length > 0);

    const filteredUngrouped = data.ungrouped.filter((op) =>
      op.name.toLowerCase().includes(searchLower)
    );

    return { groups: filteredGroups, ungrouped: filteredUngrouped };
  }, [data, search]);

  const handleAccordionChange = (groupId: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) {
        next.delete(groupId);
      } else {
        next.add(groupId);
      }
      return next;
    });
  };

  const handleDragStart = (
    event: React.DragEvent,
    operationTypeId: string,
    operationName: string,
    laborRate: number | null,
    resourceGroupName: string | null
  ) => {
    event.dataTransfer.setData('application/reactflow', 'operation');
    event.dataTransfer.setData('operationTypeId', operationTypeId);
    event.dataTransfer.setData('operationName', operationName);
    event.dataTransfer.setData('laborRate', String(laborRate ?? ''));
    event.dataTransfer.setData('resourceGroupName', resourceGroupName ?? '');
    event.dataTransfer.effectAllowed = 'move';

    onDragStart(event, operationTypeId, operationName, laborRate);
  };

  const totalOperations =
    filteredData.groups.reduce((sum, g) => sum + g.operations.length, 0) +
    filteredData.ungrouped.length;

  return (
    <Box
      sx={{
        width: 280,
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        bgcolor: 'rgba(17, 20, 57, 0.95)',
        borderRight: '1px solid rgba(255, 255, 255, 0.1)',
      }}
    >
      {/* Header */}
      <Box sx={{ p: 2, borderBottom: '1px solid rgba(255, 255, 255, 0.1)' }}>
        <Typography variant="subtitle1" sx={{ fontWeight: 600, mb: 1.5 }}>
          Operations
        </Typography>
        <TextField
          size="small"
          placeholder="Search operations..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          fullWidth
          InputProps={{
            startAdornment: (
              <InputAdornment position="start">
                <SearchIcon sx={{ fontSize: 18, color: 'text.secondary' }} />
              </InputAdornment>
            ),
          }}
          sx={{
            '& .MuiOutlinedInput-root': {
              bgcolor: 'rgba(255, 255, 255, 0.05)',
            },
          }}
        />
        <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: 'block' }}>
          Drag operations onto the canvas
        </Typography>
      </Box>

      {/* Operations List */}
      <Box sx={{ flex: 1, overflow: 'auto', p: 1 }}>
        {loading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
            <CircularProgress size={24} />
          </Box>
        ) : totalOperations === 0 ? (
          <Box sx={{ textAlign: 'center', py: 4 }}>
            <BuildIcon sx={{ fontSize: 40, color: 'text.disabled', mb: 1 }} />
            <Typography color="text.secondary" variant="body2">
              {search ? 'No matching operations' : 'No operations defined'}
            </Typography>
            <Typography color="text.secondary" variant="caption">
              {!search && 'Add operations in Settings'}
            </Typography>
          </Box>
        ) : (
          <>
            {/* Grouped Operations */}
            {filteredData.groups.map((group) => (
              <Accordion
                key={group.id}
                expanded={expandedGroups.has(group.id)}
                onChange={() => handleAccordionChange(group.id)}
                disableGutters
                elevation={0}
                sx={{
                  bgcolor: 'transparent',
                  '&:before': { display: 'none' },
                  '& .MuiAccordionSummary-root': {
                    minHeight: 40,
                    px: 1,
                  },
                }}
              >
                <AccordionSummary
                  expandIcon={<ExpandMoreIcon sx={{ fontSize: 18 }} />}
                >
                  <Typography variant="body2" sx={{ fontWeight: 500 }}>
                    {group.name}
                  </Typography>
                  <Typography
                    variant="caption"
                    color="text.secondary"
                    sx={{ ml: 1 }}
                  >
                    ({group.operations.length})
                  </Typography>
                </AccordionSummary>
                <AccordionDetails sx={{ p: 0 }}>
                  <List dense disablePadding>
                    {group.operations.map((operation) => (
                      <OperationItem
                        key={operation.id}
                        id={operation.id}
                        name={operation.name}
                        laborRate={operation.labor_rate}
                        resourceGroupName={group.name}
                        onDragStart={handleDragStart}
                      />
                    ))}
                  </List>
                </AccordionDetails>
              </Accordion>
            ))}

            {/* Ungrouped Operations */}
            {filteredData.ungrouped.length > 0 && (
              <Accordion
                expanded={expandedGroups.has('ungrouped')}
                onChange={() => handleAccordionChange('ungrouped')}
                disableGutters
                elevation={0}
                sx={{
                  bgcolor: 'transparent',
                  '&:before': { display: 'none' },
                  '& .MuiAccordionSummary-root': {
                    minHeight: 40,
                    px: 1,
                  },
                }}
              >
                <AccordionSummary
                  expandIcon={<ExpandMoreIcon sx={{ fontSize: 18 }} />}
                >
                  <Typography
                    variant="body2"
                    sx={{ fontWeight: 500, fontStyle: 'italic' }}
                  >
                    Ungrouped
                  </Typography>
                  <Typography
                    variant="caption"
                    color="text.secondary"
                    sx={{ ml: 1 }}
                  >
                    ({filteredData.ungrouped.length})
                  </Typography>
                </AccordionSummary>
                <AccordionDetails sx={{ p: 0 }}>
                  <List dense disablePadding>
                    {filteredData.ungrouped.map((operation) => (
                      <OperationItem
                        key={operation.id}
                        id={operation.id}
                        name={operation.name}
                        laborRate={operation.labor_rate}
                        resourceGroupName={null}
                        onDragStart={handleDragStart}
                      />
                    ))}
                  </List>
                </AccordionDetails>
              </Accordion>
            )}
          </>
        )}
      </Box>
    </Box>
  );
}

// Individual operation item component
interface OperationItemProps {
  id: string;
  name: string;
  laborRate: number | null;
  resourceGroupName: string | null;
  onDragStart: (
    event: React.DragEvent,
    operationTypeId: string,
    operationName: string,
    laborRate: number | null,
    resourceGroupName: string | null
  ) => void;
}

function OperationItem({ id, name, laborRate, resourceGroupName, onDragStart }: OperationItemProps) {
  return (
    <Tooltip title={`Drag to add "${name}" to the workflow`} placement="right">
      <ListItem
        draggable
        onDragStart={(e) => onDragStart(e, id, name, laborRate, resourceGroupName)}
        sx={{
          cursor: 'grab',
          borderRadius: 1,
          mx: 0.5,
          mb: 0.5,
          bgcolor: 'rgba(255, 255, 255, 0.05)',
          '&:hover': {
            bgcolor: 'rgba(70, 130, 180, 0.2)',
          },
          '&:active': {
            cursor: 'grabbing',
          },
        }}
      >
        <ListItemIcon sx={{ minWidth: 28 }}>
          <DragIndicatorIcon sx={{ fontSize: 16, color: 'text.secondary' }} />
        </ListItemIcon>
        <ListItemText
          primary={name}
          secondary={laborRate ? `$${laborRate.toFixed(2)}/hr` : null}
          primaryTypographyProps={{
            variant: 'body2',
            noWrap: true,
          }}
          secondaryTypographyProps={{
            variant: 'caption',
          }}
        />
      </ListItem>
    </Tooltip>
  );
}
