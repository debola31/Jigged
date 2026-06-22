'use client';

import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import QrCode2Icon from '@mui/icons-material/QrCode2';
import { alpha } from '@mui/material/styles';

import type { LocationSpecNode } from '@/types/inventoryLocations';

// READ-ONLY, type-aware depiction (editing lives in the config). Each top
// container is drawn to resemble its kind; a section's leaves fill the width as
// evenly-divided compartments. A QR-code icon marks wherever a label would be
// printed. Big/deep sets are summarized. A 3D diorama is a tracked follow-up.
const TOP_LIMIT = 24;
const SECTION_LIMIT = 16;
const CELL_LIMIT = 20;
const FILL_MAX = 8; // up to this many leaves fill the width; beyond, wrap centered

const qrCellBg = (t: { palette: { info: { main: string } } }) => alpha(t.palette.info.main, 0.18);

/** A little QR-code glyph marking where a printed label would go. */
function QrMark({ size = 15 }: { size?: number }) {
  return (
    <QrCode2Icon
      sx={{ fontSize: size, color: 'info.main', verticalAlign: 'middle', flexShrink: 0 }}
      titleAccess="A QR label prints here"
    />
  );
}

/** Leaves spanning the section width as evenly-divided compartments. */
function Compartments({ nodes }: { nodes: LocationSpecNode[] }) {
  if (nodes.length === 0) return null;

  if (nodes.length > FILL_MAX) {
    return (
      <Box sx={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: 0.5, mt: 0.5 }}>
        {nodes.slice(0, CELL_LIMIT).map((n) => (
          <Box
            key={n.key}
            sx={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 0.25,
              fontSize: 12,
              px: 0.75,
              py: 0.25,
              border: 1,
              borderRadius: 0.5,
              borderColor: n.is_qr_anchor ? 'info.main' : 'divider',
              bgcolor: n.is_qr_anchor ? qrCellBg : 'transparent',
              whiteSpace: 'nowrap',
            }}
          >
            {n.is_qr_anchor && <QrMark size={12} />}
            {n.name}
            {n.children.length ? ` ·${n.children.length}` : ''}
          </Box>
        ))}
        {nodes.length > CELL_LIMIT && (
          <Box sx={{ fontSize: 12, color: 'text.secondary', px: 0.5 }}>+{nodes.length - CELL_LIMIT}</Box>
        )}
      </Box>
    );
  }

  return (
    <Box sx={{ display: 'flex', mt: 0.5, borderRadius: 0.5, overflow: 'hidden' }}>
      {nodes.map((n, i) => (
        <Box
          key={n.key}
          sx={{
            flex: 1,
            minWidth: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 0.25,
            fontSize: 12,
            py: 0.4,
            px: 0.5,
            borderRight: i < nodes.length - 1 ? '1px solid' : 0,
            borderColor: 'divider',
            color: n.is_qr_anchor ? 'info.light' : 'text.primary',
            bgcolor: n.is_qr_anchor ? qrCellBg : 'transparent',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
          }}
          title={n.name}
        >
          {n.is_qr_anchor && <QrMark size={12} />}
          <Box component="span" sx={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {n.name}
            {n.children.length ? ` ·${n.children.length}` : ''}
          </Box>
        </Box>
      ))}
    </Box>
  );
}

function SectionLabel({ node }: { node: LocationSpecNode }) {
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 0.25 }}>
      <Typography variant="caption" color="text.secondary">
        {node.name}
      </Typography>
      {node.is_qr_anchor && <QrMark size={13} />}
    </Box>
  );
}

type Kind = 'cabinet' | 'shelving' | 'rack' | 'drawer' | 'aisle' | 'generic';

function unitKind(kind?: string | null): Kind {
  const k = (kind ?? '').toLowerCase();
  if (k.includes('rack')) return 'rack';
  if (k.includes('drawer')) return 'drawer';
  if (k.includes('aisle') || k.includes('zone')) return 'aisle';
  if (k.includes('shelv') || k.includes('shelf')) return 'shelving';
  if (k.includes('cabinet')) return 'cabinet';
  return 'generic';
}

