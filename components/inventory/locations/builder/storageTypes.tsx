/**
 * The visual builder's storage-type palette. Each type is a recognizable card
 * (concrete MUI icon + always-visible label, per NN/g) that doubles as a
 * starter template: picking it seeds a sensible layout the owner then tweaks.
 * `kind` values come from the shared `lib/locationKinds.ts` vocabulary.
 *
 * Two lists, because the container matters:
 *
 * - `STORAGE_TYPES` builds a NEW top-level unit, so level 0 *is* the container.
 * - `SUBDIVISION_TYPES` divides a unit that already exists, so level 0 is what goes *inside* it.
 *
 * They cannot be the same list. Every `STORAGE_TYPES` entry's level 0 is the container itself, so
 * reusing them while subdividing Cabinet 3 would create `Cabinet 3 › Cabinet 1 › Row 1 › Left` —
 * a nested cabinet inside a cabinet. `slice(1)` isn't the fix either: a sliced `Bins` or
 * `Single shelf` is an empty spec that creates nothing.
 */
import type { SvgIconComponent } from '@mui/icons-material';
import Inventory2Outlined from '@mui/icons-material/Inventory2Outlined';
import ViewModuleOutlined from '@mui/icons-material/ViewModuleOutlined';
import DnsOutlined from '@mui/icons-material/DnsOutlined';
import GridViewOutlined from '@mui/icons-material/GridViewOutlined';
import TableRowsOutlined from '@mui/icons-material/TableRowsOutlined';
import AllInboxOutlined from '@mui/icons-material/AllInboxOutlined';
import ViewColumnOutlined from '@mui/icons-material/ViewColumnOutlined';
import DashboardOutlined from '@mui/icons-material/DashboardOutlined';
import ParkOutlined from '@mui/icons-material/ParkOutlined';
import HandymanOutlined from '@mui/icons-material/HandymanOutlined';
import VerticalSplitOutlined from '@mui/icons-material/VerticalSplitOutlined';

import type { LevelSpec } from '@/types/inventoryLocations';

export interface StorageType {
  id: string;
  label: string;
  description: string;
  Icon: SvgIconComponent;
  /** Seeded layout (shallow → deep); the deepest level becomes the leaves. */
  defaultLevels: LevelSpec[];
}

export const STORAGE_TYPES: StorageType[] = [
  {
    id: 'cabinet',
    label: 'Cabinet',
    description: 'Rows of bins or drawers',
    Icon: Inventory2Outlined,
    defaultLevels: [
      { kind: 'cabinet', count: 1, namePattern: 'Cabinet {n}' },
      { kind: 'row', count: 5, namePattern: 'Row {n}' },
      { kind: 'bin', names: ['Left', 'Right'] },
    ],
  },
  {
    id: 'shelving',
    label: 'Shelving unit',
    description: 'A unit with several shelves',
    Icon: ViewModuleOutlined,
    defaultLevels: [
      { kind: 'shelving', count: 1, namePattern: 'Shelving {n}' },
      { kind: 'shelf', count: 5, namePattern: 'Shelf {n}' },
    ],
  },
  {
    id: 'rack',
    label: 'Pallet rack',
    description: 'Bays × levels × positions',
    Icon: DnsOutlined,
    defaultLevels: [
      { kind: 'rack', count: 1, namePattern: 'Rack {n}' },
      { kind: 'level', count: 4, namePattern: 'Level {n}' },
      { kind: 'position', count: 3, namePattern: 'Position {n}' },
    ],
  },
  {
    id: 'drawer-unit',
    label: 'Drawer unit',
    description: 'A tower of drawers',
    Icon: GridViewOutlined,
    defaultLevels: [
      { kind: 'drawer unit', count: 1, namePattern: 'Drawer unit {n}' },
      { kind: 'drawer', count: 6, namePattern: 'Drawer {n}' },
    ],
  },
  {
    id: 'shelf',
    label: 'Single shelf',
    description: 'One stockable shelf',
    Icon: TableRowsOutlined,
    defaultLevels: [{ kind: 'shelf', count: 1, namePattern: 'Shelf {n}' }],
  },
  {
    id: 'bins',
    label: 'Bins',
    description: 'A set of loose bins',
    Icon: AllInboxOutlined,
    defaultLevels: [{ kind: 'bin', count: 6, namePattern: 'Bin {n}' }],
  },
  {
    id: 'aisle',
    label: 'Aisle / zone',
    description: 'A broad area to fill in',
    Icon: ViewColumnOutlined,
    defaultLevels: [
      { kind: 'aisle', count: 1, namePattern: 'Aisle {n}' },
      { kind: 'bay', count: 4, namePattern: 'Bay {n}' },
    ],
  },

  /*
   * The honest single-level places.
   *
   * Their own export said the multi-level wizard solves a problem this shop has never had —
   * **118 of 121 legacy locations were flat** — and a fair share of the real names were places
   * rather than furniture. A palette that only offers structures forces "on the floor by the
   * saw" to be modelled as a cabinet, which is how a location list stops matching the shop.
   * Single-level is the whole point of these three, not a limitation of them.
   */
  {
    id: 'floor',
    label: 'Floor space',
    description: 'On the ground, marked off',
    Icon: DashboardOutlined,
    defaultLevels: [{ kind: 'floor', count: 1, namePattern: 'Floor space {n}' }],
  },
  {
    id: 'outside',
    label: 'Outside / yard',
    description: 'Stored out back',
    Icon: ParkOutlined,
    defaultLevels: [{ kind: 'outside', count: 1, namePattern: 'Yard {n}' }],
  },
  {
    id: 'bench',
    label: 'Bench',
    description: 'At or under a workbench',
    Icon: HandymanOutlined,
    defaultLevels: [{ kind: 'bench', count: 1, namePattern: 'Bench {n}' }],
  },

  /*
   * NO BAR RACK CARD — deliberately, and this comment is the reason it stays out.
   *
   * §5.5's decision 4 asserts a bar/tube rack is "the defining storage object in a machine shop",
   * which is an intuition worth acting on. But §9 of the same document records that Contour's 22
   * real places contain **no rack of any kind**, and marks the claim *weakly refuted*. Adding the
   * card on the strength of the intuition would be building for a shop we imagined instead of the
   * one whose data we have.
   *
   * Without this note someone re-adds it in three months on exactly the same intuition. If a
   * pilot shop ever asks for it, that's evidence and it goes in — the question is open, not
   * closed.
   */
];

