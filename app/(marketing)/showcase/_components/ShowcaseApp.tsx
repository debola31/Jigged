'use client';

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import posthog from 'posthog-js';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import { DISPLAY_FONT } from '@/components/marketing/marketingStyles';
import { catalog, type Catalog } from './catalog';
import Intro, { PartsRow } from './Intro';
import ShopLayout from './Layouts';
import type { PickSource } from './PartChoice';
import { picked, ready, type LivePart, type Showcase } from './showcaseData';
import { useShowcase } from './store';

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
    <Box sx={{ height: '100%', display: 'grid', placeItems: 'center', px: 3, py: 6, textAlign: 'center' }}>
      <Box sx={{ maxWidth: 420 }}>
        <Typography component="h2" sx={{ fontFamily: DISPLAY_FONT, fontWeight: 600, fontSize: '1.7rem', lineHeight: 1.15 }}>
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

/** The address follows the visitor: ?step=<id> and ?item=<id> open there, skipping the way in. */
function useAddress(part: LivePart, cat: Catalog, shop: React.RefObject<HTMLElement | null>) {
  const step = useShowcase((s) => s.step);
  const item = useShowcase((s) => s.item);
  const sheet = useShowcase((s) => s.sheet);
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const s = part.steps.findIndex((x) => x.id === q.get('step'));
    const i = q.get('item');
    const st = useShowcase.getState();
    if (s >= 0 || (i && cat.spots.has(i))) {
      st.setPhase('plan');
      if (s >= 0) st.openStep(s);
      if (i && cat.spots.has(i)) st.openItem(i);
      // After the router's own scroll on arrival, which would otherwise put the page back at the top.
      const t = window.setTimeout(() => shop.current?.scrollIntoView(), 250);
      return () => window.clearTimeout(t);
    }
  }, [part, cat, shop]);
  useEffect(() => {
    const q = new URLSearchParams();
    if (sheet === 'step' && step !== null) q.set('step', part.steps[step].id);
    if (item) q.set('item', item);
    const query = q.toString();
    const url = `${window.location.pathname}${query ? `?${query}` : ''}`;
    if (url !== window.location.pathname + window.location.search) window.history.replaceState(null, '', url);
  }, [step, item, sheet, part]);
}

/**
 * The showcase (plan §1 "Website"): the research in a few lines and the parts to pick, then the
 * whole shop in 3D. Picking a part makes its instructions, then each step flies the camera to where
 * it is done and plays its video in the card it was picked from. Everything was made ahead of time;
 * nothing a visitor does generates anything or changes the simulation.
 */
export default function ShowcaseApp({ data }: { data: Showcase }) {
  // A live part shows once some of it is published: until its renders land there is nothing to watch.
  // Each part narrowed to its picked steps (showcaseData.ts picked): every planned step stays in the data.
  const parts = useMemo(
    () => data.parts.filter((p): p is LivePart => p.status === 'live' && p.steps.some(ready)).map(picked),
    [data.parts],
  );
  const [partId, setPartId] = useState(parts[0].id);
  const part = parts.find((p) => p.id === partId) ?? parts[0];
  const cat = useMemo(() => catalog(data.shop), [data.shop]);
  const narrow = useSyncExternalStore(subscribeNarrow, () => window.matchMedia(NARROW).matches, () => false);
  const [anyway, setAnyway] = useState(false);
  const shop = useRef<HTMLElement>(null);
  useAddress(part, cat, shop);

  const pick = useCallback((id: string, source: PickSource) => {
    setPartId(id);
    useShowcase.setState({ phase: 'generating', sheet: 'need', step: null, item: null });
    shop.current?.scrollIntoView({ behavior: 'smooth' });
    posthog.capture('showcase part picked', { part: id, source });
  }, []);
  const generated = useCallback(() => useShowcase.setState({ phase: 'plan', sheet: 'need' }), []);
  const toShop = useCallback(() => shop.current?.scrollIntoView({ behavior: 'smooth' }), []);

  const props = { cat, part, parts, onPick: pick, onGenerated: generated, toShop };
  return (
    <>
      <Intro />
      <Box
        component="section"
        ref={shop}
        aria-label="The shop"
        sx={{ height: `calc(100dvh - ${HEADER}px)`, minHeight: 600, scrollMarginTop: `${HEADER}px`, borderTop: '1px solid rgba(255, 255, 255, 0.09)' }}
      >
        {narrow && !anyway ? <PhoneNotice onOpen={() => setAnyway(true)} /> : <ShopLayout {...props} />}
      </Box>
      <PartsRow parts={parts} onPick={pick} />
    </>
  );
}
