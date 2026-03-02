'use client';

import Container from '@mui/material/Container';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import EmailCapture from './EmailCapture';

export default function ComingSoonContent() {
  return (
    <Container maxWidth="sm">
      <Box
        sx={{
          minHeight: '70vh',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          alignItems: 'center',
          textAlign: 'center',
          py: 4,
        }}
      >
        <Typography
          variant="h4"
          component="h1"
          sx={{
            fontWeight: 700,
            color: 'primary.main',
            letterSpacing: '-0.5px',
            mb: 1,
          }}
        >
          Jigged
        </Typography>
        <Typography variant="body1" color="text.secondary" sx={{ mb: 5 }}>
          Manufacturing Operations
        </Typography>

        <Typography
          variant="h3"
          sx={{
            fontWeight: 700,
            mb: 2,
            fontSize: { xs: '1.75rem', md: '2rem' },
          }}
        >
          Launching Soon
        </Typography>
        <Typography
          variant="body1"
          color="text.secondary"
          sx={{ mb: 4, maxWidth: 480, lineHeight: 1.7 }}
        >
          We&apos;re building a better way to run your manufacturing shop.
          Get notified when we launch.
        </Typography>

        <Box sx={{ width: '100%', maxWidth: 480 }}>
          <EmailCapture source="coming_soon" />
        </Box>
      </Box>
    </Container>
  );
}
