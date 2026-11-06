'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import ButtonBase from '@mui/material/ButtonBase';
import Chip from '@mui/material/Chip';
import IconButton from '@mui/material/IconButton';
import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemText from '@mui/material/ListItemText';
import ListSubheader from '@mui/material/ListSubheader';
import Popover from '@mui/material/Popover';
import Typography from '@mui/material/Typography';
import { useTheme } from '@mui/material/styles';
import ArrowDownwardIcon from '@mui/icons-material/ArrowDownward';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import GridViewOutlinedIcon from '@mui/icons-material/GridViewOutlined';
import PlayCircleIcon from '@mui/icons-material/PlayCircle';
import PlayCircleOutlineIcon from '@mui/icons-material/PlayCircleOutline';
import PrecisionManufacturingOutlinedIcon from '@mui/icons-material/PrecisionManufacturingOutlined';
import UploadFileOutlinedIcon from '@mui/icons-material/UploadFileOutlined';
import WarehouseOutlinedIcon from '@mui/icons-material/WarehouseOutlined';
import Section from '@/components/marketing/Section';
import { DISPLAY_FONT, EYEBROW_COLOR, eyebrowSx } from '@/components/marketing/marketingStyles';
import type { Catalog } from './catalog';
import { CategoryIcon, PartFacts, shortName } from './glyphs';
import { PilotDialog, UPLOADS_OPEN, type PickSource } from './PartChoice';
import { finishedStill, type LivePart } from './showcaseData';

const PANEL_BG = 'rgba(17, 20, 57, 0.7)';
const MENU_BG = 'rgba(17, 20, 57, 0.98)';
const BORDER = '1px solid rgba(255, 255, 255, 0.12)';

const slideSx = {
  flex: '0 0 auto',
  scrollSnapAlign: 'start',
  borderRadius: 2,
  overflow: 'hidden',
  border: BORDER,
  bgcolor: PANEL_BG,
} as const;

/** One of our parts: the part itself, then what it is at a glance. The whole slide picks it. */
function PartSlide({ part, onPick }: { part: LivePart; onPick(): void }) {
  const still = finishedStill(part);
  return (
    <Box component="article" sx={{ ...slideSx, width: { xs: '80%', sm: 340 }, transition: 'transform 0.2s, border-color 0.2s', '&:hover': { transform: 'translateY(-4px)', borderColor: 'rgba(255, 255, 255, 0.3)' } }}>
      <ButtonBase onClick={onPick} aria-label={`Make ${part.name}`} sx={{ display: 'block', width: '100%', textAlign: 'left' }}>
        <Box sx={{ position: 'relative', aspectRatio: '4 / 3', bgcolor: 'common.black' }}>
          {still ? (
            <Box component="img" src={still} alt="" sx={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} />
          ) : (
            <Box sx={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', color: 'rgba(255, 255, 255, 0.25)' }}>
              <PrecisionManufacturingOutlinedIcon sx={{ fontSize: 72 }} />
            </Box>
          )}
          <Box sx={{ position: 'absolute', left: 12, bottom: 12, display: 'inline-flex', alignItems: 'center', gap: 0.75, pl: 0.75, pr: 1.5, py: 0.5, borderRadius: 999, bgcolor: 'primary.main', color: 'primary.contrastText', fontWeight: 600, fontSize: '0.95rem' }}>
            <PlayCircleIcon sx={{ fontSize: 22 }} />
            Make this part
          </Box>
        </Box>
        <Box sx={{ p: 2 }}>
          <Typography component="h3" sx={{ fontFamily: DISPLAY_FONT, fontWeight: 600, fontSize: '1.25rem', lineHeight: 1.2, mb: 1 }}>
            {shortName(part)}
          </Typography>
          <PartFacts part={part} />
        </Box>
      </ButtonBase>
    </Box>
  );
}

// The space at either end of the carousel, as the page's gutter.
const GUTTER = { xs: 2, md: 4 };

const arrowSx = {
  position: 'absolute',
  top: '35%',
  zIndex: 1,
  transform: 'translateY(-50%)',
  bgcolor: 'rgba(17, 20, 57, 0.9)',
  border: '1px solid rgba(255, 255, 255, 0.2)',
  boxShadow: '0 6px 20px rgba(0, 0, 0, 0.35)',
  '&:hover': { bgcolor: 'rgba(17, 20, 57, 1)' },
  // Nothing more that way: gone, but still in place for the keyboard's focus.
  '&.Mui-disabled': { opacity: 0 },
} as const;

/**
 * A row across the whole width of the page that scrolls sideways a slide at a time. The slides sit
 * in the middle while they all fit; once they don't, arrows over its ends show there is more.
 */
function Carousel({ label, children }: { label: string; children: ReactNode }) {
  const track = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ start: true, end: true });
  const measure = useCallback(() => {
    const el = track.current;
    if (el) setEdges({ start: el.scrollLeft <= 4, end: el.scrollLeft + el.clientWidth >= el.scrollWidth - 4 });
  }, []);
  useEffect(() => {
    const el = track.current;
    if (!el) return;
    measure();
    // The track, and each slide as it lays out: either can change how much there is to scroll.
    const seen = new ResizeObserver(measure);
    for (const box of [el, ...el.children]) seen.observe(box);
    return () => seen.disconnect();
  }, [measure]);
  const go = (dir: 1 | -1) => track.current?.scrollBy({ left: dir * track.current.clientWidth * 0.8, behavior: 'smooth' });
  // Padding takes the theme's spacing from a number; scroll padding and offsets take it only as a length.
  const theme = useTheme();
  const gutter = { xs: theme.spacing(GUTTER.xs), md: theme.spacing(GUTTER.md) };
  return (
    <Box component="section" aria-label={label}>
      <Typography component="h2" sx={{ ...eyebrowSx, display: 'block', color: EYEBROW_COLOR, textAlign: 'center', mb: 2.5 }}>
        {label}
      </Typography>
      <Box sx={{ position: 'relative' }}>
        <IconButton aria-label="Previous parts" disabled={edges.start} onClick={() => go(-1)} sx={{ ...arrowSx, left: gutter }}>
          <ChevronLeftIcon />
        </IconButton>
        <IconButton aria-label="More parts" disabled={edges.end} onClick={() => go(1)} sx={{ ...arrowSx, right: gutter }}>
          <ChevronRightIcon />
        </IconButton>
        <Box
          ref={track}
          onScroll={measure}
          sx={{
            display: 'flex',
            gap: 2,
            overflowX: 'auto',
            scrollSnapType: 'x mandatory',
            scrollPaddingInline: gutter,
            scrollbarWidth: 'none',
            '&::-webkit-scrollbar': { display: 'none' },
            px: GUTTER,
            pt: 0.5,
            pb: 1,
            // In the middle while they fit; from the start once they don't.
            '& > :first-of-type': { ml: 'auto' },
            '& > :last-of-type': { mr: 'auto' },
          }}
        >
          {children}
        </Box>
      </Box>
    </Box>
  );
}

