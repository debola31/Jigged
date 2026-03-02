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
    <Box
      sx={{
        minHeight: '100vh',
        position: 'relative',
        overflow: 'hidden',
        // Blueprint grid pattern
        '&::before': {
          content: '""',
          position: 'absolute',
          inset: 0,
          backgroundImage: `
            linear-gradient(rgba(70,130,180,0.04) 1px, transparent 1px),
            linear-gradient(90deg, rgba(70,130,180,0.04) 1px, transparent 1px)
          `,
          backgroundSize: '60px 60px',
          pointerEvents: 'none',
        },
      }}
    >
      <Container maxWidth="sm">
        <Box
          sx={{
            minHeight: '100vh',
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'center',
            py: 4,
            position: 'relative',
          }}
        >
          {/* Amber accent line */}
          <Box
            sx={{
              width: 48,
              height: 3,
              borderRadius: 2,
              backgroundColor: '#D4872A',
              mx: 'auto',
              mb: 3,
            }}
          />

          {/* Logo/Branding */}
          <Box
            sx={{
              textAlign: 'center',
              mb: 2,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 1.5,
            }}
          >
            <JiggedLogo size="xlarge" />

            <Typography
              variant="h5"
              sx={{
                fontWeight: 600,
                color: 'rgba(255, 255, 255, 0.75)',
                mt: 0.5,
              }}
            >
              Precision Manufacturing, Simplified.
            </Typography>
          </Box>

          {/* Auth Form */}
          <Box>
            {children}
          </Box>
        </Box>
      </Container>
    </Box>
  );
}
