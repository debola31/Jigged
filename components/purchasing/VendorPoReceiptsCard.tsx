'use client';

import { useState } from 'react';
import posthog from 'posthog-js';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import BlockIcon from '@mui/icons-material/Block';

import ErrorAlert from '@/components/common/ErrorAlert';
import StatusDot from '@/components/common/StatusDot';
import { formatUnitQuantity, unitLabel, unitNameKey } from '@/lib/purchasing/purchaseUnits';
import { voidVendorPoReceipt } from '@/utils/vendorPoAccess';
import type { VendorPoDetail, VendorPoReceipt } from '@/types/vendorPo';

export interface VendorPoReceiptsCardProps {
  po: VendorPoDetail;
  /** An archived PO: the history shows, nothing on it can be voided. */
  readOnly: boolean;
  /** After a void lands: the page refreshes. */
  onVoided: () => void;
}

function quantityText(r: VendorPoReceipt): string {
  return `${formatUnitQuantity(r.quantity)} ${unitLabel(r.unit)}`;
}

/** "= 144 in", when the receipt was typed in a unit other than the stock unit. */
function stockText(r: VendorPoReceipt): string | null {
  if (r.stockQuantity === null || !r.stockUnit || unitNameKey(r.unit) === unitNameKey(r.stockUnit)) return null;
  return `= ${formatUnitQuantity(r.stockQuantity)} ${unitLabel(r.stockUnit)}`;
}

function receivedDate(instant: string): string {
  const d = new Date(instant);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString();
}

/**
 * What arrived against this PO, newest first, voided receipts included and marked (plan §3.13
 * "Receipts card"). A receipt is append-only: a mistake is corrected by VOIDING it, which takes the
 * stock back out through the stock engine — the confirm says exactly what comes off which shelf,
 * and the database refuses when that stock is no longer there (issued to a job, moved on).
 */
export default function VendorPoReceiptsCard({ po, readOnly, onVoided }: VendorPoReceiptsCardProps) {
  const [voiding, setVoiding] = useState<VendorPoReceipt | null>(null);
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const receipts = po.receipts;

  const startVoid = (r: VendorPoReceipt) => {
    setVoiding(r);
    setReason('');
    setError(null);
  };

  const confirmVoid = async () => {
    if (!voiding) return;
    setSaving(true);
    setError(null);
    try {
      await voidVendorPoReceipt(voiding.id, reason.trim() || null);
      posthog.capture('vendor po receipt voided', { line_kind: voiding.lineKind });
      setVoiding(null);
      onVoided();
    } catch (err) {
      setError(err);
    } finally {
      setSaving(false);
    }
  };

  const consequence = (r: VendorPoReceipt): string => {
    const line = r.lineNumber !== null ? `Line ${r.lineNumber}` : 'The line';
    if (r.lineKind === 'part') {
      const stock = stockText(r);
      return (
        `${quantityText(r)}${stock ? ` (${stock.slice(2)})` : ''} comes back out of ${r.locationName ?? 'its place'}` +
        `${r.heatNumber ? `, heat ${r.heatNumber}` : ''}, and ${line.toLowerCase()} goes back to expecting it. ` +
        'The receipt stays on record as voided.'
      );
    }
    return `${line} goes back to expecting ${quantityText(r)}. The receipt stays on record as voided.`;
  };

  return (
    <Card elevation={2}>
      <CardContent>
        <Typography variant="h6" sx={{ fontWeight: 600, mb: 1 }}>
          Receipts
        </Typography>
        {receipts.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            Nothing received yet.
          </Typography>
        ) : (
          <TableContainer>
            <Table size="small" aria-label="Receipts on this purchase order">
              <TableHead>
                <TableRow>
                  <TableCell>Received</TableCell>
                  <TableCell>Line</TableCell>
                  <TableCell align="right">Quantity</TableCell>
                  <TableCell>Place</TableCell>
                  <TableCell>Heat</TableCell>
                  <TableCell>Packing slip</TableCell>
                  <TableCell>By</TableCell>
                  <TableCell align="right" />
                </TableRow>
              </TableHead>
              <TableBody>
                {receipts.map((r) => {
                  const stock = stockText(r);
                  return (
                    <TableRow key={r.id} sx={{ opacity: r.voidedAt ? 0.6 : 1 }}>
                      <TableCell sx={{ whiteSpace: 'nowrap' }}>{receivedDate(r.receivedAt)}</TableCell>
                      <TableCell>Line {r.lineNumber ?? '—'}</TableCell>
                      <TableCell align="right">
                        <Box component="span" sx={{ whiteSpace: 'nowrap' }}>
                          {quantityText(r)}
                        </Box>
                        {stock && (
                          <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                            {stock}
                          </Typography>
                        )}
                      </TableCell>
                      <TableCell>{r.locationName ?? '—'}</TableCell>
                      <TableCell>{r.heatNumber ?? '—'}</TableCell>
                      <TableCell>{r.vendorPackingSlip ?? '—'}</TableCell>
                      <TableCell>{r.receivedByName ?? '—'}</TableCell>
                      <TableCell align="right">
                        {r.voidedAt ? (
                          <StatusDot label={`Voided ${receivedDate(r.voidedAt)}`} color="default" />
                        ) : (
                          !readOnly && (
                            <Button color="error" size="small" startIcon={<BlockIcon />} onClick={() => startVoid(r)}>
                              Void
                            </Button>
                          )
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </TableContainer>
        )}
      </CardContent>

      <Dialog open={voiding !== null} onClose={() => !saving && setVoiding(null)} maxWidth="xs" fullWidth aria-labelledby="void-receipt-title">
        <DialogTitle id="void-receipt-title">Void this receipt?</DialogTitle>
        <DialogContent>
          {voiding && (
            <Typography variant="body2" sx={{ mb: 2 }}>
              {consequence(voiding)}
            </Typography>
          )}
          <TextField
            label="Why (optional)"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            fullWidth
            size="small"
            slotProps={{ htmlInput: { maxLength: 500 } }}
          />
          {error != null && <ErrorAlert error={error} entity="receipt" onClose={() => setError(null)} sx={{ mt: 2 }} />}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setVoiding(null)} disabled={saving}>
            Keep it
          </Button>
          <Button
            color="error"
            variant="contained"
            onClick={() => void confirmVoid()}
            disabled={saving}
            startIcon={saving ? <CircularProgress size={16} color="inherit" /> : <BlockIcon />}
          >
            {saving ? 'Voiding…' : 'Void receipt'}
          </Button>
        </DialogActions>
      </Dialog>
    </Card>
  );
}
