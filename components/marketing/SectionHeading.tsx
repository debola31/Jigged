'use client';

import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { eyebrowSx, DISPLAY_FONT, EYEBROW_COLOR } from './marketingStyles';

/**
 * Editorial section heading: a large index numeral + eyebrow, then an oversized
 * display headline set in the grotesk with tight tracking. Left-aligned by default —
 * the asymmetry and the numbering are the structural signature of this variant.
 */
interface SectionHeadingProps {
  eyebrow?: string;
  heading: string;
  subhead?: string;
  index?: string;
  align?: 'center' | 'left';
  maxWidth?: number;
  headingComponent?: React.ElementType;
}

export default function SectionHeading({
  eyebrow,
  heading,
  subhead,
  index,
  align = 'left',
  maxWidth = 780,
  headingComponent = 'h2',
}: SectionHeadingProps) {
  const alignItems = align === 'center' ? 'center' : 'flex-start';
  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        alignItems,
        textAlign: align,
        mx: align === 'center' ? 'auto' : 0,
        maxWidth,
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 2.5 }}>
        {index && (
          <Typography
            component="span"
            sx={{
              color: EYEBROW_COLOR,
              fontFamily: DISPLAY_FONT,
              fontWeight: 600,
              fontSize: '1.1rem',
              letterSpacing: '0.02em',
            }}
          >
            {index}
          </Typography>
        )}
        {index && (
          <Box sx={{ width: 28, height: '1px', bgcolor: 'rgba(255,255,255,0.25)' }} />
        )}
        {eyebrow && (
          <Typography component="span" sx={{ ...eyebrowSx, color: 'rgba(255,255,255,0.55)' }}>
            {eyebrow}
          </Typography>
        )}
      </Box>

      <Typography
        component={headingComponent}
        sx={{
          fontFamily: DISPLAY_FONT,
          fontWeight: 600,
          fontSize: 'clamp(2rem, 4.6vw, 3.4rem)',
          lineHeight: 1.04,
          letterSpacing: '-0.025em',
        }}
      >
        {heading}
      </Typography>

      {subhead && (
        <Typography
          sx={{
            mt: 3,
            color: 'rgba(255, 255, 255, 0.72)',
            fontSize: { xs: '1.05rem', md: '1.25rem' },
            lineHeight: 1.55,
            maxWidth: 660,
          }}
        >
          {subhead}
        </Typography>
      )}
    </Box>
  );
}