function Fact({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.75 }}>
      {icon}
      {children}
    </Box>
  );
}

/**
 * The example shop at a glance: its name, what it is, and its machines by area. A machine opens
 * where it stands in the 3D shop below.
 */
function ShopBlock({ cat, onMachine }: { cat: Catalog; onMachine(id: string): void }) {
  const [open, setOpen] = useState<{ anchor: HTMLElement; zone: string } | null>(null);
  const machines = cat.things.filter((t) => t.category === 'machines');
  const areas = cat.shop.zones.map((z) => ({ zone: z, machines: machines.filter((m) => m.zone === z.id) })).filter((a) => a.machines.length > 0);
  const shown = open ? areas.find((a) => a.zone.id === open.zone) : undefined;
  return (
    <Box component="section" aria-label="The example shop" sx={{ maxWidth: 960, mx: 'auto', mt: { xs: 5, md: 6 }, p: { xs: 2.5, md: 3.5 }, borderRadius: 2, border: BORDER, bgcolor: PANEL_BG, textAlign: 'center' }}>
      <Typography component="span" sx={{ ...eyebrowSx, color: EYEBROW_COLOR }}>
        Example shop
      </Typography>
      <Typography component="h2" sx={{ mt: 1, fontFamily: DISPLAY_FONT, fontWeight: 600, fontSize: { xs: '1.5rem', md: '1.85rem' }, lineHeight: 1.15 }}>
        {cat.shop.name}
      </Typography>
      <Box sx={{ mt: 1.5, display: 'flex', flexWrap: 'wrap', justifyContent: 'center', columnGap: 3, rowGap: 1, color: 'text.secondary' }}>
        <Fact icon={<WarehouseOutlinedIcon sx={{ fontSize: 20 }} />}>{cat.shop.fictional ? 'A fictional job shop' : 'A job shop'}</Fact>
        <Fact icon={<PrecisionManufacturingOutlinedIcon sx={{ fontSize: 20 }} />}>{machines.length} machines</Fact>
        <Fact icon={<GridViewOutlinedIcon sx={{ fontSize: 20 }} />}>{areas.length} areas</Fact>
      </Box>
      <Box sx={{ mt: 2.5, display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: 1 }}>
        {areas.map((a) => (
          <Chip
            key={a.zone.id}
            icon={<CategoryIcon category="machines" sx={{ fontSize: 18 }} />}
            label={
              <>
                {a.zone.name}
                <Box component="span" sx={{ ml: 1, color: 'text.secondary' }}>
                  {a.machines.length}
                </Box>
              </>
            }
            variant="outlined"
            aria-haspopup="menu"
            onClick={(e) => setOpen({ anchor: e.currentTarget, zone: a.zone.id })}
          />
        ))}
      </Box>
      <Typography sx={{ mt: 2, color: 'text.secondary', fontSize: '0.9rem' }}>The shop, its machines and the hands are simulated.</Typography>
      <Popover
        open={!!shown}
        anchorEl={open?.anchor}
        onClose={() => setOpen(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
        transformOrigin={{ vertical: 'top', horizontal: 'center' }}
        slotProps={{ paper: { sx: { width: 320, maxHeight: '60vh', bgcolor: MENU_BG, colorScheme: 'dark' } } }}
      >
        {shown && (
          <List dense aria-label={`${shown.zone.name} machines`} subheader={<ListSubheader sx={{ bgcolor: MENU_BG, color: 'text.secondary', fontWeight: 600 }}>{shown.zone.name}</ListSubheader>}>
            {shown.machines.map((m) => (
              <ListItemButton
                key={m.item}
                onClick={() => {
                  setOpen(null);
                  onMachine(m.item);
                }}
              >
                <ListItemText primary={m.name} />
              </ListItemButton>
            ))}
          </List>
        )}
      </Popover>
    </Box>
  );
}

function Choice({ icon, title, text, action, muted = false }: { icon: ReactNode; title: string; text: string; action: ReactNode; muted?: boolean }) {
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1.25, p: 3, borderRadius: 2, border: BORDER, borderStyle: muted ? 'dashed' : 'solid', bgcolor: muted ? 'transparent' : PANEL_BG, textAlign: 'center' }}>
      <Box sx={{ color: muted ? 'text.secondary' : EYEBROW_COLOR, display: 'grid', placeItems: 'center' }}>{icon}</Box>
      <Typography component="h3" sx={{ fontWeight: 600, fontSize: '1.15rem', color: muted ? 'text.secondary' : 'text.primary' }}>
        {title}
      </Typography>
      <Typography sx={{ color: 'text.secondary', fontSize: '0.95rem' }}>{text}</Typography>
      <Box sx={{ mt: 0.5 }}>{action}</Box>
    </Box>
  );
}

