import { z } from 'zod';

import { rollUpByPart } from '@/lib/inventoryOnHand';
import { compareLocationNames, computePathNames } from '@/lib/locationTree';
import { defineCompanyTool, registerCompanyTool, type CompanyToolEnv, type ToolTarget } from '@/lib/mcp/defineTool';
import {
  BAD_CURSOR_MESSAGE,
  DEFAULT_PAGE,
  MAX_PAGE,
  companyLink,
  isAdmin,
  matchesText,
  pageInput,
  pageOutput,
  paginate,
  urlOutput,
} from '@/lib/mcp/tools/shared';
import { ID_CHUNK } from '@/lib/queryLimits';
import { getSupabase } from '@/lib/supabase';
import type { InventoryLocation, InventoryLocationNode, LocationContent } from '@/types/inventoryLocations';
import {
  buildLocationTree,
  getContentsPageForLocations,
  getLocationOccupancy,
  getLocations,
} from '@/utils/inventoryLocationsAccess';
import { ON_HAND_ROW_CEILING, getStorageOnHand, type OnHandRow } from '@/utils/inventoryOnHandAccess';
import { occupancyFor, rollUpOccupancy } from '@/utils/locationOccupancy';
import { getPartTransactions } from '@/utils/partsAccess';
import { getOnOrderForParts } from '@/utils/vendorPoAccess';

/**
 * Storage, read-only: what the shop holds, where, and how it moved.
 *
 * MONEY: inventory cost and value go to admins only, mirroring the Storage page, which renders
 * them only when `isAdmin` (docs/modules/inventory.md §5.15). Non-admins get null in those fields.
 *
 * ON ORDER (search_inventory): what is coming on purchase orders to vendors, from `part_on_order`
 * through getOnOrderForParts — the places drawer's "Also on order" line. Quantities, not money, so
 * every office user gets them.
 *
 * PEOPLE: nothing here says who moved, counted, issued or received stock. The ledger rows carry
 * `operator_id` / `created_by` and `getPartTransactions` resolves names from them; every one of
 * those is dropped by building each output object field by field. That holds for admins too.
 */

export const PATH_SEPARATOR = ' › ';

/** PostgREST's `max_rows`: one read returns at most this many rows. */
const READ_PAGE = 1000;

export const ADMIN_ONLY = 'Only for company admins; null otherwise.';

// ---------------------------------------------------------------------------------------------
// Location tree
// ---------------------------------------------------------------------------------------------

export interface LocationIndex {
  byId: Map<string, InventoryLocation>;
  childrenOf: Map<string, InventoryLocation[]>;
  /** "Rack A › Shelf 2 › Bin 3", outermost first. */
  pathOf: (id: string) => string;
  /** Lower-cased, trimmed path segments, for matching a typed name. */
  segmentsOf: (id: string) => string[];
  /** The storage unit at the top of the tree: what the Storage board's `?unit=` selects. */
  rootOf: (id: string) => string;
}

export function indexLocations(locations: InventoryLocation[]): LocationIndex {
  const byId = new Map(locations.map((l) => [l.id, l] as const));
  const childrenOf = new Map<string, InventoryLocation[]>();
  for (const loc of locations) {
    if (!loc.parent_id || !byId.has(loc.parent_id)) continue;
    const siblings = childrenOf.get(loc.parent_id) ?? [];
    siblings.push(loc);
    childrenOf.set(loc.parent_id, siblings);
  }
  const names = new Map<string, string[]>();
  const namesOf = (id: string): string[] => {
    let cached = names.get(id);
    if (!cached) {
      cached = computePathNames(id, byId);
      names.set(id, cached);
    }
    return cached;
  };
  const rootOf = (id: string): string => {
    const seen = new Set<string>();
    let current = id;
    for (;;) {
      const parent = byId.get(current)?.parent_id;
      if (!parent || !byId.has(parent) || seen.has(parent)) return current;
      seen.add(parent);
      current = parent;
    }
  };
  return {
    byId,
    childrenOf,
    pathOf: (id) => namesOf(id).join(PATH_SEPARATOR),
    segmentsOf: (id) => namesOf(id).map(normaliseSegment),
    rootOf,
  };
}

