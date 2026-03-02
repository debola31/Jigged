'use client';

import Container from '@mui/material/Container';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Stack from '@mui/material/Stack';
import Chip from '@mui/material/Chip';
import Engineering from '@mui/icons-material/Engineering';
import Inventory2 from '@mui/icons-material/Inventory2';
import Speed from '@mui/icons-material/Speed';
import { JiggedLogo } from '@/components/branding';

interface AuthLayoutProps {
  children: React.ReactNode;
}

const features = [
  { icon: <Engineering sx={{ fontSize: 16 }} />, label: 'Work Orders' },
  { icon: <Inventory2 sx={{ fontSize: 16 }} />, label: 'Inventory' },
  { icon: <Speed sx={{ fontSize: 16 }} />, label: 'Real-Time Tracking' },
];

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
          <Box sx={{ mb: 4 }}>
            {children}
          </Box>

          {/* Feature Chips */}
          <Stack
            direction="row"
            spacing={1.5}
            justifyContent="center"
            flexWrap="wrap"
            sx={{ gap: 1.5 }}
          >
            {features.map(({ icon, label }) => (
              <Chip
                key={label}
                icon={icon}
                label={label}
                variant="outlined"
                sx={{
                  borderColor: 'rgba(255, 255, 255, 0.15)',
                  color: 'rgba(255, 255, 255, 0.6)',
                  backgroundColor: 'rgba(255, 255, 255, 0.04)',
                  fontSize: '0.8rem',
                  height: 36,
                  '& .MuiChip-icon': {
                    color: '#6FA3D8',
                  },
                }}
              />
            ))}
          </Stack>
        </Box>
      </Container>
    </Box>
  );
}
