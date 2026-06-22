'use client';

import { useState } from 'react';
import Box from '@mui/material/Box';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import Chip from '@mui/material/Chip';
import IconButton from '@mui/material/IconButton';
import Breadcrumbs from '@mui/material/Breadcrumbs';
import Link from '@mui/material/Link';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import CloseIcon from '@mui/icons-material/Close';

import type { LocationSpecNode } from '@/types/inventoryLocations';

function findPath(
  nodes: LocationSpecNode[],
  key: string,
  trail: LocationSpecNode[] = [],
): LocationSpecNode[] | null {
  for (const n of nodes) {
    const here = [...trail, n];
    if (n.key === key) return here;
    const found = findPath(n.children, key, here);
    if (found) return found;
  }
  return null;
}

const CHIP_LIMIT = 10;

interface LocationBoardPreviewProps {
  nodes: LocationSpecNode[];
  onPrune: (key: string) => void;
}

/** Live, read-only board of the assembled spec: each container card shows its
 *  contents nested inside (rows/bins as chips). Click a card to drill in; the ×
 *  removes that node (and its subtree). Pure projection of the spec — no drag,
 *  no stored geometry. */
export default function LocationBoardPreview({ nodes, onPrune }: LocationBoardPreviewProps) {
  const [focusKey, setFocusKey] = useState<string | null>(null);

  // Stay valid if the focused node was pruned or the layout changed underneath us.
  const focusPath = focusKey ? findPath(nodes, focusKey) : null;
  const focusNode = focusPath?.[focusPath.length - 1] ?? null;
  const displayed = focusNode ? focusNode.children : nodes;

  return (
    <Box>
      <Breadcrumbs sx={{ mb: 1.5 }}>
        <Link
          component="button"
          type="button"
          underline="hover"
          color={focusNode ? 'primary' : 'text.primary'}
          onClick={() => setFocusKey(null)}
        >
          All
        </Link>
        {(focusPath ?? []).map((n, i, arr) => (
          <Link
            key={n.key}
            component="button"
            type="button"
            underline="hover"
            color={i === arr.length - 1 ? 'text.primary' : 'primary'}
            onClick={() => setFocusKey(n.key)}
          >
            {n.name}
          </Link>
        ))}
      </Breadcrumbs>

      {displayed.length === 0 ? (
        <Typography variant="body2" color="text.secondary" sx={{ py: 4, textAlign: 'center' }}>
          Set a count above to see your storage take shape.
        </Typography>
      ) : (
        <Box
          sx={{
            display: 'grid',
            gap: 1.5,
            gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, 1fr)' },
          }}
        >
          {displayed.map((node) => {
            const children = node.children;
            const drillable = children.length > 0;
            return (
              <Paper
                key={node.key}
                variant="outlined"
                sx={{
                  p: 1.5,
                  cursor: drillable ? 'pointer' : 'default',
                  '&:hover': drillable ? { borderColor: 'primary.main' } : undefined,
                }}
                onClick={drillable ? () => setFocusKey(node.key) : undefined}
              >
                <Stack direction="row" alignItems="center" spacing={0.5}>
                  <Typography sx={{ fontWeight: 600, flex: 1, minWidth: 0 }} noWrap>
                    {node.name}
                  </Typography>
                  {node.is_qr_anchor && <Chip size="small" color="info" label="QR" />}
                  <IconButton
                    size="small"
                    aria-label={`Remove ${node.name}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      onPrune(node.key);
                    }}
                  >
                    <CloseIcon fontSize="small" />
                  </IconButton>
                  {drillable && <ChevronRightIcon fontSize="small" color="action" />}
                </Stack>

                {node.code && (
                  <Typography variant="caption" color="text.secondary">
                    {node.code}
                  </Typography>
                )}

                {drillable && (
                  <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, mt: 1 }}>
                    {children.slice(0, CHIP_LIMIT).map((c) => (
                      <Chip key={c.key} size="small" variant="outlined" label={c.name} />
                    ))}
                    {children.length > CHIP_LIMIT && (
                      <Chip size="small" label={`+${children.length - CHIP_LIMIT}`} />
                    )}
                  </Box>
                )}
              </Paper>
            );
          })}
        </Box>
      )}
    </Box>
  );
}
