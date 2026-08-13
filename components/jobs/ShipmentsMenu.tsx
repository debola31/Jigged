'use client';

import { useState } from 'react';
import { useLoad } from '@/hooks/useLoad';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import ListItemText from '@mui/material/ListItemText';
import Divider from '@mui/material/Divider';
import Typography from '@mui/material/Typography';
import LocalShippingIcon from '@mui/icons-material/LocalShipping';
import ArrowDropDownIcon from '@mui/icons-material/ArrowDropDown';
import AddIcon from '@mui/icons-material/Add';

import { getShipmentsForJob } from '@/utils/shipmentsAccess';
import type { ShipmentWithRelations } from '@/types/shipment';
import PackingSlipPreviewDialog from '@/components/shipments/PackingSlipPreviewDialog';

const EMPTY: ShipmentWithRelations[] = [];

/**
 * Toolbar dropdown consolidating view (open the packing slip) + create for
 * shipments, mirroring InvoicesMenu. Voiding lives inside the packing-slip
 * preview (opened from a row), next to Print/Download — so a destructive action
 * is only reachable once the slip is actually on screen.
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
                      <Typography component="span" variant="caption" color="error.light" sx={{ ml: 1 }}>
                        VOIDED
                      </Typography>
                    )}
                  </Box>
                }
                secondary={formatDate(s.ship_date)}
              />
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
        onVoided={() => {
          reload();
          onVoided?.();
        }}
      />
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
