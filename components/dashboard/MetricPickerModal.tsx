'use client';

import { useState, useEffect } from 'react';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import Button from '@mui/material/Button';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemText from '@mui/material/ListItemText';
import Checkbox from '@mui/material/Checkbox';
import Typography from '@mui/material/Typography';
import Box from '@mui/material/Box';
import DragIndicatorIcon from '@mui/icons-material/DragIndicator';
import {
  DndContext,
  closestCenter,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
  arrayMove,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { type MetricKey, AVAILABLE_METRICS, type MetricDefinition } from '@/utils/dashboardAccess';

interface MetricPickerModalProps {
  open: boolean;
  onClose: () => void;
  currentKeys: MetricKey[];
  onSave: (keys: MetricKey[]) => void;
}

function SortableMetricItem({
  metric,
  onToggle,
}: {
  metric: MetricDefinition;
  onToggle: (key: MetricKey) => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: metric.key });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 1 : undefined,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <ListItem
      ref={setNodeRef}
      style={style}
      disablePadding
      secondaryAction={
        <Box
          {...attributes}
          {...listeners}
          sx={{
            display: 'flex',
            alignItems: 'center',
            cursor: 'grab',
            color: 'text.secondary',
            touchAction: 'none',
            '&:active': { cursor: 'grabbing' },
          }}
        >
          <DragIndicatorIcon fontSize="small" />
        </Box>
      }
    >
      <ListItemButton onClick={() => onToggle(metric.key)} sx={{ py: 1.5 }}>
        <Checkbox
          checked
          tabIndex={-1}
          disableRipple
          sx={{ mr: 1 }}
        />
        <ListItemText primary={metric.label} />
      </ListItemButton>
    </ListItem>
  );
}

export default function MetricPickerModal({
  open,
  onClose,
  currentKeys,
  onSave,
}: MetricPickerModalProps) {
  const [selected, setSelected] = useState<MetricKey[]>(currentKeys);

  useEffect(() => {
    if (open) setSelected(currentKeys);
  }, [open, currentKeys]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 150, tolerance: 5 } }),
  );

  const handleToggle = (key: MetricKey) => {
    if (selected.includes(key)) {
      setSelected(selected.filter((k) => k !== key));
    } else if (selected.length < 4) {
      setSelected([...selected, key]);
    }
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (over && active.id !== over.id) {
      setSelected((prev) => {
        const oldIndex = prev.indexOf(active.id as MetricKey);
        const newIndex = prev.indexOf(over.id as MetricKey);
        return arrayMove(prev, oldIndex, newIndex);
      });
    }
  };

  const selectedMetrics = selected
    .map((key) => AVAILABLE_METRICS.find((m) => m.key === key)!)
    .filter(Boolean);
  const unselectedMetrics = AVAILABLE_METRICS.filter((m) => !selected.includes(m.key));

  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle>
        Choose Metrics
        <Typography variant="body2" color="text.secondary">
          Select up to 4 metrics. Drag to reorder.
        </Typography>
      </DialogTitle>
      <DialogContent dividers sx={{ p: 0 }}>
        {/* Selected metrics - sortable */}
        {selectedMetrics.length > 0 && (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <SortableContext items={selected} strategy={verticalListSortingStrategy}>
              <List disablePadding>
                {selectedMetrics.map((metric) => (
                  <SortableMetricItem
                    key={metric.key}
                    metric={metric}
                    onToggle={handleToggle}
                  />
                ))}
              </List>
            </SortableContext>
          </DndContext>
        )}

        {/* Unselected metrics */}
        {unselectedMetrics.length > 0 && (
          <List disablePadding>
            {selectedMetrics.length > 0 && (
              <Box sx={{ borderTop: 1, borderColor: 'divider' }} />
            )}
            {unselectedMetrics.map((metric) => {
              const isDisabled = selected.length >= 4;
              return (
                <ListItem key={metric.key} disablePadding>
                  <ListItemButton
                    onClick={() => handleToggle(metric.key)}
                    disabled={isDisabled}
                    sx={{ py: 1.5 }}
                  >
                    <Checkbox
                      checked={false}
                      disabled={isDisabled}
                      tabIndex={-1}
                      disableRipple
                      sx={{ mr: 1 }}
                    />
                    <ListItemText primary={metric.label} />
                  </ListItemButton>
                </ListItem>
              );
            })}
          </List>
        )}
      </DialogContent>
      <DialogActions sx={{ px: 3, py: 2 }}>
        <Button onClick={onClose} sx={{ minHeight: 48 }}>
          Cancel
        </Button>
        <Button
          variant="contained"
          onClick={() => onSave(selected)}
          sx={{ minHeight: 48 }}
        >
          Save
        </Button>
      </DialogActions>
    </Dialog>
  );
}
