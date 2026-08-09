'use client';

import { useState } from 'react';
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
import { isValidEmail } from '@/lib/validators';

export default function SignUp() {
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    // Validate names
    if (!firstName.trim() || !lastName.trim()) {
      setError('First name and last name are required');
      setLoading(false);
      return;
    }

    // Validate email format
    if (!isValidEmail(email)) {
      setError('Enter a valid email address');
      setLoading(false);
      return;
    }

    // Validate passwords match
    if (password !== confirmPassword) {
      setError('Passwords do not match');
      setLoading(false);
      return;
    }

    // Validate password length
    if (password.length < 6) {
      setError('Password must be at least 6 characters');
      setLoading(false);
      return;
    }

    try {
      const supabase = getSupabase();
      const { error: signUpError } = await supabase.auth.signUp({
        email,
        password,
        options: {
          emailRedirectTo: `${window.location.origin}/auth/callback`,
          data: {
            first_name: firstName.trim(),
            last_name: lastName.trim(),
            display_name: `${firstName.trim()} ${lastName.trim()}`,
          },
        },
      });

      if (signUpError) {
        throw signUpError;
      }

      setSuccess(true);
    } catch (err) {
      // No `Sentry.captureException`: `signUp` is instrumented by the Supabase integration, which
      // files this as `auto.db.supabase.auth`. See the note in Login.tsx — the sibling auth
      // screens call operations that are NOT instrumented and keep their captures.
      console.error('Sign up error:', err);
      setError(err instanceof Error ? err.message : 'An error occurred during sign up');
    } finally {
      setLoading(false);
    }
  };

  if (success) {
    return (
      <Card elevation={3}>
        <CardContent sx={{ p: 4 }}>
          <Alert severity="success" sx={{ mb: 3 }}>
            Check your email for a confirmation link!
          </Alert>
          <Typography variant="body2" color="text.secondary" align="center">
            We&apos;ve sent a confirmation email to <strong>{email}</strong>.
            Please click the link in the email to verify your account.
          </Typography>
          <Typography variant="body2" color="text.secondary" align="center" sx={{ mt: 2 }}>
            After confirming your email, we&apos;ll be in touch to get your company set up.
          </Typography>
          <Box sx={{ mt: 3, textAlign: 'center' }}>
            <MuiLink component={Link} href="/login" underline="hover">
              Return to sign in
            </MuiLink>
          </Box>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card elevation={3}>
      <CardContent sx={{ p: 4 }}>
        <Typography variant="h5" component="h2" gutterBottom align="center">
          Create Account
        </Typography>
        <Typography variant="body2" color="text.secondary" align="center" sx={{ mb: 3 }}>
          Sign up to get started with Jigged.
        </Typography>

        {error && (
          <Alert severity="error" sx={{ mb: 3 }}>
            {error}
          </Alert>
        )}

        <Box component="form" onSubmit={handleSubmit}>
          <Box sx={{ display: 'flex', gap: 2, mb: 2 }}>
            <TextField
              label="First Name"
              fullWidth
              required
              value={firstName}
              onChange={(e) => setFirstName(e.target.value)}
              disabled={loading}
              autoComplete="given-name"
              sx={{ flex: 1 }}
            />
            <TextField
              label="Last Name"
              fullWidth
              required
              value={lastName}
              onChange={(e) => setLastName(e.target.value)}
              disabled={loading}
              autoComplete="family-name"
              sx={{ flex: 1 }}
            />
          </Box>

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
            label="Password"
            type={showPassword ? 'text' : 'password'}
            fullWidth
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
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
            label="Confirm Password"
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
            error={confirmPassword !== '' && password !== confirmPassword}
            helperText={
              confirmPassword !== '' && password !== confirmPassword
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
            sx={{ mb: 2 }}
          >
            {loading ? (
              <CircularProgress size={24} color="inherit" />
            ) : (
              'Create Account'
            )}
          </Button>

          <Typography variant="body2" align="center" color="text.secondary" sx={{ mb: 1 }}>
            By creating an account, you agree to our{' '}
            <MuiLink component={Link} href="/terms" underline="hover">
              Terms of Service
            </MuiLink>
            {' and '}
            <MuiLink component={Link} href="/privacy" underline="hover">
              Privacy Policy
            </MuiLink>
            .
          </Typography>

          <Typography variant="body2" align="center" color="text.secondary">
            Already have an account?{' '}
            <MuiLink component={Link} href="/login" underline="hover">
              Sign in
            </MuiLink>
          </Typography>
        </Box>
      </CardContent>
    </Card>
  );
}
