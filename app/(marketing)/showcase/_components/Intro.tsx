'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import ButtonBase from '@mui/material/ButtonBase';
import IconButton from '@mui/material/IconButton';
import Typography from '@mui/material/Typography';
import { useTheme } from '@mui/material/styles';
import ArrowDownwardIcon from '@mui/icons-material/ArrowDownward';
import ArrowForwardIcon from '@mui/icons-material/ArrowForward';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import PlayCircleIcon from '@mui/icons-material/PlayCircle';
import PlayCircleOutlineIcon from '@mui/icons-material/PlayCircleOutline';
import PrecisionManufacturingOutlinedIcon from '@mui/icons-material/PrecisionManufacturingOutlined';
import UploadFileOutlinedIcon from '@mui/icons-material/UploadFileOutlined';
import Section from '@/components/marketing/Section';
import { BRAND_GRADIENT, DISPLAY_FONT, EYEBROW_COLOR, eyebrowSx, gradientButtonSx } from '@/components/marketing/marketingStyles';
import { PartFacts, shortName } from './glyphs';
import { PilotDialog, UPLOADS_OPEN, type PickSource } from './PartChoice';
import { finishedStill, type LivePart } from './showcaseData';

const slideSx = {
  flex: '0 0 auto',
  scrollSnapAlign: 'start',
  borderRadius: 2,
  overflow: 'hidden',
  border: '1px solid rgba(255, 255, 255, 0.12)',
  bgcolor: 'rgba(17, 20, 57, 0.7)',
} as const;

// A card that says what it is rather than showing a part: narrower, centred, no picture.
const signSx = { ...slideSx, width: { xs: '60%', sm: 230 }, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 1.5, p: 2.5, textAlign: 'center' } as const;

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

/** The visitor's own part, first: the site's gradient call to action, opening the interest form (PartChoice.tsx). */
function OwnPart() {
  const [open, setOpen] = useState(false);
  return (
    <Box component="article" sx={{ ...signSx, borderStyle: 'dashed', bgcolor: 'transparent' }}>
      <UploadFileOutlinedIcon sx={{ fontSize: 44, color: EYEBROW_COLOR }} />
      <Typography component="h3" sx={{ fontWeight: 600, fontSize: '1.1rem' }}>
        Upload your part
      </Typography>
      <Typography sx={{ color: 'text.secondary', fontSize: '0.9rem' }}>A CAD file or drawing.</Typography>
      {UPLOADS_OPEN ? (
        <>
          <Button variant="contained" onClick={() => setOpen(true)} sx={gradientButtonSx}>
            Upload a part
          </Button>
          <PilotDialog open={open} onClose={() => setOpen(false)} />
        </>
      ) : (
        // In the gradient, as the site's other "Request access" buttons, but not pressable yet.
        <Button variant="contained" disabled sx={{ ...gradientButtonSx, '&.Mui-disabled': { background: BRAND_GRADIENT, color: 'common.white', opacity: 0.8 } }}>
          Coming soon
        </Button>
      )}
    </Box>
  );
}

/** Where ours begin: a sign, not a part, pointing along the row. */
function ExamplesSign() {
  return (
    <Box component="article" sx={signSx}>
      <PlayCircleOutlineIcon sx={{ fontSize: 44, color: EYEBROW_COLOR }} />
      <Typography component="h3" sx={{ fontWeight: 600, fontSize: '1.1rem' }}>
        Select an example part
      </Typography>
      <Typography sx={{ color: 'text.secondary', fontSize: '0.9rem' }}>Parts already run through this shop.</Typography>
      <ArrowForwardIcon aria-hidden sx={{ color: EYEBROW_COLOR }} />
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
    <Box component="section" aria-label={label} sx={{ position: 'relative' }}>
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
  );
}

/** Down to the parts, under the shop: where a part is uploaded or an example picked. */
export const toTheParts = () => document.getElementById('showcase-parts')?.scrollIntoView({ behavior: 'smooth', block: 'center' });

/** What Jigged does with a part, above the example shop, and the way down to the parts. */
export default function Intro() {
  return (
    <Section grid size="minor" sx={{ pt: { xs: 6, md: 8 }, pb: { xs: 4, md: 5 } }}>
      <Box sx={{ maxWidth: 820, mx: 'auto', textAlign: 'center' }}>
        <Typography component="span" sx={{ ...eyebrowSx, color: EYEBROW_COLOR }}>
          Research preview
        </Typography>
        <Typography component="h1" sx={{ mt: 2, fontFamily: DISPLAY_FONT, fontWeight: 600, fontSize: 'clamp(2.1rem, 4vw, 3.2rem)', lineHeight: 1.05, letterSpacing: '-0.03em', textWrap: 'balance' }}>
          Upload a part, get manufacturing instructions
        </Typography>
        <Typography sx={{ mt: 2.5, color: 'rgba(255, 255, 255, 0.8)', fontSize: { xs: '1.05rem', md: '1.15rem' }, lineHeight: 1.6, textWrap: 'balance' }}>
          Jigged plans each part for the machines and tools you have, then shows every step being done. Try it on the example shop below.
        </Typography>
        <Button id="showcase-hero-cta" variant="contained" size="large" endIcon={<ArrowDownwardIcon />} onClick={toTheParts} sx={{ ...gradientButtonSx, mt: 3.5, px: 3 }}>
          Upload or try a part
        </Button>
      </Box>
    </Section>
  );
}

/** Under the shop, one row across the page: the visitor's own part, then a sign, then ours to try. */
export function PartsRow({ parts, onPick }: { parts: LivePart[]; onPick(id: string, source: PickSource): void }) {
  return (
    <Box id="showcase-parts" sx={{ py: { xs: 5, md: 6 } }}>
      <Carousel label="Your part, or an example">
        <OwnPart />
        <ExamplesSign />
        {parts.map((p) => (
          <PartSlide key={p.id} part={p} onPick={() => onPick(p.id, 'intro')} />
        ))}
      </Carousel>
    </Box>
  );
}
