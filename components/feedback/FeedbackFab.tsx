'use client';

import { useState, useCallback } from 'react';
import Snackbar from '@mui/material/Snackbar';
import Alert from '@mui/material/Alert';
import FeedbackDialog from './FeedbackDialog';

/**
 * Hook to manage feedback dialog state.
 * Used by the layout to wire the sidebar button (desktop) and FAB (mobile)
 * to the same dialog instance.
 */
export function useFeedbackDialog() {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [snackbarOpen, setSnackbarOpen] = useState(false);

  const openDialog = useCallback(() => setDialogOpen(true), []);
  const closeDialog = useCallback(() => setDialogOpen(false), []);
  const showSuccess = useCallback(() => setSnackbarOpen(true), []);
  const closeSnackbar = useCallback(() => setSnackbarOpen(false), []);

  return { dialogOpen, snackbarOpen, openDialog, closeDialog, showSuccess, closeSnackbar };
}

interface FeedbackFabProps {
  dialogOpen: boolean;
  snackbarOpen: boolean;
  onOpen?: () => void;
  onClose: () => void;
  onSuccess: () => void;
  onSnackbarClose: () => void;
}

export default function FeedbackFab({
  dialogOpen,
  snackbarOpen,
  onClose,
  onSuccess,
  onSnackbarClose,
}: FeedbackFabProps) {
  return (
    <>
      <FeedbackDialog
        open={dialogOpen}
        onClose={onClose}
        onSuccess={onSuccess}
      />

      <Snackbar
        open={snackbarOpen}
        autoHideDuration={4000}
        onClose={onSnackbarClose}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert severity="success" onClose={onSnackbarClose}>
          Thanks for your feedback!
        </Alert>
      </Snackbar>
    </>
  );
}
