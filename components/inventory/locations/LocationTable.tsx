'use client';

/**
 * Storage, as an indented table of places.
 *
 * ## Why this replaced the drawn board
 *
 * The board drew cabinets with compartments, and for the shop we have data on it drew almost
 * nothing: `unitKind` has exactly one consumer, and for a node with **no children** the only thing
 * `kind` changes is the rack border — the entire tile body is gated behind `children.length > 0`.
 * The board's own comment says why that gate exists: *"most real locations are flat (118 of 121 in
 * their legacy export), so that was the common case looking broken."* So on a real shop the board
 * was already a grid of labels, with worse density than a table and no sorting, no multi-select
 * and no bulk anything.
 *
 * The argument that killed the list view in the first place — *"Cabinet 1 alone exploded into 15
 * rows"* — was an artefact of the wizard, not of lists: the cabinet template generates 1 × 5 × 2 =
 * 16 nodes in a single pass. Stop making that the default way to create storage and a flat shop's
 * table is 12–18 rows in total.
 *
 * Twelve of twelve surveyed tools in this category present locations as a tree or a table; none
 * draws them. That is convergent evolution rather than user research, and it is worth saying out
 * loud that **no user has ever been observed using any storage UI here** — not the board, not the
 * deleted list, not this.
 *
 * ## Depth
 *
 * Unbounded, which the board never was: it could only draw three levels (unit → section →
 * compartment, with no recursion in the compartment renderer) while the generator permits four, so
 * a four-level tree was already partly invisible. Depth reads two ways — indentation, and the full
 * breadcrumb in the detail drawer.
 *
 * There was an `Inside` column too, counting child places. It went because the chevron already
 * says a row has children and the drawer already lists them, so it was a third telling of the
 * same fact — and on a flat shop (the reparenting decision measured 118 of 121 as flat) it is a
 * column of dashes. Its one distinct use, "how much is hidden under this collapsed row", did not
 * pay for a column on every visit.
 *
 * ## No selection checkboxes
 *
 * There were some, briefly, for bulk label printing — #648 listed bulk edit as a table advantage
 * and I took that as a requirement. It was arguing from a feature list rather than from a job.
 * The jobs that exist are covered: **Print all labels** for setup, and **Print QR** in the drawer
 * for one place and everything under it. Bulk-print-a-*subset* is the leftover, nobody has asked
 * for it twice, and a checkbox column charges every row on every visit for it. This page's own
 * principle is "design for the sustain, not the setup", and printing labels is setup.
 *
 * If it turns out to be real, a dialog with a checklist probably beats a selection mode in the
 * table: selection is then obviously scoped to printing, and the table never changes behaviour.
 *
 * ## Everything is a row, including Unassigned
 *
 * `Unassigned` is the auto-managed put-away pile, not a shelf. It sorts last and says so inline,
 * rather than being drawn as a different kind of object — the distinction is worth one sentence,
 * not a separate visual language.
 */

import { Fragment, useMemo, useState } from 'react';
import Box from '@mui/material/Box';
import IconButton from '@mui/material/IconButton';
import Paper from '@mui/material/Paper';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import KeyboardArrowRightIcon from '@mui/icons-material/KeyboardArrowRight';
import FactCheckOutlinedIcon from '@mui/icons-material/FactCheckOutlined';

import type { InventoryLocationNode } from '@/types/inventoryLocations';
import { occupancyFor, type OccupancyMap } from '@/utils/locationOccupancy';
import { SYSTEM_KIND } from '@/lib/locationKinds';

/**
 * Roots first by explicit order, `Unassigned` always last.
 *
 * Lifted from the deleted board, where the reasoning was recorded and still holds: the pile you
 * are trying to empty should not lead the page.
 */
export function placeOrder(a: InventoryLocationNode, b: InventoryLocationNode): number {
  const aSys = a.kind === SYSTEM_KIND ? 1 : 0;
  const bSys = b.kind === SYSTEM_KIND ? 1 : 0;
  if (aSys !== bSys) return aSys - bSys;
  return a.sort_order - b.sort_order || a.name.localeCompare(b.name);
}

