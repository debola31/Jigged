/**
 * The visual builder's storage-type palette. Each type is a recognizable card
 * (concrete MUI icon + always-visible label, per NN/g) that doubles as a
 * starter template: picking it seeds a sensible multi-level layout the owner
 * then tweaks. `kind` values map onto the existing KIND_SUGGESTIONS taxonomy.
 */
import type { SvgIconComponent } from '@mui/icons-material';
import Inventory2Outlined from '@mui/icons-material/Inventory2Outlined';
import ViewModuleOutlined from '@mui/icons-material/ViewModuleOutlined';
import DnsOutlined from '@mui/icons-material/DnsOutlined';
import GridViewOutlined from '@mui/icons-material/GridViewOutlined';
import TableRowsOutlined from '@mui/icons-material/TableRowsOutlined';
import AllInboxOutlined from '@mui/icons-material/AllInboxOutlined';
import ViewColumnOutlined from '@mui/icons-material/ViewColumnOutlined';

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
];

/** Deep-clone a type's seed levels so edits don't mutate the shared template. */
export function cloneLevels(levels: LevelSpec[]): LevelSpec[] {
  return levels.map((l) => ({ ...l, names: l.names ? [...l.names] : undefined }));
}