function Section({ node, kind }: { node: LocationSpecNode; kind: Kind }) {
  const hasLeaves = node.children.length > 0;

  if (kind === 'drawer') {
    return (
      <Box sx={{ border: 1, borderColor: 'divider', borderRadius: 1, bgcolor: 'action.hover', py: 0.75, px: 1, textAlign: 'center' }}>
        <Box sx={{ width: 28, height: 3, bgcolor: 'text.disabled', borderRadius: 2, mx: 'auto', mb: 0.5 }} />
        <SectionLabel node={node} />
        {hasLeaves && <Compartments nodes={node.children} />}
      </Box>
    );
  }

  if (kind === 'rack') {
    return (
      <Box sx={{ borderTop: '3px solid', borderBottom: '3px solid', borderColor: alpha('#5b8cf0', 0.55), py: 0.5 }}>
        <SectionLabel node={node} />
        <Compartments nodes={node.children} />
      </Box>
    );
  }

  if (kind === 'shelving' && !hasLeaves) {
    return (
      <Box sx={{ bgcolor: 'action.hover', borderBottom: '3px solid', borderColor: 'divider', borderRadius: 0.5, py: 0.5 }}>
        <SectionLabel node={node} />
      </Box>
    );
  }

  return (
    <Box sx={{ borderBottom: '3px solid', borderColor: 'divider', pb: 0.5 }}>
      <SectionLabel node={node} />
      {hasLeaves && <Compartments nodes={node.children} />}
    </Box>
  );
}

function StorageUnit({ node }: { node: LocationSpecNode }) {
  const kind = unitKind(node.kind);
  const children = node.children;
  const allLeaves = children.length > 0 && children.every((c) => c.children.length === 0);

  return (
    <Box
      sx={{
        border: 2,
        borderColor: 'divider',
        borderLeftWidth: kind === 'rack' ? 6 : 2,
        borderRightWidth: kind === 'rack' ? 6 : 2,
        borderLeftColor: kind === 'rack' ? alpha('#5b8cf0', 0.55) : 'divider',
        borderRightColor: kind === 'rack' ? alpha('#5b8cf0', 0.55) : 'divider',
        borderRadius: 1,
        overflow: 'hidden',
        bgcolor: 'background.paper',
      }}
    >
      <Box sx={{ px: 1.5, py: 0.75, bgcolor: 'action.hover', borderBottom: 1, borderColor: 'divider', display: 'flex', alignItems: 'center', gap: 0.5 }}>
        <Typography sx={{ fontWeight: 600, flex: 1, minWidth: 0 }} noWrap>
          {node.name}
        </Typography>
        {node.is_qr_anchor && <QrMark size={18} />}
        {node.code && (
          <Typography variant="caption" color="text.secondary">
            {node.code}
          </Typography>
        )}
      </Box>

      <Box sx={{ p: 1 }}>
        {children.length === 0 ? null : allLeaves ? (
          <Compartments nodes={children} />
        ) : kind === 'aisle' ? (
          <Box sx={{ display: 'flex', gap: 1, justifyContent: 'center', flexWrap: 'wrap' }}>
            {children.slice(0, SECTION_LIMIT).map((bay) => (
              <Box key={bay.key} sx={{ border: 1, borderColor: 'divider', borderRadius: 1, p: 0.5, minWidth: 56 }}>
                <SectionLabel node={bay} />
                <Stack spacing={0.25} sx={{ mt: 0.25 }}>
                  {bay.children.slice(0, CELL_LIMIT).map((leaf) => (
                    <Box
                      key={leaf.key}
                      sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 0.25, fontSize: 12, border: 1, borderColor: leaf.is_qr_anchor ? 'info.main' : 'divider', borderRadius: 0.5, py: 0.25 }}
                    >
                      {leaf.is_qr_anchor && <QrMark size={12} />}
                      {leaf.name}
                    </Box>
                  ))}
                </Stack>
              </Box>
            ))}
          </Box>
        ) : (
          <Stack spacing={kind === 'drawer' ? 0.75 : 1}>
            {children.slice(0, SECTION_LIMIT).map((section) => (
              <Section key={section.key} node={section} kind={kind} />
            ))}
            {children.length > SECTION_LIMIT && (
              <Typography variant="caption" color="text.secondary" sx={{ textAlign: 'center' }}>
                +{children.length - SECTION_LIMIT} more
              </Typography>
            )}
          </Stack>
        )}
      </Box>
    </Box>
  );
}

export default function LocationBoardPreview({ nodes }: { nodes: LocationSpecNode[] }) {
  if (nodes.length === 0) {
    return (
      <Typography variant="body2" color="text.secondary" sx={{ py: 4, textAlign: 'center' }}>
        Set a count to see your storage take shape.
      </Typography>
    );
  }

  if (nodes.every((n) => n.children.length === 0)) {
    return (
      <Box sx={{ border: 1, borderColor: 'divider', borderRadius: 1, p: 1.5 }}>
        <Compartments nodes={nodes} />
      </Box>
    );
  }

  return (
    <Box sx={{ display: 'grid', gap: 1.5, gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, 1fr)' } }}>
      {nodes.slice(0, TOP_LIMIT).map((node) => (
        <StorageUnit key={node.key} node={node} />
      ))}
      {nodes.length > TOP_LIMIT && (
        <Typography variant="caption" color="text.secondary" sx={{ alignSelf: 'center' }}>
          +{nodes.length - TOP_LIMIT} more
        </Typography>
      )}
    </Box>
  );
}
