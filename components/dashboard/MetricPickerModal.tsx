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
import { type MetricKey, AVAILABLE_METRICS } from '@/utils/dashboardAccess';

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

  useEffect(() => {
    if (open) setSelected(currentKeys);
  }, [open, currentKeys]);

  const handleToggle = (key: MetricKey) => {
    if (selected.includes(key)) {
      setSelected(selected.filter((k) => k !== key));
    } else if (selected.length < 4) {
      setSelected([...selected, key]);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle>
        Choose Metrics
        <Typography variant="body2" color="text.secondary">
          Select up to 4 metrics to pin on your dashboard.
        </Typography>
      </DialogTitle>
      <DialogContent dividers sx={{ p: 0 }}>
        <List disablePadding>
          {AVAILABLE_METRICS.map((metric) => {
            const isSelected = selected.includes(metric.key);
            const isDisabled = !isSelected && selected.length >= 4;

            return (
              <ListItem key={metric.key} disablePadding>
                <ListItemButton
                  onClick={() => handleToggle(metric.key)}
                  disabled={isDisabled}
                  sx={{ py: 1.5 }}
                >
                  <Checkbox
                    checked={isSelected}
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
