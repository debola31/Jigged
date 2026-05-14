'use client';

import { useEffect, useState } from 'react';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import Box from '@mui/material/Box';
import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemText from '@mui/material/ListItemText';
import ListItemIcon from '@mui/material/ListItemIcon';
import CircularProgress from '@mui/material/CircularProgress';
import LinearProgress from '@mui/material/LinearProgress';
import Alert from '@mui/material/Alert';
import RadioButtonUncheckedIcon from '@mui/icons-material/RadioButtonUnchecked';
import RadioButtonCheckedIcon from '@mui/icons-material/RadioButtonChecked';
import Link from 'next/link';

import { getAllMarkupRates, bulkApplyMarkupRate } from '@/utils/markupRatesAccess';
import { summarizeBreakpoints, type MarkupRate } from '@/types/markupRates';

interface BulkApplyMarkupRateDialogProps {
  open: boolean;
  onClose: () => void;
  companyId: string;
  partIds: string[];
  onApplied: (result: {
    updated: number;
    failed: number;
    priceUncomputed: number;
    rateName: string;
  }) => void;
}

export default function BulkApplyMarkupRateDialog({
  open,
  onClose,
  companyId,
  partIds,
  onApplied,
}: BulkApplyMarkupRateDialogProps) {
  const [rates, setRates] = useState<MarkupRate[]>([]);
  const [loadingRates, setLoadingRates] = useState(false);
  const [selectedRateId, setSelectedRateId] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoadingRates(true);
    setError(null);
    setSelectedRateId(null);
    getAllMarkupRates(companyId)
      .then((data) => {
        if (cancelled) return;
        setRates(data);
        const defaultRate = data.find((r) => r.is_default);
        setSelectedRateId(defaultRate?.id ?? data[0]?.id ?? null);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to load markup rates');
      })
      .finally(() => {
        if (!cancelled) setLoadingRates(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, companyId]);

  const handleConfirm = async () => {
    if (!selectedRateId) return;
    const rate = rates.find((r) => r.id === selectedRateId);
    if (!rate) return;
    setApplying(true);
    setProgress({ done: 0, total: partIds.length });
    setError(null);
    try {
      const result = await bulkApplyMarkupRate(
        companyId,
        partIds,
        selectedRateId,
        (done, total) => setProgress({ done, total }),
      );
      onApplied({
        updated: result.updated,
        failed: result.failed.length,
        priceUncomputed: result.priceUncomputed,
        rateName: rate.name,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to apply markup rate');
    } finally {
      setApplying(false);
      setProgress(null);
    }
  };

  const handleClose = () => {
    if (applying) return;
    onClose();
  };

  return (
    <Dialog open={open} onClose={handleClose} maxWidth="sm" fullWidth>
      <DialogTitle sx={{ pb: 1 }}>
        Set markup rate
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
          Apply a rate to <strong>{partIds.length}</strong> part
          {partIds.length === 1 ? '' : 's'}. The rate&apos;s breakpoints replace each
          part&apos;s pricing tiers, and the parts will stay linked so future rate
          edits cascade.
        </Typography>
      </DialogTitle>
      <DialogContent sx={{ pt: 1 }}>
        {error && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {error}
          </Alert>
        )}
        {progress && (
          <Box sx={{ mb: 2 }}>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 0.5 }}>
              <Typography variant="body2" color="text.secondary">
                Applying...
              </Typography>
              <Typography variant="body2" color="text.secondary">
                {progress.done} / {progress.total}
              </Typography>
            </Box>
            <LinearProgress
              variant="determinate"
              value={progress.total > 0 ? (progress.done / progress.total) * 100 : 0}
            />
          </Box>
        )}
        {loadingRates ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
            <CircularProgress size={28} />
          </Box>
        ) : rates.length === 0 ? (
          <Box sx={{ py: 3, textAlign: 'center' }}>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              No markup rates yet.
            </Typography>
            <Button
              component={Link}
              href={`/dashboard/${companyId}/markup-rates/new`}
              variant="outlined"
            >
              Create a rate
            </Button>
          </Box>
        ) : (
          <List dense disablePadding>
            {rates.map((rate) => {
              const isSelected = selectedRateId === rate.id;
              return (
                <ListItemButton
                  key={rate.id}
                  selected={isSelected}
                  onClick={() => setSelectedRateId(rate.id)}
                  disabled={applying}
                  sx={{ borderRadius: 1, mb: 0.5 }}
                >
                  <ListItemIcon sx={{ minWidth: 32 }}>
                    {isSelected ? (
                      <RadioButtonCheckedIcon fontSize="small" color="primary" />
                    ) : (
                      <RadioButtonUncheckedIcon fontSize="small" />
                    )}
                  </ListItemIcon>
                  <ListItemText
                    primary={rate.is_default ? `${rate.name} (default)` : rate.name}
                    secondary={summarizeBreakpoints(rate.breakpoints)}
                    slotProps={{
                      primary: { sx: { fontWeight: 500 } },
                      secondary: { sx: { fontSize: '0.75rem' } },
                    }}
                  />
                </ListItemButton>
              );
            })}
          </List>
        )}
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2.5 }}>
        <Button onClick={handleClose} disabled={applying} color="inherit" size="large">
          Cancel
        </Button>
        <Button
          onClick={handleConfirm}
          variant="contained"
          disabled={applying || loadingRates || !selectedRateId}
          size="large"
          startIcon={applying ? <CircularProgress size={16} color="inherit" /> : null}
        >
          {applying ? 'Applying...' : 'Apply'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
