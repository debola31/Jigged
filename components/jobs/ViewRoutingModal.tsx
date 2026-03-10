'use client';

import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import Button from '@mui/material/Button';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import IconButton from '@mui/material/IconButton';
import CloseIcon from '@mui/icons-material/Close';
import EditIcon from '@mui/icons-material/Edit';
import Link from 'next/link';

import RoutingWorkflowViewer from '@/components/routings/RoutingWorkflowViewer';

interface ViewRoutingModalProps {
  open: boolean;
  onClose: () => void;
  routingId: string;
  routingName: string;
  companyId: string;
  partId: string;
}

/**
 * Modal dialog to view a routing workflow diagram.
 * Provides read-only visualization with option to navigate to edit page.
 */
export default function ViewRoutingModal({
  open,
  onClose,
  routingId,
  routingName,
  companyId,
  partId,
}: ViewRoutingModalProps) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth="lg"
      fullWidth
      PaperProps={{
        sx: {
          height: '80vh',
          maxHeight: '800px',
          display: 'flex',
          flexDirection: 'column',
        },
      }}
    >
      {/* Header */}
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
            Routing Workflow
          </Typography>
          <Typography
            variant="body2"
            color="text.secondary"
            component="span"
            sx={{ ml: 2 }}
          >
            {routingName}
          </Typography>
        </Box>
        <IconButton onClick={onClose} size="small" sx={{ color: 'text.secondary' }}>
          <CloseIcon />
        </IconButton>
      </DialogTitle>

      {/* Content - Workflow Viewer */}
      <DialogContent sx={{ p: 0, flex: 1, overflow: 'hidden' }}>
        <RoutingWorkflowViewer routingId={routingId} companyId={companyId} />
      </DialogContent>

      {/* Footer */}
      <DialogActions
        sx={{
          borderTop: '1px solid rgba(255, 255, 255, 0.1)',
          px: 3,
          py: 1.5,
        }}
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
