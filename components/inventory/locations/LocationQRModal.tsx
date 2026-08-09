'use client';

import { useState } from 'react';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import Button from '@mui/material/Button';
import Box from '@mui/material/Box';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import PictureAsPdfIcon from '@mui/icons-material/PictureAsPdf';
import { QRCodeCanvas } from 'qrcode.react';

import type { InventoryLocation } from '@/types/inventoryLocations';
import { buildScanUrl } from '@/lib/jiggedScan';
import { generateLocationLabelSheet, type LocationLabel } from '@/utils/locationLabelPdf';

/**
 * `companyName` is gone from this chain, all the way up to the page.
 *
 * Its only consumer was the label sheet's page heading, which had to go when the sheet moved to
 * die-cut Avery stock — a heading at the top of page 1 prints across the middle of label 1. Nothing
 * on a label identifies the shop now, and nothing needs to: the sticker is on that shop's shelf.
 */
interface LocationQRModalProps {
  open: boolean;
  companyId: string;
  node: InventoryLocation | null;
  /** Full path of `node`, root → node. */
  path: string[];
  /** Labels for `node` and every descendant (every location is printable). */
  labels: LocationLabel[];
  onClose: () => void;
}

export default function LocationQRModal({
  open,
  companyId,
  node,
  path,
  labels,
  onClose,
}: LocationQRModalProps) {
  const [busy, setBusy] = useState(false);
  if (!node) return null;

  // The on-screen preview shows exactly what the sheet prints, so it uses the same builder and the
  // same pinned origin — a preview that differed from the paper would be worse than none.
  const url = buildScanUrl({ kind: 'location', companyId, locationId: node.id });
  const fileStem = node.name.replace(/\s+/g, '-');

  const download = async (labels: LocationLabel[], stem: string) => {
    setBusy(true);
    try {
      const doc = await generateLocationLabelSheet({ companyId, labels });
      doc.save(`${stem}.pdf`);
    } finally {
      setBusy(false);
    }
  };

  const subtreeCount = labels.length;
  const thisLabel: LocationLabel = { id: node.id, path };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle>{path.join(' › ')}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} alignItems="center">
          <Paper elevation={0} sx={{ p: 2, bgcolor: 'white', borderRadius: 2 }}>
            <QRCodeCanvas value={url} size={200} level="H" includeMargin bgColor="#ffffff" fgColor="#000000" />
          </Paper>
          <Box sx={{ width: '100%' }}>
            <Button
              fullWidth
              variant="outlined"
              startIcon={<PictureAsPdfIcon />}
              onClick={() => download([thisLabel], `${fileStem}-label`)}
              disabled={busy}
              sx={{ mb: 1 }}
            >
              Download this label
            </Button>
            <Button
              fullWidth
              variant="contained"
              startIcon={<PictureAsPdfIcon />}
              onClick={() => download(labels, `${fileStem}-labels`)}
              disabled={busy || subtreeCount <= 1}
            >
              {subtreeCount > 1
                ? `Download sheet — ${subtreeCount} labels (this + below)`
                : 'No sub-locations to print'}
            </Button>
          </Box>
          <Typography variant="caption" color="text.secondary" sx={{ textAlign: 'center' }}>
            The QR encodes the location ID, so renaming or recoding never breaks a printed label.
          </Typography>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}
