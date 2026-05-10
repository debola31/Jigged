'use client';

import Chip from '@mui/material/Chip';
import Stack from '@mui/material/Stack';
import type { Part } from '@/types/part';

interface PartClassificationChipsProps {
  part: Pick<Part, 'source' | 'is_stocked'>;
}

/**
 * Two-chip classification display for a part: source (Made / Bought) and
 * an optional Stocked indicator. Replaces the four-way derived PartKind
 * chip — the schema only carries source and is_stocked, and that is what
 * the UI now reflects directly.
 *
 * Visual treatment matches StockStatusChip and the prior PartTypeChip
 * styling (chunk 19 redesign): outlined, transparent background, no icon,
 * accent colour on text and border. A future cleanup PR can move both
 * chip families to theme palette tokens.
 */
export default function PartClassificationChips({ part }: PartClassificationChipsProps) {
  const baseSx = {
    fontWeight: 500,
    letterSpacing: 0.2,
    bgcolor: 'transparent',
    border: '1px solid',
  } as const;

  const sourceColour =
    part.source === 'made'
      ? { color: '#90caf9', borderColor: 'rgba(144, 202, 249, 0.5)' }
      : { color: '#a5d6a7', borderColor: 'rgba(165, 214, 167, 0.5)' };

  return (
    <Stack direction="row" spacing={1} alignItems="center">
      <Chip
        label={part.source === 'made' ? 'Made' : 'Bought'}
        size="small"
        variant="outlined"
        sx={{ ...baseSx, ...sourceColour }}
      />
      {part.is_stocked && (
        <Chip
          label="Stocked"
          size="small"
          variant="outlined"
          sx={{
            ...baseSx,
            color: '#b39ddb',
            borderColor: 'rgba(179, 157, 219, 0.5)',
          }}
        />
      )}
    </Stack>
  );
}