/**
 * Ways to divide a unit that already exists.
 *
 * Level 0 here is what goes *inside* the container, never the container itself — see the module
 * comment for the nested-cabinet bug this exists to prevent.
 */
export const SUBDIVISION_TYPES: StorageType[] = [
  {
    id: 'rows-sides',
    label: 'Rows × sides',
    description: 'Rows, each split left/right',
    Icon: Inventory2Outlined,
    defaultLevels: [
      { kind: 'row', count: 5, namePattern: 'Row {n}' },
      { kind: 'bin', names: ['Left', 'Right'] },
    ],
  },
  {
    id: 'rows',
    label: 'Rows',
    description: 'A stack of rows',
    Icon: VerticalSplitOutlined,
    defaultLevels: [{ kind: 'row', count: 5, namePattern: 'Row {n}' }],
  },
  {
    id: 'shelves',
    label: 'Shelves',
    description: 'A stack of shelves',
    Icon: ViewModuleOutlined,
    defaultLevels: [{ kind: 'shelf', count: 5, namePattern: 'Shelf {n}' }],
  },
  {
    id: 'drawers',
    label: 'Drawers',
    description: 'A tower of drawers',
    Icon: GridViewOutlined,
    defaultLevels: [{ kind: 'drawer', count: 6, namePattern: 'Drawer {n}' }],
  },
  {
    id: 'bins',
    label: 'Bins',
    description: 'A set of bins inside',
    Icon: AllInboxOutlined,
    defaultLevels: [{ kind: 'bin', count: 6, namePattern: 'Bin {n}' }],
  },
  {
    id: 'sides',
    label: 'Sides',
    description: 'Just left and right',
    Icon: TableRowsOutlined,
    defaultLevels: [{ kind: 'side', names: ['Left', 'Right'] }],
  },
  {
    id: 'levels-positions',
    label: 'Levels × positions',
    description: 'Levels, each with positions',
    Icon: DnsOutlined,
    defaultLevels: [
      { kind: 'level', count: 4, namePattern: 'Level {n}' },
      { kind: 'position', count: 3, namePattern: 'Position {n}' },
    ],
  },
];

/** Deep-clone a type's seed levels so edits don't mutate the shared template. */
export function cloneLevels(levels: LevelSpec[]): LevelSpec[] {
  return levels.map((l) => ({ ...l, names: l.names ? [...l.names] : undefined }));
}
