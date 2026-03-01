'use client';

import { useState, useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
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
import { JiggedLogo } from '@/components/branding';
import LockIcon from '@mui/icons-material/Lock';
import { getSupabase } from '@/lib/supabase';

/**
 * First-Login Password Change Page.
 *
 * Shown when operator logs in for the first time with temp password.
 * Must change password before accessing the operator interface.
 */
export default function ChangePasswordPage() {
  const params = useParams();
  const router = useRouter();
  const companyId = params.companyId as string;

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showCurrentPassword, setShowCurrentPassword] = useState(false);
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [checkingSession, setCheckingSession] = useState(true);

  const supabase = getSupabase();

  // Check that user is logged in and needs password change
  useEffect(() => {
    const checkSession = async () => {
      const { data: { session } } = await supabase.auth.getSession();

      if (!session) {
        router.push(`/operator/${companyId}/login`);
        return;
      }

      // If user doesn't need password change, redirect to jobs
      if (!session.user.user_metadata?.needs_password_change) {
        router.push(`/operator/${companyId}/jobs`);
        return;
      }

      setCheckingSession(false);
    };

    checkSession();
  }, [companyId, router, supabase]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    // Validation
    if (!currentPassword.trim()) {
      setError('Please enter your current password');
      return;
    }

    if (!newPassword.trim()) {
      setError('Please enter a new password');
      return;
    }

    if (newPassword.length < 8) {
      setError('New password must be at least 8 characters');
      return;
    }

    if (newPassword !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }

    if (newPassword === currentPassword) {
      setError('New password must be different from current password');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      // Update password and clear the needs_password_change flag
      const { error: updateError } = await supabase.auth.updateUser({
        password: newPassword,
        data: { needs_password_change: false },
      });

      if (updateError) {
        throw new Error(updateError.message);
      }

      // Redirect to jobs
      router.push(`/operator/${companyId}/jobs`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to change password. Please try again.');
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
          <JiggedLogo size="large" />
        </Box>
        <Typography variant="body1" color="text.secondary" sx={{ mb: 1 }}>
          Change Your Password
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 4 }}>
          Please set a new password to continue
        </Typography>

        {/* Change Password Form */}
        <Box component="form" onSubmit={handleSubmit}>
          {/* Current Password Field */}
          <TextField
            fullWidth
            type={showCurrentPassword ? 'text' : 'password'}
            label="Current Password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            disabled={loading}
            autoComplete="current-password"
            autoFocus
            sx={{ mb: 2 }}
            InputProps={{
              startAdornment: (
                <InputAdornment position="start">
                  <LockIcon color="action" />
                </InputAdornment>
              ),
              endAdornment: (
                <InputAdornment position="end">
                  <IconButton
                    onClick={() => setShowCurrentPassword(!showCurrentPassword)}
                    edge="end"
                    disabled={loading}
                  >
                    {showCurrentPassword ? <VisibilityOff /> : <Visibility />}
                  </IconButton>
                </InputAdornment>
              ),
              sx: { height: 56 },
            }}
          />

          {/* New Password Field */}
          <TextField
            fullWidth
            type={showNewPassword ? 'text' : 'password'}
            label="New Password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            disabled={loading}
            autoComplete="new-password"
            helperText="Minimum 8 characters"
            sx={{ mb: 2 }}
            InputProps={{
              startAdornment: (
                <InputAdornment position="start">
                  <LockIcon color="action" />
                </InputAdornment>
              ),
              endAdornment: (
                <InputAdornment position="end">
                  <IconButton
                    onClick={() => setShowNewPassword(!showNewPassword)}
                    edge="end"
                    disabled={loading}
                  >
                    {showNewPassword ? <VisibilityOff /> : <Visibility />}
                  </IconButton>
                </InputAdornment>
              ),
              sx: { height: 56 },
            }}
          />

          {/* Confirm Password Field */}
          <TextField
            fullWidth
            type={showConfirmPassword ? 'text' : 'password'}
            label="Confirm New Password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            disabled={loading}
            autoComplete="new-password"
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
                    onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                    edge="end"
                    disabled={loading}
                  >
                    {showConfirmPassword ? <VisibilityOff /> : <Visibility />}
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

          {/* Submit Button */}
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
            {loading ? <CircularProgress size={24} color="inherit" /> : 'Change Password'}
          </Button>
        </Box>
      </Paper>
    </Box>
  );
}
