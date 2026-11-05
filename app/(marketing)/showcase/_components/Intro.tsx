'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import ButtonBase from '@mui/material/ButtonBase';
import IconButton from '@mui/material/IconButton';
import Typography from '@mui/material/Typography';
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

/** A row that scrolls sideways a slide at a time, with arrows while there is more to see. */
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
    const seen = new ResizeObserver(measure);
    seen.observe(el);
    return () => seen.disconnect();
  }, [measure]);
  const go = (dir: 1 | -1) => track.current?.scrollBy({ left: dir * track.current.clientWidth * 0.8, behavior: 'smooth' });
  return (
    <Box component="section" aria-label={label}>
      <Box sx={{ display: 'flex', alignItems: 'center', mb: 2 }}>
        <Typography component="h2" sx={{ ...eyebrowSx, color: EYEBROW_COLOR, flex: 1 }}>
          {label}
        </Typography>
        <IconButton aria-label="Previous parts" disabled={edges.start} onClick={() => go(-1)}>
          <ChevronLeftIcon />
        </IconButton>
        <IconButton aria-label="More parts" disabled={edges.end} onClick={() => go(1)}>
          <ChevronRightIcon />
        </IconButton>
      </Box>
      <Box
        ref={track}
        onScroll={measure}
        sx={{ display: 'flex', gap: 2, overflowX: 'auto', scrollSnapType: 'x mandatory', scrollbarWidth: 'none', '&::-webkit-scrollbar': { display: 'none' }, pt: 0.5, pb: 1 }}
      >
        {children}
      </Box>
    </Box>
  );
}

/** The research in a few lines, then the parts to pick from in a carousel: ours, then the visitor's own. */
export default function Intro({ parts, onPick }: { parts: LivePart[]; onPick(id: string, source: PickSource): void }) {
  return (
    <Section grid size="minor" sx={{ pt: { xs: 6, md: 8 } }}>
      <Box sx={{ maxWidth: 760 }}>
        <Typography component="span" sx={{ ...eyebrowSx, color: EYEBROW_COLOR }}>
          Research preview
        </Typography>
        <Typography component="h1" sx={{ mt: 2, fontFamily: DISPLAY_FONT, fontWeight: 600, fontSize: 'clamp(2.1rem, 4vw, 3.2rem)', lineHeight: 1.05, letterSpacing: '-0.03em', textWrap: 'balance' }}>
          Pick a part. Watch every step of making it.
        </Typography>
        <Typography sx={{ mt: 2.5, color: 'rgba(255, 255, 255, 0.8)', fontSize: { xs: '1.05rem', md: '1.15rem' }, lineHeight: 1.6 }}>
          Jigged plans the part for a real shop&apos;s machines, then shows each step being done, at the machine and with the tools it
          needs. The shop and the hands are simulated.
        </Typography>
      </Box>
      <Box sx={{ mt: { xs: 5, md: 6 } }}>
        <Carousel label="Pick a part">
          {parts.map((p) => (
            <PartSlide key={p.id} part={p} onPick={() => onPick(p.id, 'intro')} />
          ))}
          <OwnPart />
        </Carousel>
      </Box>
    </Section>
  );
}
