'use client';

import Box from '@mui/material/Box';

/**
 * Renders a supplied device-mockup PNG — a real phone, bezel and status bar already baked
 * in, on a transparent background — with a soft brand glow behind it and a silhouette
 * drop-shadow so it floats on the dark page. No CSS phone frame (that's DeviceFrame, for
 * bare screenshots); use PhoneShot when the image already IS a phone. `drop-shadow` rather
 * than `box-shadow` so the shadow follows the phone's rounded outline, not a rectangle.
 *
 * The <picture>/<img> are raw elements for the same two reasons ScreenShot's are: Emotion
 * injects a <style> between <source> and <img> and breaks the picture (the browser then
 * downloads the 1.7 MB PNG as well as the 41 KB WebP), and MUI's Box turns `width`/
 * `height` into CSS so the intrinsic size never reaches the DOM.
 */
interface PhoneShotProps {
  src: string;
  alt: string;
  /** Responsive, so a 0.48-aspect mockup can be smaller on a phone than on a desktop. */
  maxWidth?: number | { xs?: number; sm?: number; md?: number };
  glow?: string;
}

export default function PhoneShot({
  src,
  alt,
  maxWidth = 300,
  glow = 'rgba(43, 188, 179, 0.20)',
}: PhoneShotProps) {
  return (
    <Box
      sx={{
        position: 'relative',
        width: '100%',
        maxWidth,
        mx: 'auto',
        '& img': {
          position: 'relative',
          zIndex: 1,
          display: 'block',
          width: '100%',
          height: 'auto',
          filter: 'drop-shadow(0 32px 60px rgba(0, 0, 0, 0.62))',
        },
      }}
    >
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
      <picture>
        {/* 720w WebP covers 2x for the largest placement (322 CSS px). The PNG masters are
            ~1.7 MB each and were being served whole, to be drawn at 244–322 px. */}
        <source type="image/webp" srcSet={src.replace(/\.png$/, '.webp')} />
        <img src={src} alt={alt} width={1428} height={2960} loading="lazy" decoding="async" />
      </picture>
    </Box>
  );
}
