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
import FormControlLabel from '@mui/material/FormControlLabel';
import Switch from '@mui/material/Switch';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import LockResetIcon from '@mui/icons-material/LockReset';
import { getSupabase } from '@/lib/supabase';
import type { Operator } from '@/types/operator';

/**
 * Edit Operator Page.
 *
 * Allows editing operator name and active status.
 * Email is read-only (stored in auth.users).
 * Password reset sends a password reset email.
 */
export default function EditOperatorPage() {
  const router = useRouter();
  const params = useParams();
  const companyId = params.companyId as string;
  const operatorId = params.id as string;

  const [operator, setOperator] = useState<Operator | null>(null);
  const [email, setEmail] = useState<string>('');
  const [name, setName] = useState('');
  const [isActive, setIsActive] = useState(true);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [resettingPassword, setResettingPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const supabase = getSupabase();

  // Load operator data
  useEffect(() => {
    async function load() {
      try {
        // Get operator data
        const { data: operatorData, error: opError } = await supabase
          .from('operators')
          .select('id, company_id, user_id, name, is_active, last_login_at, created_at, updated_at')
          .eq('id', operatorId)
          .single();

        if (opError) throw new Error(opError.message);

        setOperator(operatorData);
        setName(operatorData.name);
        setIsActive(operatorData.is_active);

        // Get email from auth.users via RPC or admin API
        // For now, we'll store a placeholder - in production, fetch from auth.users
        // This would typically require a service role key or an RPC function
        setEmail('(Email stored in auth system)');
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load operator');
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [operatorId, supabase]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!name.trim()) {
      setError('Name is required');
      return;
    }

    setSaving(true);
    setError(null);
    setSuccess(null);

    try {
      const { error: updateError } = await supabase
        .from('operators')
        .update({
          name: name.trim(),
          is_active: isActive,
        })
        .eq('id', operatorId);

      if (updateError) throw new Error(updateError.message);

      setSuccess('Operator updated successfully');
      setTimeout(() => {
        router.push(`/dashboard/${companyId}/team`);
      }, 1000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update operator');
    } finally {
      setSaving(false);
    }
  };

  const handleResetPassword = async () => {
    if (!operator?.user_id) {
      setError('Cannot reset password: user not found');
      return;
    }

    setResettingPassword(true);
    setError(null);
    setSuccess(null);

    try {
      // Note: This requires the email, which we'd need to fetch from auth.users
      // For now, show a message that admin needs to use Supabase dashboard
      // In production, implement via backend API with service role key
      setError('Password reset via email is not yet implemented. Please use Supabase dashboard to reset the password, or create a new operator.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send reset email');
    } finally {
      setResettingPassword(false);
    }
  };

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
        <CircularProgress />
      </Box>
    );
  }

  if (!operator) {
    return (
      <Box>
        <Alert severity="error">Operator not found</Alert>
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
      {/* Back Button */}
      <Button
        startIcon={<ArrowBackIcon />}
        onClick={() => router.push(`/dashboard/${companyId}/team`)}
        sx={{ mb: 3 }}
      >
        Back to Team
      </Button>

      <Paper
        elevation={2}
        sx={{
          p: 4,
          maxWidth: 500,
          bgcolor: 'rgba(26, 31, 74, 0.50)',
          backdropFilter: 'blur(8px)',
        }}
      >
        <Typography variant="h5" component="h1" sx={{ mb: 3 }}>
          Edit Operator
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

        <Box component="form" onSubmit={handleSubmit}>
          <TextField
            label="Name"
            fullWidth
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            sx={{ mb: 3 }}
          />

          <TextField
            label="Email"
            fullWidth
            value={email}
            disabled
            sx={{ mb: 3 }}
            helperText="Email cannot be changed"
          />

          <FormControlLabel
            control={
              <Switch
                checked={isActive}
                onChange={(e) => setIsActive(e.target.checked)}
                color="primary"
              />
            }
            label="Active"
            sx={{ mb: 3, display: 'block' }}
          />

          <Divider sx={{ my: 3 }} />

          {/* Password Reset Section */}
          <Typography variant="subtitle2" color="text.secondary" sx={{ mb: 2 }}>
            Password
          </Typography>

          <Button
            variant="outlined"
            startIcon={<LockResetIcon />}
            onClick={handleResetPassword}
            disabled={resettingPassword}
            sx={{ mb: 3 }}
          >
            {resettingPassword ? <CircularProgress size={20} /> : 'Reset Password'}
          </Button>

          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 3 }}>
            Sends a password reset email to the operator
          </Typography>

          <Box sx={{ display: 'flex', gap: 2, justifyContent: 'flex-end' }}>
            <Button
              onClick={() => router.push(`/dashboard/${companyId}/team`)}
              disabled={saving}
            >
              Cancel
            </Button>
            <Button type="submit" variant="contained" disabled={saving}>
              {saving ? <CircularProgress size={24} /> : 'Save Changes'}
            </Button>
          </Box>
        </Box>
      </Paper>

      {/* Last Login Info */}
      {operator.last_login_at && (
        <Typography variant="caption" color="text.secondary" sx={{ mt: 2, display: 'block' }}>
          Last login: {new Date(operator.last_login_at).toLocaleString()}
        </Typography>
      )}
    </Box>
  );
}