function normaliseSegment(s: string): string {
  return s.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** "Rack A › Shelf 2", "Rack A / Shelf 2" and "Rack A > Shelf 2" all name the same place. */
function splitTypedPath(raw: string): string[] {
  return raw
    .split(/[›/>]/)
    .map(normaliseSegment)
    .filter((s) => s.length > 0);
}

function endsWith(path: string[], tail: string[]): boolean {
  if (tail.length === 0 || tail.length > path.length) return false;
  const offset = path.length - tail.length;
  return tail.every((seg, i) => path[offset + i] === seg);
}

/** The location and every location inside it that has no children: where stock can sit. */
function binsUnder(id: string, places: LocationIndex): string[] {
  const bins: string[] = [];
  const seen = new Set<string>();
  const stack = [id];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined || seen.has(current)) continue;
    seen.add(current);
    const children = places.childrenOf.get(current) ?? [];
    if (children.length === 0) bins.push(current);
    for (const child of children) stack.push(child.id);
  }
  return bins;
}

export function locationLink(env: CompanyToolEnv, places: LocationIndex, id: string): string | null {
  return companyLink(env, `/inventory/locations?view=places&unit=${places.rootOf(id)}`);
}

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// ---------------------------------------------------------------------------------------------
// Balances: one (part, location, lot) row each
// ---------------------------------------------------------------------------------------------

interface Balance {
  locationId: string;
  quantity: number;
  lotId: string | null;
  lotCode: string | null;
  heatNumber: string | null;
}

export const lotOutput = z.object({
  lot_code: z.string().nullable(),
  heat_number: z.string().nullable(),
  quantity: z.number().describe('How much of this lot is here, in the part\'s unit.'),
});

export const LOTS_HELP = 'The lots (heats) held here, most first, for lot-tracked material; empty otherwise.';

type LotOut = z.infer<typeof lotOutput>;

function lotsOf(balances: Balance[]): LotOut[] {
  return balances
    .filter((b) => b.lotId !== null)
    .map((b) => ({ lot_code: b.lotCode, heat_number: b.heatNumber, quantity: b.quantity }))
    .sort((a, b) => b.quantity - a.quantity);
}

const placeOutput = z.object({
  location_id: z.string(),
  location: z.string().describe(`Full path, outermost first, e.g. "Rack A${PATH_SEPARATOR}Shelf 2".`),
  quantity: z.number().describe('How much is here, in the part\'s unit.'),
  lots: z.array(lotOutput).describe(LOTS_HELP),
});

type PlaceOut = z.infer<typeof placeOutput>;

function placesOf(balances: Balance[], places: LocationIndex): PlaceOut[] {
  const byLocation = new Map<string, Balance[]>();
  for (const b of balances) {
    const list = byLocation.get(b.locationId) ?? [];
    list.push(b);
    byLocation.set(b.locationId, list);
  }
  return [...byLocation.entries()]
    .map(([locationId, here]) => ({
      location_id: locationId,
      location: places.pathOf(locationId),
      quantity: here.reduce((sum, b) => sum + b.quantity, 0),
      lots: lotsOf(here),
    }))
    .sort((a, b) => compareLocationNames(a.location, b.location));
}

/** Summed money, rounded to the cent; null when none of it has a cost (never a zero). */
export function sumMoney(values: Array<number | null>): number | null {
  let total = 0;
  let any = false;
  for (const v of values) {
    if (v === null) continue;
    total += v;
    any = true;
  }
  return any ? Math.round(total * 100) / 100 : null;
}

// ---------------------------------------------------------------------------------------------
// search_inventory
// ---------------------------------------------------------------------------------------------

interface PartDetail {
  description: string | null;
  lotTracked: boolean;
}

/** Description and the lot-tracking flag for the stocked parts. By id, so no archive filter. */
async function readPartDetails(companyId: string, partIds: string[]): Promise<Map<string, PartDetail>> {
  const out = new Map<string, PartDetail>();
  const pages = await Promise.all(
    chunks(partIds, ID_CHUNK).map(async (ids) => {
      const { data, error } = await getSupabase()
        .from('parts')
        .select('id, description, lot_tracked')
        .eq('company_id', companyId)
        .in('id', ids);
      if (error) throw error;
      return data ?? [];
    }),
  );
  for (const row of pages.flat()) out.set(row.id, { description: row.description, lotTracked: row.lot_tracked });
  return out;
}

