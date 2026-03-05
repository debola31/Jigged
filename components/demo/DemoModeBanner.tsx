'use client';

import { useState } from 'react';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogActions from '@mui/material/DialogActions';
import CircularProgress from '@mui/material/CircularProgress';
import { useDemoMode } from '@/components/providers/DemoModeProvider';

export default function DemoModeBanner() {
  const { isDemoMode, exitDemoMode, resetDemo, isResetting } = useDemoMode();
  const [resetDialogOpen, setResetDialogOpen] = useState(false);

  if (!isDemoMode) return null;

  const handleReset = async () => {
    setResetDialogOpen(false);
    await resetDemo();
  };

  return (
    <>
      <Alert
        severity="info"
        sx={{
          borderRadius: 0,
          py: 0.5,
          '& .MuiAlert-message': {
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            width: '100%',
            gap: 2,
          },
        }}
      >
        You&apos;re in demo mode. Changes here won&apos;t affect your real company.
        <span style={{ display: 'flex', gap: 8 }}>
          <Button
            size="small"
            variant="outlined"
            color="inherit"
            onClick={() => setResetDialogOpen(true)}
            disabled={isResetting}
            startIcon={isResetting ? <CircularProgress size={16} /> : undefined}
          >
            {isResetting ? 'Resetting…' : 'Reset'}
          </Button>
          <Button
            size="small"
            variant="contained"
            color="primary"
            onClick={exitDemoMode}
          >
            Back to My Company
          </Button>
        </span>
      </Alert>

      <Dialog open={resetDialogOpen} onClose={() => setResetDialogOpen(false)}>
        <DialogTitle>Reset Demo?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            This will restore the demo to its original state. Any changes you
            made in demo mode will be lost.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setResetDialogOpen(false)}>Cancel</Button>
          <Button onClick={handleReset} color="error" variant="contained">
            Reset Demo
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
