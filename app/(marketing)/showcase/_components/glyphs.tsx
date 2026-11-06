'use client';

import type { ReactNode } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import AdjustOutlinedIcon from '@mui/icons-material/AdjustOutlined';
import CompressOutlinedIcon from '@mui/icons-material/CompressOutlined';
import ContentCutOutlinedIcon from '@mui/icons-material/ContentCutOutlined';
import HandymanOutlinedIcon from '@mui/icons-material/HandymanOutlined';
import InventoryOutlinedIcon from '@mui/icons-material/InventoryOutlined';
import LayersOutlinedIcon from '@mui/icons-material/LayersOutlined';
import LocalShippingOutlinedIcon from '@mui/icons-material/LocalShippingOutlined';
import OpacityOutlinedIcon from '@mui/icons-material/OpacityOutlined';
import PanToolOutlinedIcon from '@mui/icons-material/PanToolOutlined';
import PlayCircleOutlineIcon from '@mui/icons-material/PlayCircleOutline';
import PrecisionManufacturingOutlinedIcon from '@mui/icons-material/PrecisionManufacturingOutlined';
import SettingsOutlinedIcon from '@mui/icons-material/SettingsOutlined';
import StraightenOutlinedIcon from '@mui/icons-material/StraightenOutlined';
import TableRestaurantOutlinedIcon from '@mui/icons-material/TableRestaurantOutlined';
import type { LivePart, Step } from './showcaseData';

// The page's visual vocabulary, so a visitor reads a step by colour and shape before its words: each
// setup has a colour, a step's kind and a thing's category an icon, and a material its swatch.

// Distinct from the shop's amber (stations) and teal (what a step uses).
const SETUP_COLOURS = ['#5B8DEF', '#A07BEA', '#E0708C', '#6CC08B', '#E2C044', '#4FC1E9'];
const FINISH_COLOUR = '#9AA3AD';

/** A setup's colour, by its place in the part; finishing is grey. */
export function setupColour(part: LivePart, group: string): string {
  if (group === 'finish') return FINISH_COLOUR;
  const i = part.groups.filter((g) => g.id !== 'finish').findIndex((g) => g.id === group);
  return SETUP_COLOURS[Math.max(i, 0) % SETUP_COLOURS.length];
}

/** A machine cycle runs on its own (a gear); everything else is a person's hands. */
export function KindIcon({ kind, sx }: { kind: Step['kind']; sx?: object }) {
  return kind === 'cycle' ? <SettingsOutlinedIcon aria-label="Machine cycle" sx={sx} /> : <PanToolOutlinedIcon aria-label="By hand" sx={sx} />;
}

const CATEGORY_ICONS: Record<string, typeof SettingsOutlinedIcon> = {
  machines: PrecisionManufacturingOutlinedIcon,
  workholding: CompressOutlinedIcon,
  holders: AdjustOutlinedIcon,
  tools: ContentCutOutlinedIcon,
  inspection: StraightenOutlinedIcon,
  consumables: OpacityOutlinedIcon,
  hand_tools: HandymanOutlinedIcon,
  support: TableRestaurantOutlinedIcon,
  outside_processes: LocalShippingOutlinedIcon,
};

export function CategoryIcon({ category, sx }: { category?: string; sx?: object }) {
  const Icon = (category && CATEGORY_ICONS[category]) || InventoryOutlinedIcon;
  return <Icon sx={sx} />;
}

/** "6061-T6 aluminium" from "6061-T6 aluminium", "Delrin" from "Delrin (acetal), black". */
function shortMaterial(material: string): string {
  return material.split(',')[0].replace(/\s*\([^)]*\)/g, '').trim();
}

function swatch(material: string): string {
  const m = material.toLowerCase();
  if (m.includes('alumin')) return '#C9CED6';
  if (m.includes('stainless')) return '#A7AFB8';
  if (m.includes('delrin') || m.includes('acetal')) return '#1E1E1E';
  if (m.includes('brass') || m.includes('bronze')) return '#C9A227';
  if (m.includes('steel') || /\b41[34]0\b/.test(m)) return '#5F6670';
  return '#9AA3AD';
}

/** "NIST FTC-10" from "NIST FTC-10 (Fully-Toleranced Test Case 10)". */
export function shortName(part: LivePart): string {
  return part.name.split(' (')[0];
}

function Fact({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <Box sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.75 }}>
      {icon}
      <Typography component="span" sx={{ fontSize: '0.95rem' }}>
        {children}
      </Typography>
    </Box>
  );
}

/** A part at a glance: its material as a swatch, its setups and its steps. */
export function PartFacts({ part }: { part: LivePart }) {
  const setups = part.groups.filter((g) => g.id !== 'finish').length;
  return (
    <Box sx={{ display: 'flex', flexWrap: 'wrap', columnGap: 2, rowGap: 0.75, color: 'text.secondary' }}>
      <Fact icon={<Box sx={{ width: 14, height: 14, borderRadius: '50%', bgcolor: swatch(part.stock.material), border: '1px solid rgba(255, 255, 255, 0.4)' }} />}>
        {shortMaterial(part.stock.material)}
      </Fact>
      <Fact icon={<LayersOutlinedIcon sx={{ fontSize: 18 }} />}>
        {setups} {setups === 1 ? 'setup' : 'setups'}
      </Fact>
      <Fact icon={<PlayCircleOutlineIcon sx={{ fontSize: 18 }} />}>{part.steps.length} steps</Fact>
    </Box>
  );
}
