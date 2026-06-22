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

interface LocationBoardPreviewProps {
  nodes: LocationSpecNode[];
  onPrune: (key: string) => void;
}

/** Step 3: a read-only board of the assembled spec. Click a tile to drill in;
 *  the × removes that tile (and its subtree) before commit. Pure projection of
 *  the spec — no drag, no stored geometry. */
export default function LocationBoardPreview({ nodes, onPrune }: LocationBoardPreviewProps) {
  const [focusKey, setFocusKey] = useState<string | null>(null);

  const focusPath = focusKey ? findPath(nodes, focusKey) : null;
  const focusNode = focusPath?.[focusPath.length - 1] ?? null;
  const displayed = focusNode ? focusNode.children : nodes;

  return (
    <Box>
      <Breadcrumbs sx={{ mb: 2 }}>
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
        <Typography variant="body2" color="text.secondary">
          Nothing here.
        </Typography>
      ) : (
        <Box
          sx={{
            display: 'grid',
            gap: 1.5,
            gridTemplateColumns: { xs: 'repeat(2, 1fr)', sm: 'repeat(3, 1fr)', md: 'repeat(4, 1fr)' },
          }}
        >
          {displayed.map((node) => {
            const childCount = node.children.length;
            const drillable = childCount > 0;
            return (
              <Paper
                key={node.key}
                variant="outlined"
                sx={{
                  p: 1.5,
                  minHeight: 72,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 1,
                  cursor: drillable ? 'pointer' : 'default',
                  '&:hover': drillable ? { borderColor: 'primary.main' } : undefined,
                }}
                onClick={drillable ? () => setFocusKey(node.key) : undefined}
              >
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Typography noWrap sx={{ fontWeight: 500 }}>
                    {node.name}
                  </Typography>
                  <Stack direction="row" spacing={0.5} alignItems="center" sx={{ mt: 0.25 }}>
                    {node.code && (
                      <Typography variant="caption" color="text.secondary" noWrap>
                        {node.code}
                      </Typography>
                    )}
                    {drillable && (
                      <Chip size="small" variant="outlined" label={`${childCount} inside`} />
                    )}
                    {node.is_qr_anchor && <Chip size="small" color="info" label="QR" />}
                  </Stack>
                </Box>
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
              </Paper>
            );
          })}
        </Box>
      )}
    </Box>
  );
}
