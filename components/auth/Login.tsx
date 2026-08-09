'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import TextField from '@mui/material/TextField';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import Alert from '@mui/material/Alert';
import CircularProgress from '@mui/material/CircularProgress';
import Box from '@mui/material/Box';
import MuiLink from '@mui/material/Link';
import InputAdornment from '@mui/material/InputAdornment';
import IconButton from '@mui/material/IconButton';
import Visibility from '@mui/icons-material/Visibility';
import VisibilityOff from '@mui/icons-material/VisibilityOff';
import posthog from 'posthog-js';
import { getSupabase, getEdgeFunctionUrl } from '@/lib/supabase';
import { getPostLoginRoute } from '@/utils/companyAccess';
import { isValidEmail } from '@/lib/validators';

interface LoginProps {
  expired?: boolean;
  returnTo?: string | null;
  /** Why /auth/confirm sent them here, when it did. See app/auth/confirm/route.ts. */
  reason?: string | null;
}

/**
 * Pull the invitation id out of a `/accept-invite/<uuid>` returnTo, so an invitee holding a dead
 * link can be offered a live one. Returns null for every other destination — this must never widen
 * into "any path shaped roughly like an invite".
 */
function invitationIdFromReturnTo(returnTo: string | null | undefined): string | null {
  if (!returnTo) return null;
  const match = /^\/accept-invite\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(
    returnTo
  );
  return match ? match[1] : null;
}

/**
 * Validate returnTo path using an allowlist approach.
 * Must start with an allowed prefix and normalize to prevent open redirects.
 */
function isValidReturnTo(path: string): boolean {
  try {
    const normalized = new URL(path, window.location.origin);
    // `/operator` belongs here: without it a session expiry on the shop floor has its
    // returnTo silently rejected and the operator is dropped in the office — which for
    // a role='operator' user means an immediate AuthGuard bounce back out. It also broke
    // the scanned-traveler-QR path, which deep-links into /operator/{id}/login.
    const allowedPrefixes = ['/dashboard', '/operator', '/accept-invite'];
    return allowedPrefixes.some(p => normalized.pathname.startsWith(p)) && normalized.origin === window.location.origin;
  } catch {
    return false;
  }
}

