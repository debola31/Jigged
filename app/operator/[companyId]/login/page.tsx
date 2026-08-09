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
import Link from 'next/link';
import { JiggedLogo } from '@/components/branding';
import EmailIcon from '@mui/icons-material/Email';
import LockIcon from '@mui/icons-material/Lock';
import posthog from 'posthog-js';
import { getSupabase } from '@/lib/supabase';
import { isIndeterminateSingleError } from '@/lib/supabaseErrors';
import { clearStoredStation } from '@/lib/operatorStationStorage';
import { getCompany } from '@/utils/companyAccess';
import { safeNextPath, scanKindFromDestination } from '@/lib/jiggedScan';

/**
 * Operator Login Page.
 *
 * Mobile-first email/password login using Supabase Auth. The station is chosen
 * in-app after login (header dropdown / StationSelector), not via the URL.
 */
export default function OperatorLoginPage() {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const companyId = params.companyId as string;
  const next = searchParams.get('next');

  /**
   * Where to land after auth.
   *
   * This page used to re-derive the destination from `?job=`, `?part=`, `?operation=` and
   * `?location=` — **a second, hand-maintained copy of `scanDestination`**, with a comment
   * admitting the two had to agree and that nothing checked it. Now the scan landing route computes
   * the destination once and passes it here as `next`; this page only validates and replays it.
   * One mapping, one place, and the drift risk is gone rather than documented.
   *
   * `safeNextPath` is not a formality: a query parameter is attacker-controlled even when we were
   * the ones who wrote it, so it must be re-checked against this company's own operator prefix
   * before it becomes a navigation. Anything else falls back to the jobs list.
   */
  const postLoginPath = () => safeNextPath(next, companyId) ?? `/operator/${companyId}/jobs`;

  const [companyName, setCompanyName] = useState<string>('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [checkingSession, setCheckingSession] = useState(true);

  const supabase = getSupabase();

  // Fetch company name for display
  useEffect(() => {
    getCompany(companyId).then((company) => {
      if (company?.name) setCompanyName(company.name);
    });
  }, [companyId]);

  // Check for existing session on mount
  useEffect(() => {
    const checkSession = async () => {
      const { data: { session } } = await supabase.auth.getSession();

      // The camera-app half of "how long does a scan take". The in-app scanner can time itself;
      // this path cannot — the phone leaves the browser and comes back — so all it can honestly
      // report is that a scanned link arrived and whether it had to stop at the sign-in form.
      // `had_session` is the interesting bit: a false here is a scan that cost an extra screen.
      const destination = safeNextPath(next, companyId);
      if (destination) {
        posthog.capture('scan link opened', {
          kind: scanKindFromDestination(destination) ?? 'unknown',
          had_session: Boolean(session),
        });
      }

      if (session) {
        // User is logged in, verify they have access to this company
        const { data: operatorAccess } = await supabase
          .from('user_company_access')
          .select('id')
          .eq('user_id', session.user.id)
          .eq('company_id', companyId)
          .single();

        if (operatorAccess) {
          router.push(postLoginPath());
          return;
        }
        // Discarding the error is DELIBERATE here, unlike the two other membership
        // reads on this surface. Falling through only skips the auto-forward and
        // shows the sign-in form — it asserts nothing about access and destroys
        // no session, so there is no false "denied" to prevent. Adding a retry
        // screen in front of a form the operator can simply use would be worse.
      }

      setCheckingSession(false);
    };

    checkSession();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId, router, next, supabase]);

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

      // 3. Validate user has access to this company
      const { data: operatorAccess, error: opError } = await supabase
        .from('user_company_access')
        .select('id, name')
        .eq('user_id', data.user.id)
        .eq('company_id', companyId)
        .single();

      // "COULDN'T CHECK" IS NEVER "DENIED". This branch used to treat both alike,
      // which produced the worst version of the bug: credentials that had just
      // succeeded, immediately revoked, under a message telling the operator they
      // don't work here. Keep the session; let them press sign in again.
      if (isIndeterminateSingleError(opError)) {
        throw new Error(
          "Couldn't check your access just now — this is usually the shop's connection. Please try again.",
        );
      }

      if (!operatorAccess) {
        // Local scope — only clear this device's session; don't revoke the
        // user's sessions on other devices. The station goes with it: the
        // session that chose it is over (see AuthProvider.signOut).
        clearStoredStation();
        await supabase.auth.signOut({ scope: 'local' });
        throw new Error('You do not have access to this company');
      }

      // Note: Supabase auth automatically tracks last_sign_in_at

      // 4. Redirect to wherever the scanned QR points (per-operation step,
      // per-part traveler, per-job parts hub, or the jobs list).
      router.push(postLoginPath());
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
        <Box sx={{ display: 'flex', justifyContent: 'center', mb: 1 }}>
          <Link href="/" style={{ textDecoration: 'none' }}>
            <JiggedLogo size="large" />
          </Link>
        </Box>
        {companyName && (
          <Typography variant="h6" fontWeight={600} sx={{ mb: 0.5 }}>
            {companyName}
          </Typography>
        )}
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

        {/*
          Says why they are looking at a sign-in form when they expected a job. It used to print
          `Job: 8a3f9c1d...` — a truncated UUID, which told an operator nothing they could use and
          told anyone reading over their shoulder a fragment of an id.
        */}
        {safeNextPath(next, companyId) && (
          <Typography variant="caption" color="text.secondary" sx={{ mt: 3, display: 'block' }}>
            Sign in to open the label you scanned.
          </Typography>
        )}
      </Paper>
    </Box>
  );
}
