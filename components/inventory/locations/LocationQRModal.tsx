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
import {
  generateLocationLabelSheet,
  buildLocationScanUrl,
  type LocationLabel,
} from '@/utils/locationLabelPdf';

interface LocationQRModalProps {
  open: boolean;
  companyId: string;
  companyName?: string;
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
  companyName,
  node,
  path,
  labels,
  onClose,
}: LocationQRModalProps) {
  const [busy, setBusy] = useState(false);
  if (!node) return null;

  const baseUrl = typeof window !== 'undefined' ? window.location.origin : '';
  const url = buildLocationScanUrl(baseUrl, companyId, node.id);
  const fileStem = node.name.replace(/\s+/g, '-');

  const download = async (labels: LocationLabel[], stem: string) => {
    setBusy(true);
    try {
      const doc = await generateLocationLabelSheet({
        companyId,
        baseUrl,
        labels,
        heading: companyName,
      });
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
