'use client';

import * as Sentry from "@sentry/nextjs";
import { useState, useEffect } from 'react';
import type { AuthChangeEvent } from '@supabase/supabase-js';
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
import { getSupabase } from '@/lib/supabase';
import { useAuth } from '@/components/providers/AuthProvider';

export default function ResetPassword() {
  const router = useRouter();
  const { signOut } = useAuth();
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [isValidRecovery, setIsValidRecovery] = useState(false);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    const supabase = getSupabase();

    // Listen for the PASSWORD_RECOVERY event (fires for the implicit/hash
    // flow when Supabase JS detects #access_token=...&type=recovery in
    // the URL on load).
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event: AuthChangeEvent) => {
      if (event === 'PASSWORD_RECOVERY') {
        setIsValidRecovery(true);
        setChecking(false);
      }
    });

    const init = async () => {
      const url = new URL(window.location.href);

      // PKCE flow: Supabase appends ?code=... to the redirect URL and
      // expects exchangeCodeForSession to mint the session.
      const code = url.searchParams.get('code');
      if (code) {
        const { error: exchangeError } = await supabase.auth.exchangeCodeForSession(code);
        if (!exchangeError) {
          url.searchParams.delete('code');
          window.history.replaceState({}, '', url.toString());
          setIsValidRecovery(true);
          setChecking(false);
          return;
        }
        console.error('ResetPassword: exchangeCodeForSession failed', exchangeError);
      }

      // Implicit/hash flow: Supabase appends #access_token=...&refresh_token=...&type=recovery
      // to the redirect URL. The @supabase/ssr browser client does NOT
      // process URL hash fragments automatically (it's opinionated about
      // PKCE + cookie storage), so we have to read the hash and
      // establish the session ourselves via setSession.
      if (window.location.hash && window.location.hash.length > 1) {
        const hashParams = new URLSearchParams(window.location.hash.slice(1));
        const accessToken = hashParams.get('access_token');
        const refreshToken = hashParams.get('refresh_token');
        const type = hashParams.get('type');
        if (accessToken && refreshToken && type === 'recovery') {
          const { error: setSessionError } = await supabase.auth.setSession({
            access_token: accessToken,
            refresh_token: refreshToken,
          });
          if (!setSessionError) {
            // Strip the hash so a refresh/back doesn't try to re-use
            // an already-consumed recovery token.
            window.history.replaceState({}, '', url.pathname + url.search);
            setIsValidRecovery(true);
            setChecking(false);
            return;
          }
          console.error('ResetPassword: setSession from hash failed', setSessionError);
        }
      }

      // Already-authenticated session (e.g. PASSWORD_RECOVERY fired in
      // an earlier mount, or the user is just visiting the page while
      // logged in).
      const { data: { session } } = await supabase.auth.getSession();
      if (session) {
        setIsValidRecovery(true);
        setChecking(false);
        return;
      }

      // Nothing usable — mark invalid after a short grace period to
      // let the PASSWORD_RECOVERY listener fire if Supabase ever does
      // process the hash on its own.
      setTimeout(() => {
        setChecking((prev) => (prev ? false : prev));
      }, 3000);
    };

    init();

    return () => {
      subscription.unsubscribe();
    };
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    if (newPassword !== confirmPassword) {
      setError('Passwords do not match');
      setLoading(false);
      return;
    }

    if (newPassword.length < 6) {
      setError('Password must be at least 6 characters');
      setLoading(false);
      return;
    }

    try {
      const supabase = getSupabase();
      const { error: updateError } = await supabase.auth.updateUser({
        password: newPassword,
      });

      if (updateError) {
        throw updateError;
      }

      setSuccess(true);

      // Global scope — a password reset must invalidate the user's sessions on
      // ALL devices (the lost/old device that prompted the reset included), not
      // just this recovery session. signOut defaults to `local` now, so this
      // flow passes 'global' explicitly. The flow then redirects to /login for a
      // fresh sign-in.
      await signOut('global');
      setTimeout(() => {
        router.push('/login');
      }, 2000);
    } catch (err) {
      console.error('Password reset error:', err);
      Sentry.captureException(err);
      setError(err instanceof Error ? err.message : 'An error occurred. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  if (checking) {
    return (
      <Card elevation={3}>
        <CardContent sx={{ p: 4, textAlign: 'center' }}>
          <CircularProgress sx={{ mb: 2 }} />
          <Typography variant="body2" color="text.secondary">
            Verifying reset link...
          </Typography>
        </CardContent>
      </Card>
    );
  }

  if (!isValidRecovery) {
    return (
      <Card elevation={3}>
        <CardContent sx={{ p: 4 }}>
          <Alert severity="error" sx={{ mb: 3 }}>
            Invalid or expired reset link.
          </Alert>
          <Typography variant="body2" color="text.secondary" align="center">
            This password reset link is no longer valid. Please request a new one.
          </Typography>
          <Box sx={{ mt: 3, textAlign: 'center' }}>
            <MuiLink component={Link} href="/forgot-password" underline="hover">
              Request new reset link
            </MuiLink>
          </Box>
        </CardContent>
      </Card>
    );
  }

  if (success) {
    return (
      <Card elevation={3}>
        <CardContent sx={{ p: 4 }}>
          <Alert severity="success" sx={{ mb: 3 }}>
            Password updated successfully!
          </Alert>
          <Typography variant="body2" color="text.secondary" align="center">
            Redirecting you to sign in...
          </Typography>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card elevation={3}>
      <CardContent sx={{ p: 4 }}>
        <Typography variant="h5" component="h2" gutterBottom align="center">
          Set New Password
        </Typography>
        <Typography variant="body2" color="text.secondary" align="center" sx={{ mb: 3 }}>
          Enter your new password below.
        </Typography>

        {error && (
          <Alert severity="error" sx={{ mb: 3 }}>
            {error}
          </Alert>
        )}

        <Box component="form" onSubmit={handleSubmit}>
          <TextField
            label="New Password"
            type={showPassword ? 'text' : 'password'}
            fullWidth
            required
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            disabled={loading}
            sx={{ mb: 2 }}
            autoComplete="new-password"
            helperText="Must be at least 6 characters"
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

          <TextField
            label="Confirm New Password"
            type={showConfirmPassword ? 'text' : 'password'}
            fullWidth
            required
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            disabled={loading}
            sx={{ mb: 3 }}
            autoComplete="new-password"
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
            error={confirmPassword !== '' && newPassword !== confirmPassword}
            helperText={
              confirmPassword !== '' && newPassword !== confirmPassword
                ? 'Passwords do not match'
                : ''
            }
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
              'Reset Password'
            )}
          </Button>
        </Box>
      </CardContent>
    </Card>
  );
}
