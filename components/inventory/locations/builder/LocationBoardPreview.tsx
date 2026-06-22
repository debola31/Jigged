'use client';

import Box from '@mui/material/Box';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import Chip from '@mui/material/Chip';
import IconButton from '@mui/material/IconButton';
import CloseIcon from '@mui/icons-material/Close';

import type { LocationSpecNode } from '@/types/inventoryLocations';

// Show the whole structure nested (container → sections → leaves as chips), but
// summarize big repetitions so it stays scannable rather than becoming a wall
// of icons (the research's caution for deep/large sets). Nested CARDS, never a
// deep indented tree.
const TOP_LIMIT = 30; // top-level containers shown
const GROUP_LIMIT = 12; // sub-sections shown per container
const CHIP_LIMIT = 16; // leaf chips shown per section

/** Render an array of leaf (or near-leaf) nodes as chips, with prune + a "+N". */
function LeafChips({ nodes, onPrune }: { nodes: LocationSpecNode[]; onPrune: (k: string) => void }) {
  return (
    <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
      {nodes.slice(0, CHIP_LIMIT).map((n) => (
        <Chip
          key={n.key}
          size="small"
          variant={n.is_qr_anchor ? 'filled' : 'outlined'}
          color={n.is_qr_anchor ? 'info' : 'default'}
          // a 4th level (rare) is summarized as a count instead of nesting deeper
          label={n.children.length ? `${n.name} · ${n.children.length}` : n.name}
          onDelete={() => onPrune(n.key)}
        />
      ))}
      {nodes.length > CHIP_LIMIT && <Chip size="small" label={`+${nodes.length - CHIP_LIMIT}`} />}
    </Box>
  );
}

interface LocationBoardPreviewProps {
  nodes: LocationSpecNode[];
  onPrune: (key: string) => void;
}

export default function LocationBoardPreview({ nodes, onPrune }: LocationBoardPreviewProps) {
  if (nodes.length === 0) {
    return (
      <Typography variant="body2" color="text.secondary" sx={{ py: 4, textAlign: 'center' }}>
        Set a count to see your storage take shape.
      </Typography>
    );
  }

  return (
    <Box
      sx={{ display: 'grid', gap: 1.5, gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, 1fr)' } }}
    >
      {nodes.slice(0, TOP_LIMIT).map((node) => {
        const kids = node.children;
        const kidsHaveKids = kids.length > 0 && kids[0].children.length > 0;
        return (
          <Paper key={node.key} variant="outlined" sx={{ p: 1.5 }}>
            <Stack direction="row" alignItems="center" spacing={0.5}>
              <Typography sx={{ fontWeight: 600, flex: 1, minWidth: 0 }} noWrap>
                {node.name}
              </Typography>
              {node.is_qr_anchor && <Chip size="small" color="info" label="QR" />}
              <IconButton
                size="small"
                aria-label={`Remove ${node.name}`}
                onClick={() => onPrune(node.key)}
              >
                <CloseIcon fontSize="small" />
              </IconButton>
            </Stack>
            {node.code && (
              <Typography variant="caption" color="text.secondary">
                {node.code}
              </Typography>
            )}

            {kids.length > 0 && (
              <Box sx={{ mt: 1 }}>
                {kidsHaveKids ? (
                  <Stack spacing={1}>
                    {kids.slice(0, GROUP_LIMIT).map((section) => (
                      <Box key={section.key}>
                        <Stack direction="row" alignItems="center" spacing={0.5} sx={{ mb: 0.5 }}>
                          <Typography
                            variant="body2"
                            sx={{ fontWeight: 500, flex: 1, minWidth: 0 }}
                            noWrap
                          >
                            {section.name}
                          </Typography>
                          {section.is_qr_anchor && <Chip size="small" color="info" label="QR" />}
                          <IconButton
                            size="small"
                            aria-label={`Remove ${section.name}`}
                            onClick={() => onPrune(section.key)}
                          >
                            <CloseIcon sx={{ fontSize: 16 }} />
                          </IconButton>
                        </Stack>
                        <LeafChips nodes={section.children} onPrune={onPrune} />
                      </Box>
                    ))}
                    {kids.length > GROUP_LIMIT && (
                      <Typography variant="caption" color="text.secondary">
                        +{kids.length - GROUP_LIMIT} more
                      </Typography>
                    )}
                  </Stack>
                ) : (
                  <LeafChips nodes={kids} onPrune={onPrune} />
                )}
              </Box>
            )}
          </Paper>
        );
      })}
      {nodes.length > TOP_LIMIT && (
        <Typography variant="caption" color="text.secondary" sx={{ alignSelf: 'center' }}>
          +{nodes.length - TOP_LIMIT} more
        </Typography>
      )}
    </Box>
  );
}