const stockPartOutput = z.object({
  part_id: z.string(),
  part_name: z.string(),
  description: z.string().nullable(),
  on_hand: z.number().describe('Total on hand across every location, in `unit`.'),
  unit: z.string().nullable(),
  lot_tracked: z.boolean().describe('Whether this part\'s stock is tracked by lot (heat number).'),
  locations: z.array(placeOutput),
  last_moved_at: z.string().nullable().describe('When this part\'s stock last moved anywhere.'),
  cost_per_unit: z
    .number()
    .nullable()
    .describe(`Purchase cost of one \`unit\`, at the price break for the quantity on hand. ${ADMIN_ONLY}`),
  inventory_value: z
    .number()
    .nullable()
    .describe(`What the stock on hand cost, in the company's currency. ${ADMIN_ONLY}`),
  cost_gap: z
    .enum(['no_cost_tier', 'made'])
    .nullable()
    .describe(
      'Why the part has no cost on file: `no_cost_tier` (no purchase cost recorded) or `made` ' +
        '(a made part, costed from its routing instead). Null when it has one.',
    ),
  on_order: z.number().describe('On sent purchase orders to vendors and still to arrive, in `unit`.'),
  on_draft: z.number().describe('On draft purchase orders not sent yet, in `unit`: not on order.'),
  next_expected_on: z.string().nullable().describe('When the next of what is on order is expected.'),
  url: urlOutput,
});

export const searchInventory = defineCompanyTool({
  name: 'search_inventory',
  title: 'Search inventory',
  description:
    'Lists the stock a Jigged company holds, one entry per part: the total on hand and its unit, ' +
    'each storage location holding it with the quantity there, and the lots (heat numbers) of ' +
    'lot-tracked material, and what is on order for it on purchase orders to vendors. Search ' +
    'matches part number, description, heat or lot number, or the name of a location holding it. ' +
    'Admins also get the cost per unit and the value of the stock. Sorted by part number.',
  access: 'read',
  input: {
    search: z.string().optional().describe('Part number, description, heat or lot number, or a location name.'),
    ...pageInput,
  },
  output: {
    parts: z.array(stockPartOutput),
    ...pageOutput,
    truncated: z
      .boolean()
      .describe('True when the shop holds more stock records than one read covers, so some parts are missing.'),
  },
  run: async (args, env) => {
    const [onHand, locations] = await Promise.all([
      getStorageOnHand(env.company.id),
      getLocations(env.company.id),
    ]);
    const places = indexLocations(locations);
    const balancesByPart = new Map<string, OnHandRow[]>();
    for (const row of onHand.rows) {
      const list = balancesByPart.get(row.partId) ?? [];
      list.push(row);
      balancesByPart.set(row.partId, list);
    }
    const details = await readPartDetails(env.company.id, [...balancesByPart.keys()]);

    // `searchText` already carries the part number, every location path and every heat and lot.
    const matches = rollUpByPart(onHand.rows, places.pathOf).filter((part) =>
      matchesText(args.search, part.searchText, details.get(part.partId)?.description),
    );
    const page = paginate(matches, args);
    if (!page) return { ok: false, message: BAD_CURSOR_MESSAGE };

    const admin = isAdmin(env);
    const coming = await getOnOrderForParts(
      env.company.id,
      page.items.map((part) => part.partId),
    );
    return {
      ok: true,
      data: {
        parts: page.items.map((part) => {
          const detail = details.get(part.partId);
          const onOrder = coming.get(part.partId);
          return {
            part_id: part.partId,
            part_name: part.partName,
            description: detail?.description ?? null,
            on_hand: part.quantity,
            unit: part.primaryUnit,
            lot_tracked: detail?.lotTracked ?? false,
            locations: placesOf(balancesByPart.get(part.partId) ?? [], places),
            last_moved_at: part.lastMovedAt,
            cost_per_unit: admin ? part.costPerUnit : null,
            inventory_value: admin ? part.onHandCost : null,
            cost_gap: part.gap,
            // Loaded, so a part with nothing coming is a true 0, never unknown.
            on_order: onOrder?.onOrder ?? 0,
            on_draft: onOrder?.onDraft ?? 0,
            next_expected_on: onOrder?.nextExpectedOn ?? null,
            url: companyLink(env, `/parts/${part.partId}`),
          };
        }),
        total: page.total,
        next_cursor: page.next_cursor,
        truncated: onHand.truncated,
      },
    };
  },
});

