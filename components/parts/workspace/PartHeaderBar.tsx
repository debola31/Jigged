'use client';

import Box from '@mui/material/Box';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import Breadcrumbs from '@mui/material/Breadcrumbs';
import MuiLink from '@mui/material/Link';
import Tabs from '@mui/material/Tabs';
import Tab from '@mui/material/Tab';
import NextLink from 'next/link';
import EditIcon from '@mui/icons-material/Edit';
import DeleteIcon from '@mui/icons-material/Delete';

import { buildPartHref } from '@/lib/partNavStack';

export interface PartTabDescriptor {
  slug: string;
  label: string;
}

interface PartHeaderBarProps {
  companyId: string;
  /** Breadcrumb root (Parts vs Inventory). */
  partsListHref: string;
  partsListLabel: string;
  /** BOM drill-down chain (oldest → most recent), from `?back=`. */
  currentChain: string[];
  chainNames: Map<string, string>;
  tabs: PartTabDescriptor[];
  activeTab: string;
  onTabChange: (slug: string) => void;
  onEdit: () => void;
  onDelete: () => void;
  hasReferences: boolean;
  actionLoading: boolean;
}

/**
 * Lightweight, non-sticky header for the part workspace: a back/breadcrumb
 * trail, Edit/Delete actions, and the tab strip. The part number itself lives
 * in the global app bar (via PageTitleProvider) so it stays visible while
 * scrolling — this bar deliberately does NOT repeat the name (avoids the
 * redundant, heavy banner the first cut had).
 *
 * The breadcrumb omits the current part as a terminal crumb (it's the app-bar
 * title); it shows only the navigable ancestors.
 */
export default function PartHeaderBar({
  companyId,
  partsListHref,
  partsListLabel,
  currentChain,
  chainNames,
  tabs,
  activeTab,
  onTabChange,
  onEdit,
  onDelete,
  hasReferences,
  actionLoading,
}: PartHeaderBarProps) {
  return (
    <Box sx={{ mb: 2 }}>
      <Box
        sx={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 2,
          mb: 1.5,
        }}
      >
        <Breadcrumbs aria-label="Part trail" separator="›" sx={{ minWidth: 0 }}>
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
        </Breadcrumbs>

        <Box sx={{ display: 'flex', gap: 0.5, flexShrink: 0 }}>
          <Tooltip title="Edit part details">
            <span>
              <IconButton onClick={onEdit} disabled={actionLoading} size="small" sx={{ color: 'text.secondary' }}>
                <EditIcon fontSize="small" />
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
                size="small"
                sx={{ color: 'text.secondary', '&:hover': { color: 'error.main' } }}
              >
                <DeleteIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
        </Box>
      </Box>

      <Tabs
        value={activeTab}
        onChange={(_e, v: string) => onTabChange(v)}
        variant="scrollable"
        scrollButtons="auto"
        sx={{ borderBottom: 1, borderColor: 'divider', minHeight: 44 }}
      >
        {tabs.map((t) => (
          <Tab key={t.slug} value={t.slug} label={t.label} sx={{ fontWeight: 600 }} />
        ))}
      </Tabs>
    </Box>
  );
}
