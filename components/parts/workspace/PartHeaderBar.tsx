'use client';

import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import Breadcrumbs from '@mui/material/Breadcrumbs';
import MuiLink from '@mui/material/Link';
import Tabs from '@mui/material/Tabs';
import Tab from '@mui/material/Tab';
import NextLink from 'next/link';
import DeleteIcon from '@mui/icons-material/Delete';

import { buildPartHref } from '@/lib/partNavStack';

export interface PartTabDescriptor {
  slug: string;
  label: string;
}

interface PartHeaderBarProps {
  companyId: string;
  /** Current part's display name — the terminal breadcrumb crumb. */
  partName: string;
  /** Breadcrumb root (Parts vs Inventory). */
  partsListHref: string;
  partsListLabel: string;
  /** BOM drill-down chain (oldest → most recent), from `?back=`. */
  currentChain: string[];
  chainNames: Map<string, string>;
  tabs: PartTabDescriptor[];
  activeTab: string;
  onTabChange: (slug: string) => void;
  onDelete: () => void;
  hasReferences: boolean;
  actionLoading: boolean;
}

// Header sits on the dark/gradient app background; mirror Header.tsx's
// white-on-dark convention for legible contrast (grey text.secondary failed
// the WCAG 4.5:1 the design system targets).
const CRUMB_LINK = 'rgba(255, 255, 255, 0.7)';
const CRUMB_CURRENT = '#fff';

/**
 * Lightweight, non-sticky header for the part workspace: breadcrumb genealogy
 * (incl. the current part), the Delete action, and the tab strip. The part
 * number lives in the global app bar (PageTitleProvider) so it stays visible
 * while scrolling. Editing is inline on the Workspace tab, so there's no Edit
 * button here.
 */
export default function PartHeaderBar({
  companyId,
  partName,
  partsListHref,
  partsListLabel,
  currentChain,
  chainNames,
  tabs,
  activeTab,
  onTabChange,
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
        <Breadcrumbs
          aria-label="Part trail"
          separator="›"
          sx={{ minWidth: 0, '& .MuiBreadcrumbs-separator': { color: CRUMB_LINK } }}
        >
          <MuiLink component={NextLink} href={partsListHref} underline="hover" sx={{ color: CRUMB_LINK }}>
            {partsListLabel}
          </MuiLink>
          {currentChain.map((id, i) => (
            <MuiLink
              key={`${id}-${i}`}
              component={NextLink}
              href={buildPartHref({ companyId, targetPartId: id, chain: currentChain.slice(0, i) })}
              underline="hover"
              sx={{ color: CRUMB_LINK }}
            >
              {chainNames.get(id) ?? '…'}
            </MuiLink>
          ))}
          {/* Current part — the "you are here" terminal (not a link). */}
          <Typography sx={{ color: CRUMB_CURRENT, fontWeight: 500 }}>{partName}</Typography>
        </Breadcrumbs>

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
              sx={{
                color: 'error.main',
                flexShrink: 0,
                '&:hover': { bgcolor: 'rgba(239, 68, 68, 0.12)' },
              }}
            >
              <DeleteIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
      </Box>

      <Tabs
        value={activeTab}
        onChange={(_e, v: string) => onTabChange(v)}
        variant="scrollable"
        scrollButtons="auto"
        textColor="inherit"
        sx={{
          borderBottom: 1,
          borderColor: 'divider',
          minHeight: 44,
          '& .MuiTab-root': { color: CRUMB_LINK, fontWeight: 600 },
          '& .Mui-selected': { color: CRUMB_CURRENT },
          '& .MuiTabs-indicator': { bgcolor: 'primary.main' },
        }}
      >
        {tabs.map((t) => (
          <Tab key={t.slug} value={t.slug} label={t.label} />
        ))}
      </Tabs>
    </Box>
  );
}