// ---------------------------------------------------------------------------------------------
// list_locations
// ---------------------------------------------------------------------------------------------

const locationSummary = z.object({
  location_id: z.string(),
  name: z.string(),
  path: z.string().describe(`Full path, outermost first, e.g. "Rack A${PATH_SEPARATOR}Shelf 2".`),
  parent_id: z.string().nullable(),
  sub_location_count: z
    .number()
    .describe('Locations directly inside this one. Stock sits only in locations with none.'),
  part_placements: z
    .number()
    .describe(
      'Parts stored here or anywhere inside it, counted once per location holding them: a part in ' +
        'two bins counts twice.',
    ),
  url: urlOutput,
});

/** Depth-first, parents before children, siblings in the order the Storage board shows them. */
function inTreeOrder(roots: InventoryLocationNode[]): InventoryLocationNode[] {
  const out: InventoryLocationNode[] = [];
  const visit = (node: InventoryLocationNode) => {
    out.push(node);
    for (const child of node.children) visit(child);
  };
  for (const root of roots) visit(root);
  return out;
}

export const listLocations = defineCompanyTool({
  name: 'list_locations',
  title: 'List storage locations',
  description:
    'Lists the storage locations of a Jigged company (cabinets, racks, shelves, bins), each with ' +
    'its full path, its parent, how many locations sit directly inside it, and how many part ' +
    'placements it and everything inside it hold. Search matches any part of the path. In ' +
    'storage-tree order: each location followed by the ones inside it.',
  access: 'read',
  input: {
    search: z.string().optional().describe('Text to match in the location\'s name or path.'),
    ...pageInput,
  },
  output: { locations: z.array(locationSummary), ...pageOutput },
  run: async (args, env) => {
    const [locations, directPartCounts] = await Promise.all([
      getLocations(env.company.id),
      getLocationOccupancy(env.company.id),
    ]);
    const places = indexLocations(locations);
    const roots = buildLocationTree(locations);
    const occupancy = rollUpOccupancy(roots, directPartCounts);
    const rows = inTreeOrder(roots).filter((loc) => matchesText(args.search, places.pathOf(loc.id)));
    const page = paginate(rows, args);
    if (!page) return { ok: false, message: BAD_CURSOR_MESSAGE };
    return {
      ok: true,
      data: {
        locations: page.items.map((loc) => ({
          location_id: loc.id,
          name: loc.name,
          path: places.pathOf(loc.id),
          parent_id: loc.parent_id,
          sub_location_count: loc.children.length,
          part_placements: occupancyFor(occupancy, loc.id).totalParts,
          url: locationLink(env, places, loc.id),
        })),
        total: page.total,
        next_cursor: page.next_cursor,
      },
    };
  },
});

// ---------------------------------------------------------------------------------------------
// get_location_contents
// ---------------------------------------------------------------------------------------------

const NAME_THE_LOCATION = 'Give a location_id or a location name or path.';
const AMBIGUOUS_LISTED = 10;

/** The location a tool names by id, name or path, or a sentence saying why there isn't one. */
export function findLocation(
  args: { location_id?: string; location?: string },
  places: LocationIndex,
  env: CompanyToolEnv,
): { location: InventoryLocation } | { message: string } {
  if (args.location_id) {
    const byId = places.byId.get(args.location_id);
    return byId ? { location: byId } : { message: `There is no location with that id in ${env.company.name}.` };
  }
  const raw = args.location?.trim();
  if (!raw) return { message: NAME_THE_LOCATION };

  const wanted = splitTypedPath(raw);
  const whole = normaliseSegment(raw);
  const all = [...places.byId.values()];
  const exact = all.filter((loc) => {
    const path = places.segmentsOf(loc.id);
    return path.length === wanted.length && endsWith(path, wanted);
  });
  const candidates =
    exact.length > 0
      ? exact
      : all.filter((loc) => normaliseSegment(loc.name) === whole || endsWith(places.segmentsOf(loc.id), wanted));

  if (candidates.length === 1) return { location: candidates[0] };
  if (candidates.length === 0) return { message: `There is no location called "${raw}" in ${env.company.name}.` };
  const paths = candidates.map((loc) => places.pathOf(loc.id)).sort(compareLocationNames);
  const listed = paths.slice(0, AMBIGUOUS_LISTED).join('; ');
  const more = paths.length > AMBIGUOUS_LISTED ? `; and ${paths.length - AMBIGUOUS_LISTED} more` : '';
  return {
    message:
      `${candidates.length} locations in ${env.company.name} match "${raw}": ${listed}${more}. ` +
      'Give the full path or a location_id.',
  };
}

