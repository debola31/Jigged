'use client';

import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Chip from '@mui/material/Chip';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import Breadcrumbs from '@mui/material/Breadcrumbs';
import MuiLink from '@mui/material/Link';
import Tabs from '@mui/material/Tabs';
import Tab from '@mui/material/Tab';
import NextLink from 'next/link';
import DeleteIcon from '@mui/icons-material/Delete';
import EditIcon from '@mui/icons-material/Edit';

import type { Part } from '@/types/part';
import { buildPartHref } from '@/lib/partNavStack';
import PartClassificationChips from '@/components/parts/PartClassificationChips';
import PartCompletenessChip from './PartCompletenessChip';
import type { PartSetupStatus } from './partSetupStatus';

export interface PartTabDescriptor {
  slug: string;
  label: string;
}

interface PartStickyHeaderProps {
  part: Part;
  companyId: string;
  /** Breadcrumb root (Parts vs Inventory) — see PartWorkspace. */
  partsListHref: string;
  partsListLabel: string;
  /** BOM drill-down chain (oldest → most recent), from `?back=`. */
  currentChain: string[];
  chainNames: Map<string, string>;
  /** Null while priceability is still loading (chip hidden). */
  setupStatus: PartSetupStatus | null;
  tabs: PartTabDescriptor[];
  activeTab: string;
  onTabChange: (slug: string) => void;
  onEdit: () => void;
  onDelete: () => void;
  hasReferences: boolean;
  actionLoading: boolean;
}

/**
 * Persistent part identity bar. Sticks to the top of the scrolling dashboard
 * `<main>` so the part name (Jigged's "part number" — there is no separate
 * part_number field), classification, completeness, and the tab strip stay
 * visible while the user scrolls a long workspace.
 *
 * `zIndex` sits just below the global app Header (1100) so it tucks underneath
 * the app bar rather than over it; the opaque `background.default` fill (the
 * same colour as the page) covers content scrolling beneath. Negative margins
 * cancel the `<main>` padding so the bar spans edge-to-edge.
 */
export default function PartStickyHeader({
  part,
  companyId,
  partsListHref,
  partsListLabel,
  currentChain,
  chainNames,
  setupStatus,
  tabs,
  activeTab,
  onTabChange,
  onEdit,
  onDelete,
  hasReferences,
  actionLoading,
}: PartStickyHeaderProps) {
  return (
    <Box
      sx={{
        position: 'sticky',
        top: 0,
        zIndex: 1000,
        bgcolor: 'background.default',
        // Bleed to the scroll-container edges (cancel <main> p:{xs:2,md:3}),
        // and pull up over the top padding so the bar sits flush at the top.
        mx: { xs: -2, md: -3 },
        px: { xs: 2, md: 3 },
        mt: { xs: -2, md: -3 },
        pt: { xs: 2, md: 3 },
        mb: 3,
        borderBottom: '1px solid',
        borderColor: 'divider',
      }}
    >
      {/* Breadcrumb trail (left) + Delete (right). */}
      <Box
        sx={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 2,
          mb: 1,
        }}
      >
        <Breadcrumbs aria-label="Part trail" separator="›" sx={{ flex: 1, minWidth: 0 }}>
          <MuiLink component={NextLink} href={partsListHref} underline="hover" color="text.secondary">
            {partsListLabel}
          </MuiLink>
          {currentChain.map((id, i) => (
            <MuiLink
              key={`${id}-${i}`}
              component={NextLink}
              href={buildPartHref({ companyId, targetPartId: id, chain: currentChain.slice(0, i) })}
              underline="hover"
              color="text.secondary"
            >
              {chainNames.get(id) ?? '…'}
            </MuiLink>
          ))}
          <Typography color="text.primary" sx={{ fontWeight: 500 }}>
            {part.part_name}
          </Typography>
        </Breadcrumbs>

        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, flexShrink: 0 }}>
          <Tooltip title="Edit part details">
            <span>
              <IconButton
                onClick={onEdit}
                disabled={actionLoading}
                sx={{ color: 'text.secondary' }}
              >
                <EditIcon />
              </IconButton>
            </span>
          </Tooltip>

          <Tooltip
            title={
              hasReferences
                ? "Cannot delete — this part is referenced by quotes, jobs, or other parts' BOMs"
                : 'Delete Part'
            }
          >
            <span>
              <IconButton
                onClick={onDelete}
                disabled={actionLoading || hasReferences}
                sx={{
                  color: 'text.secondary',
                  '&:hover': { color: 'error.main', bgcolor: 'rgba(239, 68, 68, 0.1)' },
                }}
              >
                <DeleteIcon />
              </IconButton>
            </span>
          </Tooltip>
        </Box>
      </Box>

      {/* Identity row: name (the "part number"), legacy id, classification, completeness. */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap', mb: 1.5 }}>
        <Typography variant="h5" sx={{ fontWeight: 600, minWidth: 0, wordBreak: 'break-word' }}>
          {part.part_name}
        </Typography>
        {part.legacy_id && (
          <Chip size="small" variant="outlined" label={part.legacy_id} sx={{ fontFamily: 'monospace' }} />
        )}
        <PartClassificationChips part={part} />
        {setupStatus && <PartCompletenessChip status={setupStatus} />}
      </Box>

      {/* Tab strip — the divider doubles as the header's bottom edge. */}
      <Tabs
        value={activeTab}
        onChange={(_e, v: string) => onTabChange(v)}
        variant="scrollable"
        scrollButtons="auto"
        sx={{ minHeight: 48, mb: '-1px' }}
      >
        {tabs.map((t) => (
          <Tab key={t.slug} value={t.slug} label={t.label} sx={{ fontWeight: 600 }} />
        ))}
      </Tabs>
    </Box>
  );
}
