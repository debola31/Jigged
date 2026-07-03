'use client';

import { useState, useCallback } from 'react';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import Button from '@mui/material/Button';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Alert from '@mui/material/Alert';
import CircularProgress from '@mui/material/CircularProgress';
import Divider from '@mui/material/Divider';
import Radio from '@mui/material/Radio';
import RadioGroup from '@mui/material/RadioGroup';
import FormControlLabel from '@mui/material/FormControlLabel';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import TextField from '@mui/material/TextField';
import {
  preflightJobPush,
  pushJobToQuickBooks,
  type PreflightResult,
  type PushCustomerDecision,
  type BillablePart,
} from '@/utils/quickbooksAccess';
import { isValidQuantityInput } from '@/lib/quantityInput';

const CREATE_SENTINEL = '__create__';

interface PushToQuickBooksDialogProps {
  open: boolean;
  companyId: string;
  jobId: string;
  jobNumber: string;
  onClose: () => void;
  onPushed: (message: string) => void;
}

function formatCurrency(n: number): string {
  return n.toLocaleString(undefined, { style: 'currency', currency: 'USD' });
}

/**
 * Create ONE QuickBooks invoice for a job, billing a chosen quantity of each part.
 * A job can have many invoices (progressive billing). The picker defaults each line
 * to the shipped-but-unbilled qty and caps it at ordered-but-unbilled — billing
 * beyond what's shipped is allowed (a packing slip isn't a delivery), just nudged.
 * Each open mints a fresh idempotency id so a double-click can't create two invoices.
 */