/** Every balance at these bins, live parts only (the access function filters archived ones). */
async function readContents(bins: string[]): Promise<{ rows: LocationContent[]; truncated: boolean }> {
  const rows: LocationContent[] = [];
  const groups = chunks(bins, ID_CHUNK);
  for (const [i, ids] of groups.entries()) {
    for (let offset = 0; ; offset += READ_PAGE) {
      const page = await getContentsPageForLocations(ids, { limit: READ_PAGE, offset });
      rows.push(...page.contents);
      // `total` is the exact count for these bins, so it says whether another page exists.
      const more = offset + READ_PAGE < page.total;
      if (!more) break;
      if (rows.length >= ON_HAND_ROW_CEILING) return { rows, truncated: true };
    }
    // Same bound as the Storage page's read: stop rather than keep fetching, and say so.
    if (rows.length >= ON_HAND_ROW_CEILING && i < groups.length - 1) return { rows, truncated: true };
  }
  return { rows, truncated: false };
}

export function balanceKey(partId: string, locationId: string, lotId: string | null): string {
  return `${partId}|${locationId}|${lotId ?? ''}`;
}

/** What each balance at these bins cost, keyed by balanceKey. Admins only; the caller checks. */
export async function readBalanceValues(companyId: string, bins: string[]): Promise<Map<string, number | null>> {
  const out = new Map<string, number | null>();
  for (const ids of chunks(bins, ID_CHUNK)) {
    for (let offset = 0; ; offset += READ_PAGE) {
      const { data, error } = await getSupabase()
        .from('inventory_on_hand_cost')
        .select('part_id, location_id, lot_id, on_hand_cost')
        .eq('company_id', companyId)
        .in('location_id', ids)
        .order('balance_id')
        .range(offset, offset + READ_PAGE - 1);
      if (error) throw error;
      const page = data ?? [];
      for (const row of page) {
        if (!row.part_id || !row.location_id) continue;
        out.set(
          balanceKey(row.part_id, row.location_id, row.lot_id),
          row.on_hand_cost === null ? null : Number(row.on_hand_cost),
        );
      }
      if (page.length < READ_PAGE) break;
    }
  }
  return out;
}

interface Holding {
  partId: string;
  partName: string;
  unit: string | null;
  locationId: string;
  location: string;
  balances: LocationContent[];
}

const holdingOutput = z.object({
  part_id: z.string(),
  part_name: z.string(),
  location_id: z.string().describe('The location this row is in: the one asked about, or one inside it.'),
  location: z.string().describe('Its full path, outermost first.'),
  quantity: z.number().describe('How much of the part is in that location, in `unit`.'),
  unit: z.string().nullable(),
  lots: z.array(lotOutput).describe(LOTS_HELP),
  inventory_value: z.number().nullable().describe(`What this stock cost, in the company's currency. ${ADMIN_ONLY}`),
  url: urlOutput.describe('The part\'s page in Jigged.'),
});

