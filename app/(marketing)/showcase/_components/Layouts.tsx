'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import dynamic from 'next/dynamic';
import posthog from 'posthog-js';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import InputAdornment from '@mui/material/InputAdornment';
import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemText from '@mui/material/ListItemText';
import ListSubheader from '@mui/material/ListSubheader';
import Popover from '@mui/material/Popover';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import SearchIcon from '@mui/icons-material/Search';
import { CATEGORY_LABELS, matches, type Catalog } from './catalog';
import { CARD_BG, ItemContent, NeedContent, openStepTracked, StepContent, StepPicker, stepNote, SUBHEADER_BG } from './content';
import Generating from './Generating';
import type { LivePart } from './showcaseData';
import { useShowcase } from './store';

// three.js, React Three Fiber and drei load only in the browser, and only on this page.
const ShopCanvas = dynamic(() => import('./ShopCanvas'), {
  ssr: false,
  loading: () => <Box sx={{ position: 'absolute', inset: 0, bgcolor: '#eceae5' }} />,
});

// A thing's card, on the right of the shop.
const ITEM_CARD = 360;

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
  onPick(id: string): void;
  onGenerated(skipped: boolean): void;
}

/** What the card or rail shows: the parts to pick, the instructions being made, what you'll need, or the step. */
function Sheet({ cat, part, parts, onPick, onGenerated, inlineSteps = false }: ShopProps & { inlineSteps?: boolean }) {
  const phase = useShowcase((s) => s.phase);
  const sheet = useShowcase((s) => s.sheet);
  const step = useShowcase((s) => s.step);
  if (phase === 'pick') return <PickPrompt parts={parts} onPick={onPick} />;
  if (phase === 'generating') return <Generating part={part} cat={cat} onDone={onGenerated} />;
  if (inlineSteps) return <RailSteps cat={cat} part={part} />;
  return sheet === 'step' && step !== null ? <StepContent cat={cat} part={part} index={step} /> : <NeedContent cat={cat} part={part} />;
}

