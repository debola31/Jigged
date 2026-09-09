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

const EMPTY: ShipmentWithRelations[] = [];

/**
 * Toolbar dropdown consolidating view (open the packing slip) + create for
 * shipments, mirroring InvoicesMenu. Voiding lives inside the packing-slip
 * preview (opened from a row), next to Print/Download — so a destructive action
 * is only reachable once the slip is actually on screen.
 *
 * THE PREVIEW ITSELF IS NOT MOUNTED HERE. It used to be, and the job page
 * mounted a second copy for the after-create auto-preview; when the activity
 * rail grew a packing-slip row it reused the page's copy and inherited that
 * copy's missing `onVoided`, so the same slip offered Void from the toolbar and
 * not from the feed. One slip, two dialogs, two behaviours. The page owns the
 * single mount now and this menu asks it to open — see `onPreview`.
 */
export default function ShipmentsMenu({
  jobId,
  refreshKey = 0,
  canShip,
  onCreate,
  onPreview,
  disabled,
}: {
  jobId: string;
  refreshKey?: number;
  canShip: boolean;
  onCreate: () => void;
  /** Open the job page's packing-slip preview. The page owns the dialog so every
   *  route to a slip lands on the same one, with the same actions. */
  onPreview: (shipmentId: string) => void;
  disabled?: boolean;
}) {
  const [anchor, setAnchor] = useState<null | HTMLElement>(null);

  const { data } = useLoad(
    async () => {
      const rows = await getShipmentsForJob(jobId);
      // Belt and braces, not a live fix. This said the inner-join read "can
      // yield one row per line item"; it does not — PostgREST nests children
      // under one parent row, verified against a slip carrying two lines, which
      // came back as ONE row with two nested items. Kept because it costs
      // nothing, but the activity rail reads the same function without it and is
      // right to: whoever removes this should remove the claim, not trust it.
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
                onPreview(s.id);
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
