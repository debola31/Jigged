'use client';

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import dynamic from 'next/dynamic';
import posthog from 'posthog-js';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import IconButton from '@mui/material/IconButton';
import Typography from '@mui/material/Typography';
import ArrowDownwardIcon from '@mui/icons-material/ArrowDownward';
import CheckIcon from '@mui/icons-material/Check';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import CloseIcon from '@mui/icons-material/Close';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import SwapHorizIcon from '@mui/icons-material/SwapHoriz';
import { DISPLAY_FONT, EYEBROW_COLOR, eyebrowSx } from '@/components/marketing/marketingStyles';
import { CATEGORY_LABELS, type Catalog } from './catalog';
import { CARD_BG, DoneContent, ItemContent, NeedContent, openStepTracked, StepContent, StepPicker, SUBHEADER_BG } from './content';
import Generating from './Generating';
import { CategoryIcon } from './glyphs';
import { toTheParts } from './Intro';
import { PartMenu, type PickSource } from './PartChoice';
import type { LivePart } from './showcaseData';
import { useShowcase } from './store';

// The ground the shop stands on, until the scene draws it.
const GROUND = '#16181d';

// three.js, React Three Fiber and drei load only in the browser, and only on this page.
const ShopCanvas = dynamic(() => import('./ShopCanvas'), {
  ssr: false,
  loading: () => <Box sx={{ position: 'absolute', inset: 0, bgcolor: GROUND }} />,
});

// A thing's card, on the right of the shop.
const ITEM_CARD = 360;
// The step card is sized for its video, the page's main thing: 16:9 at the height the shop section
// leaves under the card's header, the step's title and the Details button (about 340px with the
// marketing header), between the narrow card's width and a little over half the screen.
const STEP_CARD = 'clamp(420px, calc((100dvh - 340px) * 16 / 9 + 40px), 58vw)';
const floatSx = {
  position: 'absolute',
  bgcolor: CARD_BG,
  backdropFilter: 'blur(8px)',
  borderRadius: 2,
  border: '1px solid rgba(255, 255, 255, 0.1)',
  boxShadow: '0 12px 40px rgba(0, 0, 0, 0.35)',
  colorScheme: 'dark',
} as const;

export interface ShopProps {
  cat: Catalog;
  part: LivePart;
  parts: LivePart[];
  onPick(id: string, source: PickSource): void;
  onGenerated(skipped: boolean): void;
  /** Brings the whole shop into view. */
  toShop(): void;
}

/** What the card shows, once a part is picked: its instructions being made, what you'll need, the step, or the part made. */
function Sheet({ cat, part, parts, onPick, onGenerated }: ShopProps) {
  const phase = useShowcase((s) => s.phase);
  const sheet = useShowcase((s) => s.sheet);
  const step = useShowcase((s) => s.step);
  if (phase === 'pick') return null;
  if (phase === 'generating') return <Generating part={part} cat={cat} onDone={onGenerated} />;
  if (sheet === 'done') return <DoneContent part={part} parts={parts} onPick={onPick} />;
  return sheet === 'step' && step !== null ? <StepContent cat={cat} part={part} index={step} /> : <NeedContent cat={cat} part={part} />;
}

/**
 * Before a part is picked: the shop is clear, and this says where to go next. It sits at the foot
 * of the window, not of the shop (whose foot starts below the fold), while neither the intro's own
 * way down nor the parts are in sight.
 */
function PartsPill() {
  const [inSight, setInSight] = useState<Record<string, boolean>>({});
  useEffect(() => {
    const seen = new IntersectionObserver((entries) => setInSight((s) => ({ ...s, ...Object.fromEntries(entries.map((e) => [e.target.id, e.isIntersecting])) })), { threshold: 0.25 });
    for (const id of ['showcase-hero-cta', 'showcase-parts']) {
      const el = document.getElementById(id);
      if (el) seen.observe(el);
    }
    return () => seen.disconnect();
  }, []);
  const partsInSight = Object.values(inSight).some(Boolean);
  return (
    <Button
      variant="contained"
      size="large"
      startIcon={<ArrowDownwardIcon />}
      onClick={toTheParts}
      tabIndex={partsInSight ? -1 : 0}
      aria-hidden={partsInSight}
      sx={{
        position: 'fixed',
        left: '50%',
        bottom: 24,
        zIndex: 2,
        transform: 'translateX(-50%)',
        borderRadius: 999,
        px: 3,
        boxShadow: '0 12px 40px rgba(0, 0, 0, 0.35)',
        opacity: partsInSight ? 0 : 1,
        pointerEvents: partsInSight ? 'none' : 'auto',
        transition: 'opacity 0.25s',
      }}
    >
      Choose or upload a part
    </Button>
  );
}