export default function PushToQuickBooksDialog({
  open,
  companyId,
  jobId,
  jobNumber,
  onClose,
  onPushed,
}: PushToQuickBooksDialogProps) {
  const [loading, setLoading] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preflight, setPreflight] = useState<PreflightResult | null>(null);
  const [choice, setChoice] = useState<string>(CREATE_SENTINEL);
  const [qtyById, setQtyById] = useState<Record<string, string>>({});
  // Client-minted idempotency key for THIS invoice draft — one per dialog open.
  const [requestId, setRequestId] = useState<string>('');

  const runPreflight = useCallback(async () => {
    setLoading(true);
    setError(null);
    setPreflight(null);
    try {
      const result = await preflightJobPush(companyId, jobId);
      setPreflight(result);
      setRequestId(crypto.randomUUID());
      const c = result.customer;
      if (c) {
        if (c.status === 'mapped' || c.status === 'exact_match') {
          setChoice(c.qb_customer_id ?? CREATE_SENTINEL);
        } else if (c.status === 'candidates' && c.candidates.length > 0) {
          setChoice(c.candidates[0].qb_id);
        } else {
          setChoice(CREATE_SENTINEL);
        }
      }
      // Default each line to bill everything shipped-but-unbilled (the invoiceable qty).
      const initial: Record<string, string> = {};
      for (const p of result.parts ?? []) {
        // Default to what's shipped-but-unbilled (the common "bill what went out"
        // case); the user can raise it up to the ordered-but-unbilled cap.
        const su = Math.max(0, p.qty_shipped - p.qty_invoiced);
        initial[p.job_part_id] = su > 0 ? String(su) : '0';
      }
      setQtyById(initial);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to prepare the QuickBooks push.');
    } finally {
      setLoading(false);
    }
  }, [companyId, jobId]);

  const setQty = (id: string, value: string) => {
    if (value === '' || isValidQuantityInput(value)) {
      setQtyById((prev) => ({ ...prev, [id]: value }));
    }
  };

  const parts = preflight?.parts ?? [];
  const billable = parts.filter((p) => p.qty_invoiceable > 0 && p.unit_price !== null);

  const lineQty = (id: string): number => {
    const n = parseFloat(qtyById[id] ?? '');
    return Number.isFinite(n) ? n : 0;
  };
  const shippedUnbilled = (p: BillablePart): number => Math.max(0, p.qty_shipped - p.qty_invoiced);
  const lineError = (jobPartId: string, invoiceable: number): string | null => {
    const s = qtyById[jobPartId] ?? '';
    if (s.trim() === '') return null;
    const n = parseFloat(s);
    if (!Number.isFinite(n) || n < 0) return 'Enter a quantity of zero or more.';
    if (n > invoiceable + 1e-9) return `Only ${invoiceable} left to invoice.`;
    return null;
  };
  // Non-blocking nudge: billing more than has shipped is allowed (a packing slip
  // isn't a delivery), just flagged so it's a conscious choice.
  const lineWarn = (p: BillablePart): string | null => {
    if (lineError(p.job_part_id, p.qty_invoiceable)) return null;
    return lineQty(p.job_part_id) > shippedUnbilled(p) + 1e-9
      ? `only ${shippedUnbilled(p)} shipped so far`
      : null;
  };

  const total = billable.reduce((sum, p) => sum + lineQty(p.job_part_id) * (p.unit_price ?? 0), 0);
  const anyToBill = billable.some((p) => lineQty(p.job_part_id) > 0);
  const anyError = billable.some((p) => !!lineError(p.job_part_id, p.qty_invoiceable));

  const notConnected = preflight !== null && preflight.connected === false;
  const nothingBillable = preflight?.connected === true && billable.length === 0;
  const canPush =
    !loading && !pushing && preflight?.connected === true && anyToBill && !anyError;

  const handlePush = async () => {
    setPushing(true);
    setError(null);
    // Pre-open a tab *synchronously* within this click so the browser's popup
    // blocker allows it; we point it at the QuickBooks invoice once the push
    // returns. (A window.open after the await loses the user-activation the
    // blocker requires.) If the push yields no invoice, close the placeholder.
    const invoiceWindow = typeof window !== 'undefined' ? window.open('', '_blank') : null;
    if (invoiceWindow) invoiceWindow.opener = null; // reverse-tabnabbing guard
    try {
      const customer: PushCustomerDecision =
        choice === CREATE_SENTINEL
          ? { action: 'create' }
          : { action: 'use_existing', qb_customer_id: choice };
      const lines = billable
        .filter((p) => lineQty(p.job_part_id) > 0)
        .map((p) => ({ job_part_id: p.job_part_id, quantity: lineQty(p.job_part_id) }));
      const result = await pushJobToQuickBooks(companyId, jobId, customer, requestId, lines);
      if (result.in_progress) {
        invoiceWindow?.close();
        setError('This invoice is already being created. Please refresh in a moment.');
        return;
      }
      // Take the user straight to the invoice that was just created (or already
      // existed) in QuickBooks, rather than only flashing a notification.
      if (result.url) {
        if (invoiceWindow) invoiceWindow.location.href = result.url;
        else window.open(result.url, '_blank', 'noopener,noreferrer');
      } else {
        invoiceWindow?.close();
      }
      const docRef = result.doc_number ? `Invoice ${result.doc_number}` : 'Invoice';
      onPushed(
        result.already_existed
          ? `${docRef} was already in QuickBooks.`
          : `${docRef} created in QuickBooks.`,
      );
    } catch (err) {
      invoiceWindow?.close();
      setError(err instanceof Error ? err.message : 'Failed to push to QuickBooks.');
    } finally {
      setPushing(false);
    }
  };

  const customer = preflight?.customer;
  const showCustomerChoices =
    customer &&
    (customer.status === 'exact_match' ||
      customer.status === 'candidates' ||
      customer.status === 'unmatched');

  return (
    <Dialog
      open={open}
      onClose={pushing ? undefined : onClose}
      maxWidth="sm"
      fullWidth
      // Run preflight each time the dialog opens (house convention: onEnter, not useEffect).
      TransitionProps={{ onEnter: runPreflight }}
    >
      <DialogTitle>Create QuickBooks invoice for {jobNumber}</DialogTitle>
      <DialogContent dividers>
        {loading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
            <CircularProgress />
          </Box>
        ) : notConnected ? (
          <Alert severity="info">
            QuickBooks isn&apos;t connected. Ask an admin to connect it in Settings.
          </Alert>
        ) : (
          <>
            {error && (
              <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>
                {error}
              </Alert>
            )}

            {customer && (
              <Box sx={{ mb: 3 }}>
                <Typography variant="subtitle2" sx={{ fontWeight: 600, mb: 1 }}>
                  Customer
                </Typography>
                {customer.status === 'mapped' ? (
                  <Typography variant="body2" color="text.secondary">
                    <strong>{customer.jigged_name}</strong> is already linked to QuickBooks.
                  </Typography>
                ) : (
                  <>
                    <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                      {customer.status === 'unmatched'
                        ? `No QuickBooks customer matches "${customer.jigged_name}".`
                        : `Link "${customer.jigged_name}" to a QuickBooks customer, or create a new one.`}
                    </Typography>
                    {showCustomerChoices && (
                      <RadioGroup value={choice} onChange={(e) => setChoice(e.target.value)}>
                        {customer.candidates.map((cand) => (
                          <FormControlLabel
                            key={cand.qb_id}
                            value={cand.qb_id}
                            control={<Radio size="small" />}
                            label={`Link to: ${cand.display_name ?? cand.qb_id}`}
                          />
                        ))}
                        <FormControlLabel
                          value={CREATE_SENTINEL}
                          control={<Radio size="small" />}
                          label={`Create "${customer.jigged_name}" in QuickBooks`}
                        />
                      </RadioGroup>
                    )}
                  </>
                )}
              </Box>
            )}

            <Divider sx={{ mb: 2 }} />

            <Typography variant="subtitle2" sx={{ fontWeight: 600, mb: 1 }}>
              Quantities to invoice
            </Typography>
            {nothingBillable ? (
              <Alert severity="info">
                Everything on this job is already invoiced.
              </Alert>
            ) : (
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Part</TableCell>
                    <TableCell align="right">Left to invoice</TableCell>
                    <TableCell align="right">Qty to bill</TableCell>
                    <TableCell align="right">Amount</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {billable.map((p) => {
                    const err = lineError(p.job_part_id, p.qty_invoiceable);
                    const warn = lineWarn(p);
                    return (
                      <TableRow key={p.job_part_id}>
                        <TableCell>
                          {p.part_name}
                          <Typography variant="caption" color="text.secondary" display="block">
                            {p.qty_ordered} ordered · {p.qty_shipped} shipped
                            {p.qty_invoiced > 0 ? ` · ${p.qty_invoiced} invoiced` : ''}
                            {p.unit_price !== null ? ` · ${formatCurrency(p.unit_price)}/ea` : ''}
                          </Typography>
                        </TableCell>
                        <TableCell align="right">{p.qty_invoiceable}</TableCell>
                        <TableCell align="right">
                          <TextField
                            value={qtyById[p.job_part_id] ?? ''}
                            onChange={(e) => setQty(p.job_part_id, e.target.value)}
                            size="small"
                            error={!!err}
                            helperText={err ?? warn ?? ' '}
                            sx={{ width: 120 }}
                            slotProps={{ htmlInput: { inputMode: 'decimal', style: { textAlign: 'right' } } }}
                          />
                        </TableCell>
                        <TableCell align="right">
                          {formatCurrency(lineQty(p.job_part_id) * (p.unit_price ?? 0))}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                  <TableRow>
                    <TableCell colSpan={3} align="right" sx={{ fontWeight: 600, border: 0 }}>
                      Total
                    </TableCell>
                    <TableCell align="right" sx={{ fontWeight: 600, border: 0 }}>
                      {formatCurrency(total)}
                    </TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            )}
          </>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={pushing}>
          Cancel
        </Button>
        <Button
          variant="contained"
          onClick={handlePush}
          disabled={!canPush}
          startIcon={pushing ? <CircularProgress size={16} color="inherit" /> : undefined}
        >
          {pushing ? 'Creating…' : 'Create Invoice'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
