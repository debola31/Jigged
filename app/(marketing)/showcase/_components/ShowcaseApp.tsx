'use client';

import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import dynamic from 'next/dynamic';
import posthog from 'posthog-js';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import { DISPLAY_FONT } from '@/components/marketing/marketingStyles';
import { catalog } from './catalog';
import Panel from './Panel';
import Rail from './Rail';
import type { LivePart, Showcase } from './showcaseData';
import { useShowcase } from './store';

// three.js, React Three Fiber and drei load only in the browser, and only on this page.
const ShopCanvas = dynamic(() => import('./ShopCanvas'), {
  ssr: false,
  loading: () => <Box sx={{ position: 'absolute', inset: 0, bgcolor: '#eceae5' }} />,
});

const overlaySx = { position: 'absolute', bgcolor: 'rgba(17, 20, 57, 0.75)' } as const;
// The marketing header above, which stays put.
const HEADER = 52;
const NARROW = '(max-width: 899px)';

function subscribeNarrow(change: () => void) {
  const query = window.matchMedia(NARROW);
  query.addEventListener('change', change);
  return () => query.removeEventListener('change', change);
}

/** The shop is laid out for a computer: a phone is told so, and can go on anyway. */
function PhoneNotice({ onOpen }: { onOpen(): void }) {
  const [copied, setCopied] = useState(false);
  return (
    <Box sx={{ minHeight: `calc(100dvh - ${HEADER}px)`, display: 'grid', placeItems: 'center', px: 3, py: 6, textAlign: 'center' }}>
      <Box sx={{ maxWidth: 420 }}>
        <Typography component="h1" sx={{ fontFamily: DISPLAY_FONT, fontWeight: 600, fontSize: '1.9rem', lineHeight: 1.15 }}>
          The shop is built for a computer
        </Typography>
        <Typography sx={{ mt: 2, color: 'text.secondary', fontSize: '1.05rem', lineHeight: 1.6 }}>
          It&apos;s a 3D machine shop with a video for every step. Open this page on a laptop or desktop to walk through it.
        </Typography>
        <Box sx={{ mt: 4, display: 'flex', flexDirection: 'column', gap: 1.5 }}>
          <Button
            variant="contained"
            size="large"
            onClick={() => {
              void navigator.clipboard?.writeText(window.location.href).then(() => setCopied(true));
            }}
          >
            {copied ? 'Link copied' : 'Copy the link'}
          </Button>
          <Button size="large" onClick={onOpen}>
            Open it here anyway
          </Button>
        </Box>
      </Box>
    </Box>
  );
}

/** The 3D view and what floats over it: walk the shop, back to the whole shop, and the walk's stop. */
function Stage({ part, cat }: { part: LivePart; cat: ReturnType<typeof catalog> }) {
  const walking = useShowcase((s) => s.walking);
  const walkStop = useShowcase((s) => s.walkStop);
  const { setWalking, overview } = useShowcase.getState();
  return (
    <Box sx={{ position: 'relative', minWidth: 0, minHeight: 0 }}>
      <Box role="img" aria-label={`A 3D view of ${cat.shop.name}`} sx={{ position: 'absolute', inset: 0 }}>
        <ShopCanvas cat={cat} part={part} />
      </Box>
      <Box sx={{ position: 'absolute', top: 12, right: 12, display: 'flex', gap: 1 }}>
        <Button
          size="small"
          variant="contained"
          onClick={() => {
            if (!walking) posthog.capture('showcase walk started', { part: part.id });
            setWalking(!walking);
          }}
        >
          {walking ? 'Stop the walk' : 'Walk the shop'}
        </Button>
        <Button
          size="small"
          variant="outlined"
          onClick={overview}
          sx={{ color: 'common.white', bgcolor: overlaySx.bgcolor, '&:hover, &:focus-visible': { bgcolor: 'rgba(17, 20, 57, 0.92)' } }}
        >
          Whole shop
        </Button>
      </Box>
      {walking && (
        <Typography role="status" sx={{ ...overlaySx, top: 12, left: 12, px: 1.5, py: 0.75, borderRadius: 1, fontSize: '0.9rem', fontWeight: 600 }}>
          {walkStop ?? 'Walking the shop'}
        </Typography>
      )}
      <Typography sx={{ ...overlaySx, right: 12, bottom: 12, px: 1.25, py: 0.5, borderRadius: 1, fontSize: '0.8rem', color: 'text.secondary' }}>
        {cat.shop.name}
        {cat.shop.fictional && ', a fictional shop'} · drag to turn · right-drag to move · scroll to zoom
      </Typography>
    </Box>
  );
}

/** ?step=<id> and ?item=<id>: a link opens on that step or thing, and the address follows the visitor. */
function useAddress(part: LivePart, cat: ReturnType<typeof catalog>) {
  const step = useShowcase((s) => s.step);
  const item = useShowcase((s) => s.item);
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const s = part.steps.findIndex((x) => x.id === q.get('step'));
    const i = q.get('item');
    const { openStep, openItem, setTab } = useShowcase.getState();
    if (s >= 0) openStep(s);
    if (i && cat.spots.has(i)) {
      openItem(i);
      if (s < 0) setTab('shop');
    }
  }, [part, cat]);
  useEffect(() => {
    const q = new URLSearchParams();
    if (step !== null) q.set('step', part.steps[step].id);
    if (item) q.set('item', item);
    const query = q.toString();
    const url = `${window.location.pathname}${query ? `?${query}` : ''}`;
    if (url !== window.location.pathname + window.location.search) window.history.replaceState(null, '', url);
  }, [step, item, part]);
}

/**
 * The showcase (plan §1 "Website"): the shop in 3D between the part's plan and the open step. Pick
 * a step and the camera goes to where it is done, with its video beside; pick anything in the
 * shop and it opens. Everything on it was made ahead of time; nothing a visitor does generates
 * anything or changes the simulation.
 */
export default function ShowcaseApp({ data }: { data: Showcase }) {
  const part = data.parts.find((p): p is LivePart => p.status === 'live')!;
  const cat = useMemo(() => catalog(data.shop), [data.shop]);
  const narrow = useSyncExternalStore(subscribeNarrow, () => window.matchMedia(NARROW).matches, () => false);
  const [anyway, setAnyway] = useState(false);
  useAddress(part, cat);

  if (narrow && !anyway) return <PhoneNotice onOpen={() => setAnyway(true)} />;
  return (
    <Box
      sx={{
        height: `calc(100dvh - ${HEADER}px)`,
        minHeight: 560,
        display: 'grid',
        gridTemplateColumns: { xs: 'minmax(0, 1fr)', md: '300px minmax(0, 1fr) 380px', xl: '340px minmax(0, 1fr) 420px' },
        gridTemplateRows: { xs: '45vh auto auto', md: 'minmax(0, 1fr)' },
      }}
    >
      <Box sx={{ order: { xs: 2, md: 0 }, display: 'grid', minHeight: 0 }}>
        <Rail cat={cat} part={part} />
      </Box>
      <Stage part={part} cat={cat} />
      <Box sx={{ order: { xs: 3, md: 0 }, display: 'grid', minHeight: 0 }}>
        <Panel cat={cat} part={part} />
      </Box>
    </Box>
  );
}
