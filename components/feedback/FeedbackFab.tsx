'use client';

import { useState } from 'react';
import Fab from '@mui/material/Fab';
import Snackbar from '@mui/material/Snackbar';
import Alert from '@mui/material/Alert';
import FeedbackIcon from '@mui/icons-material/Feedback';
import FeedbackDialog from './FeedbackDialog';

export default function FeedbackFab() {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [snackbarOpen, setSnackbarOpen] = useState(false);

  return (
    <>
      <Fab
        variant="extended"
        color="primary"
        size="medium"
        aria-label="Give feedback"
        onClick={() => setDialogOpen(true)}
        sx={{
          position: 'fixed',
          bottom: 24,
          right: 24,
          zIndex: 1150,
        }}
      >
        <FeedbackIcon sx={{ mr: 1 }} />
        Feedback
      </Fab>

      <FeedbackDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onSuccess={() => setSnackbarOpen(true)}
      />

      <Snackbar
        open={snackbarOpen}
        autoHideDuration={4000}
        onClose={() => setSnackbarOpen(false)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert severity="success" onClose={() => setSnackbarOpen(false)}>
          Thanks for your feedback!
        </Alert>
      </Snackbar>
    </>
  );
}
