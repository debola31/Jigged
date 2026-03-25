'use client';

import * as Sentry from '@sentry/nextjs';
import { useState } from 'react';
import { submitWaitlist } from '@/app/actions/waitlist';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import Alert from '@mui/material/Alert';
import CircularProgress from '@mui/material/CircularProgress';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import IconButton from '@mui/material/IconButton';
import CloseIcon from '@mui/icons-material/Close';
import Box from '@mui/material/Box';
import MenuItem from '@mui/material/MenuItem';
import { SHOP_SIZES } from '@/lib/constants/marketing';

interface EmailCaptureProps {
  source?: string;
}

export default function EmailCapture({ source = 'landing_page' }: EmailCaptureProps) {
  const [email, setEmail] = useState('');
  const [modalOpen, setModalOpen] = useState(false);
  const [name, setName] = useState('');
  const [companyName, setCompanyName] = useState('');
  const [shopSize, setShopSize] = useState('');
  const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [message, setMessage] = useState('');

  const handleOpenModal = (e: React.FormEvent) => {
    e.preventDefault();
    setModalOpen(true);
  };

  const handleCloseModal = () => {
    if (status === 'loading') return;
    setModalOpen(false);
    if (status === 'success') {
      // Reset everything after closing success state
      setEmail('');
      setName('');
      setCompanyName('');
      setShopSize('');
      setStatus('idle');
      setMessage('');
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !name || !companyName) return;

    setStatus('loading');
    try {
      const result = await submitWaitlist({
        email,
        name,
        company_name: companyName,
        shop_size: shopSize || null,
        source,
      });

      if (result.error) throw new Error(result.error);

      setStatus('success');
      setMessage("Thanks! We'll reach out shortly to get your shop set up.");
    } catch (err) {
      setStatus('error');
      setMessage('Something went wrong. Email us at hello@jigged.app');
      Sentry.captureException(err, { level: 'warning' });
    }
  };

  const gradientButton = {
    background: 'linear-gradient(135deg, #D4872A 0%, #4682B4 50%, #2BBCB3 100%)',
    '&:hover': {
      background: 'linear-gradient(135deg, #b8721f 0%, #3A6B94 50%, #239e97 100%)',
    },
  };

  return (
    <>
      {/* Inline trigger — email input + CTA */}
      <form onSubmit={handleOpenModal}>
        <Stack
          direction={{ xs: 'column', sm: 'row' }}
          spacing={1.5}
          alignItems="stretch"
        >
          <TextField
            type="email"
            placeholder="Enter your email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
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
            sx={{
              minWidth: { xs: 'auto', md: 220 },
              whiteSpace: 'nowrap',
              ...gradientButton,
            }}
          >
            <Box sx={{ display: { xs: 'none', md: 'inline' } }}>
              Request Access for Your Shop
            </Box>
            <Box sx={{ display: { xs: 'inline', md: 'none' } }}>
              Request Early Access
            </Box>
          </Button>
        </Stack>
      </form>

      {/* Access Request Modal */}
      <Dialog
        open={modalOpen}
        onClose={handleCloseModal}
        maxWidth="sm"
        fullWidth
        slotProps={{
          paper: {
            sx: {
              bgcolor: 'rgba(17, 20, 57, 0.95)',
              backdropFilter: 'blur(20px)',
              border: '1px solid rgba(255, 255, 255, 0.1)',
            },
          },
        }}
      >
        <DialogTitle
          sx={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            pb: 1,
          }}
        >
          <Typography variant="h6" component="span" sx={{ fontWeight: 600 }}>
            Request Access for Your Shop
          </Typography>
          <IconButton
            onClick={handleCloseModal}
            size="small"
            sx={{ color: 'rgba(255, 255, 255, 0.7)' }}
          >
            <CloseIcon />
          </IconButton>
        </DialogTitle>

        <DialogContent>
          {status === 'success' ? (
            <Stack spacing={2} alignItems="center" sx={{ py: 4 }}>
              <CheckCircleIcon sx={{ color: 'success.main', fontSize: 48 }} />
              <Typography
                sx={{ color: 'success.main', fontWeight: 500, textAlign: 'center' }}
              >
                {message}
              </Typography>
            </Stack>
          ) : (
            <form onSubmit={handleSubmit}>
              <Stack spacing={2.5} sx={{ pt: 1 }}>
                <TextField
                  label="Name"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  disabled={status === 'loading'}
                  fullWidth
                  sx={{ '& .MuiInputBase-root': { minHeight: 48 } }}
                />
                <TextField
                  label="Email"
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  disabled={status === 'loading'}
                  fullWidth
                  sx={{ '& .MuiInputBase-root': { minHeight: 48 } }}
                />
                <TextField
                  label="Company / Shop Name"
                  required
                  value={companyName}
                  onChange={(e) => setCompanyName(e.target.value)}
                  disabled={status === 'loading'}
                  fullWidth
                  sx={{ '& .MuiInputBase-root': { minHeight: 48 } }}
                />
                <TextField
                  label="Shop Size"
                  select
                  value={shopSize}
                  onChange={(e) => setShopSize(e.target.value)}
                  disabled={status === 'loading'}
                  fullWidth
                  sx={{ '& .MuiInputBase-root': { minHeight: 48 } }}
                >
                  <MenuItem value="">
                    <em>Select (optional)</em>
                  </MenuItem>
                  {SHOP_SIZES.map((size) => (
                    <MenuItem key={size} value={size}>
                      {size}
                    </MenuItem>
                  ))}
                </TextField>

                {status === 'error' && (
                  <Alert severity="error">
                    Something went wrong. Email us at hello@jigged.app
                  </Alert>
                )}

                <Button
                  type="submit"
                  variant="contained"
                  size="large"
                  disabled={status === 'loading'}
                  sx={{
                    minHeight: 48,
                    fontWeight: 600,
                    ...gradientButton,
                  }}
                >
                  {status === 'loading' ? (
                    <CircularProgress size={22} color="inherit" />
                  ) : (
                    'Request Access'
                  )}
                </Button>
              </Stack>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
