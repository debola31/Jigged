'use client';

import { useState } from 'react';
import { useRouter, useParams } from 'next/navigation';
import Box from '@mui/material/Box';
import Paper from '@mui/material/Paper';
import TextField from '@mui/material/TextField';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import CircularProgress from '@mui/material/CircularProgress';
import Alert from '@mui/material/Alert';
import IconButton from '@mui/material/IconButton';
import InputAdornment from '@mui/material/InputAdornment';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import VisibilityIcon from '@mui/icons-material/Visibility';
import VisibilityOffIcon from '@mui/icons-material/VisibilityOff';
import type { OperatorCreateResponse } from '@/types/operator';

// Backend API URL for Python FastAPI server
// The path /api/operators is where the operator creation endpoint lives
const getOperatorApiUrl = () => {
  const baseUrl = process.env.NEXT_PUBLIC_API_URL || '';
  // If baseUrl already ends with /api, just append /operators
  // Otherwise, append /api/operators
  if (baseUrl.endsWith('/api')) {
    return `${baseUrl}/operators`;
  }
  return `${baseUrl}/api/operators`;
};

/**
 * Create New Operator Page.
 *
 * Creates an operator with Supabase Auth (email/password).
 * Admin sets a temporary password; operator must change on first login.
 */
export default function NewOperatorPage() {
  const router = useRouter();
  const params = useParams();
  const companyId = params.companyId as string;

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!name.trim()) {
      setError('Name is required');
      return;
    }

    if (!email.trim()) {
      setError('Email is required');
      return;
    }

    // Basic email validation
    if (!/^[^@]+@[^@]+\.[^@]+$/.test(email)) {
      setError('Please enter a valid email address');
      return;
    }

    if (!password || password.length < 8) {
      setError('Password must be at least 8 characters');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      // Call backend API to create operator with Supabase user
      const url = getOperatorApiUrl();
      console.log('Creating operator at:', url);

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          company_id: companyId,
          name: name.trim(),
          email: email.trim().toLowerCase(),
          password,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ detail: 'Failed to create operator' }));
        throw new Error(errorData.detail || 'Failed to create operator');
      }

      const data: OperatorCreateResponse = await response.json();

      if (!data.success) {
        throw new Error(data.message || 'Failed to create operator');
      }

      router.push(`/dashboard/${companyId}/team`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create operator');
    } finally {
      setLoading(false);
    }
  };

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
          bgcolor: 'rgba(26, 31, 74, 0.55)',
          backdropFilter: 'blur(8px)',
        }}
      >
        <Typography variant="h5" component="h1" sx={{ mb: 3 }}>
          New Operator
        </Typography>

        {error && (
          <Alert severity="error" sx={{ mb: 3 }}>
            {error}
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
            placeholder="John Smith"
          />

          <TextField
            label="Email"
            type="email"
            fullWidth
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            sx={{ mb: 3 }}
            placeholder="operator@example.com"
            helperText="Operator will use this email to log in"
          />

          <TextField
            label="Temporary Password"
            fullWidth
            required
            type={showPassword ? 'text' : 'password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            sx={{ mb: 3 }}
            placeholder="Minimum 8 characters"
            helperText="Operator will be required to change this on first login"
            slotProps={{
              input: {
                endAdornment: (
                  <InputAdornment position="end">
                    <IconButton
                      onClick={() => setShowPassword(!showPassword)}
                      edge="end"
                    >
                      {showPassword ? <VisibilityOffIcon /> : <VisibilityIcon />}
                    </IconButton>
                  </InputAdornment>
                ),
              },
            }}
          />

          <Box sx={{ display: 'flex', gap: 2, justifyContent: 'flex-end' }}>
            <Button
              onClick={() => router.push(`/dashboard/${companyId}/team`)}
              disabled={loading}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant="contained"
              disabled={loading}
            >
              {loading ? <CircularProgress size={24} /> : 'Create Operator'}
            </Button>
          </Box>
        </Box>
      </Paper>
    </Box>
  );
}
