'use client';

import Container from '@mui/material/Container';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';

export default function SocialProof() {
  return (
    <Box
      component="section"
      sx={{
        py: { xs: 4, md: 6 },
        bgcolor: 'rgba(0, 0, 0, 0.1)',
      }}
    >
      <Container maxWidth="md">
        <Typography
          variant="h5"
          align="center"
          sx={{
            fontWeight: 500,
            fontStyle: 'italic',
            color: 'rgba(255, 255, 255, 0.85)',
            lineHeight: 1.6,
          }}
        >
          &ldquo;Built alongside real precision manufacturing shops
          who were tired of fighting their ERP.&rdquo;
        </Typography>
      </Container>
    </Box>
  );
}