export const getLocationContents = defineCompanyTool({
  name: 'get_location_contents',
  title: 'Get a location\'s contents',
  description:
    'Lists the parts stored at one storage location, with quantity, unit and lots (heat numbers). ' +
    'For a location that contains others (a cabinet or rack), it lists what is in every location ' +
    'inside it, each row naming its own location. Find the location by id, by name, or by path ' +
    `("Rack A${PATH_SEPARATOR}Shelf 2"). Admins also get the value of each row's stock.`,
  access: 'read',
  input: {
    location_id: z.guid().optional().describe('The location, by id.'),
    location: z
      .string()
      .optional()
      .describe(`The location, by name or path ("Rack A${PATH_SEPARATOR}Shelf 2"), when you have no id.`),
    ...pageInput,
  },
  output: {
    location_id: z.string(),
    name: z.string(),
    path: z.string(),
    contents: z.array(holdingOutput),
    ...pageOutput,
    truncated: z.boolean().describe('True when the location holds more stock records than one read covers.'),
    url: urlOutput,
  },
  run: async (args, env) => {
    const places = indexLocations(await getLocations(env.company.id));
    const found = findLocation(args, places, env);
    if ('message' in found) return { ok: false, message: found.message };
    const { location } = found;

    const { rows, truncated } = await readContents(binsUnder(location.id, places));
    const holdings = new Map<string, Holding>();
    for (const row of rows) {
      const key = `${row.part_id}|${row.location_id}`;
      const holding = holdings.get(key) ?? {
        partId: row.part_id,
        partName: row.part_name,
        unit: row.primary_unit,
        locationId: row.location_id,
        location: places.pathOf(row.location_id),
        balances: [],
      };
      holding.balances.push(row);
      holdings.set(key, holding);
    }
    const ordered = [...holdings.values()].sort(
      (a, b) => compareLocationNames(a.location, b.location) || compareLocationNames(a.partName, b.partName),
    );
    const page = paginate(ordered, args);
    if (!page) return { ok: false, message: BAD_CURSOR_MESSAGE };

    const values = isAdmin(env)
      ? await readBalanceValues(env.company.id, [...new Set(page.items.map((h) => h.locationId))])
      : null;

    return {
      ok: true,
      data: {
        location_id: location.id,
        name: location.name,
        path: places.pathOf(location.id),
        contents: page.items.map((h) => {
          const balances: Balance[] = h.balances.map((b) => ({
            locationId: b.location_id,
            quantity: b.quantity,
            lotId: b.lot_id,
            lotCode: b.lot_code,
            heatNumber: b.heat_number,
          }));
          return {
            part_id: h.partId,
            part_name: h.partName,
            location_id: h.locationId,
            location: h.location,
            quantity: balances.reduce((sum, b) => sum + b.quantity, 0),
            unit: h.unit,
            lots: lotsOf(balances),
            inventory_value: values
              ? sumMoney(h.balances.map((b) => values.get(balanceKey(b.part_id, b.location_id, b.lot_id)) ?? null))
              : null,
            url: companyLink(env, `/parts/${h.partId}`),
          };
        }),
        total: page.total,
        next_cursor: page.next_cursor,
        truncated,
        url: locationLink(env, places, location.id),
      },
    };
  },
});

// ---------------------------------------------------------------------------------------------
// get_part_stock_history
// ---------------------------------------------------------------------------------------------

const NAME_THE_PART = 'Give a part_id or a part_name.';

export interface FoundPart {
  id: string;
  part_name: string;
  primary_unit: string | null;
  archived: boolean;
}

/** The part a tool names by id or exact part number, in this company, or why there isn't one. */
export async function findPart(
  args: { part_id?: string; part_name?: string },
  env: CompanyToolEnv,
): Promise<{ part: FoundPart } | { message: string }> {
  const name = args.part_name?.trim();
  if (!args.part_id && !name) return { message: NAME_THE_PART };
  let query = getSupabase()
    .from('parts')
    .select('id, part_name, primary_unit, deleted_at')
    .eq('company_id', env.company.id);
  // A by-id read finds an archived part too; a lookup by number is for live parts, like a list.
  query = args.part_id ? query.eq('id', args.part_id) : query.eq('part_name', name ?? '').is('deleted_at', null);
  const { data, error } = await query.limit(1).maybeSingle();
  if (error) throw error;
  if (!data) {
    return {
      message: args.part_id
        ? `There is no part with that id in ${env.company.name}.`
        : `There is no part ${name} in ${env.company.name}.`,
    };
  }
  return {
    part: { id: data.id, part_name: data.part_name, primary_unit: data.primary_unit, archived: data.deleted_at !== null },
  };
}

/** The offset and size a cursor asks for, or null for a cursor no list returned. Mirrors `paginate`. */
function pageWindow(args: { limit?: number; cursor?: string }): { offset: number; limit: number } | null {
  const limit = Math.min(args.limit ?? DEFAULT_PAGE, MAX_PAGE);
  if (args.cursor === undefined) return { offset: 0, limit };
  if (!/^\d+$/.test(args.cursor)) return null;
  return { offset: Number(args.cursor), limit };
}

