'use client';

import Container from '@mui/material/Container';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';

export default function SocialProof() {
  return (
    <Box
      component="section"
      sx={{
        py: { xs: 5, md: 7 },
        bgcolor: 'rgba(0, 0, 0, 0.15)',
      }}
    >
      <Container maxWidth="md">
        <Box sx={{ textAlign: 'center' }}>
          <Typography
            variant="h4"
            component="blockquote"
            sx={{
              fontStyle: 'italic',
              fontWeight: 400,
              color: 'rgba(255, 255, 255, 0.85)',
              lineHeight: 1.6,
              fontSize: { xs: '1.25rem', md: '1.65rem' },
              mb: 3,
            }}
          >
            &ldquo;[Testimonial coming soon]&rdquo;
          </Typography>

          <Typography
            variant="body2"
            sx={{ color: 'rgba(255, 255, 255, 0.6)' }}
          >
            Pilot customer
          </Typography>
        </Box>
      </Container>
    </Box>
  );
}
