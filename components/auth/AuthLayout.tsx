'use client';

import Container from '@mui/material/Container';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { JiggedLogo } from '@/components/branding';

interface AuthLayoutProps {
  children: React.ReactNode;
}

export default function AuthLayout({ children }: AuthLayoutProps) {
  return (
    <Container maxWidth="sm">
      <Box
        sx={{
          minHeight: '100vh',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          py: 4,
        }}
      >
        {/* Logo/Branding */}
        <Box sx={{ textAlign: 'center', mb: 4, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1 }}>
          <JiggedLogo size="large" />
          <Typography variant="body2" color="text.secondary">
            Manufacturing Operations
          </Typography>
        </Box>

        {/* Auth Form */}
        {children}
      </Box>
    </Container>
  );
}
