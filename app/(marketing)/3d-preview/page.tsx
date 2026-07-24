'use client';

import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
import dynamic from 'next/dynamic';

// R3F's <Canvas> touches WebGL / the DOM, so it must never run during SSR.
// Loading Scene with { ssr: false } keeps the whole three.js bundle off the
// server render and out of the initial HTML — it only mounts in the browser.
const Scene = dynamic(() => import('./Scene'), {
  ssr: false,
  loading: () => (
    <Box
      sx={{
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <CircularProgress />
    </Box>
  ),
});

export default function ThreeDPreviewPage() {
  return (
    <Box sx={{ height: '85vh', width: '100%', bgcolor: '#0a0a0a' }}>
      <Scene />
    </Box>
  );
}
