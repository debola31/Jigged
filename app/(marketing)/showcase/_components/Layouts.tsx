'use client';

import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import dynamic from 'next/dynamic';
import posthog from 'posthog-js';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemText from '@mui/material/ListItemText';
import ListSubheader from '@mui/material/ListSubheader';
import Popover from '@mui/material/Popover';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import CheckIcon from '@mui/icons-material/Check';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import CloseIcon from '@mui/icons-material/Close';
import DragIndicatorIcon from '@mui/icons-material/DragIndicator';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import SearchIcon from '@mui/icons-material/Search';
import SwapHorizIcon from '@mui/icons-material/SwapHoriz';
import { CATEGORY_LABELS, matches, type Catalog } from './catalog';
import { CARD_BG, DoneContent, ItemContent, NeedContent, openStepTracked, StepContent, StepPicker, SUBHEADER_BG } from './content';
import Generating from './Generating';
import { CategoryIcon, PartFacts, shortName } from './glyphs';
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
// How much of a dragged card stays in the shop: enough of its header to grab it again.
const KEEP_X = 120;
const KEEP_Y = 56;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * A card the visitor can drag by its header, anywhere over the shop. Pressing a control in the
 * header doesn't drag; a double-click puts the card back.
 */
function useDraggable() {
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const drag = useRef<{ px: number; py: number; x: number; y: number; box: { x0: number; x1: number; y0: number; y1: number } } | null>(null);
  const reset = useCallback(() => setOffset({ x: 0, y: 0 }), []);
  const onPointerDown = (e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('button, a, input, [role="button"]')) return;
    const card = e.currentTarget.closest('aside');
    const shop = card?.parentElement;
    if (!card || !shop) return;
    const c = card.getBoundingClientRect();
    const s = shop.getBoundingClientRect();
    drag.current = {
      px: e.clientX,
      py: e.clientY,
      x: offset.x,
      y: offset.y,
      box: {
        x0: offset.x - (c.left - s.left) - (c.width - KEEP_X),
        x1: offset.x + (s.right - c.left) - KEEP_X,
        y0: offset.y - (c.top - s.top),
        y1: offset.y + (s.bottom - c.top) - KEEP_Y,
      },
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d) return;
    setOffset({ x: clamp(d.x + e.clientX - d.px, d.box.x0, d.box.x1), y: clamp(d.y + e.clientY - d.py, d.box.y0, d.box.y1) });
  };
  const onPointerUp = () => {
    drag.current = null;
  };
  const onDoubleClick = (e: React.MouseEvent<HTMLElement>) => {
    if (!(e.target as HTMLElement).closest('button, a, input, [role="button"]')) reset();
  };
  return {
    offset,
    moved: offset.x !== 0 || offset.y !== 0,
    reset,
    handle: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp, onDoubleClick },
    handleSx: { cursor: 'grab', touchAction: 'none', userSelect: 'none', '&:active': { cursor: 'grabbing' } },
    transform: `translate(${offset.x}px, ${offset.y}px)`,
  };
}

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
}

/** What the card shows: the parts to pick, the instructions being made, what you'll need, the step, or the part made. */
function Sheet({ cat, part, parts, onPick, onGenerated }: ShopProps) {
  const phase = useShowcase((s) => s.phase);
  const sheet = useShowcase((s) => s.sheet);
  const step = useShowcase((s) => s.step);
  if (phase === 'pick') return <PickPrompt parts={parts} onPick={onPick} />;
  if (phase === 'generating') return <Generating part={part} cat={cat} onDone={onGenerated} />;
  if (sheet === 'done') return <DoneContent part={part} parts={parts} onPick={onPick} />;
  return sheet === 'step' && step !== null ? <StepContent cat={cat} part={part} index={step} /> : <NeedContent cat={cat} part={part} />;
}

/** Before a part is picked: the same choice as the intro's, for a visitor who scrolled straight here. */
function PickPrompt({ parts, onPick }: { parts: LivePart[]; onPick(id: string, source: PickSource): void }) {
  return (
    <Box>
      <Typography component="h2" sx={{ fontWeight: 600, fontSize: '1.3rem' }}>
        Pick a part to see it made
      </Typography>
      {parts.map((p) => (
        <Box key={p.id} sx={{ mt: 2, p: 2, borderRadius: 1.5, border: '1px solid rgba(255, 255, 255, 0.12)' }}>
          <Typography sx={{ fontWeight: 600, mb: 0.75 }}>{shortName(p)}</Typography>
          <PartFacts part={p} />
          <Button variant="contained" onClick={() => onPick(p.id, 'prompt')} sx={{ mt: 1.5 }}>
            Make this part
          </Button>
        </Box>
      ))}
      <Button size="small" onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })} sx={{ mt: 2 }}>
        Or send us your own part
      </Button>
    </Box>
  );
}

