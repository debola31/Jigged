'use client';

import { useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import IconButton from '@mui/material/IconButton';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Typography from '@mui/material/Typography';
import CloseIcon from '@mui/icons-material/Close';
import UploadFileOutlinedIcon from '@mui/icons-material/UploadFileOutlined';
import Section from '@/components/marketing/Section';
import { DISPLAY_FONT, EYEBROW_COLOR, eyebrowSx } from '@/components/marketing/marketingStyles';
import PilotRequest from './PilotRequest';
import { mediaUrl, ready, type LivePart } from './showcaseData';
import { useShowcase, type Layout } from './store';

const cardSx = {
  display: 'flex',
  flexDirection: 'column',
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

function PartCard({ part, onPick }: { part: LivePart; onPick(): void }) {
  const still = finishedStill(part);
  const setups = part.groups.filter((g) => g.id !== 'finish').length;
  return (
    <Box sx={cardSx}>
      <Box sx={{ aspectRatio: '16 / 9', bgcolor: 'common.black' }}>
        {still && <Box component="img" src={still} alt={`${part.name}, finished`} sx={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />}
      </Box>
      <Box sx={{ p: 2.5, display: 'flex', flexDirection: 'column', gap: 1, flex: 1 }}>
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
    </Box>
  );
}

function OwnPartCard() {
  const [open, setOpen] = useState(false);
  return (
    <Box sx={{ ...cardSx, borderStyle: 'dashed', justifyContent: 'center', p: 3, gap: 1.5 }}>
      <UploadFileOutlinedIcon sx={{ fontSize: 40, color: EYEBROW_COLOR }} />
      <Typography component="h3" sx={{ fontFamily: DISPLAY_FONT, fontWeight: 600, fontSize: '1.2rem' }}>
        Your own part
      </Typography>
      <Typography sx={{ color: 'text.secondary', fontSize: '0.95rem', lineHeight: 1.55 }}>
        Send us a STEP, IGES, Parasolid or SolidWorks file, or a PDF drawing, and we&apos;ll make its walkthrough for your shop.
      </Typography>
      <Button variant="outlined" size="large" onClick={() => setOpen(true)} sx={{ alignSelf: 'flex-start' }}>
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

/**
 * Temporary, for the review only: the user is choosing between the two shop layouts (2026-11-04).
 * Remove it, and the layout not chosen, once they have.
 */
function LayoutChoice() {
  const layout = useShowcase((s) => s.layout);
  const setLayout = useShowcase((s) => s.setLayout);
  return (
    <Box sx={{ mt: 5, display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap', p: 1.5, borderRadius: 1.5, border: '1px dashed rgba(255, 255, 255, 0.25)', width: 'fit-content' }}>
      <Typography sx={{ color: 'text.secondary', fontSize: '0.9rem' }}>For review only: the shop&apos;s layout</Typography>
      <ToggleButtonGroup size="small" exclusive value={layout} onChange={(_, v: Layout | null) => v && setLayout(v)}>
        <ToggleButton value="cards">Cards over the shop</ToggleButton>
        <ToggleButton value="rail">One side rail</ToggleButton>
      </ToggleButtonGroup>
    </Box>
  );
}

/** The research, in a few lines, and the parts to pick from: ours, or the visitor's own. */
export default function Intro({ parts, onPick }: { parts: LivePart[]; onPick(id: string): void }) {
  return (
    <Section grid size="minor" sx={{ pt: { xs: 6, md: 8 } }}>
      <Typography component="span" sx={{ ...eyebrowSx, color: EYEBROW_COLOR }}>
        Research preview
      </Typography>
      <Typography component="h1" sx={{ mt: 2, fontFamily: DISPLAY_FONT, fontWeight: 600, fontSize: 'clamp(2.1rem, 4.5vw, 3.4rem)', lineHeight: 1.05, letterSpacing: '-0.03em', maxWidth: 820 }}>
        Pick a part. Watch every step of making it.
      </Typography>
      <Typography sx={{ mt: 2.5, maxWidth: 680, color: 'rgba(255, 255, 255, 0.8)', fontSize: { xs: '1.05rem', md: '1.15rem' }, lineHeight: 1.6 }}>
        Jigged plans the part for a real shop&apos;s machines, then shows each step being done, at the machine and with the
        tools it needs. The shop and the hands are simulated.
      </Typography>
      <Box sx={{ mt: 5, display: 'grid', gap: 3, gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, minmax(0, 1fr))', lg: 'repeat(3, minmax(0, 1fr))' } }}>
        {parts.map((p) => (
          <PartCard key={p.id} part={p} onPick={() => onPick(p.id)} />
        ))}
        <OwnPartCard />
      </Box>
      <LayoutChoice />
    </Section>
  );
}
