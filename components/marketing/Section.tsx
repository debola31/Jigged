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

interface SectionProps {
  id?: string;
  surface?: Surface;
  maxWidth?: 'sm' | 'md' | 'lg';
  size?: 'major' | 'minor';
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
        py: size === 'major' ? { xs: 9, md: 16 } : { xs: 6, md: 11 },
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
