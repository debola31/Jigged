'use client';

import { useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogTitle from '@mui/material/DialogTitle';
import Divider from '@mui/material/Divider';
import Typography from '@mui/material/Typography';
import Alert from '@mui/material/Alert';
import type { OAuthGrant } from '@supabase/supabase-js';
import posthog from 'posthog-js';
import * as Sentry from '@sentry/nextjs';

import BusyButton from '@/components/common/BusyButton';
import LoadFailedState from '@/components/common/LoadFailedState';
import { useLoad } from '@/hooks/useLoad';
import ConnectAssistantMenu from '@/components/aiAssistants/ConnectAssistantMenu';
import { clientKindOf } from '@/lib/mcp/clientKind';
import { friendlyErrorMessage, toError } from '@/lib/supabaseErrors';
import { disconnectAssistant, listConnectedAssistants } from '@/utils/aiAssistantAccess';

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });

/**
 * The assistants this person has connected to Jigged, each with Disconnect. Reached from the
 * account menu. Connecting happens from the "Connect your assistant" menu (on the dashboard, and
 * here in the header), never by sending someone to this page first.
 */
export default function AiAssistantsPanel() {
  const [confirming, setConfirming] = useState<OAuthGrant | null>(null);
  const [disconnecting, setDisconnecting] = useState(false);
  const [disconnectError, setDisconnectError] = useState<string | null>(null);

  const { data: grants, loading, error, reload } = useLoad(listConnectedAssistants, [], {
    onError: (err) => Sentry.captureException(toError(err)),
  });

  const confirmDisconnect = async () => {
    if (!confirming) return;
    setDisconnecting(true);
    setDisconnectError(null);
    try {
      await disconnectAssistant(confirming.client.id);
      posthog.capture('ai assistant disconnected', { client_kind: clientKindOf(confirming.client.name) });
      setConfirming(null);
      await reload();
    } catch (err) {
      Sentry.captureException(toError(err));
      setDisconnectError(friendlyErrorMessage(err, { fallback: 'Failed to disconnect that assistant.' }));
    } finally {
      setDisconnecting(false);
    }
  };

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3, maxWidth: 720 }}>
      <Card elevation={2}>
        <CardContent sx={{ p: 2.5 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap', mb: 0.5 }}>
            <Typography variant="h6" component="h2" sx={{ fontWeight: 600, flex: 1 }}>
              Connected assistants
            </Typography>
            <ConnectAssistantMenu />
          </Box>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Every assistant you have allowed, in all your companies. Disconnecting one stops it
            within the hour; you can connect it again any time.
          </Typography>
          {loading && !grants ? null : error && !grants ? (
            <LoadFailedState error={error} entity="your connected assistants" onRetry={() => void reload()} />
          ) : !grants || grants.length === 0 ? (
            <Typography color="text.secondary">No assistants connected yet.</Typography>
          ) : (
            <Box component="ul" sx={{ listStyle: 'none', p: 0, m: 0 }}>
              {grants.map((grant, i) => (
                <Box component="li" key={grant.client.id}>
                  {i > 0 && <Divider />}
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, py: 1.5, flexWrap: 'wrap' }}>
                    <Box sx={{ flex: 1, minWidth: 0 }}>
                      <Typography sx={{ fontWeight: 600 }}>{grant.client.name || 'Unnamed assistant'}</Typography>
                      <Typography variant="body2" color="text.secondary">
                        Connected {dateFormat.format(new Date(grant.granted_at))}
                      </Typography>
                    </Box>
                    <Button
                      variant="outlined"
                      color="error"
                      onClick={() => {
                        setDisconnectError(null);
                        setConfirming(grant);
                      }}
                    >
                      Disconnect
                    </Button>
                  </Box>
                </Box>
              ))}
            </Box>
          )}
        </CardContent>
      </Card>

      <Dialog open={confirming !== null} onClose={() => (disconnecting ? undefined : setConfirming(null))}>
        <DialogTitle>Disconnect {confirming?.client.name || 'this assistant'}?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            It loses access to Jigged within the hour. You can connect it again any time.
          </DialogContentText>
          {disconnectError && (
            <Alert severity="error" sx={{ mt: 2 }}>
              {disconnectError}
            </Alert>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirming(null)} disabled={disconnecting}>
            Cancel
          </Button>
          <BusyButton
            pending={disconnecting}
            pendingLabel="Disconnecting…"
            color="error"
            variant="contained"
            onClick={() => void confirmDisconnect()}
          >
            Disconnect
          </BusyButton>
        </DialogActions>
      </Dialog>

    </Box>
  );
}
