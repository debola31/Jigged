'use client';

import { useEffect, useRef, useState } from 'react';
import * as Sentry from '@sentry/nextjs';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemText from '@mui/material/ListItemText';
import ListSubheader from '@mui/material/ListSubheader';
import Typography from '@mui/material/Typography';
import { DISPLAY_FONT, EYEBROW_COLOR } from '@/components/marketing/marketingStyles';
import { mediaUrl, type LivePart } from './showcaseData';

/**
 * One step at a time: its video, the plan's title and caption, and previous / next. The video
 * plays once the visitor has picked a step, never on page load. Playback is the only control:
 * nothing a visitor does changes the simulation.
 */
export function StepPlayer({
  part,
  index,
  autoPlay,
  onSelect,
}: {
  part: LivePart;
  index: number;
  autoPlay: boolean;
  onSelect(index: number): void;
}) {
  const step = part.steps[index];
  const group = part.groups.find((g) => g.id === step.group);
  const [failed, setFailed] = useState<string | null>(null);
  const reported = useRef(false);

  return (
    <Box>
      <Box sx={{ position: 'relative', aspectRatio: '16 / 9', borderRadius: 2, overflow: 'hidden', bgcolor: 'common.black' }}>
        <Box
          component="video"
          key={step.id}
          src={mediaUrl(step.video)}
          controls
          muted
          playsInline
          preload="metadata"
          autoPlay={autoPlay}
          aria-label={`Video: ${step.title}`}
          onError={() => {
            setFailed(step.id);
            if (!reported.current) {
              reported.current = true;
              Sentry.captureException(new Error(`Showcase: the video for ${part.id} ${step.id} failed to load`));
            }
          }}
          sx={{ width: '100%', height: '100%', display: 'block' }}
        />
        {failed === step.id && (
          <Typography
            role="status"
            sx={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', p: 3, textAlign: 'center', color: 'text.secondary' }}
          >
            This step&apos;s video couldn&apos;t be loaded. Its title and caption are below.
          </Typography>
        )}
      </Box>

      <Box sx={{ mt: 3 }} aria-live="polite">
        <Typography sx={{ color: EYEBROW_COLOR, fontWeight: 600, fontSize: '0.9rem', letterSpacing: '0.04em' }}>
          Step {index + 1} of {part.steps.length}
          {group && ` · ${group.title}`}
        </Typography>
        <Box sx={{ mt: 1, display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap' }}>
          <Typography component="h3" sx={{ fontFamily: DISPLAY_FONT, fontWeight: 600, fontSize: { xs: '1.5rem', md: '1.9rem' }, lineHeight: 1.15 }}>
            {step.title}
          </Typography>
          {step.kind === 'cycle' && <Chip label="Machine cycle" size="small" variant="outlined" />}
        </Box>
        <Typography sx={{ mt: 1.5, fontSize: { xs: '1.05rem', md: '1.15rem' }, lineHeight: 1.6, color: 'rgba(255, 255, 255, 0.85)' }}>
          {step.caption}
        </Typography>
      </Box>

      <Box sx={{ mt: 3, display: 'flex', gap: 1.5 }}>
        <Button variant="outlined" disabled={index === 0} onClick={() => onSelect(index - 1)}>
          Previous step
        </Button>
        <Button variant="contained" disabled={index === part.steps.length - 1} onClick={() => onSelect(index + 1)}>
          Next step
        </Button>
      </Box>
    </Box>
  );
}

/** Every step of the part, grouped by setup, in a box that scrolls on its own. */
export function StepList({ part, index, onSelect }: { part: LivePart; index: number; onSelect(index: number): void }) {
  const box = useRef<HTMLDivElement>(null);
  const current = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Keep the current step in view inside the list, without scrolling the page. Measured against
    // the box, since each group's List is its own offsetParent.
    const b = box.current;
    const c = current.current;
    if (!b || !c) return;
    const top = c.getBoundingClientRect().top - b.getBoundingClientRect().top + b.scrollTop;
    if (top < b.scrollTop + 48 || top + c.offsetHeight > b.scrollTop + b.clientHeight) {
      b.scrollTop = top - b.clientHeight / 3;
    }
  }, [index]);

  return (
    <Box
      ref={box}
      sx={{
        position: 'relative',
        maxHeight: '60vh',
        overflowY: 'auto',
        borderRadius: 2,
        border: '1px solid rgba(255, 255, 255, 0.1)',
        bgcolor: 'rgba(17, 20, 57, 0.55)',
      }}
    >
      {part.groups.map((g) => (
        <List
          key={g.id}
          dense
          disablePadding
          subheader={
            <ListSubheader sx={{ bgcolor: 'rgba(17, 20, 57, 0.97)', color: 'text.secondary', fontWeight: 600, lineHeight: 2.6 }}>
              {g.title}
            </ListSubheader>
          }
        >
          {part.steps.map((s, i) =>
            s.group !== g.id ? null : (
              <ListItemButton
                key={s.id}
                ref={i === index ? current : undefined}
                selected={i === index}
                aria-current={i === index ? 'step' : undefined}
                onClick={() => onSelect(i)}
              >
                <ListItemText
                  primary={`${i + 1}. ${s.title}`}
                  secondary={s.kind === 'cycle' ? 'Machine cycle' : undefined}
                  slotProps={{ primary: { sx: { fontSize: '0.98rem' } } }}
                />
              </ListItemButton>
            ),
          )}
        </List>
      ))}
    </Box>
  );
}