/** Find any machine or tool and fly to it. */
function FindThings({ cat }: { cat: Catalog }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [query, setQuery] = useState('');
  const openItem = useShowcase((s) => s.openItem);
  const shown = cat.things.filter((t) => matches(t, query, cat.zoneName(t.zone)));
  const zones = cat.shop.zones.filter((z) => shown.some((t) => t.zone === z.id));
  return (
    <>
      <Button size="small" variant="contained" color="inherit" startIcon={<SearchIcon />} onClick={(e) => setAnchor(e.currentTarget)} sx={{ bgcolor: CARD_BG, color: 'common.white', '&:hover': { bgcolor: SUBHEADER_BG } }}>
        Find a machine or tool
      </Button>
      <Popover
        open={!!anchor}
        anchorEl={anchor}
        onClose={() => setAnchor(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
        slotProps={{ paper: { sx: { width: 360, maxHeight: '65vh', bgcolor: SUBHEADER_BG, colorScheme: 'dark', display: 'flex', flexDirection: 'column' } } }}
      >
        <Box sx={{ p: 1.5, flexShrink: 0 }}>
          <TextField
            autoFocus
            fullWidth
            size="small"
            type="search"
            placeholder="Vise, edge finder, Haas…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            slotProps={{ htmlInput: { 'aria-label': 'Find a machine or tool' } }}
          />
        </Box>
        <Box sx={{ overflowY: 'auto' }}>
          {zones.map((z) => (
            <List key={z.id} dense disablePadding subheader={<ListSubheader sx={{ bgcolor: SUBHEADER_BG, color: 'text.secondary', fontWeight: 600 }}>{z.name}</ListSubheader>}>
              {shown
                .filter((t) => t.zone === z.id)
                .map((t) => (
                  <ListItemButton
                    key={t.item}
                    onClick={() => {
                      setAnchor(null);
                      openItem(t.item);
                      posthog.capture('showcase item opened', { category: t.category, source: 'search' });
                    }}
                  >
                    <ListItemText primary={t.name} secondary={CATEGORY_LABELS[t.category] ?? t.category} />
                  </ListItemButton>
                ))}
            </List>
          ))}
          {shown.length === 0 && <Typography sx={{ p: 2, color: 'text.secondary' }}>Nothing matches “{query}”.</Typography>}
        </Box>
      </Popover>
    </>
  );
}

/** Over the shop, top right: the cards back where they were, find, walk, and back to the whole shop. */
function ShopButtons({ cat, part, onSnapBack, onWholeShop }: { cat: Catalog; part: LivePart; onSnapBack?(): void; onWholeShop(): void }) {
  const walking = useShowcase((s) => s.walking);
  const { setWalking } = useShowcase.getState();
  return (
    <Box sx={{ position: 'absolute', top: 16, right: 16, display: 'flex', gap: 1 }}>
      {onSnapBack && (
        <Button size="small" variant="contained" color="inherit" startIcon={<RestartAltIcon />} onClick={onSnapBack} sx={{ bgcolor: CARD_BG, color: 'common.white', '&:hover': { bgcolor: SUBHEADER_BG } }}>
          Put the cards back
        </Button>
      )}
      <FindThings cat={cat} />
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

function Hint({ cat }: { cat: Catalog }) {
  return (
    <Typography sx={{ ...floatSx, right: 16, bottom: 16, px: 1.25, py: 0.5, fontSize: '0.8rem', color: 'text.secondary', boxShadow: 'none' }}>
      {cat.shop.name}
      {cat.shop.fictional && ', a fictional shop'} · drag to turn · right-drag to move · scroll to zoom
    </Typography>
  );
}

/**
 * The shop fills the section, with cards over it: the step card on the left, which opens out to its
 * video's size while a step is open, and a thing's card on the right. Either can be dragged by its
 * header and put back. The camera centres what it flies to in the space the cards leave where they
 * start.
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
  const stepDrag = useDraggable();
  const itemDrag = useDraggable();
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
    <Box sx={{ position: 'relative', height: '100%' }}>
      {/* Its own stacking context, so the labels over the shop (z-index 0-20) stay under the cards. */}
      <Box role="img" aria-label={`A 3D view of ${cat.shop.name}`} sx={{ position: 'absolute', inset: 0, zIndex: 0 }}>
        <ShopCanvas cat={cat} part={part} left={cardWidth ? cardWidth + 16 : 0} right={item ? ITEM_CARD + 16 : 0} />
      </Box>
      <ShopButtons
        cat={cat}
        part={part}
        onWholeShop={wholeShop}
        onSnapBack={
          stepDrag.moved || itemDrag.moved
            ? () => {
                stepDrag.reset();
                itemDrag.reset();
              }
            : undefined
        }
      />
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
          display: 'flex',
          flexDirection: 'column',
          transform: stepDrag.transform,
          transition: 'width 0.3s ease',
        }}
      >
        {phase === 'plan' && (
          <Box
            {...stepDrag.handle}
            sx={{ ...stepDrag.handleSx, display: 'flex', alignItems: 'center', gap: 1, p: 1.5, pl: 0.75, borderBottom: collapsed ? 'none' : '1px solid rgba(255, 255, 255, 0.08)', flexShrink: 0 }}
          >
            <DragIndicatorIcon aria-hidden sx={{ color: 'text.secondary', fontSize: 20 }} />
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
          sx={{ ...floatSx, top: 64, right: 16, width: ITEM_CARD, maxHeight: 'calc(100% - 128px)', display: 'flex', flexDirection: 'column', transform: itemDrag.transform }}
        >
          <Box
            {...itemDrag.handle}
            sx={{ ...itemDrag.handleSx, display: 'flex', alignItems: 'center', gap: 1, py: 1, pl: 0.75, pr: 1, borderBottom: '1px solid rgba(255, 255, 255, 0.08)', flexShrink: 0 }}
          >
            <DragIndicatorIcon aria-hidden sx={{ color: 'text.secondary', fontSize: 20 }} />
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
      <Hint cat={cat} />
    </Box>
  );
}
