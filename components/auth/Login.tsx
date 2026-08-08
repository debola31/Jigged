'use client';

import * as Sentry from "@sentry/nextjs";
import { useState } from 'react';
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
import { getSupabase } from '@/lib/supabase';
import { getPostLoginRoute } from '@/utils/companyAccess';
import { isValidEmail } from '@/lib/validators';

interface LoginProps {
  expired?: boolean;
  returnTo?: string | null;
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

export default function Login({ expired, returnTo }: LoginProps) {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);

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
      console.error('Login error:', err);
      Sentry.captureException(err);
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
