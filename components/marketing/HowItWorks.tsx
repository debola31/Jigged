'use client';

import Container from '@mui/material/Container';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Stack from '@mui/material/Stack';

const STEPS = [
  {
    number: '1',
    headline: 'Sign up and set up your shop',
    description:
      'Add your team, your part categories, and your markup defaults. Takes about 15 minutes.',
  },
  {
    number: '2',
    headline: 'Start quoting and tracking',
    description:
      'Create quotes, convert them to jobs, and track everything from one place.',
  },
  {
    number: '3',
    headline: 'Run your shop, not your software',
    description:
      'Jigged stays out of the way. No training manuals, no implementation consultants, no six-month rollout.',
  },
];

export default function HowItWorks() {
  return (
    <Box
      id="how-it-works"
      component="section"
      sx={{ py: { xs: 5, md: 7 }, scrollMarginTop: 80 }}
    >
      <Container maxWidth="lg">
        <Typography
          variant="h3"
          component="h2"
          sx={{
            fontWeight: 700,
            mb: { xs: 4, md: 6 },
            textAlign: 'center',
            fontSize: { xs: '1.5rem', md: '2rem' },
          }}
        >
          How It Works
        </Typography>

        <Stack
          direction={{ xs: 'column', md: 'row' }}
          spacing={{ xs: 4, md: 6 }}
          alignItems={{ md: 'flex-start' }}
        >
          {STEPS.map((step) => (
            <Box
              key={step.number}
              sx={{
                flex: 1,
                textAlign: { xs: 'left', md: 'center' },
                display: 'flex',
                flexDirection: { xs: 'row', md: 'column' },
                alignItems: { xs: 'flex-start', md: 'center' },
                gap: { xs: 2, md: 0 },
              }}
            >
              <Typography
                sx={{
                  fontSize: { xs: '2rem', md: '2.5rem' },
                  fontWeight: 700,
                  color: 'common.white',
                  lineHeight: 1,
                  mb: { md: 2 },
                  flexShrink: 0,
                }}
              >
                {step.number}
              </Typography>

              <Box>
                <Typography
                  variant="h5"
                  component="h3"
                  sx={{
                    fontWeight: 600,
                    mb: 1,
                    fontSize: { xs: '1.1rem', md: '1.25rem' },
                  }}
                >
                  {step.headline}
                </Typography>

                <Typography
                  variant="body1"
                  sx={{
                    color: 'rgba(255, 255, 255, 0.75)',
                    lineHeight: 1.7,
                    fontSize: { xs: '0.95rem', md: '1rem' },
                  }}
                >
                  {step.description}
                </Typography>
              </Box>
            </Box>
          ))}
        </Stack>
      </Container>
    </Box>
  );
}
