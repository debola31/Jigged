'use client';

/**
 * A drawing you can actually read: zoom, and drag to move around.
 *
 * The browser's own PDF frame was fine for "is this the right sheet" and useless
 * for the thing people do next — reading a title block or a tolerance, which on an
 * A3 sheet scaled into half a screen is a few pixels tall. So this renders through
 * pdf.js, which the extractor already depends on, and gives the two controls a
 * drawing actually needs.
 *
 * FIT IS THE DEFAULT, and zoom is measured from it rather than from 100%: a sheet
 * arrives whole, and "in" means bigger than whole. Starting at 100% would open
 * most drawings somewhere in the middle of a page with no way to tell where.
 *
 * Dragging pans, because at 3x on a trackpad the scrollbars are a worse instrument
 * than the hand you already have on the drawing.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import AddIcon from '@mui/icons-material/Add';
import RemoveIcon from '@mui/icons-material/Remove';
import CropFreeIcon from '@mui/icons-material/CropFree';

interface Props {
  file: File;
}

/** Multipliers of the fit-to-panel scale. */
const ZOOMS = [1, 1.5, 2, 3, 4, 6];

export default function DrawingPdfView({ file }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const [zoomIndex, setZoomIndex] = useState(0);
  const [pageCount, setPageCount] = useState(1);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const zoom = ZOOMS[zoomIndex];

  // pdf.js TRANSFERS the buffer it is given, so each render needs its own copy —
  // the same trap the text extractor hit, where a second read got a detached
  // ArrayBuffer and returned nothing.
  const bytes = useMemo(() => file.arrayBuffer(), [file]);

  useEffect(() => {
    let cancelled = false;
    // The TASK owns the worker, not the document proxy — destroying the proxy is
    // not a thing, and calling it threw right where the drawing should appear.
    let task: { destroy: () => Promise<void> } | null = null;

    (async () => {
      setLoading(true);
      setError(null);
      try {
        const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
        if (!pdfjs.GlobalWorkerOptions.workerSrc) {
          pdfjs.GlobalWorkerOptions.workerSrc = new URL(
            'pdfjs-dist/legacy/build/pdf.worker.mjs',
            import.meta.url,
          ).toString();
        }

        const data = (await bytes).slice(0);
        if (cancelled) return;

        const started = pdfjs.getDocument({ data });
        task = started;
        const loaded = await started.promise;
        if (cancelled) return;
        setPageCount(loaded.numPages);

        const pdfPage = await loaded.getPage(Math.min(page, loaded.numPages));
        if (cancelled) return;

        const canvas = canvasRef.current;
        const holder = scrollRef.current;
        if (!canvas || !holder) return;

        // Fit the whole sheet first, then apply the zoom multiplier on top.
        const unscaled = pdfPage.getViewport({ scale: 1 });
        const fit = Math.max(
          0.1,
          Math.min(
            (holder.clientWidth - 16) / unscaled.width,
            (holder.clientHeight - 16) / unscaled.height,
          ),
        );
        // Render at device resolution, or a drawing looks soft on a retina panel
        // exactly where someone is trying to read a tolerance.
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const viewport = pdfPage.getViewport({ scale: fit * zoom * dpr });

        canvas.width = viewport.width;
        canvas.height = viewport.height;
        canvas.style.width = `${viewport.width / dpr}px`;
        canvas.style.height = `${viewport.height / dpr}px`;

        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        await pdfPage.render({ canvas, canvasContext: ctx, viewport }).promise;
        if (!cancelled) setLoading(false);
      } catch {
        if (!cancelled) {
          setError('Could not draw this PDF.');
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
      // Unconditionally, or the worker outlives the view — and a destroy that
      // rejects must not surface as an unhandled rejection in a render path.
      void task?.destroy().catch(() => undefined);
    };
  }, [bytes, zoom, page]);

  /** Drag to pan — at 4x the scrollbars are a worse instrument than the hand. */
  const onPointerDown = useCallback((e: React.PointerEvent) => {
    const holder = scrollRef.current;
    if (!holder) return;
    const startX = e.clientX;
    const startY = e.clientY;
    const fromLeft = holder.scrollLeft;
    const fromTop = holder.scrollTop;
    holder.setPointerCapture(e.pointerId);

    const move = (ev: PointerEvent) => {
      holder.scrollLeft = fromLeft - (ev.clientX - startX);
      holder.scrollTop = fromTop - (ev.clientY - startY);
    };
    const up = () => {
      holder.removeEventListener('pointermove', move);
      holder.removeEventListener('pointerup', up);
    };
    holder.addEventListener('pointermove', move);
    holder.addEventListener('pointerup', up);
  }, []);

  return (
    <Box sx={{ position: 'relative', flex: 1, display: 'flex', minHeight: 0 }}>
      <Box
        ref={scrollRef}
        onPointerDown={onPointerDown}
        sx={{
          flex: 1,
          overflow: 'auto',
          display: 'grid',
          placeItems: 'center',
          backgroundColor: 'rgba(0,0,0,0.25)',
          cursor: zoom > 1 ? 'grab' : 'default',
          '&:active': { cursor: zoom > 1 ? 'grabbing' : 'default' },
          touchAction: 'none',
        }}
      >
        {error ? (
          <Typography variant="body2" color="text.secondary" sx={{ p: 3 }}>
            {error}
          </Typography>
        ) : (
          <canvas ref={canvasRef} style={{ display: 'block', backgroundColor: '#fff' }} />
        )}
        {loading && !error && (
          <CircularProgress size={22} sx={{ position: 'absolute', top: 12, right: 12 }} />
        )}
      </Box>

      <Box
        sx={{
          position: 'absolute',
          bottom: 10,
          left: '50%',
          transform: 'translateX(-50%)',
          display: 'flex',
          alignItems: 'center',
          gap: 0.25,
          px: 0.5,
          borderRadius: 2,
          backgroundColor: 'background.paper',
          border: 1,
          borderColor: 'divider',
        }}
      >
        <Tooltip title="Zoom out">
          <span>
            <IconButton
              size="small"
              onClick={() => setZoomIndex((i) => Math.max(0, i - 1))}
              disabled={zoomIndex === 0}
              aria-label="Zoom out"
            >
              <RemoveIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
        <Tooltip title="Fit the sheet">
          <span>
            <IconButton
              size="small"
              onClick={() => setZoomIndex(0)}
              disabled={zoomIndex === 0}
              aria-label="Fit the sheet"
            >
              <CropFreeIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
        <Tooltip title="Zoom in">
          <span>
            <IconButton
              size="small"
              onClick={() => setZoomIndex((i) => Math.min(ZOOMS.length - 1, i + 1))}
              disabled={zoomIndex === ZOOMS.length - 1}
              aria-label="Zoom in"
            >
              <AddIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>

        {pageCount > 1 && (
          <>
            <Box sx={{ width: 1, height: 20, backgroundColor: 'divider', mx: 0.5 }} />
            <IconButton
              size="small"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page === 1}
              aria-label="Previous sheet"
            >
              ‹
            </IconButton>
            <Typography variant="caption" sx={{ minWidth: 44, textAlign: 'center' }}>
              {page} / {pageCount}
            </Typography>
            <IconButton
              size="small"
              onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
              disabled={page === pageCount}
              aria-label="Next sheet"
            >
              ›
            </IconButton>
          </>
        )}
      </Box>
    </Box>
  );
}
