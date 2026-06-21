'use client';

import { useState } from 'react';
import { useRouter, useParams, useSearchParams } from 'next/navigation';
import Box from '@mui/material/Box';
import Paper from '@mui/material/Paper';
import TextField from '@mui/material/TextField';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import CircularProgress from '@mui/material/CircularProgress';
import Alert from '@mui/material/Alert';
import FormControl from '@mui/material/FormControl';
import InputLabel from '@mui/material/InputLabel';
import Select from '@mui/material/Select';
import MenuItem from '@mui/material/MenuItem';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import { getSupabase, getEdgeFunctionUrl } from '@/lib/supabase';
import type { InviteResponse } from '@/types/team';

/**
 * Get the Edge Function URL for team invitations.
 */
const getInviteUrl = () => getEdgeFunctionUrl('team-invites');

/**
 * Invite Team Member Page.
 *
 * Sends a magic link invitation email to the specified address.
 * The invited user clicks the link to join the company with the assigned role.
 */
export default function InviteTeamMemberPage() {
  const router = useRouter();
  const params = useParams();
  const searchParams = useSearchParams();
  const companyId = params.companyId as string;
  const defaultRole = searchParams.get('role') as 'admin' | 'user' | 'operator' || 'user';

  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'admin' | 'user' | 'operator'>(defaultRole);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!email.trim()) {
      setError('Email is required');
      return;
    }

    // Basic email validation
    if (!/^[^@]+@[^@]+\.[^@]+$/.test(email)) {
      setError('Please enter a valid email address');
      return;
    }

    setLoading(true);
    setError(null);
    setSuccess(null);
    setWarning(null);

    try {
      // Get auth session for Edge Function authorization
      const supabase = getSupabase();
      const { data: { session } } = await supabase.auth.getSession();

      if (!session) {
        throw new Error('Not authenticated');
      }

      // Call Edge Function to send invitation
      const url = getInviteUrl();
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          company_id: companyId,
          email: email.trim().toLowerCase(),
          role,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ error: 'Failed to send invitation' }));
        throw new Error(errorData.error || 'Failed to send invitation');
      }

      const data: InviteResponse = await response.json();

      if (!data.success) {
        throw new Error(data.message || 'Failed to send invitation');
      }

      // The invitation row can be created even when the email fails to send.
      // Don't show a green "sent" confirmation in that case — surface a warning
      // and keep the admin on the page so they can Resend from the team list.
      if (data.email_sent === false) {
        setWarning(data.message || 'Invitation created, but the email could not be sent. Use "Resend" on the team page to try again.');
        return;
      }

      setSuccess(data.message || `Invitation sent to ${email}`);

      // Navigate back to team page after a brief delay
      setTimeout(() => {
        router.push(`/dashboard/${companyId}/team`);
      }, 1500);
    } catch (err) {
      console.error('Error sending invitation:', err);
      setError(err instanceof Error ? err.message : 'Failed to send invitation');
    } finally {
      setLoading(false);
    }
  };

  const roleLabel = role === 'admin' ? 'Admin' : role === 'operator' ? 'Operator' : 'User';

  return (
    <Box>
      <Button
        startIcon={<ArrowBackIcon />}
        onClick={() => router.push(`/dashboard/${companyId}/team`)}
        sx={{ mb: 2 }}
      >
        Back to Team
      </Button>

      <Paper sx={{ p: 4, maxWidth: 500 }}>
        <Typography variant="h5" gutterBottom>
          Invite {roleLabel}
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
          Send an email invitation with a magic link.
        </Typography>

        {error && (
          <Alert severity="error" sx={{ mb: 3 }}>
            {error}
          </Alert>
        )}

        {warning && (
          <Alert severity="warning" sx={{ mb: 3 }}>
            {warning}
          </Alert>
        )}

        {success && (
          <Alert severity="success" sx={{ mb: 3 }}>
            {success}
          </Alert>
        )}

        <form onSubmit={handleSubmit}>
          <TextField
            label="Email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            fullWidth
            required
            autoFocus
            sx={{ mb: 3 }}
            helperText="They will receive an email with a link to join your team"
          />

          <FormControl fullWidth sx={{ mb: 3 }}>
            <InputLabel>Role</InputLabel>
            <Select
              value={role}
              label="Role"
              onChange={(e) => setRole(e.target.value as 'admin' | 'user' | 'operator')}
            >
              <MenuItem value="admin">Admin - Full access, can manage team</MenuItem>
              <MenuItem value="user">User - Can use all modules, cannot manage team</MenuItem>
              <MenuItem value="operator">Operator - Shop floor access only</MenuItem>
            </Select>
          </FormControl>

          <Box sx={{ display: 'flex', gap: 2 }}>
            <Button
              type="button"
              variant="outlined"
              onClick={() => router.push(`/dashboard/${companyId}/team`)}
              disabled={loading}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant="contained"
              disabled={loading || !!success}
              startIcon={loading ? <CircularProgress size={16} color="inherit" /> : null}
            >
              {loading ? 'Sending...' : 'Send Invitation'}
            </Button>
          </Box>
        </form>
      </Paper>
    </Box>
  );
}
