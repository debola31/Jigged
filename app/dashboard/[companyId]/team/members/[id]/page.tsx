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
import Divider from '@mui/material/Divider';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import FormControl from '@mui/material/FormControl';
import InputLabel from '@mui/material/InputLabel';
import Select from '@mui/material/Select';
import MenuItem from '@mui/material/MenuItem';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import LockResetIcon from '@mui/icons-material/LockReset';
import DeleteIcon from '@mui/icons-material/Delete';
import { getSupabase, getEdgeFunctionUrl } from '@/lib/supabase';
import type { TeamMember } from '@/types/team';

const getTeamUrl = () => getEdgeFunctionUrl('team');

/**
 * Edit Team Member Page.
 *
 * Allows viewing and editing team member role for all roles (admin, user, operator).
 * Email and name are read-only (stored in auth.users).
 *
 * Password reset triggers an email-link recovery flow — admin never sees,
 * sets, or transmits a password. See plans/we-need-to-replace-atomic-wirth.md.
 */
export default function EditTeamMemberPage() {
  const router = useRouter();
  const params = useParams();
  const companyId = params.companyId as string;
  const memberId = params.id as string;

  const [member, setMember] = useState<TeamMember | null>(null);
  const [role, setRole] = useState<'admin' | 'user' | 'operator'>('user');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Password reset confirmation dialog — NO password input, just confirm.
  const [resetDialogOpen, setResetDialogOpen] = useState(false);
  const [resetting, setResetting] = useState(false);

  // Delete dialog
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Load member data
  useEffect(() => {
    const loadMember = async () => {
      try {
        const supabase = getSupabase();
        const { data: { session } } = await supabase.auth.getSession();

        if (!session) {
          throw new Error('Not authenticated');
        }

        const url = `${getTeamUrl()}/${memberId}`;
        const response = await fetch(url, {
          headers: {
            'Authorization': `Bearer ${session.access_token}`,
          },
        });

        if (!response.ok) {
          throw new Error('Failed to load team member');
        }

        const data: TeamMember = await response.json();
        setMember(data);
        setRole(data.role);
      } catch (err) {
        console.error('Error loading team member:', err);
        setError('Failed to load team member');
      } finally {
        setLoading(false);
      }
    };

    loadMember();
  }, [memberId]);

  // Save role change
  const handleSaveRole = async () => {
    if (!member || role === member.role) return;

    setSaving(true);
    setError(null);
    setSuccess(null);

    try {
      const supabase = getSupabase();
      const { error: updateError } = await supabase
        .from('user_company_access')
        .update({ role })
        .eq('id', memberId);

      if (updateError) throw updateError;

      setMember({ ...member, role });
      setSuccess(`Role updated to ${role}`);
    } catch (err) {
      console.error('Error updating role:', err);
      setError('Failed to update role');
    } finally {
      setSaving(false);
    }
  };

  // Send password reset email. The Edge Function returns a generic
  // success body for every outcome (success / forbidden / failed) — we
  // never display the underlying state to avoid leaking account
  // existence. Distinct outcomes are visible only via the audit log.
  const handleSendResetEmail = async () => {
    setResetting(true);
    setError(null);
    setSuccess(null);

    try {
      const supabase = getSupabase();
      const { data: { session } } = await supabase.auth.getSession();

      if (!session) {
        throw new Error('Not authenticated');
      }

      const url = `${getTeamUrl()}/${memberId}/reset-password`;
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({}),
      });

      if (!response.ok) {
        throw new Error('Failed to send password reset email');
      }

      setResetDialogOpen(false);
      setSuccess(`Reset link sent to ${member?.email || 'this user'}.`);
    } catch (err) {
      console.error('Error sending password reset email:', err);
      setError(err instanceof Error ? err.message : 'Failed to send password reset email');
    } finally {
      setResetting(false);
    }
  };

  // Delete member
  const handleDelete = async () => {
    setDeleting(true);
    setError(null);

    try {
      const supabase = getSupabase();
      const { error: deleteError } = await supabase
        .from('user_company_access')
        .delete()
        .eq('id', memberId);

      if (deleteError) throw deleteError;

      // Navigate back to team page with appropriate tab
      const tabIndex = member?.role === 'admin' ? 0 : member?.role === 'user' ? 1 : 2;
      router.push(`/dashboard/${companyId}/team?tab=${tabIndex}`);
    } catch (err) {
      console.error('Error deleting team member:', err);
      setError('Failed to delete team member');
      setDeleting(false);
      setDeleteDialogOpen(false);
    }
  };

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
        <CircularProgress />
      </Box>
    );
  }

  if (!member) {
    return (
      <Box>
        <Alert severity="error">Team member not found</Alert>
        <Button
          startIcon={<ArrowBackIcon />}
          onClick={() => router.push(`/dashboard/${companyId}/team`)}
          sx={{ mt: 2 }}
        >
          Back to Team
        </Button>
      </Box>
    );
  }

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
          {member.name || 'Team Member'}
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
          {member.email}
        </Typography>

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

        <TextField
          label="Name"
          value={member.name || ''}
          fullWidth
          disabled
          sx={{ mb: 3 }}
          helperText="Name is managed in user settings"
        />

        <TextField
          label="Email"
          value={member.email || ''}
          fullWidth
          disabled
          sx={{ mb: 3 }}
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

        {role !== member.role && (
          <Button
            variant="contained"
            onClick={handleSaveRole}
            disabled={saving}
            sx={{ mb: 3 }}
            startIcon={saving ? <CircularProgress size={16} color="inherit" /> : null}
          >
            {saving ? 'Saving...' : 'Save Role Change'}
          </Button>
        )}

        <Divider sx={{ my: 3 }} />

        <Typography variant="subtitle2" gutterBottom>
          Account Actions
        </Typography>

        <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
          <Button
            variant="outlined"
            startIcon={<LockResetIcon />}
            onClick={() => setResetDialogOpen(true)}
          >
            Reset Password
          </Button>
          <Button
            variant="outlined"
            color="error"
            startIcon={<DeleteIcon />}
            onClick={() => setDeleteDialogOpen(true)}
          >
            Remove from Team
          </Button>
        </Box>
      </Paper>

      {/* Password Reset Confirmation Dialog — no password input. */}
      <Dialog
        open={resetDialogOpen}
        onClose={() => !resetting && setResetDialogOpen(false)}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle>Reset password?</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
            We&apos;ll email <strong>{member.email || 'this user'}</strong> a single-use,
            expiring link to set a new password. The link expires in 1 hour.
          </Typography>
          <Typography variant="body2" color="text.secondary">
            You will never see or set the password yourself.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button
            onClick={() => setResetDialogOpen(false)}
            disabled={resetting}
          >
            Cancel
          </Button>
          <Button
            onClick={handleSendResetEmail}
            variant="contained"
            disabled={resetting}
            startIcon={resetting ? <CircularProgress size={16} color="inherit" /> : null}
          >
            {resetting ? 'Sending...' : 'Reset Password'}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog
        open={deleteDialogOpen}
        onClose={() => !deleting && setDeleteDialogOpen(false)}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle>Remove from Team</DialogTitle>
        <DialogContent>
          <Typography>
            Are you sure you want to remove <strong>{member.name || member.email}</strong> from this company?
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
            They will lose access to this company but their account will remain active.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button
            onClick={() => setDeleteDialogOpen(false)}
            disabled={deleting}
          >
            Cancel
          </Button>
          <Button
            onClick={handleDelete}
            variant="contained"
            color="error"
            disabled={deleting}
            startIcon={deleting ? <CircularProgress size={16} color="inherit" /> : <DeleteIcon />}
          >
            {deleting ? 'Removing...' : 'Remove'}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