/**
 * The example shop over its own 3D view: its name, then its areas, which steer the view below. An
 * area flies the camera there and lists its machines, and a machine flies there and opens it. It
 * stays in sight while the view is in use, as the top of the shop's section.
 */
function ShopHeader({ cat, toShop }: { cat: Catalog; toShop(): void }) {
  const look = useShowcase((s) => s.look);
  const openItem = useShowcase((s) => s.openItem);
  const item = useShowcase((s) => s.item);
  const [area, setArea] = useState<string | null>(null);
  const machines = cat.things.filter((t) => t.category === 'machines');
  const areas = cat.shop.zones.map((z) => ({ zone: z, machines: machines.filter((m) => m.zone === z.id) })).filter((a) => a.machines.length > 0);
  const open = areas.find((a) => a.zone.id === area);
  return (
    <Box
      component="nav"
      aria-label="The example shop"
      sx={{ px: 2, pt: { xs: 2.5, md: 3 }, pb: 2, textAlign: 'center', bgcolor: SUBHEADER_BG, borderBottom: '1px solid rgba(255, 255, 255, 0.09)', flexShrink: 0 }}
    >
      <Typography component="span" sx={{ ...eyebrowSx, color: EYEBROW_COLOR }}>
        Example shop
      </Typography>
      <Typography component="h2" sx={{ mt: 0.75, fontFamily: DISPLAY_FONT, fontWeight: 600, fontSize: { xs: '1.5rem', md: '1.85rem' }, lineHeight: 1.15 }}>
        {cat.shop.name}
      </Typography>
      <Typography sx={{ mt: 1.5, color: 'text.secondary', fontSize: '0.9rem' }}>Its {machines.length} machines, by area</Typography>
      <Box sx={{ mt: 1, display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: 1 }}>
        {areas.map((a) => {
          const here = a.zone.id === area;
          return (
            <Chip
              key={a.zone.id}
              icon={<CategoryIcon category="machines" sx={{ fontSize: 20 }} />}
              label={
                <>
                  {a.zone.name}
                  <Box component="span" sx={{ ml: 1, px: 0.75, minWidth: 22, display: 'inline-block', textAlign: 'center', borderRadius: 999, fontSize: '0.8rem', fontWeight: 600, lineHeight: '20px', bgcolor: here ? 'rgba(255, 255, 255, 0.25)' : 'rgba(255, 255, 255, 0.1)' }}>
                    {a.machines.length}
                  </Box>
                </>
              }
              variant={here ? 'filled' : 'outlined'}
              color={here ? 'primary' : 'default'}
              aria-pressed={here}
              aria-controls={here ? 'showcase-area-machines' : undefined}
              onClick={() => {
                toShop();
                setArea(a.zone.id);
                const [x0, y0, x1, y1] = a.zone.rect;
                look({ kind: 'zone', where: { name: a.zone.name, x: (x0 + x1) / 2, y: (y0 + y1) / 2 } });
                posthog.capture('showcase area opened', { zone: a.zone.id });
              }}
              sx={{ height: 40, fontSize: '0.95rem', borderColor: 'rgba(255, 255, 255, 0.28)', '& .MuiChip-icon': { ml: 1.25 }, '& .MuiChip-label': { pl: 1, pr: 1.5 } }}
            />
          );
        })}
      </Box>
      {open && (
        <Box id="showcase-area-machines" role="group" aria-label={`Machines in ${open.zone.name}`} sx={{ mt: 1.75 }}>
          <Typography sx={{ color: 'text.secondary', fontSize: '0.9rem' }}>Machines in {open.zone.name}</Typography>
          <Box sx={{ mt: 1, display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: 1 }}>
            {open.machines.map((m) => {
              const shown = item === m.item;
              return (
                <Chip
                  key={m.item}
                  label={m.name}
                  aria-pressed={shown}
                  onClick={() => {
                    openItem(m.item);
                    posthog.capture('showcase item opened', { category: 'machines', source: 'area' });
                  }}
                  // Quieter than the areas: no outline, a tint, and the one open in the secondary colour.
                  sx={{
                    height: 36,
                    borderRadius: 1.5,
                    bgcolor: shown ? 'secondary.main' : 'rgba(255, 255, 255, 0.07)',
                    color: shown ? 'secondary.contrastText' : 'text.primary',
                    '&:hover': { bgcolor: shown ? 'secondary.dark' : 'rgba(255, 255, 255, 0.14)' },
                    '& .MuiChip-label': { px: 1.75 },
                  }}
                />
              );
            })}
          </Box>
        </Box>
      )}
    </Box>
  );
}