/** Before a part is picked: the same choice as the intro's, for a visitor who scrolled straight here. */
function PickPrompt({ parts, onPick }: { parts: LivePart[]; onPick(id: string): void }) {
  return (
    <Box>
      <Typography component="h2" sx={{ fontWeight: 600, fontSize: '1.3rem' }}>
        Pick a part to see it made
      </Typography>
      {parts.map((p) => (
        <Box key={p.id} sx={{ mt: 2, p: 2, borderRadius: 1.5, border: '1px solid rgba(255, 255, 255, 0.12)' }}>
          <Typography sx={{ fontWeight: 600 }}>{p.name}</Typography>
          <Typography sx={{ color: 'text.secondary', fontSize: '0.9rem', mt: 0.5 }}>
            {p.stock.material} · {p.steps.length} steps
          </Typography>
          <Button variant="contained" onClick={() => onPick(p.id)} sx={{ mt: 1.5 }}>
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

/** Over the shop, top right: find, walk, and back to the whole shop. */
function ShopButtons({ part, find }: { part: LivePart; find?: ReactNode }) {
  const walking = useShowcase((s) => s.walking);
  const { setWalking, overview } = useShowcase.getState();
  return (
    <Box sx={{ position: 'absolute', top: 16, right: 16, display: 'flex', gap: 1 }}>
      {find}
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
      <Button size="small" variant="contained" color="inherit" onClick={overview} sx={{ bgcolor: CARD_BG, color: 'common.white', '&:hover': { bgcolor: SUBHEADER_BG } }}>
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

// --- option 1: cards over the shop --------------------------------------------------------------

/** The shop fills the section; the step card floats on the left and a thing's card on the right. */
export function CardsLayout(props: ShopProps) {
  const { cat, part } = props;
  const phase = useShowcase((s) => s.phase);
  const sheet = useShowcase((s) => s.sheet);
  const item = useShowcase((s) => s.item);
  const showNeed = useShowcase((s) => s.showNeed);
  const [collapsed, setCollapsed] = useState(false);
  const body = useRef<HTMLDivElement>(null);
  const card = useRef<HTMLElement>(null);
  const [cardWidth, setCardWidth] = useState(0);
  const step = useShowcase((s) => s.step);
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
      <Box role="img" aria-label={`A 3D view of ${cat.shop.name}`} sx={{ position: 'absolute', inset: 0 }}>
        <ShopCanvas cat={cat} part={part} left={cardWidth ? cardWidth + 16 : 0} right={item ? ITEM_CARD + 16 : 0} />
      </Box>
      <ShopButtons part={part} find={<FindThings cat={cat} />} />
      <WalkStatus />
      <Box
        component="aside"
        ref={card}
        aria-label="The step"
        sx={{ ...floatSx, top: 16, left: 16, width: { md: 380, xl: 420 }, maxHeight: 'calc(100% - 32px)', display: 'flex', flexDirection: 'column' }}
      >
        {phase === 'plan' && (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, p: 1.5, borderBottom: collapsed ? 'none' : '1px solid rgba(255, 255, 255, 0.08)', flexShrink: 0 }}>
            <StepPicker part={part} />
            {sheet === 'step' && (
              <Button size="small" onClick={showNeed}>
                What you&apos;ll need
              </Button>
            )}
            <IconButton size="small" onClick={() => setCollapsed((c) => !c)} aria-label={collapsed ? 'Show the card' : 'Fold the card away'} sx={{ ml: 'auto' }}>
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
        <Box component="aside" aria-label="The thing" sx={{ ...floatSx, top: 64, right: 16, width: ITEM_CARD, maxHeight: 'calc(100% - 128px)', overflowY: 'auto', p: 2.5 }}>
          <ItemContent cat={cat} part={part} id={item} />
        </Box>
      )}
      <Hint cat={cat} />
    </Box>
  );
}

// --- option 2: one side rail --------------------------------------------------------------------

/** The steps in the rail, the open one opened out in place with its video. */
function RailSteps({ cat, part }: { cat: Catalog; part: LivePart }) {
  const index = useShowcase((s) => s.step);
  const sheet = useShowcase((s) => s.sheet);
  const showNeed = useShowcase((s) => s.showNeed);
  const open = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Keep the open step in view inside the rail, without scrolling the page (which scrollIntoView would).
    const c = open.current;
    const box = c?.closest<HTMLElement>('[data-rail-scroll]');
    if (!c || !box) return;
    // Below the group's sticky heading, which would otherwise cover the open step's title.
    const heading = c.closest('ul')?.querySelector<HTMLElement>('li.MuiListSubheader-root')?.offsetHeight ?? 0;
    box.scrollTop = c.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop - heading - 4;
  }, [index, sheet]);
  return (
    <>
      <ListItemButton selected={sheet === 'need'} onClick={showNeed} ref={sheet === 'need' ? open : undefined}>
        <ListItemText primary="What you'll need" secondary="The stock, the stations and the tools" />
      </ListItemButton>
      {sheet === 'need' && (
        <Box sx={{ px: 2.5, pb: 3 }}>
          <NeedContent cat={cat} part={part} />
        </Box>
      )}
      {part.groups.map((g) => (
        <List key={g.id} disablePadding subheader={<ListSubheader sx={{ bgcolor: SUBHEADER_BG, color: 'text.secondary', fontWeight: 600, lineHeight: 2.4 }}>{g.title}</ListSubheader>}>
          {part.steps.map((s, i) => {
            if (s.group !== g.id) return null;
            const isOpen = sheet === 'step' && i === index;
            return (
              <Box key={s.id} ref={isOpen ? open : undefined}>
                <ListItemButton selected={isOpen} aria-current={isOpen ? 'step' : undefined} onClick={() => openStepTracked(part, i)}>
                  <ListItemText primary={`${i + 1}. ${s.title}`} secondary={isOpen ? undefined : stepNote(s)} />
                </ListItemButton>
                {isOpen && (
                  <Box sx={{ px: 2, pb: 2.5, pt: 0.5, bgcolor: 'rgba(255, 255, 255, 0.04)' }}>
                    <StepContent cat={cat} part={part} index={i} header={false} />
                  </Box>
                )}
              </Box>
            );
          })}
        </List>
      ))}
    </>
  );
}

/** Steps and things matching the rail's search. */
function RailSearch({ cat, part, query, onDone }: { cat: Catalog; part: LivePart; query: string; onDone(): void }) {
  const openItem = useShowcase((s) => s.openItem);
  const q = query.trim().toLowerCase();
  const steps = part.steps.flatMap((s, i) => ((s.title + ' ' + s.caption).toLowerCase().includes(q) ? [i] : []));
  const things = cat.things.filter((t) => matches(t, query, cat.zoneName(t.zone)));
  return (
    <>
      {steps.length > 0 && (
        <List dense disablePadding subheader={<ListSubheader sx={{ bgcolor: SUBHEADER_BG, color: 'text.secondary', fontWeight: 600 }}>Steps</ListSubheader>}>
          {steps.map((i) => (
            <ListItemButton
              key={part.steps[i].id}
              onClick={() => {
                onDone();
                openStepTracked(part, i);
              }}
            >
              <ListItemText primary={`${i + 1}. ${part.steps[i].title}`} />
            </ListItemButton>
          ))}
        </List>
      )}
      {things.length > 0 && (
        <List dense disablePadding subheader={<ListSubheader sx={{ bgcolor: SUBHEADER_BG, color: 'text.secondary', fontWeight: 600 }}>In the shop</ListSubheader>}>
          {things.map((t) => (
            <ListItemButton
              key={t.item}
              onClick={() => {
                onDone();
                openItem(t.item);
                posthog.capture('showcase item opened', { category: t.category, source: 'search' });
              }}
            >
              <ListItemText primary={t.name} secondary={cat.zoneName(t.zone)} />
            </ListItemButton>
          ))}
        </List>
      )}
      {steps.length + things.length === 0 && <Typography sx={{ p: 2.5, color: 'text.secondary' }}>Nothing matches “{query}”.</Typography>}
    </>
  );
}

/** One rail on the left with the steps (the open one plays in place) and a search over steps and things. */
export function RailLayout(props: ShopProps) {
  const { cat, part } = props;
  const phase = useShowcase((s) => s.phase);
  const item = useShowcase((s) => s.item);
  const [query, setQuery] = useState('');
  return (
    <Box sx={{ display: 'grid', gridTemplateColumns: { md: '380px minmax(0, 1fr)', xl: '420px minmax(0, 1fr)' }, height: '100%' }}>
      <Box component="nav" aria-label="The steps" sx={{ display: 'flex', flexDirection: 'column', minHeight: 0, borderRight: '1px solid rgba(255, 255, 255, 0.09)', bgcolor: 'rgba(17, 20, 57, 0.6)' }}>
        {phase === 'plan' && (
          <Box sx={{ p: 2, flexShrink: 0, borderBottom: '1px solid rgba(255, 255, 255, 0.08)' }}>
            <Typography sx={{ fontWeight: 600 }}>{part.name}</Typography>
            <TextField
              fullWidth
              size="small"
              type="search"
              placeholder="Search the steps and the shop"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              sx={{ mt: 1.5 }}
              slotProps={{
                htmlInput: { 'aria-label': 'Search the steps and the shop' },
                input: {
                  startAdornment: (
                    <InputAdornment position="start">
                      <SearchIcon fontSize="small" />
                    </InputAdornment>
                  ),
                },
              }}
            />
          </Box>
        )}
        <Box data-rail-scroll sx={{ flex: 1, minHeight: 0, overflowY: 'auto', colorScheme: 'dark' }}>
          {item ? (
            <Box sx={{ p: 2.5 }}>
              <ItemContent cat={cat} part={part} id={item} />
            </Box>
          ) : query.trim() && phase === 'plan' ? (
            <RailSearch cat={cat} part={part} query={query} onDone={() => setQuery('')} />
          ) : phase === 'plan' ? (
            <Sheet {...props} inlineSteps />
          ) : (
            <Box sx={{ p: 2.5 }}>
              <Sheet {...props} />
            </Box>
          )}
        </Box>
      </Box>
      <Box sx={{ position: 'relative', minWidth: 0, minHeight: 0 }}>
        <Box role="img" aria-label={`A 3D view of ${cat.shop.name}`} sx={{ position: 'absolute', inset: 0 }}>
          <ShopCanvas cat={cat} part={part} />
        </Box>
        <ShopButtons part={part} />
        <WalkStatus />
        <Hint cat={cat} />
      </Box>
    </Box>
  );
}
