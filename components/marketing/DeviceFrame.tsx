'use client';

import Box from '@mui/material/Box';

/**
 * Wraps a bare mobile screenshot in a clean modern phone bezel (rounded, near-bezel-less)
 * with a soft brand glow behind it, so operator/notes captures read as a phone on the
 * shop floor. Swap the src for a supplied device-mockup PNG anytime — just drop the frame.
 */
interface DeviceFrameProps {
  src: string;
  alt: string;
  maxWidth?: number;
  glow?: string;
}

export default function DeviceFrame({
  src,
  alt,
  maxWidth = 300,
  glow = 'rgba(43,188,179,0.22)',
}: DeviceFrameProps) {
  return (
    <Box sx={{ position: 'relative', width: '100%', maxWidth, mx: 'auto' }}>
      <Box
        aria-hidden
        sx={{
          position: 'absolute',
          inset: '3% -3% -5% -3%',
          background: `radial-gradient(closest-side, ${glow}, transparent)`,
          filter: 'blur(52px)',
          zIndex: 0,
        }}
      />
      <Box
        sx={{
          position: 'relative',
          zIndex: 1,
          p: '9px',
          borderRadius: '2.5rem',
          background: 'linear-gradient(155deg, #1b1f33 0%, #0a0c16 100%)',
          border: '1px solid rgba(255, 255, 255, 0.14)',
          boxShadow:
            '0 34px 70px -26px rgba(0,0,0,0.78), inset 0 1px 0 rgba(255,255,255,0.06)',
        }}
      >
        <Box
          component="img"
          src={src}
          alt={alt}
          loading="lazy"
          sx={{
            display: 'block',
            width: '100%',
            height: 'auto',
            borderRadius: '2rem',
          }}
        />
      </Box>
    </Box>
  );
}