export default function Login({ expired, returnTo, reason }: LoginProps) {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [resendState, setResendState] = useState<'idle' | 'sending' | 'sent'>('idle');
  const [resendError, setResendError] = useState<string | null>(null);

  const inviteLinkExpired = reason === 'invite-link-expired';
  const resetLinkExpired = reason === 'reset-link-expired';
  const invitationId = invitationIdFromReturnTo(returnTo);

  useEffect(() => {
    if (inviteLinkExpired) {
      posthog.capture('invitation link expired', { can_self_resend: invitationId !== null });
    }
  }, [inviteLinkExpired, invitationId]);

  /**
   * Ask for a fresh invitation link. Unauthenticated by necessity — the whole point is that this
   * person has no account they can reach yet — so the anon key is the only credential we can send,
   * and the endpoint mails only the address already on the invitation row.
   */
  const handleResendRequest = async () => {
    if (!invitationId) return;
    setResendState('sending');
    setResendError(null);

    try {
      const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
      const response = await fetch(
        `${getEdgeFunctionUrl('team-invites')}/${invitationId}/request-resend`,
        {
          method: 'POST',
          headers: anonKey ? { apikey: anonKey, Authorization: `Bearer ${anonKey}` } : {},
        }
      );
      const body = await response.json().catch(() => null);

      if (!response.ok) {
        throw new Error(body?.error || 'Could not send a new link. Please try again in a moment.');
      }

      setResendState('sent');
      posthog.capture('invitation link resend requested');
    } catch (err) {
      console.error('Invitation resend request failed:', err);
      setResendState('idle');
      setResendError(
        err instanceof Error ? err.message : 'Could not send a new link. Please try again in a moment.'
      );
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isValidEmail(email)) {
      setError('Enter a valid email address');
      return;
    }
    setLoading(true);
    setError(null);

    try {
      const supabase = getSupabase();
      const { data, error: signInError } = await supabase.auth.signInWithPassword({
        email,
        password,
      });

      if (signInError) {
        throw signInError;
      }

      if (data.user) {
        posthog.identify(data.user.id, { email: data.user.email });
        posthog.capture('user signed in');
        // If we have a valid returnTo path (e.g., from session expiry), go there
        if (returnTo && isValidReturnTo(returnTo)) {
          router.push(returnTo);
          return;
        }

        // Otherwise determine redirect based on company access
        const redirectRoute = await getPostLoginRoute(data.user.id);
        router.push(redirectRoute);
      }
    } catch (err) {
      /**
       * No `Sentry.captureException` here: `signInWithPassword` is in the Supabase integration's
       * `AUTH_OPERATIONS_TO_INSTRUMENT`, so since the net went in (#708) it files this itself, as
       * `auto.db.supabase.auth`. Capturing again filed every sign-in failure twice under two
       * fingerprints.
       *
       * This is NOT true of every auth call — `updateUser`, `resetPasswordForEmail` and
       * `getSession` are absent from that list, so ForgotPassword, ResetPassword, ChangePassword
       * and AuthProvider keep their manual captures, which are their only reporter. Check the
       * list before removing another one.
       */
      console.error('Login error:', err);
      setError(err instanceof Error ? err.message : 'An error occurred during sign in');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card elevation={3}>
      <CardContent sx={{ p: 4 }}>
        <Typography variant="h5" component="h2" gutterBottom align="center">
          Sign In
        </Typography>
        <Typography variant="body2" color="text.secondary" align="center" sx={{ mb: 3 }}>
          Welcome back! Enter your credentials to continue.
        </Typography>

        {expired && (
          <Alert severity="info" sx={{ mb: 2 }}>
            Your session expired. Please sign in again.
          </Alert>
        )}

        {/*
          An expired invite link used to land here with no explanation at all, so the invitee did
          the only thing the page offered — typed a password for an account that had never been
          given one — and got "Invalid login credentials" (#722). Say what happened, and hand them
          the one action that actually resolves it.
        */}
        {inviteLinkExpired && (
          <Alert severity="warning" sx={{ mb: 2 }}>
            {/*
              Hedged on purpose. An invitee joining a SECOND company already has a password and
              could sign in below; a first-time invitee has none and cannot. This page can't tell
              them apart — no session, and probing for one would leak which addresses have accounts
              — so the sentence has to be true of both.
            */}
            <Typography variant="body2" sx={{ mb: invitationId ? 1.5 : 0 }}>
              That invitation link has expired — they&apos;re good for 24 hours. If this is your
              first Jigged invitation you don&apos;t have a password yet, so signing in below
              won&apos;t work until you&apos;ve opened a live link.
            </Typography>
            {invitationId && resendState !== 'sent' && (
              <Button
                variant="outlined"
                size="small"
                onClick={handleResendRequest}
                disabled={resendState === 'sending'}
              >
                {resendState === 'sending' ? 'Sending…' : 'Send me a new link'}
              </Button>
            )}
            {invitationId && resendState === 'sent' && (
              <Typography variant="body2">
                A new link is on its way. Check your inbox — and your spam folder.
              </Typography>
            )}
            {!invitationId && (
              <Typography variant="body2">
                Ask your administrator to resend the invitation.
              </Typography>
            )}
            {resendError && (
              <Typography variant="body2" color="error" sx={{ mt: 1 }}>
                {resendError}
              </Typography>
            )}
          </Alert>
        )}

        {resetLinkExpired && (
          <Alert severity="warning" sx={{ mb: 2 }}>
            That password reset link has expired.{' '}
            <MuiLink component={Link} href="/forgot-password" underline="hover">
              Request a new one
            </MuiLink>
            .
          </Alert>
        )}

        {error && (
          <Alert severity="error" sx={{ mb: 3 }}>
            {error}
          </Alert>
        )}

        <Box component="form" onSubmit={handleSubmit}>
          <TextField
            label="Email"
            type="email"
            fullWidth
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            error={email.trim() !== '' && !isValidEmail(email)}
            helperText={
              email.trim() !== '' && !isValidEmail(email)
                ? 'Enter a valid email address'
                : undefined
            }
            disabled={loading}
            sx={{ mb: 2 }}
            autoComplete="email"
          />

          <TextField
            id="login-password"
            label="Password"
            type={showPassword ? 'text' : 'password'}
            fullWidth
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={loading}
            sx={{ mb: 1 }}
            autoComplete="current-password"
            slotProps={{
              input: {
                endAdornment: (
                  <InputAdornment position="end">
                    <IconButton onClick={() => setShowPassword(!showPassword)} edge="end" size="small">
                      {showPassword ? <VisibilityOff /> : <Visibility />}
                    </IconButton>
                  </InputAdornment>
                ),
              },
            }}
          />

          <Box sx={{ textAlign: 'right', mb: 2 }}>
            <MuiLink component={Link} href="/forgot-password" underline="hover" variant="body2">
              Forgot password?
            </MuiLink>
          </Box>

          <Button
            type="submit"
            variant="contained"
            fullWidth
            size="large"
            disabled={loading}
            sx={{ mb: 2 }}
          >
            {loading ? (
              <CircularProgress size={24} color="inherit" />
            ) : (
              'Sign In'
            )}
          </Button>

          <Typography variant="body2" align="center" color="text.secondary">
            Need an account? Contact your company administrator for an invitation.
          </Typography>
        </Box>
      </CardContent>
    </Card>
  );
}
