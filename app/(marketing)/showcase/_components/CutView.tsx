'use client';

import { useEffect, useRef, useState } from 'react';
import * as Sentry from '@sentry/nextjs';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { toError } from '@/lib/supabaseErrors';
import { PartScene } from './partScene';

/**
 * The part after a machine cycle in 3D, for a mouse to turn, laid over the step's still once it has
 * loaded. Only a desktop gets it (StepPlayer decides, and imports it with ssr: false): on a phone
 * the still is the step. It stays mounted from one cut to the next and swaps the model.
 */
export default function CutView({ url }: { url: string }) {
  const container = useRef<HTMLDivElement>(null);
  const scene = useRef<PartScene | null>(null);
  const [shown, setShown] = useState<string | null>(null);

  useEffect(() => {
    if (!container.current) return;
    const s = new PartScene(container.current);
    scene.current = s;
    return () => {
      s.dispose();
      scene.current = null;
    };
  }, []);

  // Runs after the effect above, so the scene exists. A model that fails leaves the still showing.
  useEffect(() => {
    scene.current?.show(url).then(
      (drawn) => drawn && setShown(url),
      (error: unknown) => Sentry.captureException(toError(error, `Showcase: the part model ${url} failed to load`)),
    );
  }, [url]);

  const ready = shown === url;
  return (
    <Box
      aria-hidden
      sx={{
        position: 'absolute',
        inset: 0,
        opacity: ready ? 1 : 0,
        pointerEvents: ready ? 'auto' : 'none',
        cursor: 'grab',
        transition: 'opacity 200ms',
        '@media (prefers-reduced-motion: reduce)': { transition: 'none' },
      }}
    >
      <Box ref={container} sx={{ position: 'absolute', inset: 0 }} />
      <Typography
        sx={{
          position: 'absolute',
          left: 12,
          bottom: 12,
          px: 1.25,
          py: 0.5,
          borderRadius: 1,
          fontSize: '0.85rem',
          bgcolor: 'rgba(17, 20, 57, 0.7)',
          color: 'text.secondary',
          pointerEvents: 'none',
        }}
      >
        Drag to turn the part
      </Typography>
    </Box>
  );
}
