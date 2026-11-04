'use client';

import { useEffect, useRef, useState } from 'react';
import * as Sentry from '@sentry/nextjs';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import { toError } from '@/lib/supabaseErrors';
import { ShopScene, type LoadState, type WalkState } from './shopScene';
import type { Shop, Where } from './showcaseData';

const overlaySx = { position: 'absolute', bgcolor: 'rgba(17, 20, 57, 0.7)' } as const;

/**
 * The shop in 3D, with the current step's station outlined. The camera flies to each station as
 * the visitor moves through the steps; a mouse can also orbit it, and "Walk the shop" walks the
 * part's route at eye height. Loaded only in the browser (ShowcaseContent imports it with
 * ssr: false), so three.js stays out of every other bundle.
 */
export default function ShopView({ shop, where, route, fly }: { shop: Shop; where: Where; route: Where[]; fly: number }) {
  const container = useRef<HTMLDivElement>(null);
  const scene = useRef<ShopScene | null>(null);
  const [load, setLoad] = useState<LoadState>({ loaded: 0, failed: 0, total: Object.keys(shop.assets).length });
  const [walk, setWalk] = useState<WalkState>({ walking: false });

  const [near, setNear] = useState(false);

  // The models are several megabytes, so they load only once the view comes near the screen: on a
  // phone it sits below the video, and a visitor who never scrolls to it never downloads them.
  useEffect(() => {
    const el = container.current;
    if (!el) return;
    const seen = new IntersectionObserver(([e]) => e.isIntersecting && setNear(true), { rootMargin: '300px' });
    seen.observe(el);
    return () => seen.disconnect();
  }, []);

  useEffect(() => {
    if (!near || !container.current) return;
    const s = new ShopScene(container.current, shop, {
      orbit: window.matchMedia('(hover: hover) and (pointer: fine)').matches,
      onLoad(state, error) {
        setLoad(state);
        if (error) Sentry.captureException(toError(error, `Showcase: ${state.failed} of ${state.total} shop models failed to load`));
      },
      onWalk: setWalk,
    });
    scene.current = s;
    return () => {
      s.dispose();
      scene.current = null;
    };
  }, [near, shop]);

  // `fly` counts the visitor's moves; the first view stays on the whole shop with the station outlined.
  // It runs after the effect above, so it also catches up a scene that has just been made.
  useEffect(() => {
    scene.current?.highlight(where);
    if (fly > 0) scene.current?.flyToStation(where);
  }, [where, fly, near]);

  const loading = load.loaded + load.failed < load.total;
  return (
    <Box>
      <Box
        sx={{
          position: 'relative',
          aspectRatio: '4 / 3',
          borderRadius: 2,
          overflow: 'hidden',
          border: '1px solid rgba(255, 255, 255, 0.1)',
        }}
      >
        <Box
          ref={container}
          role="img"
          aria-label={`A 3D view of ${shop.name}, with ${where.name} outlined`}
          sx={{ position: 'absolute', inset: 0 }}
        />
        <Box sx={{ position: 'absolute', top: 12, right: 12, display: 'flex', gap: 1 }}>
          <Button
            size="small"
            variant="contained"
            onClick={() => (walk.walking ? scene.current?.flyToStation(where) : scene.current?.walk(route, where))}
          >
            {walk.walking ? 'Stop the walk' : 'Walk the shop'}
          </Button>
          <Button size="small" variant="outlined" onClick={() => scene.current?.showWholeShop()} sx={{ bgcolor: overlaySx.bgcolor }}>
            Whole shop
          </Button>
        </Box>
        {walk.walking && (
          <Typography
            role="status"
            sx={{ ...overlaySx, top: 12, left: 12, px: 1.5, py: 0.75, borderRadius: 1, fontSize: '0.9rem', fontWeight: 600 }}
          >
            {walk.stop ?? 'Walking the shop'}
          </Typography>
        )}
        {(loading || load.failed > 0) && (
          <Typography
            role="status"
            sx={{
              position: 'absolute',
              left: 12,
              bottom: 12,
              px: 1.5,
              py: 0.75,
              borderRadius: 1,
              bgcolor: 'rgba(17, 20, 57, 0.8)',
              color: 'text.secondary',
              fontSize: '0.9rem',
            }}
          >
            {loading
              ? `Loading the shop: ${load.loaded} of ${load.total} models`
              : `${load.failed} of ${load.total} models couldn't be loaded. Reload the page to try again.`}
          </Typography>
        )}
      </Box>
      <Typography sx={{ mt: 1.5, color: 'text.secondary', fontSize: '0.95rem' }}>
        {shop.name}
        {shop.fictional && ', a fictional shop'}. This step happens at{' '}
        <Box component="span" sx={{ color: 'text.primary', fontWeight: 600 }}>
          {where.name}
        </Box>
        , outlined in amber.
      </Typography>
    </Box>
  );
}
