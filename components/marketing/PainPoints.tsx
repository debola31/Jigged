'use client';

import Container from '@mui/material/Container';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';

const PAIN_POINTS = [
  'You quoted a job from memory because opening the ERP was slower than doing the math yourself.',
  'You lost track of a job\u2019s status and had to walk the floor to find out.',
  'Your inventory says you have material. Your shelf says otherwise.',
  'You bought software built for 500-person plants and your 12-person shop uses 10% of it.',
];

export default function PainPoints() {
  return (
    <Box
      component="section"
      sx={{ py: { xs: 5, md: 7 }, scrollMarginTop: 80 }}
    >
      <Container maxWidth="md">
        <Typography
          variant="h3"
          component="h2"
          sx={{
            fontWeight: 700,
            mb: { xs: 4, md: 5 },
            textAlign: 'center',
            fontSize: { xs: '1.5rem', md: '2rem' },
          }}
        >
          Sound Familiar?
        </Typography>

        <Box sx={{ display: 'flex', flexDirection: 'column', gap: { xs: 3, md: 4 } }}>
          {PAIN_POINTS.map((quote, i) => (
            <Typography
              key={i}
              variant="h5"
              component="p"
              sx={{
                fontStyle: 'italic',
                fontWeight: 400,
                color: 'rgba(255, 255, 255, 0.85)',
                lineHeight: 1.6,
                fontSize: { xs: '1.1rem', md: '1.35rem' },
                pl: { xs: 2, md: 4 },
                borderLeft: '3px solid',
                borderColor: 'primary.main',
              }}
            >
              &ldquo;{quote}&rdquo;
            </Typography>
          ))}
        </Box>

        <Typography
          variant="body1"
          sx={{
            mt: { xs: 4, md: 5 },
            color: 'rgba(255, 255, 255, 0.75)',
            fontSize: { xs: '1rem', md: '1.1rem' },
            lineHeight: 1.7,
            textAlign: 'center',
            maxWidth: 640,
            mx: 'auto',
          }}
        >
          Jigged was built because shop owners kept telling us the same thing
          — nothing out there is built for how they actually work.
        </Typography>
      </Container>
    </Box>
  );
}