/** Over the shop, top right: the parts, walk, and back to the whole shop. */
function ShopButtons({ part, onWholeShop }: { part: LivePart; onWholeShop(): void }) {
  const walking = useShowcase((s) => s.walking);
  const phase = useShowcase((s) => s.phase);
  const { setWalking } = useShowcase.getState();
  return (
    <Box sx={{ position: 'absolute', top: 16, right: 16, display: 'flex', gap: 1 }}>
      {/* Before a part, the pill at the bottom says this. */}
      {phase !== 'pick' && (
        <Button size="small" variant="contained" color="inherit" startIcon={<ArrowDownwardIcon />} onClick={toTheParts} sx={{ bgcolor: CARD_BG, color: 'common.white', '&:hover': { bgcolor: SUBHEADER_BG } }}>
          The parts
        </Button>
      )}
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
      <Button size="small" variant="contained" color="inherit" onClick={onWholeShop} sx={{ bgcolor: CARD_BG, color: 'common.white', '&:hover': { bgcolor: SUBHEADER_BG } }}>
        Whole shop
      </Button>
    </Box>
  );
}

function WalkStatus() {
  const walking = useShowcase((s) => s.walking);
  const walkStop = useShowcase((s) => s.walkStop);
  if (!walking) return null;
  return (
    <Typography role="status" sx={{ ...floatSx, top: 16, left: '50%', transform: 'translateX(-50%)', px: 2, py: 0.75, fontWeight: 600 }}>
      {walkStop ?? 'Walking the shop'}
    </Typography>
  );
}

function subscribeNothing() {
  return () => {};
}

/** How this computer zooms the shop: a Mac's trackpad pinches, or ⌘ with the wheel; anything else, Ctrl. */
function useZoomKeys(): string {
  const mac = useSyncExternalStore(subscribeNothing, () => /Mac|iPhone|iPad/.test(navigator.userAgent), () => false);
  return mac ? 'Pinch or ⌘ + scroll' : 'Ctrl + scroll';
}

function Hint({ cat }: { cat: Catalog }) {
  const zoomKeys = useZoomKeys();
  return (
    <Typography sx={{ ...floatSx, right: 16, bottom: 16, px: 1.25, py: 0.5, fontSize: '0.8rem', color: 'text.secondary', boxShadow: 'none' }}>
      {cat.shop.name}
      {cat.shop.fictional && ', a fictional shop'} · drag to turn · right-drag to move · {zoomKeys.toLowerCase()} to zoom
    </Typography>
  );
}

/**
 * The page scrolls over the shop, as it does everywhere else, so a visitor can always get back up
 * to the parts: the camera zooms only with Ctrl or ⌘ held, or a trackpad's pinch (which the browser
 * reports as Ctrl). A plain scroll says how to zoom, briefly.
 */
