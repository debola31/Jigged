'use client';

import { useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Typography from '@mui/material/Typography';
import * as Sentry from '@sentry/nextjs';
import posthog from 'posthog-js';
import {
  actionLabel,
  revokeChatActionGrant,
  type ChatActionGrant,
} from '@/utils/chatActionGrantsAccess';

interface AllowedActionsDialogProps {
  open: boolean;
  onClose: () => void;
  grants: ChatActionGrant[];
  /** Called after a grant is turned off, so the owner re-reads the list. */
  onChanged: () => void;
}

/**
 * The actions this person lets Jigged chat take without asking -- theirs only, in this
 * company -- each with Turn off. Turning one off is immediate and archives the grant;
 * the next such change asks again, and Always allow there brings it back.
 */
export default function AllowedActionsDialog({ open, onClose, grants, onChanged }: AllowedActionsDialogProps) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const turnOff = async (grant: ChatActionGrant) => {
    setBusyId(grant.id);
    setError(null);
    try {
      await revokeChatActionGrant(grant.id);
      posthog.capture('chat action allowance revoked', { tool_name: grant.tool_name });
      onChanged();
    } catch (err) {
      Sentry.captureException(err);
      setError(err instanceof Error ? err.message : 'Failed to turn that action off.');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>Allowed actions</DialogTitle>
      <DialogContent>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Jigged chat makes these changes for you without asking first. Every other change waits
          for your approval. This list is yours alone.
        </Typography>
        {error && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {error}
          </Alert>
        )}
        {grants.length === 0 ? (
          <Typography variant="body2">Nothing is allowed without asking.</Typography>
        ) : (
          grants.map((grant) => (
            <Box
              key={grant.id}
              sx={{
                display: 'flex',
                alignItems: 'center',
                gap: 2,
                py: 1,
                borderBottom: '1px solid',
                borderColor: 'divider',
              }}
            >
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Typography variant="body1">{actionLabel(grant.tool_name)}</Typography>
                <Typography variant="caption" color="text.secondary">
                  Allowed {new Date(grant.created_at).toLocaleDateString()}
                </Typography>
              </Box>
              <Button
                variant="outlined"
                onClick={() => turnOff(grant)}
                disabled={busyId !== null}
                sx={{ minHeight: 48 }}
              >
                {busyId === grant.id ? 'Turning off…' : 'Turn off'}
              </Button>
            </Box>
          ))
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} sx={{ minHeight: 48 }}>
          Done
        </Button>
      </DialogActions>
    </Dialog>
  );
}
