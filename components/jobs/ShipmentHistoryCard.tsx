'use client';

import { useCallback, useEffect, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Divider from '@mui/material/Divider';
import IconButton from '@mui/material/IconButton';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import BlockIcon from '@mui/icons-material/Block';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import PrintIcon from '@mui/icons-material/Print';

import { getShipmentsForJob, voidShipment } from '@/utils/shipmentsAccess';
import type { ShipmentWithRelations } from '@/types/shipment';
import { SHIPPING_METHOD_LABELS } from '@/types/shipment';
import PackingSlipPreviewDialog from '@/components/shipments/PackingSlipPreviewDialog';

interface ShipmentHistoryCardProps {
  jobId: string;
  /** Set to a new value (e.g., Date.now()) when a fresh shipment has been created so the card refetches. */
  refreshKey?: number;
  /**
   * Optional: when set to a shipment id, the card mounts with the
   * preview dialog already open on that row (e.g., right after the
   * RPC returns from create_shipment_with_line_items).
   */
  initialPreviewShipmentId?: string | null;
  /**
   * Optional: fired after a shipment is voided so the parent can re-pull
   * the job + per-part fulfillment summaries (the void cascade changes
   * job_parts.fulfillment_status). The card reloads its own list.
   */
  onShipmentVoided?: () => void;
}

export default function ShipmentHistoryCard({
  jobId,
  refreshKey = 0,
  initialPreviewShipmentId = null,
  onShipmentVoided,
}: ShipmentHistoryCardProps) {
  const [shipments, setShipments] = useState<ShipmentWithRelations[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [previewId, setPreviewId] = useState<string | null>(initialPreviewShipmentId);
  const [voidTarget, setVoidTarget] = useState<ShipmentWithRelations | null>(null);
  const [voiding, setVoiding] = useState(false);
  const [voidError, setVoidError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const rows = await getShipmentsForJob(jobId);
      // The PostgREST inner-join produces one row per matching
      // shipment_line_item. Roll up to one row per shipment so the
      // table shows distinct PS#'s.
      const byId = new Map<string, ShipmentWithRelations>();
      for (const r of rows) {
        const existing = byId.get(r.id);
        if (!existing) {
          byId.set(r.id, r);
        } else {
          existing.shipment_line_items = [
            ...(existing.shipment_line_items ?? []),
            ...(r.shipment_line_items ?? []),
          ];
        }
      }
      const merged = Array.from(byId.values()).sort((a, b) => {
        const ad = a.ship_date;
        const bd = b.ship_date;
        if (ad !== bd) return ad < bd ? 1 : -1;
        return a.created_at < b.created_at ? 1 : -1;
      });
      setShipments(merged);
    } catch (err) {
      console.error('Failed to load shipment history:', err);
      setError(err instanceof Error ? err.message : 'Failed to load shipments.');
    } finally {
      setLoading(false);
    }
  }, [jobId]);

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  // When a parent passes an initial preview id (post-create flow),
  // open the dialog on first mount. Don't reopen on refresh.
  useEffect(() => {
    if (initialPreviewShipmentId) setPreviewId(initialPreviewShipmentId);
  }, [initialPreviewShipmentId]);

  const totalQuantity = (s: ShipmentWithRelations): number => {
    return (s.shipment_line_items ?? []).reduce(
      (acc, li) => acc + Number(li.quantity),
      0,
    );
  };

  const handleVoidConfirm = useCallback(async () => {
    if (!voidTarget) return;
    setVoiding(true);
    setVoidError(null);
    try {
      await voidShipment(voidTarget.id);
      setVoidTarget(null);
      await load();
      // Parent re-pulls job + per-part summaries: the void cascade just
      // changed job_parts.fulfillment_status (and possibly the job's).
      onShipmentVoided?.();
    } catch (err) {
      console.error('Failed to void shipment:', err);
      setVoidError(err instanceof Error ? err.message : 'Failed to void shipment.');
    } finally {
      setVoiding(false);
    }
  }, [voidTarget, load, onShipmentVoided]);

  return (
    <Card elevation={2}>
      <CardContent>
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 2 }}>
          <Typography variant="h6" sx={{ fontWeight: 600 }}>
            Shipment History ({shipments.length})
          </Typography>
        </Box>
        <Divider sx={{ mb: 2 }} />

        {loading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
            <CircularProgress size={24} />
          </Box>
        ) : error ? (
          <Typography variant="body2" color="error">
            {error}
          </Typography>
        ) : shipments.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            No shipments yet. Create one with the &quot;Create Shipment&quot; action above.
          </Typography>
        ) : (
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Packing Slip #</TableCell>
                <TableCell>Ship Date</TableCell>
                <TableCell>Method</TableCell>
                <TableCell>Carrier</TableCell>
                <TableCell align="right">Qty</TableCell>
                <TableCell align="right" sx={{ width: 110 }}>
                  Actions
                </TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {shipments.map((s) => (
                <TableRow key={s.id}>
                  <TableCell sx={{ fontWeight: 600 }}>
                    {s.packing_slip_number}
                    {s.voided_at && (
                      <Typography variant="caption" color="error" sx={{ ml: 1 }}>
                        VOIDED
                      </Typography>
                    )}
                  </TableCell>
                  <TableCell>{formatShipDate(s.ship_date)}</TableCell>
                  <TableCell>
                    {s.shipping_method ? SHIPPING_METHOD_LABELS[s.shipping_method] : '—'}
                  </TableCell>
                  <TableCell>{s.carrier ?? '—'}</TableCell>
                  <TableCell align="right">{totalQuantity(s)}</TableCell>
                  <TableCell align="right">
                    <Tooltip title="View / Print">
                      <IconButton size="small" onClick={() => setPreviewId(s.id)}>
                        <PrintIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                    {!s.voided_at && (
                      <Tooltip title="Void packing slip">
                        <IconButton
                          size="small"
                          color="error"
                          onClick={() => {
                            setVoidError(null);
                            setVoidTarget(s);
                          }}
                        >
                          <BlockIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>

      <PackingSlipPreviewDialog
        open={Boolean(previewId)}
        shipmentId={previewId}
        onClose={() => setPreviewId(null)}
      />

      <Dialog
        open={Boolean(voidTarget)}
        onClose={() => {
          if (!voiding) setVoidTarget(null);
        }}
      >
        <DialogTitle>Void {voidTarget?.packing_slip_number}?</DialogTitle>
        <DialogContent>
          <Typography variant="body2" sx={{ mb: voidError ? 2 : 0 }}>
            This reverses the shipped quantities on{' '}
            <strong>{voidTarget?.packing_slip_number}</strong> and reopens the affected
            lines for re-shipment. The packing-slip number stays on record as voided —
            it is not reused.
          </Typography>
          {voidError && <Alert severity="error">{voidError}</Alert>}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setVoidTarget(null)} disabled={voiding}>
            Keep Slip
          </Button>
          <Button
            onClick={handleVoidConfirm}
            color="error"
            variant="contained"
            disabled={voiding}
            startIcon={voiding ? <CircularProgress size={16} color="inherit" /> : <BlockIcon />}
          >
            {voiding ? 'Voiding…' : 'Void Slip'}
          </Button>
        </DialogActions>
      </Dialog>
    </Card>
  );
}

function formatShipDate(value: string | null | undefined): string {
  if (!value) return '—';
  const ymd = /^\d{4}-\d{2}-\d{2}$/.exec(value);
  if (ymd) {
    const [y, m, d] = value.split('-').map((n) => parseInt(n, 10));
    return new Date(y, m - 1, d).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  }
  return new Date(value).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}