function useScrollPastTheShop(shop: React.RefObject<HTMLElement | null>): boolean {
  const [hint, setHint] = useState(false);
  useEffect(() => {
    const el = shop.current;
    if (!el) return;
    let timer = 0;
    const onWheel = (e: WheelEvent) => {
      // The zoom passed on below, on its way to the camera.
      if (!e.isTrusted) return;
      // Kept from the camera, which would zoom on it and stop the page scrolling.
      e.stopPropagation();
      if (e.ctrlKey || e.metaKey) {
        // Not the browser's own zoom: the camera's, toward the cursor, as a plain scroll gives it.
        e.preventDefault();
        e.target?.dispatchEvent(
          new WheelEvent('wheel', {
            deltaX: e.deltaX,
            deltaY: e.deltaY,
            deltaZ: e.deltaZ,
            deltaMode: e.deltaMode,
            clientX: e.clientX,
            clientY: e.clientY,
            screenX: e.screenX,
            screenY: e.screenY,
            bubbles: true,
            cancelable: true,
          }),
        );
        return;
      }
      setHint(true);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setHint(false), 1500);
    };
    el.addEventListener('wheel', onWheel, { capture: true, passive: false });
    return () => {
      el.removeEventListener('wheel', onWheel, { capture: true });
      window.clearTimeout(timer);
    };
  }, [shop]);
  return hint;
}

function ZoomHint({ shown }: { shown: boolean }) {
  const zoomKeys = useZoomKeys();
  return (
    <Typography
      aria-hidden
      sx={{ ...floatSx, left: '50%', bottom: 64, transform: 'translateX(-50%)', px: 2, py: 1, fontWeight: 600, pointerEvents: 'none', opacity: shown ? 1 : 0, transition: 'opacity 0.25s' }}
    >
      {zoomKeys} to zoom the shop
    </Typography>
  );
}

/**
 * The shop fills the section under its header, with cards over it: the step card on the left, which
 * opens out to its video's size while a step is open and closes the part from its header, and a
 * thing's card on the right. The camera centres what it flies to in the space the cards leave.
 */
