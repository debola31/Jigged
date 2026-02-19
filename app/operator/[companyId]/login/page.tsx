'use client';

import { useState, useEffect } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import Box from '@mui/material/Box';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import TextField from '@mui/material/TextField';
import Button from '@mui/material/Button';
import Alert from '@mui/material/Alert';
import CircularProgress from '@mui/material/CircularProgress';
import InputAdornment from '@mui/material/InputAdornment';
import IconButton from '@mui/material/IconButton';
import Visibility from '@mui/icons-material/Visibility';
import VisibilityOff from '@mui/icons-material/VisibilityOff';
import EmailIcon from '@mui/icons-material/Email';
import LockIcon from '@mui/icons-material/Lock';
import { getSupabase } from '@/lib/supabase';

/**
 * Operator Login Page.
 *
 * Mobile-first email/password login using Supabase Auth.
 * Reads station (operation_type_id) from URL query param.
 */
export default function OperatorLoginPage() {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const companyId = params.companyId as string;
  const stationId = searchParams.get('station') || undefined;

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [checkingSession, setCheckingSession] = useState(true);

  const supabase = getSupabase();

  // Check for existing session on mount
  useEffect(() => {
    const checkSession = async () => {
      const { data: { session } } = await supabase.auth.getSession();

      if (session) {
        // User is logged in, verify they're an operator for this company
        const { data: operatorAccess } = await supabase
          .from('user_company_access')
          .select('id')
          .eq('user_id', session.user.id)
          .eq('company_id', companyId)
          .eq('role', 'operator')
          .single();

        if (operatorAccess) {
          // Persist station from QR code to sessionStorage for the context to pick up
          if (stationId && typeof window !== 'undefined') {
            sessionStorage.setItem('jigged_operator_station', stationId);
          }

          // Check if password change required
          if (session.user.user_metadata?.needs_password_change) {
            router.push(`/operator/${companyId}/change-password`);
          } else {
            router.push(`/operator/${companyId}/jobs`);
          }
          return;
        }
      }

      setCheckingSession(false);
    };

    checkSession();
  }, [companyId, router, stationId, supabase]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!email.trim() || !password.trim()) {
      setError('Please enter both email and password');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      // 1. Sign in with Supabase Auth
      const { data, error: authError } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      });

      if (authError) {
        throw new Error(authError.message);
      }

      if (!data.user || !data.session) {
        throw new Error('Login failed');
      }

      // 2. Ensure session is synchronized before querying
      // The signInWithPassword response includes the session, but we need to
      // ensure the client's auth state is updated for RLS policies to work
      await supabase.auth.setSession({
        access_token: data.session.access_token,
        refresh_token: data.session.refresh_token,
      });

      // 3. Validate user is an operator for this company
      const { data: operatorAccess, error: opError } = await supabase
        .from('user_company_access')
        .select('id, name')
        .eq('user_id', data.user.id)
        .eq('company_id', companyId)
        .eq('role', 'operator')
        .single();

      if (opError || !operatorAccess) {
        await supabase.auth.signOut();
        throw new Error('You are not registered as an operator for this company');
      }

      // Note: Supabase auth automatically tracks last_sign_in_at

      // 4. Check if password change required
      if (data.user.user_metadata?.needs_password_change) {
        router.push(`/operator/${companyId}/change-password`);
        return;
      }

      // 5. Persist station to sessionStorage for station context
      if (stationId && typeof window !== 'undefined') {
        sessionStorage.setItem('jigged_operator_station', stationId);
      }

      // 6. Redirect to jobs
      router.push(`/operator/${companyId}/jobs`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  if (checkingSession) {
    return (
      <Box
        sx={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'linear-gradient(135deg, #111439 0%, #4682B4 50%, #111439 100%)',
        }}
      >
        <CircularProgress />
      </Box>
    );
  }

  return (
    <Box
      sx={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        p: 2,
        background: 'linear-gradient(135deg, #111439 0%, #4682B4 50%, #111439 100%)',
      }}
    >
      <Paper
        elevation={3}
        sx={{
          p: 4,
          maxWidth: 400,
          width: '100%',
          textAlign: 'center',
          bgcolor: 'rgba(17, 20, 57, 0.95)',
          backdropFilter: 'blur(10px)',
          borderRadius: 2,
        }}
      >
        {/* Logo / Title */}
        <Typography
          variant="h4"
          component="h1"
          sx={{ mb: 1, fontWeight: 700, color: 'primary.main' }}
        >
          Jigged
        </Typography>
        <Typography variant="body1" color="text.secondary" sx={{ mb: 4 }}>
          Operator Sign In
        </Typography>

        {/* Login Form */}
        <Box component="form" onSubmit={handleSubmit}>
          {/* Email Field */}
          <TextField
            fullWidth
            type="email"
            label="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={loading}
            autoComplete="email"
            autoFocus
            sx={{ mb: 2 }}
            InputProps={{
              startAdornment: (
                <InputAdornment position="start">
                  <EmailIcon color="action" />
                </InputAdornment>
              ),
              sx: { height: 56 },
            }}
          />

          {/* Password Field */}
          <TextField
            fullWidth
            type={showPassword ? 'text' : 'password'}
            label="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={loading}
            autoComplete="current-password"
            sx={{ mb: 3 }}
            InputProps={{
              startAdornment: (
                <InputAdornment position="start">
                  <LockIcon color="action" />
                </InputAdornment>
              ),
              endAdornment: (
                <InputAdornment position="end">
                  <IconButton
                    onClick={() => setShowPassword(!showPassword)}
                    edge="end"
                    disabled={loading}
                  >
                    {showPassword ? <VisibilityOff /> : <Visibility />}
                  </IconButton>
                </InputAdornment>
              ),
              sx: { height: 56 },
            }}
          />

          {/* Error Message */}
          {error && (
            <Alert severity="error" sx={{ mb: 3 }}>
              {error}
            </Alert>
          )}

          {/* Sign In Button */}
          <Button
            type="submit"
            variant="contained"
            fullWidth
            disabled={loading}
            sx={{
              height: 56,
              fontSize: '1.1rem',
              fontWeight: 600,
            }}
          >
            {loading ? <CircularProgress size={24} color="inherit" /> : 'Sign In'}
          </Button>
        </Box>

        {/* Station Info */}
        {stationId && (
          <Typography variant="caption" color="text.secondary" sx={{ mt: 3, display: 'block' }}>
            Station: {stationId.slice(0, 8)}...
          </Typography>
        )}
      </Paper>
    </Box>
  );
}