/** The visitor's way on: their own part (once uploads open), or one of ours. */
function Choices({ onExamples }: { onExamples(): void }) {
  const [pilot, setPilot] = useState(false);
  return (
    <Box sx={{ mt: { xs: 4, md: 5 }, maxWidth: 760, mx: 'auto', display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' }, gap: 2 }}>
      <Choice
        muted={!UPLOADS_OPEN}
        icon={<UploadFileOutlinedIcon sx={{ fontSize: 40 }} />}
        title="Upload your part"
        text="A CAD file or drawing."
        action={
          UPLOADS_OPEN ? (
            <Button variant="contained" onClick={() => setPilot(true)}>
              Send a part
            </Button>
          ) : (
            <Button variant="outlined" disabled>
              Coming soon
            </Button>
          )
        }
      />
      <Choice
        icon={<PlayCircleOutlineIcon sx={{ fontSize: 40 }} />}
        title="Try an example part"
        text="Parts already run through this shop."
        action={
          <Button variant="contained" endIcon={<ArrowDownwardIcon />} onClick={onExamples}>
            See the examples
          </Button>
        }
      />
      {UPLOADS_OPEN && <PilotDialog open={pilot} onClose={() => setPilot(false)} />}
    </Box>
  );
}

const toTheExamples = () => document.getElementById('showcase-parts')?.scrollIntoView({ behavior: 'smooth', block: 'center' });

/**
 * The page's way in: what Jigged does with a part, the example shop it's shown in, then the choice
 * of the visitor's own part or one of ours, and ours across the page.
 */
export default function Intro({ cat, parts, onPick, onMachine }: { cat: Catalog; parts: LivePart[]; onPick(id: string, source: PickSource): void; onMachine(id: string): void }) {
  return (
    <>
      <Section grid size="minor" sx={{ pt: { xs: 6, md: 8 }, pb: { xs: 4, md: 5 } }}>
        <Box sx={{ maxWidth: 760, mx: 'auto', textAlign: 'center' }}>
          <Typography component="span" sx={{ ...eyebrowSx, color: EYEBROW_COLOR }}>
            Research preview
          </Typography>
          <Typography component="h1" sx={{ mt: 2, fontFamily: DISPLAY_FONT, fontWeight: 600, fontSize: 'clamp(2.1rem, 4vw, 3.2rem)', lineHeight: 1.05, letterSpacing: '-0.03em', textWrap: 'balance' }}>
            Upload a part. Get its instructions for your shop.
          </Typography>
          <Typography sx={{ mt: 2.5, color: 'rgba(255, 255, 255, 0.8)', fontSize: { xs: '1.05rem', md: '1.15rem' }, lineHeight: 1.6, textWrap: 'balance' }}>
            Jigged plans a part for the machines you have, then shows every step being done, at the machine and with the tools it needs.
            Try it on an example shop and parts we&apos;ve already run through it.
          </Typography>
        </Box>
        <ShopBlock cat={cat} onMachine={onMachine} />
        <Choices onExamples={toTheExamples} />
      </Section>
      <Box id="showcase-parts" sx={{ pb: { xs: 5, md: 7 } }}>
        <Carousel label="Example parts">
          {parts.map((p) => (
            <PartSlide key={p.id} part={p} onPick={() => onPick(p.id, 'intro')} />
          ))}
        </Carousel>
      </Box>
    </>
  );
}
