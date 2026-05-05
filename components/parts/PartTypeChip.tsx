'use client';

import Chip from '@mui/material/Chip';
import type { ChipProps } from '@mui/material/Chip';
import PrecisionManufacturingIcon from '@mui/icons-material/PrecisionManufacturing';
import Inventory2Icon from '@mui/icons-material/Inventory2';
import LayersIcon from '@mui/icons-material/Layers';
import HelpOutlineIcon from '@mui/icons-material/HelpOutline';
import type { PartKind } from '@/types/part';

interface PartTypeChipProps {
  kind: PartKind;
  size?: ChipProps['size'];
}

/**
 * Single source of visual truth for the part-classification chip used in the
 * parts list and the search-first add flow. One chip per row, mutually
 * exclusive, derived from the (is_manufacturable, is_stockable) pair.
 *
 * - Manufactured: blue. The shop makes this in-house.
 * - Inventory: green. Stocked / purchased item.
 * - Sub-assembly: indigo. Both made AND consumed in another part's BOM —
 *   visually distinct so it's obvious at a glance.
 * - Unclassified: gray, de-emphasized. Neither flag set; usually historical
 *   hand-created rows that haven't been classified yet.
 */
export default function PartTypeChip({ kind, size = 'small' }: PartTypeChipProps) {
  switch (kind) {
    case 'manufactured':
      return (
        <Chip
          icon={<PrecisionManufacturingIcon />}
          label="Manufactured"
          size={size}
          sx={{
            fontWeight: 600,
            bgcolor: 'info.dark',
            color: 'common.white',
            '& .MuiChip-icon': { color: 'common.white' },
          }}
        />
      );
    case 'inventory':
      return (
        <Chip
          icon={<Inventory2Icon />}
          label="Inventory"
          size={size}
          sx={{
            fontWeight: 600,
            bgcolor: 'success.dark',
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
            // Indigo / purple — distinct from both Manufactured and Inventory
            bgcolor: '#5e35b1',
            color: 'common.white',
            '& .MuiChip-icon': { color: 'common.white' },
          }}
        />
      );
    case 'unclassified':
    default:
      return (
        <Chip
          icon={<HelpOutlineIcon />}
          label="Unclassified"
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
  }
}
