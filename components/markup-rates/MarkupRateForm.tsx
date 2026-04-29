'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import TextField from '@mui/material/TextField';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import Divider from '@mui/material/Divider';
import IconButton from '@mui/material/IconButton';
import Alert from '@mui/material/Alert';
import CircularProgress from '@mui/material/CircularProgress';
import Table from '@mui/material/Table';
import TableHead from '@mui/material/TableHead';
import TableBody from '@mui/material/TableBody';
import TableRow from '@mui/material/TableRow';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import FormControlLabel from '@mui/material/FormControlLabel';
import Switch from '@mui/material/Switch';
import AddIcon from '@mui/icons-material/Add';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import DeleteIcon from '@mui/icons-material/Delete';
import {
  type MarkupRateFormData,
  EMPTY_MARKUP_RATE_FORM,
} from '@/types/markupRates';
import {
  createMarkupRate,
  updateMarkupRate,
  deleteMarkupRate,
  checkMarkupRateNameExists,
} from '@/utils/markupRatesAccess';

interface MarkupRateFormProps {
  companyId: string;
  mode: 'create' | 'edit';
  rateId?: string;
  initialData?: MarkupRateFormData;
}

interface RowDraft {
  qty: string;
  markupPercent: string;
}

function toRowDrafts(formData: MarkupRateFormData): RowDraft[] {
  if (formData.breakpoints.length === 0) {
    return [{ qty: '1', markupPercent: '25' }];
  }
  return formData.breakpoints.map((bp) => ({
    qty: String(bp.qty),
    markupPercent: String(bp.markup_percent),
  }));
}