/**
 * Empty vs has-stock, as a dot. Nothing here claims to know capacity.
 *
 * `display: inline-block` is load-bearing, not styling — kept verbatim from the board, where a
 * bare `<span>` defaulted to `display: inline`, **ignored width and height**, and rendered the
 * dot at zero width while every unit test passed. jsdom has no layout engine, so only a browser
 * caught it.
 */
function FillDot({ filled }: { filled: boolean }) {
  return (
    <Box
      component="span"
      sx={{
        display: 'inline-block',
        verticalAlign: 'middle',
        width: 7,
        height: 7,
        mr: 0.75,
        flexShrink: 0,
        borderRadius: '50%',
        border: filled ? 0 : '1px solid',
        borderColor: 'text.disabled',
        bgcolor: filled ? 'success.main' : 'transparent',
      }}
    />
  );
}

/** One row per node, parents before children, depth carried for indentation. */
function flatten(
  nodes: InventoryLocationNode[],
  collapsed: ReadonlySet<string>,
  depth = 0,
): Array<{ node: InventoryLocationNode; depth: number }> {
  const out: Array<{ node: InventoryLocationNode; depth: number }> = [];
  for (const node of [...nodes].sort(placeOrder)) {
    out.push({ node, depth });
    if (node.children.length > 0 && !collapsed.has(node.id)) {
      out.push(...flatten(node.children, collapsed, depth + 1));
    }
  }
  return out;
}

export interface LocationTableProps {
  tree: InventoryLocationNode[];
  occupancy: OccupancyMap;
  /** Open the per-place drawer, which owns every action on one place. */
  onOpen: (node: InventoryLocationNode) => void;
  /** Straight to that place's count worksheet, without the drawer. */
  onCountHere: (node: InventoryLocationNode) => void;
}

