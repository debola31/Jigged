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
  const [isValidRecovery, setIsValidRecovery] = useState(false);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    const supabase = getSupabase();

    // Listen for the PASSWORD_RECOVERY event (fires if we arrive before AuthProvider processes it)
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event: AuthChangeEvent) => {
      if (event === 'PASSWORD_RECOVERY') {
        setIsValidRecovery(true);
        setChecking(false);
      }
    });

    // Also check if there's already an active session (the PASSWORD_RECOVERY event
    // may have already fired in AuthProvider before this component mounted)
    const checkExistingSession = async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (session) {
        setIsValidRecovery(true);
        setChecking(false);
      } else {
        // No session and event hasn't fired — give it a moment, then mark invalid
        setTimeout(() => {
          setChecking((prev) => {
            // Only update if still checking (event may have fired in the meantime)
            return prev ? false : prev;
          });
        }, 3000);
      }
    };

    checkExistingSession();

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

      // Sign out and redirect to login after a short delay
      await signOut();
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
            type="password"
            fullWidth
            required
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            disabled={loading}
            sx={{ mb: 2 }}
            autoComplete="new-password"
            helperText="Must be at least 6 characters"
          />

          <TextField
            label="Confirm New Password"
            type="password"
            fullWidth
            required
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            disabled={loading}
            sx={{ mb: 3 }}
            autoComplete="new-password"
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