const movementOutput = z.object({
  movement_id: z.string(),
  type: z
    .enum(['addition', 'depletion', 'adjustment'])
    .describe('`addition` put stock in, `depletion` took it out, `adjustment` corrected a count.'),
  quantity: z
    .number()
    .describe(
      'As entered, in `unit`, and positive: `type` gives the direction. An adjustment records the size ' +
        'of the correction, and its notes say from what to what.',
    ),
  unit: z.string(),
  stock_quantity: z.number().describe('The same quantity in the part\'s stock unit.'),
  location_id: z.string().nullable(),
  location: z
    .string()
    .nullable()
    .describe('Where it happened: the full path, or the name it had if that location has since been deleted.'),
  transfer_group_id: z
    .string()
    .nullable()
    .describe('Shared by the two rows of a move between locations: the depletion where it left, the addition where it arrived.'),
  job: z
    .object({ job_id: z.string(), job_number: z.string(), url: urlOutput })
    .nullable()
    .describe('The job the stock was issued to, when it was tagged with one.'),
  operation: z
    .object({ sequence: z.number(), name: z.string() })
    .nullable()
    .describe('The job\'s routing step it was issued to, when one was named.'),
  heat_number: z.string().nullable(),
  has_discrepancy: z
    .boolean()
    .describe('A removal of more than the location held: the balance stopped at zero.'),
  notes: z.string().nullable(),
  created_at: z.string(),
  url: urlOutput.describe('The part\'s activity in Jigged.'),
});

export const getPartStockHistory = defineCompanyTool({
  name: 'get_part_stock_history',
  title: 'Get a part\'s stock history',
  description:
    'Lists the stock movements of one part, newest first: each addition, depletion and adjustment ' +
    'with its quantity and unit, location, date, the job and routing step it was issued to, heat ' +
    'number and notes. A move between locations is a depletion and an addition sharing a ' +
    'transfer_group_id. Who made a movement is not included. Find the part by id or by its exact ' +
    'part number.',
  access: 'read',
  input: {
    part_id: z.guid().optional().describe('The part, by id.'),
    part_name: z.string().optional().describe('The part, by its exact part number, when you have no id.'),
    ...pageInput,
  },
  output: {
    part_id: z.string(),
    part_name: z.string(),
    stock_unit: z.string().nullable(),
    archived: z.boolean(),
    movements: z.array(movementOutput),
    ...pageOutput,
    url: urlOutput,
  },
  run: async (args, env) => {
    const window = pageWindow(args);
    if (!window) return { ok: false, message: BAD_CURSOR_MESSAGE };
    const found = await findPart(args, env);
    if ('message' in found) return { ok: false, message: found.message };
    const { part } = found;

    const [{ transactions, total }, locations] = await Promise.all([
      // No photos: nothing here shows one, and signing their URLs is a storage round trip.
      getPartTransactions(part.id, window.offset, window.limit, { photos: false }),
      getLocations(env.company.id),
    ]);
    const places = indexLocations(locations);
    const activity = companyLink(env, `/parts/${part.id}?tab=history`);
    const next = window.offset + transactions.length;

    return {
      ok: true,
      data: {
        part_id: part.id,
        part_name: part.part_name,
        stock_unit: part.primary_unit,
        archived: part.archived,
        // Built field by field: the rows also carry operator_id, created_by, the resolved
        // operator name and photo_path, and none of those may leave (the surveillance guardrail).
        movements: transactions.map((t) => ({
          movement_id: t.id,
          type: t.type,
          quantity: t.quantity,
          unit: t.unit,
          stock_quantity: t.converted_quantity,
          location_id: t.location_id,
          location: t.location_id && places.byId.has(t.location_id) ? places.pathOf(t.location_id) : t.location_name,
          transfer_group_id: t.transfer_group_id,
          job: t.job
            ? { job_id: t.job.id, job_number: t.job.job_number, url: companyLink(env, `/jobs/${t.job.id}`) }
            : null,
          operation: t.job_operation ? { sequence: t.job_operation.sequence, name: t.job_operation.operation_name } : null,
          heat_number: t.heat_number,
          has_discrepancy: t.has_discrepancy,
          notes: t.notes,
          created_at: t.created_at,
          url: activity,
        })),
        total,
        next_cursor: transactions.length > 0 && next < total ? String(next) : null,
        url: activity,
      },
    };
  },
});

export function registerInventoryTools(server: ToolTarget): void {
  registerCompanyTool(server, searchInventory);
  registerCompanyTool(server, listLocations);
  registerCompanyTool(server, getLocationContents);
  registerCompanyTool(server, getPartStockHistory);
}

/** Exported for the catalogue test. */
export const INVENTORY_TOOLS = [searchInventory, listLocations, getLocationContents, getPartStockHistory];
