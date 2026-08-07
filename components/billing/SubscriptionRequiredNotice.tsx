'use client';

import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import { useOptionalSubscription } from '@/components/providers/SubscriptionProvider';
import SubscribeButton from '@/components/billing/SubscribeButton';
import { useUserRole } from '@/hooks/useUserRole';

interface SubscriptionRequiredNoticeProps {
  /** Plural, as it appears mid-sentence: "parts", "customers", "work centers". */
  entityPlural: string;
}

/**
 * Says up front that this shop can't save yet, on the pages whose whole purpose is creating
 * something.
 *
 * Deliberately NOT a disabled button or a hidden form. interaction-standards.md §4 rule 1 is
 * "keep it visible; explain on attempt" — a disabled control isn't focusable, so keyboard and
 * screen-reader users never learn it exists or why. This adds the explanation *before* the
 * attempt; the form and its submit stay exactly as they are, and a submit still produces the
 * full ErrorAlert with the same Subscribe action.
 *
 * Renders nothing when there is nothing to say: while entitlement is still loading, for demo
 * companies, outside a SubscriptionProvider, and — the common case — when the shop can write.
 */
export default function SubscriptionRequiredNotice({
  entityPlural,
}: SubscriptionRequiredNoticeProps) {
  const subscription = useOptionalSubscription();
  const { isAdmin, loading: roleLoading } = useUserRole();

  if (!subscription) return null;
  // `isLoading` starts true with `billing: null`, which resolves to `must_subscribe` — so
  // `canWrite` is false for a perfectly healthy shop until the first fetch lands. Without this
  // the notice would flash on every create page load.
  if (subscription.isLoading) return null;
  if (subscription.isDemo) return null;
  if (subscription.canWrite) return null;

  const canSubscribe = !roleLoading && isAdmin;

  const message = !canSubscribe
    ? `Your shop's subscription isn't active, so new ${entityPlural} can't be saved yet. An admin at your shop can restart it in Settings.`
    : subscription.mustSubscribe
      ? `Start your subscription to add ${entityPlural} to Jigged.`
      : `Your subscription has ended, so Jigged is read-only. Resubscribe to add ${entityPlural} again.`;

  return (
    <Alert
      severity="info"
      sx={{
        mb: 3,
        ...(canSubscribe && {
          '& .MuiAlert-message': {
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            width: '100%',
            gap: 2,
            flexWrap: 'wrap',
          },
        }),
      }}
    >
      {message}
      {canSubscribe && (
        <Box component="span" sx={{ flexShrink: 0 }}>
          <SubscribeButton label={subscription.mustSubscribe ? 'Subscribe' : undefined} />
        </Box>
      )}
    </Alert>
  );
}
