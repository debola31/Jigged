'use client';

import Box from '@mui/material/Box';
import ButtonBase from '@mui/material/ButtonBase';
import Typography from '@mui/material/Typography';
import { BRAND } from '@/components/marketing/marketingStyles';
import { playable, type Part } from './showcaseData';

const cardSx = {
  flex: '0 0 auto',
  minHeight: 96,
  p: 2,
  borderRadius: 2,
  textAlign: 'left',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  gap: 1,
  bgcolor: 'rgba(17, 20, 57, 0.55)',
  border: '1px solid rgba(255, 255, 255, 0.1)',
} as const;

function status(p: Part): string {
  if (p.status === 'coming') return 'Coming soon';
  const ready = p.steps.filter(playable).length;
  return ready === p.steps.length ? 'Ready to watch' : `Steps ready, videos coming (${ready} of ${p.steps.length})`;
}

/**
 * All 20 parts. A live part is a button; the others stay visible and say they're coming rather
 * than sitting there disabled. On a phone the row scrolls sideways instead of shrinking its cards.
 */
export default function PartPicker({
  parts,
  selected,
  onSelect,
}: {
  parts: Part[];
  selected: string;
  onSelect(id: string): void;
}) {
  return (
    <Box
      component="ul"
      aria-label="Parts"
      sx={{
        listStyle: 'none',
        m: 0,
        p: 0,
        display: { xs: 'flex', md: 'grid' },
        gridTemplateColumns: { md: 'repeat(4, minmax(0, 1fr))', lg: 'repeat(5, minmax(0, 1fr))' },
        gap: 1.5,
        overflowX: { xs: 'auto', md: 'visible' },
        pb: { xs: 1, md: 0 },
      }}
    >
      {parts.map((p) => {
        const body = (
          <>
            <Typography sx={{ fontWeight: 600, lineHeight: 1.3, fontSize: '0.98rem' }}>{p.name}</Typography>
            <Box sx={{ display: 'flex', gap: 1, alignItems: 'baseline', flexWrap: 'wrap' }}>
              <Typography
                component="span"
                sx={{ fontSize: '0.8rem', fontWeight: 600, color: p.status === 'live' ? BRAND.teal : 'text.secondary' }}
              >
                {status(p)}
              </Typography>
              <Typography component="span" sx={{ fontSize: '0.8rem', color: 'text.secondary' }}>
                {p.size}
              </Typography>
            </Box>
          </>
        );
        return (
          <Box component="li" key={p.id} sx={{ display: 'flex' }}>
            {p.status === 'live' ? (
              <ButtonBase
                onClick={() => onSelect(p.id)}
                aria-pressed={selected === p.id}
                sx={{
                  ...cardSx,
                  width: { xs: 240, md: '100%' },
                  borderColor: selected === p.id ? BRAND.amber : 'rgba(255, 255, 255, 0.1)',
                  '&:hover': { borderColor: BRAND.amber },
                  '&.Mui-focusVisible': { outline: `2px solid ${BRAND.steelLight}`, outlineOffset: 2 },
                }}
              >
                {body}
              </ButtonBase>
            ) : (
              <Box sx={{ ...cardSx, width: { xs: 240, md: '100%' } }}>{body}</Box>
            )}
          </Box>
        );
      })}
    </Box>
  );
}
