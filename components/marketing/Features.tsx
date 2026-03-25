'use client';

import Container from '@mui/material/Container';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Grid from '@mui/material/Grid';

const FEATURES: {
  headline: string;
  description: string;
  image: string | string[];
}[] = [
  {
    headline: 'Quote faster, win more work',
    description:
      'Build accurate cost-plus quotes in minutes. Set your markups by part category and Jigged handles the math.',
    image: '/screenshots/feature-quotes.png',
  },
  {
    headline: 'Know where every job stands',
    description:
      'Track jobs from quote to completion. See what\u2019s in progress, what\u2019s waiting, and what\u2019s done \u2014 without walking the floor.',
    image: '/screenshots/feature-jobs.png',
  },
  {
    headline: 'Inventory that matches reality',
    description:
      'Track stock by the units you actually use. Link material to jobs so you always know what\u2019s allocated and what\u2019s available.',
    image: '/screenshots/feature-inventory.png',
  },
  {
    headline: 'Give operators what they need',
    description:
      'A clean, simple view for your shop floor. Operators see their jobs, update status, and log time \u2014 nothing more, nothing less.',
    image: [
      '/screenshots/feature-operator-pending.png',
      '/screenshots/feature-operator-active.png',
    ],
  },
];

export default function Features() {
  return (
    <Box
      id="features"
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
          Built for Precision Manufacturing
        </Typography>

        <Grid container spacing={{ xs: 3, md: 4 }}>
          {FEATURES.map((feature, i) => (
            <Grid key={i} size={{ xs: 12, md: 6 }}>
              <Box
                sx={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 2,
                  height: '100%',
                }}
              >
                <Typography
                  variant="h5"
                  component="h3"
                  sx={{
                    fontWeight: 600,
                    fontSize: { xs: '1.15rem', md: '1.35rem' },
                  }}
                >
                  {feature.headline}
                </Typography>

                <Typography
                  variant="body1"
                  sx={{
                    color: 'rgba(255, 255, 255, 0.75)',
                    lineHeight: 1.7,
                    fontSize: { xs: '0.95rem', md: '1rem' },
                  }}
                >
                  {feature.description}
                </Typography>

                {/* Feature screenshot */}
                <Box
                  sx={{
                    mt: 'auto',
                    width: '100%',
                    aspectRatio: '4 / 3',
                    borderRadius: 2,
                    overflow: 'hidden',
                    border: '1px solid rgba(255, 255, 255, 0.1)',
                    bgcolor: 'rgba(26, 31, 74, 0.4)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    p: 0.5,
                  }}
                >
                  {Array.isArray(feature.image) ? (
                    <Box
                      sx={{
                        display: 'flex',
                        gap: 2,
                        justifyContent: 'center',
                        height: '100%',
                      }}
                    >
                      {feature.image.map((src, j) => (
                        <Box
                          key={j}
                          component="img"
                          src={src}
                          alt={feature.headline}
                          sx={{
                            height: '100%',
                            borderRadius: 2,
                            border: 'none',
                            objectFit: 'contain',
                            imageRendering: '-webkit-optimize-contrast',
                          }}
                        />
                      ))}
                    </Box>
                  ) : (
                    <Box
                      component="img"
                      src={feature.image}
                      alt={feature.headline}
                      sx={{
                        maxWidth: '100%',
                        maxHeight: '100%',
                        objectFit: 'contain',
                        imageRendering: '-webkit-optimize-contrast',
                      }}
                    />
                  )}
                </Box>
              </Box>
            </Grid>
          ))}
        </Grid>
      </Container>
    </Box>
  );
}
