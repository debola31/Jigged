'use client';

import { useState, type ReactNode } from 'react';
import Box from '@mui/material/Box';
import ButtonBase from '@mui/material/ButtonBase';
import Collapse from '@mui/material/Collapse';
import Typography from '@mui/material/Typography';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';

interface CollapsibleSectionProps {
  title: string;
  /** Right-aligned summary shown in the header (e.g. status chips, "Shipped 13/15"). */
  summary?: ReactNode;
  /** Initial expanded state. Static per the job's state — not remembered per user
   *  (predictable on shared shop-floor tablets; no storage). */
  defaultExpanded?: boolean;
  children: ReactNode;
}

/**
 * A section grouped under a clickable header bar that expands/collapses its content.
 * Deliberately NOT a Card — the content below often contains its own cards, so a card
 * wrapper here would double-nest. Groups the long job page into Production /
 * Fulfillment / Attachments so each audience can focus without a role concept.
 */
export default function CollapsibleSection({
  title,
  summary,
  defaultExpanded = true,
  children,
}: CollapsibleSectionProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  return (
    <Box>
      <ButtonBase
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        sx={{
          width: '100%',
          justifyContent: 'space-between',
          textAlign: 'left',
          px: 1,
          py: 1.5,
          borderRadius: 1,
          '&:hover': { backgroundColor: 'action.hover' },
        }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap', minWidth: 0 }}>
          <Typography variant="h6" sx={{ fontWeight: 600 }}>
            {title}
          </Typography>
          {summary != null && (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
              {summary}
            </Box>
          )}
        </Box>
        <ExpandMoreIcon
          sx={{
            color: 'text.primary',
            transition: 'transform 150ms',
            transform: expanded ? 'rotate(180deg)' : 'none',
          }}
        />
      </ButtonBase>
      <Collapse in={expanded} unmountOnExit>
        <Box sx={{ pt: 1.5 }}>{children}</Box>
      </Collapse>
    </Box>
  );
}