export default function ShopLayout(props: ShopProps) {
  const { cat, part, parts, onPick } = props;
  const phase = useShowcase((s) => s.phase);
  const sheet = useShowcase((s) => s.sheet);
  const item = useShowcase((s) => s.item);
  const showNeed = useShowcase((s) => s.showNeed);
  const showDone = useShowcase((s) => s.showDone);
  const closeItem = useShowcase((s) => s.closeItem);
  const overview = useShowcase((s) => s.overview);
  const body = useRef<HTMLDivElement>(null);
  const card = useRef<HTMLElement>(null);
  const view = useRef<HTMLDivElement>(null);
  const zoomHint = useScrollPastTheShop(view);
  const [cardWidth, setCardWidth] = useState(0);
  const step = useShowcase((s) => s.step);
  // Folded at a step of a part, so opening another step, finishing, or another part unfolds it: a
  // step picked is a step to watch.
  const [folded, setFolded] = useState<{ part: string; at: number | null; sheet: string } | null>(null);
  const collapsed = phase === 'plan' && folded !== null && folded.part === part.id && folded.at === step && folded.sheet === sheet;
  const fold = () => setFolded({ part: part.id, at: step, sheet });
  const watching = phase === 'plan' && sheet === 'step' && step !== null && !collapsed;
  // The whole shop wants the room the video takes: the card folds to its header, and the camera
  // frames the shop again once it has.
  const wholeShop = () => {
    fold();
    overview();
  };
  const last = step === part.steps.length - 1;
  // Done with this part: the card goes, the shop stands back, and the pill points to the parts again.
  const closePart = () => {
    setFolded(null);
    useShowcase.setState({ phase: 'pick', sheet: 'need', step: null, item: null });
    overview();
  };
  const thing = item ? cat.spots.get(item)?.[0] : undefined;
  useEffect(() => {
    if (body.current) body.current.scrollTop = 0;
  }, [step, sheet]);
  useEffect(() => {
    const el = card.current;
    if (!el) return;
    const seen = new ResizeObserver(() => setCardWidth(el.offsetWidth));
    seen.observe(el);
    return () => seen.disconnect();
  }, []);

  return (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <ShopHeader cat={cat} toShop={props.toShop} />
      <Box sx={{ position: 'relative', flex: 1, minHeight: 0 }}>
        {/* Its own stacking context, so the labels over the shop (z-index 0-20) stay under the cards. */}
        <Box ref={view} role="img" aria-label={`A 3D view of ${cat.shop.name}`} sx={{ position: 'absolute', inset: 0, zIndex: 0 }}>
          <ShopCanvas cat={cat} part={part} left={cardWidth ? cardWidth + 16 : 0} right={item ? ITEM_CARD + 16 : 0} />
        </Box>
        <ShopButtons part={part} onWholeShop={wholeShop} />
        <WalkStatus />
        <Box
          component="aside"
          ref={card}
          aria-label="The step"
          sx={{
            ...floatSx,
            top: 16,
            left: 16,
            // Folded, just its header, on one line.
            width: watching ? STEP_CARD : collapsed ? 'max-content' : { md: 380, xl: 420 },
            '& button': { whiteSpace: 'nowrap' },
            maxHeight: 'calc(100% - 32px)',
            // Not before a part is picked; kept mounted, so its width is measured from the start.
            display: phase === 'pick' ? 'none' : 'flex',
            flexDirection: 'column',
            transition: 'width 0.3s ease',
          }}
        >
          {phase === 'plan' && (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, p: 1.5, borderBottom: collapsed ? 'none' : '1px solid rgba(255, 255, 255, 0.08)', flexShrink: 0 }}>
              <StepPicker part={part} />
              {sheet === 'step' && (
                <Button size="small" onClick={showNeed}>
                  What you&apos;ll need
                </Button>
              )}
              <PartMenu parts={parts} current={part.id} onPick={onPick} source="menu" label="Change part" buttonProps={{ startIcon: <SwapHorizIcon /> }} />
              <Box sx={{ flex: 1 }} />
              {/* Up here, so stepping on never scrolls away under a long step. */}
              {sheet === 'step' && step !== null && (
                <>
                  <IconButton size="small" aria-label="Previous step" disabled={step === 0} onClick={() => openStepTracked(part, step - 1)}>
                    <ChevronLeftIcon />
                  </IconButton>
                  {last ? (
                    <Button size="small" variant="contained" endIcon={<CheckIcon />} onClick={showDone}>
                      Finish
                    </Button>
                  ) : (
                    <Button size="small" variant="contained" endIcon={<ChevronRightIcon />} onClick={() => openStepTracked(part, step + 1)}>
                      Next step
                    </Button>
                  )}
                </>
              )}
              <IconButton size="small" onClick={() => (collapsed ? setFolded(null) : fold())} aria-label={collapsed ? 'Show the card' : 'Fold the card away'}>
                {collapsed ? <ExpandMoreIcon /> : <ExpandLessIcon />}
              </IconButton>
              <IconButton size="small" onClick={closePart} aria-label={`Close ${part.name}`}>
                <CloseIcon />
              </IconButton>
            </Box>
          )}
          {!collapsed && (
            <Box ref={body} sx={{ p: 2.5, overflowY: 'auto', minHeight: 0 }}>
              <Sheet {...props} />
            </Box>
          )}
        </Box>
        {item && (
          <Box
            component="aside"
            aria-label="The thing"
            sx={{ ...floatSx, top: 64, right: 16, width: ITEM_CARD, maxHeight: 'calc(100% - 128px)', display: 'flex', flexDirection: 'column' }}
          >
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, py: 1, pl: 1.5, pr: 1, borderBottom: '1px solid rgba(255, 255, 255, 0.08)', flexShrink: 0 }}>
              <CategoryIcon category={thing?.category} sx={{ fontSize: 20, color: 'secondary.main' }} />
              <Typography sx={{ flex: 1, color: 'secondary.main', fontWeight: 600, fontSize: '0.85rem', letterSpacing: '0.04em' }}>
                {thing ? (CATEGORY_LABELS[thing.category] ?? thing.category) : ''}
              </Typography>
              <IconButton size="small" onClick={closeItem} aria-label={sheet === 'step' && step !== null ? 'Back to the step' : 'Close'}>
                <CloseIcon />
              </IconButton>
            </Box>
            <Box sx={{ p: 2.5, overflowY: 'auto', minHeight: 0 }}>
              <ItemContent cat={cat} part={part} id={item} />
            </Box>
          </Box>
        )}
        {phase === 'pick' && <PartsPill />}
        <ZoomHint shown={zoomHint} />
        <Hint cat={cat} />
      </Box>
    </Box>
  );
}
