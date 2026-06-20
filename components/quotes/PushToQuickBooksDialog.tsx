'use client';

import { useState, useEffect, useCallback } from 'react';
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
import {
  preflightQuotePush,
  pushQuoteToQuickBooks,
  type PreflightResult,
  type PushCustomerDecision,
} from '@/utils/quickbooksAccess';

const CREATE_SENTINEL = '__create__';

interface PushToQuickBooksDialogProps {
  open: boolean;
  companyId: string;
  quoteId: string;
  quoteNumber: string;
  onClose: () => void;
  onPushed: (message: string) => void;
}

function formatCurrency(n: number): string {
  return n.toLocaleString(undefined, { style: 'currency', currency: 'USD' });
}

export default function PushToQuickBooksDialog({
  open,
  companyId,
  quoteId,
  quoteNumber,
  onClose,
  onPushed,
}: PushToQuickBooksDialogProps) {
  const [loading, setLoading] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preflight, setPreflight] = useState<PreflightResult | null>(null);
  const [choice, setChoice] = useState<string>(CREATE_SENTINEL);

  const runPreflight = useCallback(async () => {
    setLoading(true);
    setError(null);
    setPreflight(null);
    try {
      const result = await preflightQuotePush(companyId, quoteId);
      setPreflight(result);
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
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to prepare the QuickBooks push.');
    } finally {
      setLoading(false);
    }
  }, [companyId, quoteId]);

  useEffect(() => {
    if (open) runPreflight();
  }, [open, runPreflight]);

  const handlePush = async () => {
    setPushing(true);
    setError(null);
    try {
      const customer: PushCustomerDecision =
        choice === CREATE_SENTINEL
          ? { action: 'create' }
          : { action: 'use_existing', qb_customer_id: choice };
      const result = await pushQuoteToQuickBooks(companyId, quoteId, customer);
      if (result.in_progress) {
        setError('A push for this quote is already in progress. Please refresh in a moment.');
        return;
      }
      const docRef = result.doc_number ? `Invoice ${result.doc_number}` : 'Invoice';
      onPushed(
        result.already_existed
          ? `${docRef} was already in QuickBooks.`
          : `${docRef} created in QuickBooks.`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to push to QuickBooks.');
    } finally {
      setPushing(false);
    }
  };

  const customer = preflight?.customer;
  const lines = preflight?.lines_preview ?? [];
  const total = lines.reduce((sum, ln) => sum + ln.amount, 0);

  const notConnected = preflight !== null && preflight.connected === false;
  const alreadyPushed = preflight?.already_pushed === true;
  const canPush = !loading && !pushing && preflight?.connected === true && !alreadyPushed;

  const showCustomerChoices =
    customer && (customer.status === 'exact_match' || customer.status === 'candidates' || customer.status === 'unmatched');

  return (
    <Dialog open={open} onClose={pushing ? undefined : onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Push {quoteNumber} to QuickBooks</DialogTitle>
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
            {alreadyPushed && (
              <Alert
                severity="success"
                sx={{ mb: 2 }}
                action={
                  preflight?.invoice_url ? (
                    <Button
                      color="inherit"
                      size="small"
                      href={preflight.invoice_url}
                      target="_blank"
                      rel="noopener"
                    >
                      View in QuickBooks
                    </Button>
                  ) : undefined
                }
              >
                This quote has already been pushed to QuickBooks.
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
              Invoice lines
            </Typography>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Part</TableCell>
                  <TableCell align="right">Qty</TableCell>
                  <TableCell align="right">Rate</TableCell>
                  <TableCell align="right">Amount</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {lines.map((ln, i) => (
                  <TableRow key={i}>
                    <TableCell>{ln.part_name}</TableCell>
                    <TableCell align="right">{ln.quantity}</TableCell>
                    <TableCell align="right">
                      {ln.unit_price !== null ? formatCurrency(ln.unit_price) : '—'}
                    </TableCell>
                    <TableCell align="right">{formatCurrency(ln.amount)}</TableCell>
                  </TableRow>
                ))}
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
          {pushing ? 'Pushing…' : 'Push to QuickBooks'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
