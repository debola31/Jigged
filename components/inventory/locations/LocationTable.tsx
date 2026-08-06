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
 * **You traverse one branch at a time.** Opening a place closes whatever else was open, so the
 * table never shows two siblings' contents at once and indentation never has to carry more than a
 * single chain. See `openPath` below for why that is a path and not a set of expanded ids.
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

/**
 * One row per node, parents before children, depth carried for indentation.
 *
 * `ancestors` rides along so a row can compute what the open path becomes when its chevron is
 * clicked, without a second walk to find where it sits.
 */
function flatten(
  nodes: InventoryLocationNode[],
  openPath: readonly string[],
  depth = 0,
  ancestors: readonly string[] = [],
): Array<{ node: InventoryLocationNode; depth: number; ancestors: readonly string[] }> {
  const out: Array<{ node: InventoryLocationNode; depth: number; ancestors: readonly string[] }> =
    [];
  for (const node of [...nodes].sort(placeOrder)) {
    out.push({ node, depth, ancestors });
    if (node.children.length > 0 && openPath.includes(node.id)) {
      out.push(...flatten(node.children, openPath, depth + 1, [...ancestors, node.id]));
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
   * ONE open branch in the whole table, held as the chain of ids from a root down to the deepest
   * open node. Empty means roots only.
   *
   * ## Why this replaced "everything starts expanded"
   *
   * The previous state was a set of *collapsed* ids defaulting to empty, on the reasoning that at
   * 12–18 places the whole shop fits on one screen and a tree that starts closed makes you click
   * to discover you have nothing to discover. That reasoning does not survive contact with a
   * generated cabinet: the builder's own default is 5 rows × 2 bins, so **one** subdivide turns a
   * single row into 16, and a shop with three such cabinets renders 50 rows of which two matter.
   * You are not reading a shop, you are scrolling past one.
   *
   * An accordion also cannot express "everything expanded" — siblings would start co-open, which
   * is precisely the state being removed — so default-collapsed is not a separate decision, it is
   * the same one.
   *
   * ## Why a path rather than a set
   *
   * "At most one open node per parent" and "at most one open branch overall" differ only in what
   * happens to a second root, and a path makes the stricter answer the only representable one:
   * opening a node sets the path to its own ancestry plus itself, so anything not on that chain is
   * closed by construction rather than by a cleanup pass that could be forgotten.
   */
  const [openPath, setOpenPath] = useState<readonly string[]>([]);

  const rows = useMemo(() => flatten(tree, openPath), [tree, openPath]);

  /** Open this node (closing whatever else was open), or close it and keep its ancestors open. */
  const toggleOpen = (id: string, ancestors: readonly string[]) =>
    setOpenPath((prev) => (prev.includes(id) ? [...ancestors] : [...ancestors, id]));

  return (
    <TableContainer component={Paper} elevation={2}>
      <Table size="small">
        <TableHead>
          <TableRow>
            <TableCell sx={{ fontWeight: 600 }}>Place</TableCell>
            <TableCell sx={{ fontWeight: 600 }}>Stock</TableCell>
            <TableCell sx={{ fontWeight: 600 }} align="right" />
          </TableRow>
        </TableHead>
        <TableBody>
          {rows.map(({ node, depth, ancestors }) => {
            const occ = occupancyFor(occupancy, node.id);
            const isSystem = node.kind === SYSTEM_KIND;
            const countLabel = isSystem ? `Put away from ${node.name}` : `Count ${node.name}`;
            const isOpen = openPath.includes(node.id);
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
                            toggleOpen(node.id, ancestors);
                          }}
                          aria-label={isOpen ? `Collapse ${node.name}` : `Expand ${node.name}`}
                          // Says the same thing to assistive tech that the chevron says visually.
                          // The label alone flips wording without ever announcing a state.
                          aria-expanded={isOpen}
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
                          {isOpen ? (
                            <KeyboardArrowDownIcon fontSize="small" />
                          ) : (
                            <KeyboardArrowRightIcon fontSize="small" />
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
                    {/* Offered on containers too, where it counts everything in the bins beneath.

                        A container holds no stock of its own (20260806160053), so this briefly did
                        nothing and was briefly hidden. Both were wrong: "count this cabinet"
                        obviously means its bins, which is also how you would physically do it, and
                        `commitCount` already writes each line at its own bin — so the worksheet
                        needed a wider read, not the button taking away.

                        Tooltip and accessible name must agree. They didn't: sighted users read
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
