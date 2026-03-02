'use client';

import { useState } from 'react';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import Alert from '@mui/material/Alert';
import CircularProgress from '@mui/material/CircularProgress';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';

interface EmailCaptureProps {
  source?: string;
}

export default function EmailCapture({ source = 'landing_page' }: EmailCaptureProps) {
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [message, setMessage] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email) return;

    setStatus('loading');
    try {
      const res = await fetch('/api/waitlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, source }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.detail || 'Something went wrong');
      }

      const data = await res.json();
      setStatus('success');
      setMessage(data.message);
    } catch (err) {
      setStatus('error');
      setMessage(err instanceof Error ? err.message : 'Something went wrong. Please try again.');
    }
  };

  if (status === 'success') {
    return (
      <Stack direction="row" spacing={1} alignItems="center" justifyContent="center">
        <CheckCircleIcon sx={{ color: 'success.main' }} />
        <Typography sx={{ color: 'success.main', fontWeight: 500 }}>
          {message}
        </Typography>
      </Stack>
    );
  }

  return (
    <form onSubmit={handleSubmit}>
      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        spacing={1.5}
        alignItems="stretch"
      >
        <TextField
          type="email"
          placeholder="Enter your work email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={status === 'loading'}
          size="small"
          sx={{
            flex: 1,
            '& .MuiInputBase-root': { minHeight: 48 },
          }}
        />
        <Button
          type="submit"
          variant="contained"
          size="large"
          disabled={status === 'loading'}
          sx={{
            minWidth: 160,
            whiteSpace: 'nowrap',
            background: 'linear-gradient(135deg, #D4872A 0%, #4682B4 50%, #2BBCB3 100%)',
            '&:hover': {
              background: 'linear-gradient(135deg, #b8721f 0%, #3A6B94 50%, #239e97 100%)',
            },
          }}
        >
          {status === 'loading' ? (
            <CircularProgress size={22} color="inherit" />
          ) : (
            'Get Early Access'
          )}
        </Button>
      </Stack>
      {status === 'error' && (
        <Alert severity="error" sx={{ mt: 1.5 }}>
          {message}
        </Alert>
      )}
    </form>
  );
}
