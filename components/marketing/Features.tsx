'use client';

import Container from '@mui/material/Container';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';

export default function Features() {
  return (
    <Box
      id="features"
      component="section"
      sx={{ py: { xs: 5, md: 7 }, scrollMarginTop: 80 }}
    >
      <Container maxWidth="lg">
        <Box sx={{ textAlign: 'center' }}>
          <Typography
            variant="h3"
            component="h2"
            sx={{
              fontWeight: 700,
              mb: 1.5,
              fontSize: { xs: '1.5rem', md: '1.75rem' },
            }}
          >
            Built for Precision Manufacturing
          </Typography>
          <Typography
            variant="body1"
            sx={{ color: 'rgba(255, 255, 255, 0.75)', maxWidth: 480, mx: 'auto' }}
          >
            Everything you need, nothing you don&apos;t.
          </Typography>
        </Box>
      </Container>
    </Box>
  );
}
