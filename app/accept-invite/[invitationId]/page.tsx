'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter, useParams } from 'next/navigation';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import TextField from '@mui/material/TextField';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import CircularProgress from '@mui/material/CircularProgress';
import Alert from '@mui/material/Alert';
import Chip from '@mui/material/Chip';
import InputAdornment from '@mui/material/InputAdornment';
import IconButton from '@mui/material/IconButton';
import Visibility from '@mui/icons-material/Visibility';
import VisibilityOff from '@mui/icons-material/VisibilityOff';
import posthog from 'posthog-js';
import type { AuthChangeEvent, Session } from '@supabase/supabase-js';
import { getSupabase } from '@/lib/supabase';
import { setLastCompany, homePathForRole } from '@/utils/companyAccess';
import { getEdgeFunctionUrl } from '@/lib/supabase';
import { AuthLayout } from '@/components/auth';
import type { Invitation } from '@/types/team';

type PageState = 'loading' | 'no-session' | 'name-prompt' | 'accepting' | 'error';

export default function AcceptInvitePage() {
  const router = useRouter();
  const params = useParams();
  const invitationId = params.invitationId as string;

  const [state, setState] = useState<PageState>('loading');
  const [invitation, setInvitation] = useState<Invitation | null>(null);
  const [companyName, setCompanyName] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);

  const checkSessionAndLoadInvitation = useCallback(async () => {
    const supabase = getSupabase();

    // Handle auth tokens from the invite email redirect.
    // Supabase may use implicit flow (hash fragments) or PKCE (code param).
    // Process these before checking for an existing session.
    if (typeof window !== 'undefined') {
      // Handle hash fragment tokens (implicit flow)
      if (window.location.hash) {
        const hashParams = new URLSearchParams(window.location.hash.substring(1));
        const accessToken = hashParams.get('access_token');
        const refreshToken = hashParams.get('refresh_token');
        if (accessToken) {
          if (refreshToken) {
            await supabase.auth.setSession({ access_token: accessToken, refresh_token: refreshToken });
          } else {
            // Some flows only provide access_token — set it manually
            await supabase.auth.setSession({ access_token: accessToken, refresh_token: '' });
          }
          window.history.replaceState(null, '', window.location.pathname);
        }
      }

      // Handle code param (PKCE flow)
      const urlParams = new URLSearchParams(window.location.search);
      const code = urlParams.get('code');
      if (code) {
        await supabase.auth.exchangeCodeForSession(code);
        window.history.replaceState(null, '', window.location.pathname);
      }
    }

    // Check for authenticated session.
    // If no session yet, wait briefly for async auth state processing.
    let session = (await supabase.auth.getSession()).data.session;

    if (!session) {
      // Wait for auth state change (hash fragment processing may be async)
      session = await new Promise<typeof session>((resolve) => {
        const timeout = setTimeout(() => resolve(null), 3000);
        const { data: { subscription } } = supabase.auth.onAuthStateChange((_event: AuthChangeEvent, newSession: Session | null) => {
          if (newSession) {
            clearTimeout(timeout);
            subscription.unsubscribe();
            resolve(newSession);
          }
        });
      });
    }

    if (!session) {
      setState('no-session');
      return;
    }

    setUserId(session.user.id);

    // Pre-fill name from user metadata if available
    const meta = session.user.user_metadata;
    if (meta?.first_name) setFirstName(meta.first_name);
    if (meta?.last_name) setLastName(meta.last_name);
    if (!meta?.first_name && (meta?.name || meta?.full_name)) {
      const fullName = (meta.name || meta.full_name || '').trim();
      const parts = fullName.split(/\s+/);
      if (parts.length >= 2) {
        setFirstName(parts[0]);
        setLastName(parts.slice(1).join(' '));
      } else if (parts.length === 1) {
        setFirstName(parts[0]);
      }
    }

    // Fetch invitation via edge function (uses service role, bypasses RLS).
    // Direct table queries and RPCs fail due to JWT propagation timing
    // after hash-fragment authentication from the invite email link.
    const inviteUrl = getEdgeFunctionUrl('team-invites');
    let inv: Invitation & { company_name?: string };

    try {
      const res = await fetch(`${inviteUrl}/${invitationId}`, {
        headers: {
          'Authorization': `Bearer ${session.access_token}`,
        },
      });

      if (!res.ok) {
        console.error('Invitation fetch failed:', res.status);
        setError('Invitation not found. It may have been revoked or already accepted.');
        setState('error');
        return;
      }

      inv = await res.json();
    } catch (err) {
      console.error('Invitation fetch error:', err);
      setError('Invitation not found. It may have been revoked or already accepted.');
      setState('error');
      return;
    }

    // Check if invitation is still valid
    if (inv.status !== 'pending') {
      if (inv.status === 'accepted') {
        // Already accepted — send them to their home surface, which for an operator
        // is the shop floor rather than a dashboard they'd be bounced straight out of.
        router.replace(homePathForRole(inv.role, inv.company_id));
        return;
      }
      setError(`This invitation has been ${inv.status}. Please contact your admin for a new invitation.`);
      setState('error');
      return;
    }

    if (new Date(inv.expires_at) < new Date()) {
      setError('This invitation has expired. Please contact your admin for a new invitation.');
      setState('error');
      return;
    }

    // Check email matches
    if (session.user.email?.toLowerCase() !== inv.email.toLowerCase()) {
      setError(
        `This invitation was sent to ${inv.email}. You are signed in as ${session.user.email}. Please sign in with the correct email address.`
      );
      setState('error');
      return;
    }

    // Company name comes from the RPC join (bypasses RLS)
    setCompanyName(inv.company_name || '');
    setInvitation(inv);
    setState('name-prompt');
  }, [invitationId, router]);

  useEffect(() => {
    // False positive: checkSessionAndLoadInvitation is an async auth
    // orchestration (token exchange → session → invitation fetch) and every
    // setState inside it runs AFTER an await, never synchronously in this
    // effect body — so it can't cause the cascading-render the rule guards.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    checkSessionAndLoadInvitation();
  }, [checkSessionAndLoadInvitation]);

  async function handleAccept(e: React.FormEvent) {
    e.preventDefault();

    if (!firstName.trim() || !lastName.trim()) {
      setError('First name and last name are required');
      return;
    }

    if (password) {
      if (password.length < 6) {
        setError('Password must be at least 6 characters');
        return;
      }
      if (password !== confirmPassword) {
        setError('Passwords do not match');
        return;
      }
    }

    if (!invitation || !userId) return;

    setState('accepting');
    setError(null);

    try {
      const supabase = getSupabase();

      // Update user profile (and password if provided)
      const updatePayload: { password?: string; data: Record<string, string | null> } = {
        data: {
          first_name: firstName.trim(),
          last_name: lastName.trim(),
          display_name: `${firstName.trim()} ${lastName.trim()}`,
          // Clear invitation_id so the auth callback fallback doesn't
          // redirect here on future logins
          invitation_id: null,
        },
      };
      if (password) {
        updatePayload.password = password;
      }

      const { error: updateError } = await supabase.auth.updateUser(updatePayload);
      if (updateError) {
        throw new Error(updateError.message || 'Failed to update account');
      }

      // Accept invitation via database RPC
      const { data: companyId, error: rpcError } = await supabase
        .rpc('accept_invitation', {
          p_invitation_id: invitation.id,
          p_user_id: userId,
        });

      if (rpcError) {
        throw new Error(rpcError.message || 'Failed to accept invitation');
      }

      // Update the user's name on the team record
      const { data: { session } } = await supabase.auth.getSession();
      const fullName = `${firstName.trim()} ${lastName.trim()}`;

      if (session) {
        const teamUrl = getEdgeFunctionUrl('team');
        const { data: members } = await supabase
          .from('user_company_access')
          .select('id')
          .eq('user_id', userId)
          .eq('company_id', companyId)
          .single();

        if (members) {
          await fetch(`${teamUrl}/${members.id}`, {
            method: 'PATCH',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${session.access_token}`,
            },
            body: JSON.stringify({ name: fullName }),
          });
        }
      }

      // Set as last company
      await setLastCompany(userId, companyId);

      posthog.identify(userId, { email: invitation.email });
      posthog.capture('invitation_accepted', { role: invitation.role });

      // Straight to the surface the invited role actually works on. A new operator's
      // very first screen used to be a dashboard flash before AuthGuard corrected it.
      router.replace(homePathForRole(invitation.role, companyId));
    } catch (err) {
      console.error('Error accepting invitation:', err);
      setError(err instanceof Error ? err.message : 'Failed to accept invitation');
      setState('name-prompt');
    }
  }

  // Loading state
  if (state === 'loading') {
    return (
      <AuthLayout>
        <Box sx={{ textAlign: 'center', py: 4 }}>
          <CircularProgress />
        </Box>
      </AuthLayout>
    );
  }

  // No session — redirect to login
  if (state === 'no-session') {
    return (
      <AuthLayout>
        <Card elevation={3}>
          <CardContent sx={{ p: 4, textAlign: 'center' }}>
            <Typography variant="h5" gutterBottom>
              Sign In Required
            </Typography>
            <Typography variant="body1" color="text.secondary" sx={{ mb: 3 }}>
              Please sign in to accept your team invitation.
            </Typography>
            <Button
              variant="contained"
              onClick={() => router.push(`/login?returnTo=/accept-invite/${invitationId}`)}
            >
              Sign In
            </Button>
          </CardContent>
        </Card>
      </AuthLayout>
    );
  }

  // Error state
  if (state === 'error') {
    return (
      <AuthLayout>
        <Card elevation={3}>
          <CardContent sx={{ p: 4 }}>
            <Typography variant="h5" gutterBottom>
              Invitation Problem
            </Typography>
            <Alert severity="error" sx={{ mb: 3 }}>
              {error}
            </Alert>
            <Button variant="outlined" onClick={() => router.push('/login')}>
              Go to Login
            </Button>
          </CardContent>
        </Card>
      </AuthLayout>
    );
  }

  // Accepting state
  if (state === 'accepting') {
    return (
      <AuthLayout>
        <Box sx={{ textAlign: 'center', py: 4 }}>
          <CircularProgress sx={{ mb: 2 }} />
          <Typography>Joining {companyName || 'team'}...</Typography>
        </Box>
      </AuthLayout>
    );
  }

  // Account setup — main acceptance form
  const roleLabel = invitation?.role === 'admin' ? 'Admin' : invitation?.role === 'operator' ? 'Operator' : 'User';

  return (
    <AuthLayout>
      <Card elevation={3}>
        <CardContent sx={{ p: 4 }}>
          <Typography variant="h5" component="h2" gutterBottom align="center">
            Join {companyName || 'Your Team'}
          </Typography>
          <Typography variant="body2" color="text.secondary" align="center" sx={{ mb: 1 }}>
            Set up your account to get started.
          </Typography>
          <Box sx={{ display: 'flex', justifyContent: 'center', mb: 3 }}>
            <Chip label={roleLabel} color="primary" />
          </Box>

          {error && (
            <Alert severity="error" sx={{ mb: 3 }}>
              {error}
            </Alert>
          )}

          <Box component="form" onSubmit={handleAccept}>
            <Box sx={{ display: 'flex', gap: 2, mb: 2 }}>
              <TextField
                label="First Name"
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                fullWidth
                required
                autoFocus
                autoComplete="given-name"
                sx={{ flex: 1 }}
              />
              <TextField
                label="Last Name"
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
                fullWidth
                required
                autoComplete="family-name"
                sx={{ flex: 1 }}
              />
            </Box>

            <TextField
              label="Password"
              type={showPassword ? 'text' : 'password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              fullWidth
              sx={{ mb: 2 }}
              autoComplete="new-password"
              helperText="Set a password for future logins. Leave blank if you already have one."
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
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              fullWidth
              sx={{ mb: 3 }}
              autoComplete="new-password"
              error={confirmPassword !== '' && password !== confirmPassword}
              helperText={
                confirmPassword !== '' && password !== confirmPassword
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
            >
              Accept Invitation
            </Button>
          </Box>
        </CardContent>
      </Card>
    </AuthLayout>
  );
}
