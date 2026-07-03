'use client';

import { useCallback, useState } from 'react';
import { useLoad } from '@/hooks/useLoad';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import ListItemText from '@mui/material/ListItemText';
import Divider from '@mui/material/Divider';
import Typography from '@mui/material/Typography';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import Alert from '@mui/material/Alert';
import CircularProgress from '@mui/material/CircularProgress';
import LocalShippingIcon from '@mui/icons-material/LocalShipping';
import ArrowDropDownIcon from '@mui/icons-material/ArrowDropDown';
import AddIcon from '@mui/icons-material/Add';
import BlockIcon from '@mui/icons-material/Block';

import { getShipmentsForJob, voidShipment } from '@/utils/shipmentsAccess';
import type { ShipmentWithRelations } from '@/types/shipment';
import PackingSlipPreviewDialog from '@/components/shipments/PackingSlipPreviewDialog';

const EMPTY: ShipmentWithRelations[] = [];

/**
 * Toolbar dropdown consolidating view (open the packing slip) + void + create
 * for shipments, mirroring InvoicesMenu. Replaces the old Fulfillment section's
 * ShipmentHistoryCard so all shipment actions live at the top of the job page.
 */
export default function ShipmentsMenu({
  jobId,
  refreshKey = 0,
  canShip,
  onCreate,
  onVoided,
  disabled,
}: {
  jobId: string;
  refreshKey?: number;
  canShip: boolean;
  onCreate: () => void;
  /** Fired after a shipment is voided so the page can re-pull job fulfillment status. */
  onVoided?: () => void;
  disabled?: boolean;
}) {
  const [anchor, setAnchor] = useState<null | HTMLElement>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [voidTarget, setVoidTarget] = useState<ShipmentWithRelations | null>(null);
  const [voiding, setVoiding] = useState(false);
  const [voidError, setVoidError] = useState<string | null>(null);

  const { data, reload } = useLoad(
    async () => {
      const rows = await getShipmentsForJob(jobId);
      // The inner-join read can yield one row per line item — roll up to one per slip.
      const byId = new Map<string, ShipmentWithRelations>();
      for (const r of rows) if (!byId.has(r.id)) byId.set(r.id, r);
      return Array.from(byId.values());
    },
    [jobId, refreshKey],
    { onError: (err) => console.warn('ShipmentsMenu load failed', err) },
  );
  const shipments = data ?? EMPTY;

  const handleVoidConfirm = useCallback(async () => {
    if (!voidTarget) return;
    setVoiding(true);
    setVoidError(null);
    try {
      await voidShipment(voidTarget.id);
      setVoidTarget(null);
      await reload();
      onVoided?.();
    } catch (err) {
      setVoidError(err instanceof Error ? err.message : 'Failed to void shipment.');
    } finally {
      setVoiding(false);
    }
  }, [voidTarget, reload, onVoided]);

  return (
    <>
      <Button
        variant="outlined"
        startIcon={<LocalShippingIcon />}
        endIcon={<ArrowDropDownIcon />}
        onClick={(e) => setAnchor(e.currentTarget)}
        disabled={disabled}
      >
        Shipments ({shipments.length})
      </Button>
      <Menu anchorEl={anchor} open={!!anchor} onClose={() => setAnchor(null)}>
        {shipments.length === 0 ? (
          <MenuItem disabled>
            <ListItemText primary="No shipments yet" />
          </MenuItem>
        ) : (
          shipments.map((s) => (
            <MenuItem
              key={s.id}
              onClick={() => {
                setPreviewId(s.id);
                setAnchor(null);
              }}
            >
              <ListItemText
                primary={
                  <Box component="span">
                    {s.packing_slip_number}
                    {s.voided_at && (
                      <Typography component="span" variant="caption" color="error" sx={{ ml: 1 }}>
                        VOIDED
                      </Typography>
                    )}
                  </Box>
                }
                secondary={formatDate(s.ship_date)}
              />
              {!s.voided_at && (
                <Tooltip title="Void packing slip">
                  <IconButton
                    edge="end"
                    size="small"
                    color="error"
                    sx={{ ml: 3 }}
                    onClick={(e) => {
                      e.stopPropagation();
                      setVoidError(null);
                      setVoidTarget(s);
                      setAnchor(null);
                    }}
                  >
                    <BlockIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
              )}
            </MenuItem>
          ))
        )}
        {canShip && <Divider />}
        {canShip && (
          <MenuItem
            onClick={() => {
              setAnchor(null);
              onCreate();
            }}
          >
            <AddIcon fontSize="small" sx={{ mr: 1 }} />
            Create shipment
          </MenuItem>
        )}
      </Menu>

      <PackingSlipPreviewDialog
        open={!!previewId}
        shipmentId={previewId}
        onClose={() => setPreviewId(null)}
      />

      <Dialog open={!!voidTarget} onClose={() => !voiding && setVoidTarget(null)}>
        <DialogTitle>Void {voidTarget?.packing_slip_number}?</DialogTitle>
        <DialogContent>
          <Typography variant="body2" sx={{ mb: voidError ? 2 : 0 }}>
            This reverses the shipped quantities on{' '}
            <strong>{voidTarget?.packing_slip_number}</strong> and reopens the affected lines.
            The packing-slip number stays on record as voided — it is not reused.
          </Typography>
          {voidError && <Alert severity="error">{voidError}</Alert>}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setVoidTarget(null)} disabled={voiding}>
            Keep slip
          </Button>
          <Button
            onClick={handleVoidConfirm}
            color="error"
            variant="contained"
            disabled={voiding}
            startIcon={voiding ? <CircularProgress size={16} color="inherit" /> : <BlockIcon />}
          >
            {voiding ? 'Voiding…' : 'Void slip'}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}

function formatDate(value: string | null | undefined): string {
  if (!value) return '';
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
