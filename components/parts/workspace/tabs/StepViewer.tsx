'use client';

import { useEffect, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Alert from '@mui/material/Alert';
import CircularProgress from '@mui/material/CircularProgress';

interface StepViewerProps {
  /** Signed URL of the STEP file to render. */
  url: string;
}

/**
 * In-browser 3D viewer for STEP models, built on `online-3d-viewer` (three.js +
 * occt-import-js WASM). The engine fetches occt-import-js from the jsdelivr CDN
 * at runtime — there is no self-hosting hook in v0.18.
 *
 * Must be mounted via `next/dynamic({ ssr: false })`: the engine touches
 * `window`/DOM and pulls in WASM, so it can't be server-rendered. The module
 * import is also deferred into the effect (client-only) as a second guard. The
 * WebGL context is freed on unmount via `Destroy()` to avoid leaks across the
 * modal's repeated open/close.
 */
export default function StepViewer({ url }: StepViewerProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let viewer: import('online-3d-viewer').EmbeddedViewer | null = null;
    let observer: ResizeObserver | null = null;
    let cancelled = false;

    (async () => {
      const container = containerRef.current;
      if (!container) return;
      try {
        const OV = await import('online-3d-viewer');
        if (cancelled) return;
        viewer = new OV.EmbeddedViewer(container, {
          onModelLoaded: () => {
            if (!cancelled) setLoading(false);
          },
          onModelLoadFailed: () => {
            if (!cancelled) {
              setError('Could not render this STEP model. Download it to open in your CAD software.');
              setLoading(false);
            }
          },
        });
        viewer.LoadModelFromUrlList([url]);
        observer = new ResizeObserver(() => viewer?.Resize());
        observer.observe(container);
      } catch {
        if (!cancelled) {
          setError('Could not load the 3D viewer.');
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
      observer?.disconnect();
      viewer?.Destroy();
    };
  }, [url]);

  return (
    <Box sx={{ position: 'relative', width: '100%', height: '75vh' }}>
      {loading && !error && (
        <Box
          sx={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
            zIndex: 1,
          }}
        >
          <CircularProgress />
        </Box>
      )}
      {error && (
        <Alert severity="error" sx={{ m: 1 }}>
          {error}
        </Alert>
      )}
      <Box ref={containerRef} sx={{ width: '100%', height: '100%' }} />
    </Box>
  );
}
