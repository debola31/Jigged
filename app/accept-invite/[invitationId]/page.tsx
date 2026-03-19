'use client';

import { useState, useEffect } from 'react';
import { useRouter, useParams } from 'next/navigation';
import Box from '@mui/material/Box';
import Paper from '@mui/material/Paper';
import TextField from '@mui/material/TextField';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import CircularProgress from '@mui/material/CircularProgress';
import Alert from '@mui/material/Alert';
import Chip from '@mui/material/Chip';
import { getSupabase } from '@/lib/supabase';
import { setLastCompany } from '@/utils/companyAccess';
import { getEdgeFunctionUrl } from '@/lib/supabase';
import type { Invitation } from '@/types/team';

type PageState = 'loading' | 'no-session' | 'name-prompt' | 'accepting' | 'error';

export default function AcceptInvitePage() {
  const router = useRouter();
  const params = useParams();
  const invitationId = params.invitationId as string;

  const [state, setState] = useState<PageState>('loading');
  const [invitation, setInvitation] = useState<Invitation | null>(null);
  const [companyName, setCompanyName] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);

  useEffect(() => {
    checkSessionAndLoadInvitation();
  }, [invitationId]);

  async function checkSessionAndLoadInvitation() {
    const supabase = getSupabase();

    // Check for authenticated session
    const { data: { session } } = await supabase.auth.getSession();

    if (!session) {
      setState('no-session');
      return;
    }

    setUserId(session.user.id);

    // Pre-fill name from user metadata if available
    const metaName = session.user.user_metadata?.name || session.user.user_metadata?.full_name || '';
    if (metaName) {
      setName(metaName);
    }

    // Fetch the invitation
    const { data: inv, error: invError } = await supabase
      .from('invitations')
      .select('id, company_id, email, role, status, invited_by, expires_at, created_at')
      .eq('id', invitationId)
      .single();

    if (invError || !inv) {
      setError('Invitation not found. It may have been revoked or already accepted.');
      setState('error');
      return;
    }

    // Check if invitation is still valid
    if (inv.status !== 'pending') {
      if (inv.status === 'accepted') {
        // Already accepted — just redirect to dashboard
        router.replace(`/dashboard/${inv.company_id}`);
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

    // Fetch company name for display
    const { data: company } = await supabase
      .from('companies')
      .select('name')
      .eq('id', inv.company_id)
      .single();

    setCompanyName(company?.name || '');
    setInvitation(inv);
    setState('name-prompt');
  }

  async function handleAccept(e: React.FormEvent) {
    e.preventDefault();

    if (!name.trim()) {
      setError('Please enter your name');
      return;
    }

    if (!invitation || !userId) return;

    setState('accepting');
    setError(null);

    try {
      const supabase = getSupabase();

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

      if (session) {
        // Find the user_company_access record and update the name
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
            body: JSON.stringify({ name: name.trim() }),
          });
        }
      }

      // Set as last company
      await setLastCompany(userId, companyId);

      // Redirect to dashboard
      router.replace(`/dashboard/${companyId}`);
    } catch (err) {
      console.error('Error accepting invitation:', err);
      setError(err instanceof Error ? err.message : 'Failed to accept invitation');
      setState('name-prompt');
    }
  }

  // Loading state
  if (state === 'loading') {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '60vh' }}>
        <CircularProgress />
      </Box>
    );
  }

  // No session — redirect to login
  if (state === 'no-session') {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '60vh' }}>
        <Paper sx={{ p: 4, maxWidth: 450, textAlign: 'center' }}>
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
        </Paper>
      </Box>
    );
  }

  // Error state
  if (state === 'error') {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '60vh' }}>
        <Paper sx={{ p: 4, maxWidth: 450 }}>
          <Typography variant="h5" gutterBottom>
            Invitation Problem
          </Typography>
          <Alert severity="error" sx={{ mb: 3 }}>
            {error}
          </Alert>
          <Button variant="outlined" onClick={() => router.push('/login')}>
            Go to Login
          </Button>
        </Paper>
      </Box>
    );
  }

  // Accepting state
  if (state === 'accepting') {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '60vh' }}>
        <Box sx={{ textAlign: 'center' }}>
          <CircularProgress sx={{ mb: 2 }} />
          <Typography>Joining {companyName || 'team'}...</Typography>
        </Box>
      </Box>
    );
  }

  // Name prompt — main acceptance form
  return (
    <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '60vh' }}>
      <Paper sx={{ p: 4, maxWidth: 450 }}>
        <Typography variant="h5" gutterBottom>
          Join {companyName}
        </Typography>
        <Typography variant="body1" color="text.secondary" sx={{ mb: 1 }}>
          You&apos;ve been invited to join as:
        </Typography>
        <Chip
          label={invitation?.role === 'admin' ? 'Admin' : invitation?.role === 'operator' ? 'Operator' : 'User'}
          color="primary"
          sx={{ mb: 3 }}
        />

        {error && (
          <Alert severity="error" sx={{ mb: 3 }}>
            {error}
          </Alert>
        )}

        <form onSubmit={handleAccept}>
          <TextField
            label="Your Name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            fullWidth
            required
            autoFocus
            sx={{ mb: 3 }}
            helperText="This is how your team will see you"
          />

          <Button
            type="submit"
            variant="contained"
            fullWidth
            size="large"
          >
            Accept Invitation
          </Button>
        </form>
      </Paper>
    </Box>
  );
}
