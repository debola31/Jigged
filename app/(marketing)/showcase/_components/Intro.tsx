'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import ButtonBase from '@mui/material/ButtonBase';
import IconButton from '@mui/material/IconButton';
import Typography from '@mui/material/Typography';
import { useTheme } from '@mui/material/styles';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import PlayCircleIcon from '@mui/icons-material/PlayCircle';
import PrecisionManufacturingOutlinedIcon from '@mui/icons-material/PrecisionManufacturingOutlined';
import UploadFileOutlinedIcon from '@mui/icons-material/UploadFileOutlined';
import Section from '@/components/marketing/Section';
import { DISPLAY_FONT, EYEBROW_COLOR, eyebrowSx } from '@/components/marketing/marketingStyles';
import { PartFacts, shortName } from './glyphs';
import { PilotDialog, type PickSource } from './PartChoice';
import { finishedStill, type LivePart } from './showcaseData';

const slideSx = {
  flex: '0 0 auto',
  scrollSnapAlign: 'start',
  borderRadius: 2,
  overflow: 'hidden',
  border: '1px solid rgba(255, 255, 255, 0.12)',
  bgcolor: 'rgba(17, 20, 57, 0.7)',
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

/** The visitor's own part, last and narrower: it has nothing to show yet. */
function OwnPart() {
  const [open, setOpen] = useState(false);
  return (
    <Box component="article" sx={{ ...slideSx, width: { xs: '60%', sm: 230 }, borderStyle: 'dashed', bgcolor: 'transparent', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 1.5, p: 2.5, textAlign: 'center' }}>
      <UploadFileOutlinedIcon sx={{ fontSize: 44, color: EYEBROW_COLOR }} />
      <Typography component="h3" sx={{ fontWeight: 600, fontSize: '1.1rem' }}>
        Your own part
      </Typography>
      <Typography sx={{ color: 'text.secondary', fontSize: '0.9rem', lineHeight: 1.45 }}>A CAD file or drawing. We&apos;ll make its walkthrough.</Typography>
      <Button variant="outlined" onClick={() => setOpen(true)}>
        Send a part
      </Button>
      <PilotDialog open={open} onClose={() => setOpen(false)} />
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

/** The research in a few lines, in the middle, then the parts to pick from across the page: ours, then the visitor's own. */
export default function Intro({ parts, onPick }: { parts: LivePart[]; onPick(id: string, source: PickSource): void }) {
  return (
    <>
      <Section grid size="minor" sx={{ pt: { xs: 6, md: 8 }, pb: { xs: 4, md: 5 } }}>
        <Box sx={{ maxWidth: 760, mx: 'auto', textAlign: 'center' }}>
          <Typography component="span" sx={{ ...eyebrowSx, color: EYEBROW_COLOR }}>
            Research preview
          </Typography>
          <Typography component="h1" sx={{ mt: 2, fontFamily: DISPLAY_FONT, fontWeight: 600, fontSize: 'clamp(2.1rem, 4vw, 3.2rem)', lineHeight: 1.05, letterSpacing: '-0.03em', textWrap: 'balance' }}>
            Pick a part. Watch every step of making it.
          </Typography>
          <Typography sx={{ mt: 2.5, color: 'rgba(255, 255, 255, 0.8)', fontSize: { xs: '1.05rem', md: '1.15rem' }, lineHeight: 1.6, textWrap: 'balance' }}>
            Jigged plans the part for a real shop&apos;s machines, then shows each step being done, at the machine and with the tools it
            needs. The shop and the hands are simulated.
          </Typography>
        </Box>
      </Section>
      <Box id="showcase-parts" sx={{ pb: { xs: 5, md: 7 } }}>
        <Carousel label="Pick a part">
          {parts.map((p) => (
            <PartSlide key={p.id} part={p} onPick={() => onPick(p.id, 'intro')} />
          ))}
          <OwnPart />
        </Carousel>
      </Box>
    </>
  );
}
