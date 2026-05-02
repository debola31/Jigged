'use client';

import { useEffect, useState } from 'react';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import Button from '@mui/material/Button';
import Autocomplete from '@mui/material/Autocomplete';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import Alert from '@mui/material/Alert';
import CircularProgress from '@mui/material/CircularProgress';
import Box from '@mui/material/Box';
import {
  getAllMarkupRates,
  bulkApplyMarkupRate,
} from '@/utils/markupRatesAccess';
import {
  type MarkupRate,
  summarizeBreakpoints,
} from '@/types/markupRates';

interface BulkApplyRateDialogProps {
  open: boolean;
  companyId: string;
  partIds: string[];
  onClose: () => void;
  onApplied: (succeeded: number, failed: number) => void;
}

export default function BulkApplyRateDialog({
  open,
  companyId,
  partIds,
  onClose,
  onApplied,
}: BulkApplyRateDialogProps) {
  const [rates, setRates] = useState<MarkupRate[]>([]);
  const [selectedRate, setSelectedRate] = useState<MarkupRate | null>(null);
  const [loadingRates, setLoadingRates] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset selection + error each time the dialog opens, and load the
  // company's rates fresh so newly-created rates show up without a refresh.
  useEffect(() => {
    if (!open) return;
    setSelectedRate(null);
    setError(null);
    setLoadingRates(true);
    getAllMarkupRates(companyId)
      .then(setRates)
      .catch((err) => {
        console.error('Failed to load markup rates:', err);
        setError(err instanceof Error ? err.message : 'Failed to load rates');
      })
      .finally(() => setLoadingRates(false));
  }, [open, companyId]);

  const handleApply = async () => {
    if (!selectedRate) return;
    setApplying(true);
    setError(null);
    try {
      const result = await bulkApplyMarkupRate(
        companyId,
        partIds,
        selectedRate.id,
      );
      onApplied(result.succeeded.length, result.failed.length);
      onClose();
    } catch (err) {
      console.error('Failed to bulk apply markup rate:', err);
      setError(err instanceof Error ? err.message : 'Failed to apply rate');
    } finally {
      setApplying(false);
    }
  };

  const partCount = partIds.length;

  return (
    <Dialog
      open={open}
      onClose={() => !applying && onClose()}
      maxWidth="sm"
      fullWidth
    >
      <DialogTitle>
        Apply markup rate to {partCount} part{partCount === 1 ? '' : 's'}
      </DialogTitle>
      <DialogContent>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          The selected rate&apos;s breakpoints will replace each part&apos;s pricing tiers.
          Future edits to the rate will cascade into these parts automatically.
        </Typography>

        {error && (
          <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>
            {error}
          </Alert>
        )}

        <Autocomplete
          options={rates}
          value={selectedRate}
          onChange={(_, v) => setSelectedRate(v)}
          getOptionLabel={(rate) => rate.name}
          isOptionEqualToValue={(o, v) => o.id === v.id}
          loading={loadingRates}
          disabled={applying}
          renderInput={(params) => (
            <TextField
              {...params}
              label="Markup rate"
              autoFocus
              slotProps={{
                input: {
                  ...params.InputProps,
                  endAdornment: (
                    <>
                      {loadingRates ? <CircularProgress size={16} /> : null}
                      {params.InputProps.endAdornment}
                    </>
                  ),
                },
              }}
            />
          )}
          renderOption={(props, rate) => {
            const { key, ...rest } = props as React.HTMLAttributes<HTMLLIElement> & {
              key: string;
            };
            return (
              <li key={key} {...rest}>
                <Box>
                  <Typography variant="body2" sx={{ fontWeight: 500 }}>
                    {rate.name}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    {summarizeBreakpoints(rate.breakpoints)}
                  </Typography>
                </Box>
              </li>
            );
          }}
        />

        {selectedRate && (
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ display: 'block', mt: 1 }}
          >
            {summarizeBreakpoints(selectedRate.breakpoints)}
          </Typography>
        )}
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2.5 }}>
        <Button onClick={onClose} disabled={applying} color="inherit">
          Cancel
        </Button>
        <Button
          variant="contained"
          onClick={handleApply}
          disabled={!selectedRate || applying || partCount === 0}
          startIcon={applying ? <CircularProgress size={16} color="inherit" /> : null}
        >
          {applying
            ? 'Applying…'
            : `Apply to ${partCount} part${partCount === 1 ? '' : 's'}`}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
