'use client';

import { useState } from 'react';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemText from '@mui/material/ListItemText';
import Checkbox from '@mui/material/Checkbox';
import Typography from '@mui/material/Typography';
import Box from '@mui/material/Box';
import ArrowUpwardIcon from '@mui/icons-material/ArrowUpward';
import ArrowDownwardIcon from '@mui/icons-material/ArrowDownward';
import { type MetricKey, PICKABLE_METRICS, PINNED_METRIC_SLOTS } from '@/utils/dashboardAccess';

interface MetricPickerModalProps {
  open: boolean;
  onClose: () => void;
  currentKeys: MetricKey[];
  onSave: (keys: MetricKey[]) => void;
}

export default function MetricPickerModal({
  open,
  onClose,
  currentKeys,
  onSave,
}: MetricPickerModalProps) {
  const [selected, setSelected] = useState<MetricKey[]>(currentKeys);

  const handleToggle = (key: MetricKey) => {
    if (selected.includes(key)) {
      setSelected(selected.filter((k) => k !== key));
    } else if (selected.length < PINNED_METRIC_SLOTS) {
      setSelected([...selected, key]);
    }
  };

  const moveUp = (index: number) => {
    if (index <= 0) return;
    setSelected((prev) => {
      const copy = [...prev];
      [copy[index - 1], copy[index]] = [copy[index], copy[index - 1]];
      return copy;
    });
  };

  const moveDown = (index: number) => {
    setSelected((prev) => {
      if (index >= prev.length - 1) return prev;
      const copy = [...prev];
      [copy[index + 1], copy[index]] = [copy[index], copy[index + 1]];
      return copy;
    });
  };

  const selectedMetrics = selected
    .map((key) => PICKABLE_METRICS.find((m) => m.key === key)!)
    .filter(Boolean);
  const unselectedMetrics = PICKABLE_METRICS.filter((m) => !selected.includes(m.key));

  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth="xs"
      fullWidth
      // Re-seed the selection from the current pins each time the modal opens
      // (house convention: onEnter, not a reset useEffect).
      TransitionProps={{ onEnter: () => setSelected(currentKeys) }}
    >
      <DialogTitle>
        Choose Metrics
        <Typography variant="body2" color="text.secondary">
          Select up to 4 metrics. Use the arrows to reorder.
        </Typography>
      </DialogTitle>
      <DialogContent dividers sx={{ p: 0 }}>
        {selectedMetrics.length > 0 && (
          <List disablePadding>
            {selectedMetrics.map((metric, index) => (
              <ListItem
                key={metric.key}
                disablePadding
                secondaryAction={
                  <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.25, pr: 1 }}>
                    <IconButton
                      size="small"
                      onClick={() => moveUp(index)}
                      disabled={index === 0}
                      aria-label={`Move ${metric.label} up`}
                      sx={{ p: 0.25 }}
                    >
                      <ArrowUpwardIcon sx={{ fontSize: 18 }} />
                    </IconButton>
                    <IconButton
                      size="small"
                      onClick={() => moveDown(index)}
                      disabled={index === selectedMetrics.length - 1}
                      aria-label={`Move ${metric.label} down`}
                      sx={{ p: 0.25 }}
                    >
                      <ArrowDownwardIcon sx={{ fontSize: 18 }} />
                    </IconButton>
                  </Box>
                }
              >
                <ListItemButton onClick={() => handleToggle(metric.key)} sx={{ py: 1.5 }}>
                  <Checkbox
                    checked
                    tabIndex={-1}
                    disableRipple
                    sx={{ mr: 1 }}
                  />
                  <ListItemText primary={metric.label} />
                </ListItemButton>
              </ListItem>
            ))}
          </List>
        )}

        {unselectedMetrics.length > 0 && (
          <List disablePadding>
            {selectedMetrics.length > 0 && (
              <Box sx={{ borderTop: 1, borderColor: 'divider' }} />
            )}
            {unselectedMetrics.map((metric) => {
              const isDisabled = selected.length >= PINNED_METRIC_SLOTS;
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
