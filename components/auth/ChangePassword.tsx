'use client';

import * as Sentry from "@sentry/nextjs";
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@supabase/supabase-js';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import TextField from '@mui/material/TextField';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import Alert from '@mui/material/Alert';
import CircularProgress from '@mui/material/CircularProgress';
import Box from '@mui/material/Box';
import InputAdornment from '@mui/material/InputAdornment';
import IconButton from '@mui/material/IconButton';
import Visibility from '@mui/icons-material/Visibility';
import VisibilityOff from '@mui/icons-material/VisibilityOff';
import { getSupabase } from '@/lib/supabase';
import { getPostLoginRoute } from '@/utils/companyAccess';

/**
 * Logged-in self-rotate password page.
 *
 * Requires the user to enter their current password before setting a new
 * one — the shop-floor deployment environment has shared/unattended
 * workstations, so a hijacked session must not yield instant account
 * takeover. Supabase's `updateUser({password})` only requires an active
 * session, so we add the current-password check ourselves via a throwaway
 * `signInWithPassword` round-trip.
 *
 * CRITICAL: the current-password check uses a separate `verifier` client
 * with `persistSession: false`. Calling `signInWithPassword` on the
 * shared `supabase` singleton would issue a fresh session, replace
 * persisted tokens, and fire `onAuthStateChange('SIGNED_IN')` on every
 * subscriber — AuthGuard (which routes on auth state) would react
 * mid-flow and could redirect away before `updateUser` runs. The
 * throwaway client isolates verification from app state.
 */
