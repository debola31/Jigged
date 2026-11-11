'use client';

import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import LockOutlinedIcon from '@mui/icons-material/LockOutlined';
import SubscribeButton from '@/components/billing/SubscribeButton';
import { useUserRole } from '@/hooks/useUserRole';
import type { WriteBlockedState } from '@/lib/billingCopy';

/** A subscription is a next step, not a chat error. History remains readable. */
export default function ChatSubscriptionNotice({ state }: { state?: WriteBlockedState }) {
  const { isAdmin, loading } = useUserRole();
  const adminMessage = {
    never_started: 'Start your subscription to ask questions, create charts and generate reports about your shop.',
    ended: 'Your subscription has ended. Reactivate it to keep chatting about your shop.',
    paused: 'Your subscription is paused. Resume it to keep chatting about your shop.',
  };
  const memberMessage = {
    never_started: 'Ask an admin at your shop to start a subscription so you can use chat.',
    ended: "Your shop's subscription has ended. Ask an admin at your shop to reactivate it to use chat.",
    paused: "Your shop's subscription is paused. Ask an admin at your shop to resume it to use chat.",
  };
  // A server denial can arrive before the billing refresh. Don't invent a status
  // (or a role) from the cache while that check is still in flight.
  const message = !loading && state
    ? (isAdmin ? adminMessage : memberMessage)[state]
    : 'An active subscription lets you ask questions and create charts and reports about your shop.';

  return (
    <Box sx={{ p: 2, mb: 2, border: '1px solid', borderColor: 'divider', borderRadius: 1, bgcolor: 'background.paper' }}>
      <Stack direction="row" spacing={1.5} sx={{ alignItems: 'flex-start' }}>
        <LockOutlinedIcon sx={{ color: 'text.secondary', mt: 0.5 }} />
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography variant="subtitle1" component="h3" sx={{ fontWeight: 600 }}>
            Chat requires an active subscription
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
            {message}
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
            You can still view your chat history.
          </Typography>
          {!loading && isAdmin && (
            <Box sx={{ mt: 2 }}>
              <SubscribeButton size="medium" label={state === 'never_started' ? 'Start subscription' : 'Manage subscription'} />
            </Box>
          )}
        </Box>
      </Stack>
    </Box>
  );
}
