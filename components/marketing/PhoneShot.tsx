'use client';

import Box from '@mui/material/Box';

/**
 * Renders a supplied device-mockup PNG — a real phone (bezel + status bar already baked in)
 * on a transparent background — with a soft brand glow behind it and a silhouette drop-shadow
 * so it floats on the dark page. No CSS phone frame (that's DeviceFrame, for bare screenshots);
 * use PhoneShot when the image already IS a phone. drop-shadow (not box-shadow) so the shadow
 * follows the phone's rounded outline rather than a rectangle.
 */
interface PhoneShotProps {
  src: string;
  alt: string;
  maxWidth?: number;
  glow?: string;
}

export default function PhoneShot({
  src,
  alt,
  maxWidth = 300,
  glow = 'rgba(43, 188, 179, 0.20)',
}: PhoneShotProps) {
  return (
    <Box sx={{ position: 'relative', width: '100%', maxWidth, mx: 'auto' }}>
      <Box
        aria-hidden
        sx={{
          position: 'absolute',
          inset: '8% 2% 4% 2%',
          background: `radial-gradient(closest-side, ${glow}, transparent)`,
          filter: 'blur(56px)',
          zIndex: 0,
        }}
      />
      <Box
        component="img"
        src={src}
        alt={alt}
        loading="lazy"
        sx={{
          position: 'relative',
          zIndex: 1,
          display: 'block',
          width: '100%',
          height: 'auto',
          filter: 'drop-shadow(0 32px 60px rgba(0, 0, 0, 0.62))',
        }}
      />
    </Box>
  );
}
