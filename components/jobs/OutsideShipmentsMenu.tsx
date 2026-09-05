'use client';

import { useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import ListItemText from '@mui/material/ListItemText';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import Typography from '@mui/material/Typography';
import ArrowDropDownIcon from '@mui/icons-material/ArrowDropDown';
import FactoryIcon from '@mui/icons-material/Factory';

import { useLoad } from '@/hooks/useLoad';
import { OutsideShipmentPreviewDialog } from '@/components/outsideShipments';
import { getOutsideShipmentsForJob, outstandingOn } from '@/utils/outsideShipmentsAccess';
import type { OutsideShipmentWithRelations } from '@/types/outsideShipment';

const EMPTY: OutsideShipmentWithRelations[] = [];

/**
 * Toolbar dropdown listing this job's outside-processing slips, mirroring
 * ShipmentsMenu.
 *
 * THERE IS NO "CREATE" ITEM, unlike its sibling, and that is the whole
 * difference. A customer shipment is a job-level act; an outside send belongs to
 * ONE operation and needs that operation's quantity, so it is initiated from the
 * op card and nowhere else. This menu views and reprints. Void, as on the
 * packing slip, lives inside the preview.
 */
export default function OutsideShipmentsMenu({
  jobId,
  refreshKey = 0,
  onVoided,
  disabled,
}: {
  jobId: string;
  refreshKey?: number;
  /** Fired after a slip is voided so the page can re-pull operation status. */
  onVoided?: () => void;
  disabled?: boolean;
}) {
  const [anchor, setAnchor] = useState<null | HTMLElement>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);

  const { data, reload } = useLoad(() => getOutsideShipmentsForJob(jobId), [jobId, refreshKey], {
    onError: (err) => console.warn('OutsideShipmentsMenu load failed', err),
  });
  const slips = data ?? EMPTY;

  // The button is hidden entirely when a job has no outside work — a permanent
  // "Outside slips (0)" on every job in a shop that does none is noise on the
  // toolbar that matters most.
  if (slips.length === 0) return null;

  return (
    <>
      <Button
        variant="outlined"
        startIcon={<FactoryIcon />}
        endIcon={<ArrowDropDownIcon />}
        onClick={(e) => setAnchor(e.currentTarget)}
        disabled={disabled}
      >
        Vendor slips ({slips.length})
      </Button>
      <Menu anchorEl={anchor} open={!!anchor} onClose={() => setAnchor(null)}>
        {slips.map((s) => {
          const out = outstandingOn(s);
          return (
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
                    {s.slip_number}
                    {s.voided_at && (
                      <Typography component="span" variant="caption" color="error.light" sx={{ ml: 1 }}>
                        VOIDED
                      </Typography>
                    )}
                  </Box>
                }
                secondary={
                  `${s.vendor_name} · ${s.quantity} sent` + (out > 0 ? ` · ${out} still out` : '')
                }
              />
            </MenuItem>
          );
        })}
      </Menu>

      <OutsideShipmentPreviewDialog
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