export default function ChangePassword() {
  const router = useRouter();

  const [email, setEmail] = useState<string | null>(null);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showCurrentPassword, setShowCurrentPassword] = useState(false);
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [checkingSession, setCheckingSession] = useState(true);

  useEffect(() => {
    const checkSession = async () => {
      const supabase = getSupabase();
      const { data: { session } } = await supabase.auth.getSession();

      if (!session) {
        router.replace('/login');
        return;
      }

      setEmail(session.user.email ?? null);
      setCheckingSession(false);
    };

    checkSession();
  }, [router]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!currentPassword.trim()) {
      setError('Please enter your current password');
      return;
    }

    if (!newPassword.trim()) {
      setError('Please enter a new password');
      return;
    }

    if (newPassword.length < 8) {
      setError('New password must be at least 8 characters');
      return;
    }

    if (newPassword !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }

    if (newPassword === currentPassword) {
      setError('New password must be different from current password');
      return;
    }

    setLoading(true);
    setError(null);
    setSuccess(null);

    try {
      const supabase = getSupabase();
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.user?.email) {
        throw new Error('Session lost. Please sign in again.');
      }

      // Throwaway verifier client — see file-level comment.
      const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
      const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
      if (!supabaseUrl || !supabaseAnonKey) {
        throw new Error('Supabase client is not configured');
      }
      const verifier = createClient(supabaseUrl, supabaseAnonKey, {
        auth: {
          persistSession: false,
          autoRefreshToken: false,
          detectSessionInUrl: false,
        },
      });

      // TODO: MFA — signInWithPassword surfaces an MFA challenge if MFA
      // is ever enabled on this project. Currently disabled; revisit
      // when enabled.
      const { error: verifyErr } = await verifier.auth.signInWithPassword({
        email: session.user.email,
        password: currentPassword,
      });

      if (verifyErr) {
        // Supabase rate-limits repeated failed sign-ins. Distinguish
        // rate-limit from "wrong password" so a user who genuinely
        // mistyped doesn't see a misleading lockout message — and so
        // we get a server-side breadcrumb when pilot users hit it.
        const status = (verifyErr as { status?: number }).status;
        const isRateLimit = status === 429 || /rate ?limit/i.test(verifyErr.message);
        if (isRateLimit) {
          try {
            Sentry.captureMessage('change_password: signInWithPassword rate-limited', {
              level: 'warning',
              extra: { user_id: session.user.id },
            });
          } catch {
            console.warn('change_password rate-limited', session.user.id);
          }
          setError('Too many attempts. Please wait a minute and try again.');
        } else {
          setError('Current password is incorrect');
        }
        return;
      }

      // Verification passed. Update the password on the SHARED client
      // (the one carrying the user's real session).
      const { data: { user }, error: updateError } = await supabase.auth.updateUser({
        password: newPassword,
      });

      if (updateError) {
        throw updateError;
      }

      if (!user) {
        throw new Error('Session lost during password change. Please sign in again.');
      }

      // Invalidate other active sessions on this user (other devices,
      // other browsers). scope='others' leaves the current tab signed
      // in. Default-on for the shop-floor context where shared
      // workstations are common.
      await supabase.auth.signOut({ scope: 'others' });

      setSuccess('Password updated. Other devices have been signed out.');
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');

      // Redirect to the user's home shortly after success.
      setTimeout(async () => {
        const redirectRoute = await getPostLoginRoute(user.id);
        router.replace(redirectRoute);
      }, 1500);
    } catch (err) {
      console.error('Change password error:', err);
      Sentry.captureException(err);
      setError(err instanceof Error ? err.message : 'Failed to change password. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  if (checkingSession) {
    return (
      <Card elevation={3}>
        <CardContent sx={{ p: 4, textAlign: 'center' }}>
          <CircularProgress sx={{ mb: 2 }} />
          <Typography variant="body2" color="text.secondary">
            Loading...
          </Typography>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card elevation={3}>
      <CardContent sx={{ p: 4 }}>
        <Typography variant="h5" component="h2" gutterBottom align="center">
          Change your password
        </Typography>
        {email && (
          <Typography variant="body2" align="center" sx={{ mb: 3, color: 'text.secondary' }}>
            Signed in as {email}
          </Typography>
        )}

        {error && (
          <Alert severity="error" sx={{ mb: 3 }}>
            {error}
          </Alert>
        )}

        {success && (
          <Alert severity="success" sx={{ mb: 3 }}>
            {success}
          </Alert>
        )}

        <Box component="form" onSubmit={handleSubmit}>
          <TextField
            label="Current Password"
            type={showCurrentPassword ? 'text' : 'password'}
            fullWidth
            required
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            disabled={loading}
            autoComplete="current-password"
            autoFocus
            sx={{ mb: 2 }}
            slotProps={{
              input: {
                endAdornment: (
                  <InputAdornment position="end">
                    <IconButton onClick={() => setShowCurrentPassword(!showCurrentPassword)} edge="end" size="small">
                      {showCurrentPassword ? <VisibilityOff /> : <Visibility />}
                    </IconButton>
                  </InputAdornment>
                ),
              },
            }}
          />

          <TextField
            label="New Password"
            type={showNewPassword ? 'text' : 'password'}
            fullWidth
            required
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            disabled={loading}
            autoComplete="new-password"
            helperText="Minimum 8 characters"
            sx={{ mb: 2 }}
            slotProps={{
              input: {
                endAdornment: (
                  <InputAdornment position="end">
                    <IconButton onClick={() => setShowNewPassword(!showNewPassword)} edge="end" size="small">
                      {showNewPassword ? <VisibilityOff /> : <Visibility />}
                    </IconButton>
                  </InputAdornment>
                ),
              },
            }}
          />

          <TextField
            label="Confirm New Password"
            type={showConfirmPassword ? 'text' : 'password'}
            fullWidth
            required
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            disabled={loading}
            autoComplete="new-password"
            sx={{ mb: 3 }}
            error={confirmPassword !== '' && newPassword !== confirmPassword}
            helperText={
              confirmPassword !== '' && newPassword !== confirmPassword
                ? 'Passwords do not match'
                : ''
            }
            slotProps={{
              input: {
                endAdornment: (
                  <InputAdornment position="end">
                    <IconButton onClick={() => setShowConfirmPassword(!showConfirmPassword)} edge="end" size="small">
                      {showConfirmPassword ? <VisibilityOff /> : <Visibility />}
                    </IconButton>
                  </InputAdornment>
                ),
              },
            }}
          />

          <Button
            type="submit"
            variant="contained"
            fullWidth
            size="large"
            disabled={loading}
          >
            {loading ? (
              <CircularProgress size={24} color="inherit" />
            ) : (
              'Change Password'
            )}
          </Button>
        </Box>
      </CardContent>
    </Card>
  );
}
