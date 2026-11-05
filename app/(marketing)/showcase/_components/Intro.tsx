'use client';

import { useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import IconButton from '@mui/material/IconButton';
import Typography from '@mui/material/Typography';
import CloseIcon from '@mui/icons-material/Close';
import UploadFileOutlinedIcon from '@mui/icons-material/UploadFileOutlined';
import Section from '@/components/marketing/Section';
import { DISPLAY_FONT, EYEBROW_COLOR, eyebrowSx } from '@/components/marketing/marketingStyles';
import PilotRequest from './PilotRequest';
import { mediaUrl, ready, type LivePart } from './showcaseData';

const cardSx = {
  display: 'flex',
  borderRadius: 2,
  overflow: 'hidden',
  border: '1px solid rgba(255, 255, 255, 0.12)',
  bgcolor: 'rgba(17, 20, 57, 0.7)',
} as const;

/** The part as its last cut leaves it: the newest published still of a machine cycle. */
function finishedStill(part: LivePart): string | null {
  const cut = [...part.steps].reverse().find((s) => s.media.type === 'cut' && ready(s));
  return cut && cut.media.type === 'cut' ? mediaUrl(cut.media.still) : null;
}

/** One of our parts: what it is on the left, the part itself on the right. */
function PartCard({ part, onPick }: { part: LivePart; onPick(): void }) {
  const still = finishedStill(part);
  const setups = part.groups.filter((g) => g.id !== 'finish').length;
  return (
    <Box sx={cardSx}>
      <Box sx={{ p: 2.5, display: 'flex', flexDirection: 'column', gap: 1, flex: 1, minWidth: 0 }}>
        <Typography component="h3" sx={{ fontFamily: DISPLAY_FONT, fontWeight: 600, fontSize: '1.2rem', lineHeight: 1.2 }}>
          {part.name}
        </Typography>
        <Typography sx={{ color: 'text.secondary', fontSize: '0.95rem' }}>
          {part.stock.material} · {part.stock.size} in · {setups} {setups === 1 ? 'setup' : 'setups'} · {part.steps.length} steps
        </Typography>
        <Button variant="contained" size="large" onClick={onPick} sx={{ mt: 'auto', alignSelf: 'flex-start' }}>
          Make this part
        </Button>
      </Box>
      {/* Until one of its cuts is published there is no picture of the part, and an empty frame reads as broken. */}
      {still && (
        <Box sx={{ position: 'relative', width: '46%', flexShrink: 0, minHeight: { xs: 140, md: 170 }, bgcolor: 'common.black' }}>
          <Box component="img" src={still} alt={`${part.name}, finished`} sx={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} />
        </Box>
      )}
    </Box>
  );
}

/** The visitor's own part: one line, since it has nothing to show yet. */
function OwnPart() {
  const [open, setOpen] = useState(false);
  return (
    <Box sx={{ ...cardSx, borderStyle: 'dashed', alignItems: 'center', gap: 2, px: 2.5, py: 2, flexWrap: { xs: 'wrap', sm: 'nowrap' } }}>
      <UploadFileOutlinedIcon sx={{ fontSize: 32, color: EYEBROW_COLOR }} />
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography component="h3" sx={{ fontWeight: 600 }}>
          Your own part
        </Typography>
        <Typography sx={{ color: 'text.secondary', fontSize: '0.9rem', lineHeight: 1.5 }}>
          Send a STEP, IGES, Parasolid or SolidWorks file, or a PDF drawing, and we&apos;ll make its walkthrough for your shop.
        </Typography>
      </Box>
      <Button variant="outlined" onClick={() => setOpen(true)} sx={{ flexShrink: 0 }}>
        Send a part
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} maxWidth="sm" fullWidth>
        <Box sx={{ position: 'relative' }}>
          <IconButton onClick={() => setOpen(false)} aria-label="Close" sx={{ position: 'absolute', top: 8, right: 8, zIndex: 1 }}>
            <CloseIcon />
          </IconButton>
          <PilotRequest />
        </Box>
      </Dialog>
    </Box>
  );
}

/** The research, in a few lines, beside the parts to pick from: ours, or the visitor's own. */
export default function Intro({ parts, onPick }: { parts: LivePart[]; onPick(id: string): void }) {
  return (
    <Section grid size="minor" sx={{ pt: { xs: 6, md: 8 } }}>
      <Box sx={{ display: 'grid', gap: { xs: 5, md: 6 }, gridTemplateColumns: { md: 'minmax(0, 5fr) minmax(0, 7fr)' }, alignItems: 'start' }}>
        {/* Stays in view beside a long list of parts. */}
        <Box sx={{ position: { md: 'sticky' }, top: { md: 96 } }}>
          <Typography component="span" sx={{ ...eyebrowSx, color: EYEBROW_COLOR }}>
            Research preview
          </Typography>
          <Typography component="h1" sx={{ mt: 2, fontFamily: DISPLAY_FONT, fontWeight: 600, fontSize: 'clamp(2.1rem, 3.6vw, 3rem)', lineHeight: 1.05, letterSpacing: '-0.03em', textWrap: 'balance' }}>
            Pick a part. Watch every step of making it.
          </Typography>
          <Typography sx={{ mt: 2.5, color: 'rgba(255, 255, 255, 0.8)', fontSize: { xs: '1.05rem', md: '1.15rem' }, lineHeight: 1.6 }}>
            Jigged plans the part for a real shop&apos;s machines, then shows each step being done, at the machine and with the
            tools it needs. The shop and the hands are simulated.
          </Typography>
        </Box>
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {parts.map((p) => (
            <PartCard key={p.id} part={p} onPick={() => onPick(p.id)} />
          ))}
          <OwnPart />
        </Box>
      </Box>
    </Section>
  );
}
