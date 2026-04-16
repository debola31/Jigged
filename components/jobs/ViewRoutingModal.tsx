'use client';

import { useEffect, useState } from 'react';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import Button from '@mui/material/Button';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import IconButton from '@mui/material/IconButton';
import CircularProgress from '@mui/material/CircularProgress';
import Alert from '@mui/material/Alert';
import CloseIcon from '@mui/icons-material/Close';
import EditIcon from '@mui/icons-material/Edit';
import Link from 'next/link';

import RoutingViewer from '@/components/routings/RoutingViewer';
import { getRoutingWithGraph } from '@/utils/routingsAccess';
import type { RoutingWithGraph } from '@/types/routings';

interface ViewRoutingModalProps {
  open: boolean;
  onClose: () => void;
  routingId: string;
  routingName: string;
  companyId: string;
  partId: string;
}

/**
 * Read-only modal showing a routing's operations and materials.
 */
export default function ViewRoutingModal({
  open,
  onClose,
  routingId,
  routingName,
  companyId,
  partId,
}: ViewRoutingModalProps) {
  const [routing, setRouting] = useState<RoutingWithGraph | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !routingId) return;
    setLoading(true);
    setError(null);
    getRoutingWithGraph(routingId)
      .then(setRouting)
      .catch((err) => {
        console.error('Failed to load routing:', err);
        setError('Failed to load routing.');
      })
      .finally(() => setLoading(false));
  }, [open, routingId]);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth="md"
      fullWidth
      PaperProps={{
        sx: { maxHeight: '85vh', display: 'flex', flexDirection: 'column' },
      }}
    >
      <DialogTitle
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          borderBottom: '1px solid rgba(255, 255, 255, 0.1)',
          py: 1.5,
        }}
      >
        <Box>
          <Typography variant="h6" component="span" sx={{ fontWeight: 600 }}>
            Routing
          </Typography>
          <Typography variant="body2" color="text.secondary" component="span" sx={{ ml: 2 }}>
            {routingName}
          </Typography>
        </Box>
        <IconButton onClick={onClose} size="small" sx={{ color: 'text.secondary' }}>
          <CloseIcon />
        </IconButton>
      </DialogTitle>

      <DialogContent sx={{ p: 2, flex: 1, overflow: 'auto' }}>
        {loading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
            <CircularProgress />
          </Box>
        ) : error ? (
          <Alert severity="error">{error}</Alert>
        ) : routing ? (
          <RoutingViewer routing={routing} />
        ) : (
          <Typography variant="body2" color="text.secondary">
            No routing found.
          </Typography>
        )}
      </DialogContent>

      <DialogActions
        sx={{ borderTop: '1px solid rgba(255, 255, 255, 0.1)', px: 3, py: 1.5 }}
      >
        <Button
          component={Link}
          href={`/dashboard/${companyId}/parts/${partId}/routing/edit`}
          startIcon={<EditIcon />}
          variant="outlined"
          size="small"
        >
          Edit Routing
        </Button>
        <Button onClick={onClose} variant="contained" size="small">
          Close
        </Button>
      </DialogActions>
    </Dialog>
  );
}