export default function LocationTable({ tree, occupancy, onOpen, onCountHere }: LocationTableProps) {
  /**
   * Collapsed, not expanded: the default is everything visible.
   *
   * At 12–18 places the whole shop fits on one screen, and a tree that starts closed makes you
   * click to discover you have nothing to discover. Collapsing is for the shop that grows.
   */
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());

  const rows = useMemo(() => flatten(tree, collapsed), [tree, collapsed]);

  const toggleCollapse = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <TableContainer component={Paper} elevation={2}>
      <Table size="small">
        <TableHead>
          <TableRow>
            <TableCell sx={{ fontWeight: 600 }}>Place</TableCell>
            <TableCell sx={{ fontWeight: 600 }}>Code</TableCell>
            <TableCell sx={{ fontWeight: 600 }}>Stock</TableCell>
            <TableCell sx={{ fontWeight: 600 }} align="right" />
          </TableRow>
        </TableHead>
        <TableBody>
          {rows.map(({ node, depth }) => {
            const occ = occupancyFor(occupancy, node.id);
            const isSystem = node.kind === SYSTEM_KIND;
            const countLabel = isSystem ? `Put away from ${node.name}` : `Count ${node.name}`;
            return (
              <Fragment key={node.id}>
                {/*
                  The WHOLE row opens the place. Only the name was clickable before, which left
                  most of a wide row as dead space.

                  Deliberately NOT "a parent row expands": that gives one gesture two meanings
                  depending on whether a row happens to have children, and it would cost parent
                  rows their drawer — where rename, print QR, photo and history live. Expanding is
                  the chevron's job, and it costs nothing to separate them because the drawer
                  already lists what is inside with each child clickable.

                  Mouse affordance only. The name stays a real <button> so the row is reachable and
                  announced by keyboard and screen reader without pretending a <tr> is a control.
                */}
                <TableRow
                  hover
                  onClick={() => onOpen(node)}
                  sx={{ cursor: 'pointer' }}
                >
                  <TableCell>
                    {/* Indentation is the depth signal. `pl` scales with depth rather than nesting
                        real elements, so a row stays one row at any depth. */}
                    <Box sx={{ display: 'flex', alignItems: 'center', pl: depth * 3 }}>
                      {node.children.length > 0 ? (
                        <IconButton
                          // The row opens the place; this must not also do that.
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleCollapse(node.id);
                          }}
                          aria-label={
                            collapsed.has(node.id) ? `Expand ${node.name}` : `Collapse ${node.name}`
                          }
                          /*
                           * 48px, like the count button at the end of this row — and for the same
                           * reason its comment gives: the theme applies the design system's 48px
                           * touch floor to Button, TextField and ListItemButton, but NOT to
                           * IconButton, so `size="small"` renders about 34px.
                           *
                           * That matters more here than anywhere else on the page, because this
                           * is a small target sitting inside a full-width tappable row that does
                           * something DIFFERENT — a near-miss opens the drawer instead of
                           * expanding. On a phone that is most taps.
                           */
                          sx={{ width: 48, height: 48, mr: 0.5 }}
                        >
                          {collapsed.has(node.id) ? (
                            <KeyboardArrowRightIcon fontSize="small" />
                          ) : (
                            <KeyboardArrowDownIcon fontSize="small" />
                          )}
                        </IconButton>
                      ) : (
                        // Keeps names aligned whether or not a row has children. Tracks the
                        // chevron's width above, including its right margin.
                        <Box sx={{ width: 52, flexShrink: 0 }} />
                      )}
                      <Box sx={{ minWidth: 0 }}>
                        <Typography
                          component="button"
                          onClick={(e: React.MouseEvent) => {
                            // Redundant with the row, but keeps a focusable control with a real
                            // accessible name. Stopped so the handler does not fire twice.
                            e.stopPropagation();
                            onOpen(node);
                          }}
                          sx={{
                            background: 'none',
                            border: 0,
                            p: 0,
                            font: 'inherit',
                            color: 'inherit',
                            cursor: 'pointer',
                            textAlign: 'left',
                            fontWeight: depth === 0 ? 600 : 400,
                            '&:hover': { textDecoration: 'underline' },
                          }}
                        >
                          {node.name}
                        </Typography>
                        {/* One sentence rather than a separate visual language: the pile is not a
                            shelf, and that is the only thing you need to know about it. */}
                        {isSystem && (
                          <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                            Parts with no recorded place yet — your put-away list, not a shelf.
                          </Typography>
                        )}
                      </Box>
                    </Box>
                  </TableCell>

                  <TableCell>
                    <Typography variant="body2" color="text.secondary">
                      {node.code || '—'}
                    </Typography>
                  </TableCell>

                  <TableCell>
                    {/* Rolled up, so a cabinet whose stock is all in its shelves never reads empty
                        — the roll-up bug this replaced was exactly that. Empty-vs-has-stock only;
                        nothing here claims to know capacity. */}
                    <Box sx={{ display: 'flex', alignItems: 'center' }}>
                      <FillDot filled={occ.hasStock} />
                      <Typography variant="body2" color={occ.hasStock ? 'text.primary' : 'text.secondary'}>
                        {occ.hasStock
                          ? `${occ.totalParts.toLocaleString()} ${occ.totalParts === 1 ? 'part' : 'parts'}`
                          : 'empty'}
                      </Typography>
                    </Box>
                  </TableCell>

                  <TableCell align="right">
                    {/* Tooltip and accessible name must agree. They didn't: sighted users read
                        "Put away from Unassigned" while a screen reader said "Count Unassigned".
                        The worksheet does both, and at the pile putting away is the real job. */}
                    <Tooltip title={countLabel}>
                      <IconButton
                        onClick={(e) => {
                          e.stopPropagation();
                          onCountHere(node);
                        }}
                        aria-label={countLabel}
                        sx={{ width: 48, height: 48 }}
                      >
                        <FactCheckOutlinedIcon />
                      </IconButton>
                    </Tooltip>
                  </TableCell>
                </TableRow>
              </Fragment>
            );
          })}
        </TableBody>
      </Table>
    </TableContainer>
  );
}
