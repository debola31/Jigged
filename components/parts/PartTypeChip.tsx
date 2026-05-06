'use client';

import Chip from '@mui/material/Chip';
import type { ChipProps } from '@mui/material/Chip';
import BuildIcon from '@mui/icons-material/Build';
import LayersIcon from '@mui/icons-material/Layers';
import Inventory2Icon from '@mui/icons-material/Inventory2';
import LocalShippingIcon from '@mui/icons-material/LocalShipping';
import type { PartKind } from '@/types/part';
import { assertNeverPartKind } from '@/types/part';

interface PartTypeChipProps {
  kind: PartKind;
  size?: ChipProps['size'];
}

/**
 * Single source of visual truth for the part-classification chip used in the
 * parts list and the search-first add flow. One chip per row, mutually
 * exclusive, derived from (source, is_stocked).
 *
 * - Custom Made:  primary blue. Built to order; will have a routing.
 * - Sub-assembly: indigo (the special case — both made AND consumed/stocked).
 * - Raw Material: green. Vendor stock kept on hand.
 * - Service:      gray, low-emphasis. Drop-ship items and outside services.
 *
 * Exhaustive over PartKind — there is no Unclassified chip. The orphan
 * (false, false) quadrant from the old boolean model was removed by the
 * 20260504 source-enum migration.
 */
export default function PartTypeChip({ kind, size = 'small' }: PartTypeChipProps) {
  switch (kind) {
    case 'custom_made':
      return (
        <Chip
          icon={<BuildIcon />}
          label="Custom Made"
          size={size}
          sx={{
            fontWeight: 600,
            bgcolor: 'info.dark',
            color: 'common.white',
            '& .MuiChip-icon': { color: 'common.white' },
          }}
        />
      );
    case 'sub_assembly':
      return (
        <Chip
          icon={<LayersIcon />}
          label="Sub-assembly"
          size={size}
          sx={{
            fontWeight: 600,
            // Indigo / purple — visually distinct from Custom Made and Raw
            // Material to make the special "made AND stocked" case
            // immediately recognizable on the parts list.
            bgcolor: '#5e35b1',
            color: 'common.white',
            '& .MuiChip-icon': { color: 'common.white' },
          }}
        />
      );
    case 'raw_material':
      return (
        <Chip
          icon={<Inventory2Icon />}
          label="Raw Material"
          size={size}
          sx={{
            fontWeight: 600,
            bgcolor: 'success.dark',
            color: 'common.white',
            '& .MuiChip-icon': { color: 'common.white' },
          }}
        />
      );
    case 'service':
      return (
        <Chip
          icon={<LocalShippingIcon />}
          label="Service"
          size={size}
          variant="outlined"
          sx={{
            fontWeight: 500,
            color: 'text.secondary',
            borderColor: 'divider',
            '& .MuiChip-icon': { color: 'text.secondary' },
          }}
        />
      );
    default:
      return assertNeverPartKind(kind);
  }
}
