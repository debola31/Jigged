'use client';

import Box from '@mui/material/Box';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import Chip from '@mui/material/Chip';
import IconButton from '@mui/material/IconButton';
import CloseIcon from '@mui/icons-material/Close';
import AddIcon from '@mui/icons-material/Add';

import type { LocationSpecNode } from '@/types/inventoryLocations';

// Spatial depiction: containers as cards, sections stacked, leaves as CENTERED
// cells (3 on a line → middle one centered). Editable: × removes a node, ＋ adds
// one to that branch. Big/deep sets are summarized so it stays scannable.
const TOP_LIMIT = 30;
const GROUP_LIMIT = 14;
const CELL_LIMIT = 18;

const cellSx = (qr: boolean) => ({
  px: 1,
  py: 0.5,
  borderRadius: 1,
  border: 1,
  borderColor: qr ? 'info.main' : 'divider',
  color: qr ? 'info.light' : 'text.primary',
  fontSize: 13,
  display: 'inline-flex',
  alignItems: 'center',
  gap: 0.25,
  whiteSpace: 'nowrap' as const,
});

interface Edit {
  onRemove: (key: string) => void;
  onAdd: (parentKey: string) => void;
}

function Cell({ node, onRemove }: { node: LocationSpecNode } & Pick<Edit, 'onRemove'>) {
  return (
    <Box sx={cellSx(node.is_qr_anchor)}>
      {node.name}
      {node.children.length ? ` ·${node.children.length}` : ''}
      <IconButton
        size="small"
        aria-label={`Remove ${node.name}`}
        onClick={() => onRemove(node.key)}
        sx={{ p: 0, ml: 0.25 }}
      >
        <CloseIcon sx={{ fontSize: 14 }} />
      </IconButton>
    </Box>
  );
}

function AddButton({ parentKey, label, onAdd }: { parentKey: string; label: string } & Pick<Edit, 'onAdd'>) {
  return (
    <IconButton
      size="small"
      aria-label={label}
      onClick={() => onAdd(parentKey)}
      sx={{ border: 1, borderStyle: 'dashed', borderColor: 'divider', borderRadius: 1 }}
    >
      <AddIcon sx={{ fontSize: 16 }} />
    </IconButton>
  );
}

/** Centered, wrapping row of leaf cells + an Add button for this branch. */
function CellGroup({
  nodes,
  parentKey,
  addLabel,
  onRemove,
  onAdd,
}: { nodes: LocationSpecNode[]; parentKey?: string; addLabel?: string } & Edit) {
  const truncated = nodes.length > CELL_LIMIT;
  return (
    <Box sx={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: 0.5, alignItems: 'center' }}>
      {nodes.slice(0, CELL_LIMIT).map((n) => (
        <Cell key={n.key} node={n} onRemove={onRemove} />
      ))}
      {truncated && <Box sx={{ ...cellSx(false), color: 'text.secondary' }}>+{nodes.length - CELL_LIMIT}</Box>}
      {parentKey && !truncated && (
        <AddButton parentKey={parentKey} label={addLabel ?? 'Add one'} onAdd={onAdd} />
      )}
    </Box>
  );
}

function ContainerCard({ node, onRemove, onAdd }: { node: LocationSpecNode } & Edit) {
  const kids = node.children;
  const threeLevel = kids.length > 0 && kids[0].children.length > 0;

  return (
    <Paper variant="outlined" sx={{ p: 1.5 }}>
      <Stack direction="row" alignItems="center" spacing={0.5} sx={{ mb: kids.length ? 1 : 0 }}>
        <Typography sx={{ fontWeight: 600, flex: 1, minWidth: 0 }} noWrap>
          {node.name}
        </Typography>
        {node.is_qr_anchor && <Chip size="small" color="info" label="QR" />}
        <IconButton size="small" aria-label={`Remove ${node.name}`} onClick={() => onRemove(node.key)}>
          <CloseIcon fontSize="small" />
        </IconButton>
      </Stack>

      {kids.length > 0 &&
        (threeLevel ? (
          <Stack spacing={1}>
            {kids.slice(0, GROUP_LIMIT).map((section) => (
              <Box key={section.key}>
                <Stack direction="row" alignItems="center" justifyContent="center" spacing={0.5} sx={{ mb: 0.25 }}>
                  <Typography variant="caption" color="text.secondary">
                    {section.name}
                    {section.is_qr_anchor ? ' · QR' : ''}
                  </Typography>
                  <IconButton
                    size="small"
                    aria-label={`Remove ${section.name}`}
                    onClick={() => onRemove(section.key)}
                    sx={{ p: 0 }}
                  >
                    <CloseIcon sx={{ fontSize: 14 }} />
                  </IconButton>
                </Stack>
                <CellGroup
                  nodes={section.children}
                  parentKey={section.key}
                  addLabel={`Add to ${section.name}`}
                  onRemove={onRemove}
                  onAdd={onAdd}
                />
              </Box>
            ))}
            {kids.length > GROUP_LIMIT && (
              <Typography variant="caption" color="text.secondary" sx={{ textAlign: 'center' }}>
                +{kids.length - GROUP_LIMIT} more
              </Typography>
            )}
            <Box sx={{ display: 'flex', justifyContent: 'center' }}>
              <AddButton parentKey={node.key} label={`Add a section to ${node.name}`} onAdd={onAdd} />
            </Box>
          </Stack>
        ) : (
          <CellGroup
            nodes={kids}
            parentKey={node.key}
            addLabel={`Add to ${node.name}`}
            onRemove={onRemove}
            onAdd={onAdd}
          />
        ))}
    </Paper>
  );
}

interface LocationBoardPreviewProps extends Edit {
  nodes: LocationSpecNode[];
}

export default function LocationBoardPreview({ nodes, onRemove, onAdd }: LocationBoardPreviewProps) {
  if (nodes.length === 0) {
    return (
      <Typography variant="body2" color="text.secondary" sx={{ py: 4, textAlign: 'center' }}>
        Set a count to see your storage take shape.
      </Typography>
    );
  }

  // Flat (every top node is a leaf, e.g. loose bins): one centered cluster.
  if (nodes.every((n) => n.children.length === 0)) {
    return (
      <Paper variant="outlined" sx={{ p: 1.5 }}>
        <CellGroup nodes={nodes} onRemove={onRemove} onAdd={onAdd} />
      </Paper>
    );
  }

  return (
    <Box sx={{ display: 'grid', gap: 1.5, gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, 1fr)' } }}>
      {nodes.slice(0, TOP_LIMIT).map((node) => (
        <ContainerCard key={node.key} node={node} onRemove={onRemove} onAdd={onAdd} />
      ))}
      {nodes.length > TOP_LIMIT && (
        <Typography variant="caption" color="text.secondary" sx={{ alignSelf: 'center' }}>
          +{nodes.length - TOP_LIMIT} more
        </Typography>
      )}
    </Box>
  );
}
