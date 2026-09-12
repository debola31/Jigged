'use client';

import Box from '@mui/material/Box';
import Container from '@mui/material/Container';
import type { SxProps, Theme } from '@mui/material/styles';
import { blueprintGridSx } from './marketingStyles';

/**
 * Standardizes section vertical rhythm, width, and surface. Surfaces are marketing-local
 * layers on top of the app-wide fixed indigo gradient (which we must not touch). The
 * editorial variant alternates these — including a lighter "flip" band — and can lay a
 * faint blueprint grid behind a section as its signature motif.
 */
type Surface = 'transparent' | 'raised' | 'recess' | 'light';
/**
 * `strip` is a thin band that carries a whole argument without a section's ceremony —
 * a rule above and below, no heading treatment. Introduced 2026-09-11 for the price band.
 */
type Size = 'major' | 'minor' | 'strip';

interface SectionProps {
  id?: string;
  surface?: Surface;
  maxWidth?: 'sm' | 'md' | 'lg';
  size?: Size;
  hairlineTop?: boolean;
  grid?: boolean;
  children: React.ReactNode;
  sx?: SxProps<Theme>;
  containerSx?: SxProps<Theme>;
}

const surfaceSx: Record<Surface, object> = {
  transparent: {},
  raised: {
    bgcolor: 'rgba(17, 20, 57, 0.55)',
    backdropFilter: 'blur(6px)',
    WebkitBackdropFilter: 'blur(6px)',
    borderTop: '1px solid rgba(255, 255, 255, 0.06)',
    borderBottom: '1px solid rgba(255, 255, 255, 0.06)',
  },
  recess: {
    bgcolor: 'rgba(0, 0, 0, 0.22)',
    borderTop: '1px solid rgba(255, 255, 255, 0.05)',
    borderBottom: '1px solid rgba(255, 255, 255, 0.05)',
  },
  // Lighter neutral band — the editorial "flip" for contrast, still on-brand (no cream).
  light: {
    bgcolor: 'rgba(226, 232, 245, 0.055)',
    backdropFilter: 'blur(6px)',
    WebkitBackdropFilter: 'blur(6px)',
    borderTop: '1px solid rgba(255, 255, 255, 0.09)',
    borderBottom: '1px solid rgba(255, 255, 255, 0.09)',
  },
};

/**
 * Vertical rhythm. Majors were `md: 16` (256px of padding per section) until 2026-09-11 —
 * across eight sections that was ~1,800px of nothing, and cutting it to `md: 11` is what
 * paid for the price strip and the FAQ without the page growing.
 */
const SIZE_PY: Record<Size, { xs: number; md: number }> = {
  major: { xs: 6, md: 10 },
  minor: { xs: 5, md: 7 },
  strip: { xs: 3.5, md: 5 },
};

export default function Section({
  id,
  surface = 'transparent',
  maxWidth = 'lg',
  size = 'major',
  hairlineTop = false,
  grid = false,
  children,
  sx,
  containerSx,
}: SectionProps) {
  return (
    <Box
      id={id}
      component="section"
      sx={{
        position: 'relative',
        scrollMarginTop: 80,
        py: SIZE_PY[size],
        ...(hairlineTop && surface === 'transparent'
          ? { borderTop: '1px solid rgba(255, 255, 255, 0.08)' }
          : {}),
        ...surfaceSx[surface],
        ...(grid
          ? {
              '&::before': {
                content: '""',
                position: 'absolute',
                inset: 0,
                ...blueprintGridSx,
                maskImage:
                  'radial-gradient(ellipse at 50% 0%, black 0%, transparent 78%)',
                WebkitMaskImage:
                  'radial-gradient(ellipse at 50% 0%, black 0%, transparent 78%)',
                pointerEvents: 'none',
              },
            }
          : {}),
        ...sx,
      }}
    >
      <Container maxWidth={maxWidth} sx={{ position: 'relative', zIndex: 1, ...containerSx }}>
        {children}
      </Container>
    </Box>
  );
}