function parseInteger(s: string): number | null {
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

function parseDecimal(s: string): number | null {
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export default function MarkupRateForm({
  companyId,
  mode,
  rateId,
  initialData,
}: MarkupRateFormProps) {
  const router = useRouter();
  const seed = initialData ?? EMPTY_MARKUP_RATE_FORM;

  const [name, setName] = useState(seed.name);
  const [description, setDescription] = useState(seed.description);
  const [rows, setRows] = useState<RowDraft[]>(toRowDrafts(seed));
  const [isDefault, setIsDefault] = useState(seed.is_default);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // True when this row is the company's current default. Drives copy in the
  // toggle helper text and prevents the user from accidentally clearing it
  // without realizing what they're giving up.
  const wasDefaultOnLoad = mode === 'edit' && initialData?.is_default === true;

  const updateRow = (idx: number, patch: Partial<RowDraft>) => {
    setRows((prev) => prev.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  };

  const addRow = () => {
    // Default the new row to (last_qty × 10, last_markup − 3) — sensible
    // starting values for a volume-discount breakpoint.
    const last = rows[rows.length - 1];
    const lastQty = last ? parseInteger(last.qty) ?? 1 : 1;
    const lastMarkup = last ? parseDecimal(last.markupPercent) ?? 25 : 25;
    setRows((prev) => [
      ...prev,
      {
        qty: String(lastQty * 10),
        markupPercent: String(Math.max(0, lastMarkup - 3)),
      },
    ]);
  };

  const removeRow = (idx: number) => {
    setRows((prev) => (prev.length > 1 ? prev.filter((_, i) => i !== idx) : prev));
  };

  const handleSave = async () => {
    setError(null);
    setNameError(null);

    const trimmedName = name.trim();
    if (!trimmedName) {
      setNameError('Name is required');
      return;
    }

    // Validate breakpoints — at least one row with valid qty + markup.
    const breakpoints = rows
      .map((r) => ({
        qty: parseInteger(r.qty),
        markup_percent: parseDecimal(r.markupPercent),
      }))
      .filter(
        (bp): bp is { qty: number; markup_percent: number } =>
          bp.qty !== null && bp.markup_percent !== null,
      );

    if (breakpoints.length === 0) {
      setError('Add at least one breakpoint with a valid quantity and markup %.');
      return;
    }

    // Detect duplicate qtys — would create ambiguous lookup at apply time.
    const qtys = breakpoints.map((bp) => bp.qty);
    if (new Set(qtys).size !== qtys.length) {
      setError('Each breakpoint needs a unique quantity.');
      return;
    }

    setSaving(true);
    try {
      // Server enforces uniqueness via the (company_id, name) constraint, but
      // we check first so the user gets an inline error rather than a 23505.
      const exists = await checkMarkupRateNameExists(companyId, trimmedName, rateId);
      if (exists) {
        setNameError('A rate with this name already exists.');
        setSaving(false);
        return;
      }

      const formData: MarkupRateFormData = {
        name: trimmedName,
        description: description.trim(),
        breakpoints,
        is_default: isDefault,
      };

      if (mode === 'create') {
        await createMarkupRate(companyId, formData);
      } else if (rateId) {
        await updateMarkupRate(rateId, formData);
      }
      router.push(`/dashboard/${companyId}/markup-rates`);
    } catch (err) {
      console.error('Failed to save markup rate:', err);
      setError(err instanceof Error ? err.message : 'Failed to save markup rate');
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!rateId) return;
    setDeleting(true);
    setError(null);
    try {
      await deleteMarkupRate(rateId);
      router.push(`/dashboard/${companyId}/markup-rates`);
    } catch (err) {
      console.error('Failed to delete markup rate:', err);
      setError(err instanceof Error ? err.message : 'Failed to delete markup rate');
      setDeleting(false);
      setDeleteDialogOpen(false);
    }
  };

  return (
    <Card elevation={2}>
      <CardContent>
        <Typography variant="h6" sx={{ fontWeight: 600, mb: 2 }}>
          {mode === 'create' ? 'New Markup Rate' : 'Edit Markup Rate'}
        </Typography>
        <Divider sx={{ mb: 3 }} />

        {error && (
          <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>
            {error}
          </Alert>
        )}

        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          <TextField
            label="Name"
            placeholder="e.g. ACME Q4, Aerospace, Premium small batch"
            helperText={
              nameError ??
              'Use a customer name, a strategy, or an industry — whatever helps you remember when to apply it.'
            }
            error={Boolean(nameError)}
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              if (nameError) setNameError(null);
            }}
            fullWidth
            required
            disabled={saving}
            slotProps={{ htmlInput: { maxLength: 100 } }}
          />

          <TextField
            label="Description"
            placeholder="Optional — what is this rate for?"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            fullWidth
            multiline
            rows={2}
            disabled={saving}
            slotProps={{ htmlInput: { maxLength: 500 } }}
          />

          <Box>
            <Typography variant="subtitle2" sx={{ fontWeight: 600, mb: 1 }}>
              Breakpoints
            </Typography>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1.5 }}>
              Each row sets the markup % at a quantity threshold. When applied, parts with at
              least one breakpoint price tiers based on these rules.
            </Typography>

            <TableContainer>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Quantity</TableCell>
                    <TableCell align="right">Markup %</TableCell>
                    <TableCell align="right" sx={{ width: 60 }}></TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {rows.map((row, idx) => (
                    <TableRow key={idx}>
                      <TableCell sx={{ minWidth: 120 }}>
                        <TextField
                          size="small"
                          value={row.qty}
                          onChange={(e) => {
                            const v = e.target.value;
                            if (v === '' || /^\d+$/.test(v)) updateRow(idx, { qty: v });
                          }}
                          inputMode="numeric"
                          placeholder="1"
                          disabled={saving}
                          sx={{ width: 100 }}
                        />
                      </TableCell>
                      <TableCell align="right" sx={{ minWidth: 120 }}>
                        <TextField
                          size="small"
                          value={row.markupPercent}
                          onChange={(e) => {
                            const v = e.target.value;
                            if (v === '' || /^\d*\.?\d*$/.test(v))
                              updateRow(idx, { markupPercent: v });
                          }}
                          inputMode="decimal"
                          placeholder="25"
                          disabled={saving}
                          sx={{ width: 100 }}
                        />
                      </TableCell>
                      <TableCell align="right">
                        <IconButton
                          size="small"
                          color="error"
                          onClick={() => removeRow(idx)}
                          disabled={saving || rows.length <= 1}
                          aria-label="Remove breakpoint"
                        >
                          <DeleteOutlineIcon fontSize="small" />
                        </IconButton>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>

            <Box sx={{ display: 'flex', justifyContent: 'flex-end', mt: 1 }}>
              <Button
                size="small"
                variant="outlined"
                startIcon={<AddIcon />}
                onClick={addRow}
                disabled={saving}
              >
                Add breakpoint
              </Button>
            </Box>
          </Box>

          {/* Set-as-default toggle. Promoting demotes the previous default
              atomically (handled in the access layer). Demoting (the user
              turning this off when it was on) leaves the company with no
              default — the list page surfaces that state separately. */}
          <Box>
            <FormControlLabel
              control={
                <Switch
                  checked={isDefault}
                  onChange={(_, checked) => setIsDefault(checked)}
                  disabled={saving}
                />
              }
              label="Set as default rate"
            />
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', ml: 6 }}>
              {isDefault && wasDefaultOnLoad
                ? 'This rate is currently your default — auto-applied to new parts on creation.'
                : isDefault
                  ? 'Saving will make this the default and demote whichever rate is the default today.'
                  : wasDefaultOnLoad
                    ? 'Turning this off leaves no default rate. New parts will start without pricing tiers.'
                    : 'When set, this rate is auto-applied to new parts on creation.'}
            </Typography>
          </Box>

          <Divider />

          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            {mode === 'edit' && (
              <Button
                color="error"
                startIcon={<DeleteIcon />}
                onClick={() => setDeleteDialogOpen(true)}
                disabled={saving || deleting}
              >
                Delete
              </Button>
            )}
            <Box sx={{ flex: 1 }} />
            <Button
              onClick={() => router.push(`/dashboard/${companyId}/markup-rates`)}
              disabled={saving || deleting}
            >
              Cancel
            </Button>
            <Button
              variant="contained"
              onClick={handleSave}
              disabled={saving || deleting}
              startIcon={saving ? <CircularProgress size={16} color="inherit" /> : null}
            >
              {saving ? 'Saving…' : mode === 'create' ? 'Create rate' : 'Save changes'}
            </Button>
          </Box>
        </Box>
      </CardContent>

      <Dialog
        open={deleteDialogOpen}
        onClose={() => !deleting && setDeleteDialogOpen(false)}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle sx={{ pb: 2 }}>Delete Rate</DialogTitle>
        <DialogContent sx={{ pt: 0 }}>
          <Typography variant="body1" sx={{ mb: 1 }}>
            Delete <strong>{initialData?.name ?? 'this rate'}</strong>? Parts that previously
            had it applied keep their pricing tiers — snapshot semantics mean nothing cascades.
          </Typography>
          <Typography variant="body2" color="text.secondary">
            This action cannot be undone.
          </Typography>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2.5 }}>
          <Button
            onClick={() => setDeleteDialogOpen(false)}
            disabled={deleting}
            color="inherit"
            size="large"
          >
            Cancel
          </Button>
          <Button
            onClick={handleDelete}
            variant="contained"
            color="error"
            disabled={deleting}
            size="large"
            startIcon={
              deleting ? <CircularProgress size={16} color="inherit" /> : <DeleteIcon />
            }
          >
            {deleting ? 'Deleting…' : 'Delete'}
          </Button>
        </DialogActions>
      </Dialog>
    </Card>
  );
}
