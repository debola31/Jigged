import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import { countNote } from '@/lib/inventoryCountPlan';
import { defineCompanyTool, registerCompanyTool, type CompanyToolEnv } from '@/lib/mcp/defineTool';
import {
  ADMIN_ONLY,
  LOTS_HELP,
  PATH_SEPARATOR,
  balanceKey,
  findLocation,
  findPart,
  indexLocations,
  locationLink,
  lotOutput,
  readBalanceValues,
  sumMoney,
  type FoundPart,
  type LocationIndex,
} from '@/lib/mcp/tools/inventory';
import { companyLink, isAdmin, urlOutput } from '@/lib/mcp/tools/shared';
import { getSupabase } from '@/lib/supabase';
import { convertToBaseUnit, getStandardUnitsForUnit, resolveUnitAlias } from '@/lib/unitPresets';
import type { CountCandidate } from '@/types/inventoryCount';
import type { InventoryLocation } from '@/types/inventoryLocations';
import { loadPartAtLocationCandidates, readPlaceBalances } from '@/utils/inventoryCountAccess';
import {
  addStockAtLocation,
  adjustStockAtLocation,
  createLocation,
  depleteStockAtLocation,
  getLocations,
  materializeLocationSpec,
  transferStock,
} from '@/utils/inventoryLocationsAccess';

/**
 * Storage, written: the four stock verbs of the Storage page (Add · Remove · Move · Adjust) and
 * its two ways of making a location. Each calls the access function the page calls, with the
 * arguments the page passes, so the RPCs' own rules (the billing gate, a container holds no
 * stock, a take off a lot-tracked part names its lot) apply unchanged.
 *
 * WHICH SURFACE. The office one: `PlaceStockActionForm` (Add, Remove, Move), `PlaceAdjustForm`
 * (Adjust, through `commitCount`), `LocationsManager` (`Add one inside` → `createLocation`) and
 * `VisualLocationBuilder` (`Add storage` with no levels → `materializeLocationSpec`). Nothing on
 * that page is admin-only except money, so every office role may use these; the value of the
 * stock in each answer is the admins-only part, as in the read tools.
 *
 * REMOVALS ARE NOT GRACEFUL. The office form refuses a take larger than the balance
 * (`graceful = false`); the shop floor's clamp-to-zero-and-flag is for a machinist already
 * holding the part. An assistant is the office.
 *
 * PEOPLE. A movement is stamped with the caller's membership id as the app does, so the ledger
 * names who made it inside Jigged; nothing here returns it.
 */

/** A balance is compared in floating point after a unit conversion; this absorbs the noise. */
const EPSILON = 1e-9;

/** The UI's own unit fallback for a part with none (`primary_unit || 'ea'`). */
const FALLBACK_UNIT = 'ea';

const NOTES_MAX = 2000;
const LOT_MAX = 64;
const LOCATION_NAME_MAX = 100;

/** Jobs a removal may be issued to: what the Storage page's job picker offers. */
const TAGGABLE_JOB_STATUSES = new Set(['not_started', 'in_progress']);

// ---------------------------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------------------------

const partInput = {
  part_id: z.guid().optional().describe('The part, by id.'),
  part_name: z.string().optional().describe('The part, by its exact part number, when you have no id.'),
};

const locationInput = {
  location_id: z.guid().optional().describe('The storage location, by id.'),
  location: z
    .string()
    .optional()
    .describe(`The storage location, by name or path ("Rack A${PATH_SEPARATOR}Shelf 2"), when you have no id.`),
};

const quantityInput = z.number().positive().describe('How much, in `unit`. Greater than zero.');

const unitInput = z
  .string()
  .max(40)
  .optional()
  .describe(
    "The unit `quantity` is in. Defaults to the part's stock unit; another unit of the same kind " +
      '(feet for a part kept in inches, kilograms for one kept in pounds) is converted.',
  );

const lotInput = z
  .string()
  .trim()
  .max(LOT_MAX)
  .optional()
  .describe(
    'Which lot: its heat number or lot code. Needed only when the part is held at that location ' +
      'in more than one lot (heat); otherwise the stock there is used.',
  );

const notesInput = z.string().trim().max(NOTES_MAX).optional().describe('A note recorded on the movement.');

// ---------------------------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------------------------

const lotRefOutput = z
  .object({ lot_code: z.string().nullable(), heat_number: z.string().nullable() })
  .nullable()
  .describe('The lot (heat) this stock belongs to; null for stock not held in lots.');

const stockHereOutput = z.object({
  location_id: z.string(),
  location: z.string().describe(`Full path, outermost first, e.g. "Rack A${PATH_SEPARATOR}Shelf 2".`),
  on_hand: z.number().describe("How much of the part is here now, every lot together, in the part's stock unit."),
  lots: z.array(lotOutput).describe(LOTS_HELP),
  inventory_value: z
    .number()
    .nullable()
    .describe(`What the part's stock here cost, in the company's currency. ${ADMIN_ONLY}`),
  url: urlOutput.describe('The location on the Storage page in Jigged.'),
});

type StockHereOut = z.infer<typeof stockHereOutput>;

const partOutput = {
  part_id: z.string(),
  part_name: z.string(),
  stock_unit: z.string().nullable().describe("The unit the part's stock is kept in. Every on-hand figure uses it."),
  part_on_hand: z.number().describe("The part's total on hand across every location, after the change."),
  url: urlOutput.describe("The part's page in Jigged."),
};

const enteredOutput = {
  quantity: z.number().describe('The quantity as entered, in `unit`.'),
  unit: z.string().describe('The unit it was entered in.'),
};

// ---------------------------------------------------------------------------------------------
// Lookups and checks
// ---------------------------------------------------------------------------------------------

type Found<T> = T | { message: string };

/** A live part, by id or part number. An archived part is not offered by any stock form. */
async function findStockPart(
  args: { part_id?: string; part_name?: string },
  env: CompanyToolEnv,
): Promise<Found<{ part: FoundPart }>> {
  const found = await findPart(args, env);
  if ('message' in found) return found;
  if (found.part.archived) {
    return { message: `${found.part.part_name} is archived in ${env.company.name}, so its stock can't be changed.` };
  }
  return found;
}

function stockUnitOf(part: FoundPart): string {
  return part.primary_unit || FALLBACK_UNIT;
}

/**
 * The unit a quantity may be given in: the part's own and the standard units of the same kind,
 * exactly what the Storage page's unit menu offers.
 */
function resolveUnit(raw: string | undefined, part: FoundPart): Found<{ unit: string }> {
  const primary = stockUnitOf(part);
  const wanted = raw?.trim();
  if (!wanted) return { unit: primary };
  const choices = Array.from(new Set([primary, ...getStandardUnitsForUnit(primary)])).filter(Boolean);
  const canonical = (u: string) => resolveUnitAlias(u).toLowerCase();
  const match =
    choices.find((u) => u === wanted) ??
    choices.find((u) => resolveUnitAlias(u) === resolveUnitAlias(wanted)) ??
    choices.find((u) => canonical(u) === canonical(wanted) || u.toLowerCase() === wanted.toLowerCase());
  if (match) return { unit: match };
  return {
    message:
      `${part.part_name} is kept in ${primary}, so its stock can't be given in "${wanted}". ` +
      `Use one of: ${choices.join(', ')}.`,
  };
}

/** `quantity` of `unit` in the part's stock unit, the way the access layer converts it. */
async function inStockUnits(part: FoundPart, quantity: number, unit: string): Promise<number> {
  const primary = stockUnitOf(part);
  if (unit === primary) return quantity;
  const { data, error } = await getSupabase()
    .from('parts_unit_conversions')
    .select('from_unit, to_primary_factor')
    .eq('part_id', part.id);
  if (error) throw error;
  const conversions = (data ?? []).map((c) => ({ from_unit: c.from_unit, to_primary_factor: Number(c.to_primary_factor) }));
  return convertToBaseUnit(quantity, unit, primary, conversions);
}

/** Stock sits only in a location with nothing inside it; the database refuses anything else. */
function containerRefusal(location: InventoryLocation, places: LocationIndex): string | null {
  const inside = places.childrenOf.get(location.id) ?? [];
  if (inside.length === 0) return null;
  return (
    `${places.pathOf(location.id)} has locations inside it, and stock goes in one of those rather ` +
    `than in it (for example ${places.pathOf(inside[0].id)}).`
  );
}

const fmt = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 4 });

interface Held {
  quantity: number;
  lotId: string | null;
  lotCode: string | null;
  heatNumber: string | null;
}

function lotName(held: Pick<Held, 'lotId' | 'lotCode' | 'heatNumber'>): string {
  if (!held.lotId) return 'no lot';
  return held.heatNumber ? `heat ${held.heatNumber}` : (held.lotCode ?? 'an unnamed lot');
}

function describeHeld(held: Held[], unit: string): string {
  return held.map((h) => `${lotName(h)}: ${fmt(h.quantity)} ${unit}`).join('; ');
}

/**
 * Which balance a removal, move or count is about.
 *
 * The Storage page lists a part once per lot at a place and takes the quantity on that line, so
 * the line IS the lot. Here: the lot named by heat or code; else the only balance there; else the
 * stock held in no lot (what the RPCs act on when no lot is sent); else the person has to say.
 */
function pickHeld<T extends Held>(
  held: T[],
  lot: string | undefined,
  ctx: { partName: string; path: string; unit: string },
): Found<{ held: T }> {
  if (held.length === 0) return { message: `There is no ${ctx.partName} at ${ctx.path}.` };
  if (lot) {
    const key = lot.toLowerCase();
    const matches = held.filter(
      (h) => h.lotId !== null && (h.heatNumber?.toLowerCase() === key || h.lotCode?.toLowerCase() === key),
    );
    if (matches.length === 1) return { held: matches[0] };
    return {
      message: `${ctx.partName} at ${ctx.path} has no lot "${lot}". What is there: ${describeHeld(held, ctx.unit)}.`,
    };
  }
  if (held.length === 1) return { held: held[0] };
  const untagged = held.filter((h) => h.lotId === null);
  if (untagged.length === 1) return { held: untagged[0] };
  return {
    message:
      `${ctx.partName} is held at ${ctx.path} in ${held.length} lots: ${describeHeld(held, ctx.unit)}. ` +
      'Give `lot` (the heat number or lot code) to say which.',
  };
}

/**
 * The caller's own `user_company_access.id`, which the Storage page stamps on each movement as
 * `operator_id` so the ledger can say who made it. Best effort, as there: a failed lookup records
 * no name rather than blocking the write.
 *
 * Read here rather than through `getCurrentMember`, whose in-flight sharing is keyed by company
 * alone: in a browser that is one person, on this server it could hand one caller another's row.
 */
async function memberIdOf(env: CompanyToolEnv): Promise<string | undefined> {
  const { data, error } = await getSupabase()
    .from('user_company_access')
    .select('id')
    .eq('user_id', env.caller.userId)
    .eq('company_id', env.company.id)
    .maybeSingle();
  if (error || !data) return undefined;
  return data.id;
}

/** The part's total on hand, the roll-up the stock functions maintain. */
async function partOnHand(env: CompanyToolEnv, partId: string): Promise<number> {
  const { data, error } = await getSupabase()
    .from('parts')
    .select('quantity')
    .eq('id', partId)
    .eq('company_id', env.company.id)
    .maybeSingle();
  if (error) throw error;
  return Number(data?.quantity ?? 0);
}

/** The value of each balance at these places, for admins; null for everyone else. */
async function valuesFor(env: CompanyToolEnv, locationIds: string[]): Promise<Map<string, number | null> | null> {
  return isAdmin(env) ? readBalanceValues(env.company.id, locationIds) : null;
}

/** What the part holds at one place after the write, read back from the database. */
async function stockAt(
  env: CompanyToolEnv,
  places: LocationIndex,
  partId: string,
  locationId: string,
  values: Map<string, number | null> | null,
): Promise<{ out: StockHereOut; held: Held[] }> {
  const held = [...(await readPlaceBalances(locationId, [partId])).values()];
  return {
    held,
    out: {
      location_id: locationId,
      location: places.pathOf(locationId),
      on_hand: held.reduce((sum, h) => sum + h.quantity, 0),
      lots: held
        .filter((h) => h.lotId !== null)
        .map((h) => ({ lot_code: h.lotCode, heat_number: h.heatNumber, quantity: h.quantity }))
        .sort((a, b) => b.quantity - a.quantity),
      inventory_value: values
        ? sumMoney(held.map((h) => values.get(balanceKey(partId, locationId, h.lotId)) ?? null))
        : null,
      url: locationLink(env, places, locationId),
    },
  };
}

function lotRef(held: Pick<Held, 'lotId' | 'lotCode' | 'heatNumber'> | undefined): z.infer<typeof lotRefOutput> {
  return held?.lotId ? { lot_code: held.lotCode, heat_number: held.heatNumber } : null;
}

function partFields(env: CompanyToolEnv, part: FoundPart, onHand: number) {
  return {
    part_id: part.id,
    part_name: part.part_name,
    stock_unit: part.primary_unit,
    part_on_hand: onHand,
    url: companyLink(env, `/parts/${part.id}`),
  };
}

/** The part and the one place a single-location verb acts on, checked; or a sentence. */
async function partAndPlace(
  args: { part_id?: string; part_name?: string; location_id?: string; location?: string },
  env: CompanyToolEnv,
): Promise<Found<{ part: FoundPart; location: InventoryLocation; places: LocationIndex }>> {
  const [foundPart, locations] = await Promise.all([findStockPart(args, env), getLocations(env.company.id)]);
  if ('message' in foundPart) return foundPart;
  const places = indexLocations(locations);
  const foundPlace = findLocation(args, places, env);
  if ('message' in foundPlace) return foundPlace;
  const container = containerRefusal(foundPlace.location, places);
  if (container) return { message: container };
  return { part: foundPart.part, location: foundPlace.location, places };
}

// ---------------------------------------------------------------------------------------------
// add_stock
// ---------------------------------------------------------------------------------------------

export const addStock = defineCompanyTool({
  name: 'add_stock',
  title: 'Add stock',
  description:
    'Puts a quantity of a part into a storage location in Jigged, as Add does on the Storage ' +
    'page, and records the addition in the part\'s stock history. The quantity may be given in ' +
    'the part\'s stock unit or another unit of the same kind. A heat (lot) number from the ' +
    'material\'s tag files the stock under that lot, creating it the first time it is seen, and ' +
    'starts lot tracking for a part that was not tracked; a lot-tracked part received without one ' +
    'gets a generated lot code. Returns what the part now holds at that location and in total. ' +
    'Admins also get the value of the stock there.',
  access: 'write',
  idempotent: false,
  input: {
    ...partInput,
    ...locationInput,
    quantity: quantityInput,
    unit: unitInput,
    heat_number: z
      .string()
      .trim()
      .max(LOT_MAX)
      .optional()
      .describe('The mill heat or lot number off the material\'s tag, if it has one.'),
    notes: notesInput,
  },
  output: {
    ...partOutput,
    ...enteredOutput,
    lot: lotRefOutput,
    started_lot_tracking: z
      .boolean()
      .describe('True when this heat number is the first recorded for the part, so it is now lot-tracked.'),
    location: stockHereOutput,
  },
  run: async (args, env) => {
    const found = await partAndPlace(args, env);
    if ('message' in found) return { ok: false, message: found.message };
    const { part, location, places } = found;
    const unit = resolveUnit(args.unit, part);
    if ('message' in unit) return { ok: false, message: unit.message };

    const operatorId = await memberIdOf(env);
    const result = await addStockAtLocation(part.id, location.id, args.quantity, unit.unit, {
      notes: args.notes || undefined,
      operatorId,
      heatNumber: args.heat_number || undefined,
    });

    const values = await valuesFor(env, [location.id]);
    const here = await stockAt(env, places, part.id, location.id, values);
    return {
      ok: true,
      data: {
        ...partFields(env, part, Number(result.part_quantity)),
        quantity: args.quantity,
        unit: unit.unit,
        lot: lotRef(here.held.find((h) => result.lot_id && h.lotId === result.lot_id)),
        started_lot_tracking: result.started_tracking === true,
        location: here.out,
      },
    };
  },
});

// ---------------------------------------------------------------------------------------------
// remove_stock
// ---------------------------------------------------------------------------------------------

interface TaggableJob {
  id: string;
  job_number: string;
}

/** The job a removal is issued to, when one is named: live, and not started or in progress. */
async function findTaggableJob(
  args: { job_id?: string; job_number?: string },
  env: CompanyToolEnv,
): Promise<Found<{ job: TaggableJob | null }>> {
  const number = args.job_number?.trim();
  if (!args.job_id && !number) return { job: null };
  const lookup = getSupabase()
    .from('jobs')
    .select('id, job_number, production_status, deleted_at')
    .eq('company_id', env.company.id);
  const { data, error } = await (args.job_id ? lookup.eq('id', args.job_id) : lookup.eq('job_number', number ?? ''))
    .order('deleted_at', { ascending: false, nullsFirst: true })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    return {
      message: args.job_id
        ? `There is no job with that id in ${env.company.name}.`
        : `There is no job ${number} in ${env.company.name}.`,
    };
  }
  if (data.deleted_at !== null) {
    return { message: `Job ${data.job_number} is archived, so stock can't be issued to it.` };
  }
  if (!TAGGABLE_JOB_STATUSES.has(data.production_status)) {
    const state = data.production_status.replace(/_/g, ' ');
    return {
      message: `Job ${data.job_number} is ${state}. Stock can be issued only to a job that is not started or in progress.`,
    };
  }
  return { job: { id: data.id, job_number: data.job_number } };
}

export const removeStock = defineCompanyTool({
  name: 'remove_stock',
  title: 'Remove stock',
  description:
    'Takes a quantity of a part out of a storage location in Jigged, as Remove does on the ' +
    'Storage page, and records the depletion in the part\'s stock history, optionally issued to ' +
    'an open job (not started or in progress). A removal larger than what the location holds is ' +
    'refused. For a part held there in more than one lot (heat), `lot` says which. Returns what ' +
    'the part now holds at that location and in total. Admins also get the value of the stock there.',
  access: 'write',
  idempotent: false,
  input: {
    ...partInput,
    ...locationInput,
    quantity: quantityInput,
    unit: unitInput,
    lot: lotInput,
    job_id: z.guid().optional().describe('The job the stock is issued to, by id.'),
    job_number: z.string().optional().describe('The job the stock is issued to, by its number.'),
    notes: notesInput,
  },
  output: {
    ...partOutput,
    ...enteredOutput,
    lot: lotRefOutput,
    job: z
      .object({ job_id: z.string(), job_number: z.string(), url: urlOutput })
      .nullable()
      .describe('The job the stock was issued to, if any.'),
    location: stockHereOutput,
  },
  run: async (args, env) => {
    const found = await partAndPlace(args, env);
    if ('message' in found) return { ok: false, message: found.message };
    const { part, location, places } = found;
    const unit = resolveUnit(args.unit, part);
    if ('message' in unit) return { ok: false, message: unit.message };
    const jobFound = await findTaggableJob(args, env);
    if ('message' in jobFound) return { ok: false, message: jobFound.message };
    const { job } = jobFound;

    const path = places.pathOf(location.id);
    const stockUnit = stockUnitOf(part);
    const before = [...(await readPlaceBalances(location.id, [part.id])).values()];
    const picked = pickHeld(before, args.lot, { partName: part.part_name, path, unit: stockUnit });
    if ('message' in picked) return { ok: false, message: picked.message };
    const need = await inStockUnits(part, args.quantity, unit.unit);
    if (need - picked.held.quantity > EPSILON) {
      const of = picked.held.lotId ? ` (${lotName(picked.held)})` : '';
      return {
        ok: false,
        message:
          `Only ${fmt(picked.held.quantity)} ${stockUnit} of ${part.part_name}${of} is at ${path}, so ` +
          `${fmt(args.quantity)} ${unit.unit} can't be removed. Nothing was changed.`,
      };
    }

    const operatorId = await memberIdOf(env);
    const result = await depleteStockAtLocation(part.id, location.id, args.quantity, unit.unit, {
      graceful: false,
      notes: args.notes || undefined,
      operatorId,
      jobId: job?.id,
      lotId: picked.held.lotId ?? undefined,
    });

    const values = await valuesFor(env, [location.id]);
    const here = await stockAt(env, places, part.id, location.id, values);
    return {
      ok: true,
      data: {
        ...partFields(env, part, Number(result.part_quantity)),
        quantity: args.quantity,
        unit: unit.unit,
        lot: lotRef(picked.held),
        job: job ? { job_id: job.id, job_number: job.job_number, url: companyLink(env, `/jobs/${job.id}`) } : null,
        location: here.out,
      },
    };
  },
});

// ---------------------------------------------------------------------------------------------
// adjust_stock
// ---------------------------------------------------------------------------------------------

export const adjustStock = defineCompanyTool({
  name: 'adjust_stock',
  title: 'Adjust stock to a count',
  description:
    'Sets how much of a part a storage location holds to the quantity counted there, as Adjust ' +
    'does on the Storage page: the balance becomes that number and the ledger records an ' +
    'adjustment noting the recorded and counted figures. The count is in the part\'s stock unit, ' +
    'and 0 says the location holds none. For a part in lots (heats), `lot` says which lot was ' +
    'counted. A count equal to the recorded figure changes nothing and is refused. Returns the ' +
    'previous and new quantity and what the part now holds there and in total. Admins also get ' +
    'the value of the stock there.',
  access: 'write',
  idempotent: true,
  input: {
    ...partInput,
    ...locationInput,
    quantity: z
      .number()
      .min(0)
      .describe("The quantity counted at the location, in the part's stock unit. 0 or more."),
    lot: lotInput,
  },
  output: {
    ...partOutput,
    lot: lotRefOutput,
    previous_quantity: z.number().describe('What Jigged recorded there before the count, in the stock unit.'),
    new_quantity: z.number().describe('The quantity counted, now recorded.'),
    change: z.number().describe('new_quantity minus previous_quantity.'),
    location: stockHereOutput,
  },
  run: async (args, env) => {
    const found = await partAndPlace(args, env);
    if ('message' in found) return { ok: false, message: found.message };
    const { part, location, places } = found;

    // The count page's own read for one part at one place: a row per balance there, or one at 0
    // (per lot, for a lot-tracked part) for stock the system doesn't know is there.
    const candidates = await loadPartAtLocationCandidates(env.company.id, part.id, location.id, location.name);
    const asHeld = candidates.map((c) => ({ ...c, quantity: c.systemQuantity }));
    const picked = pickHeld(asHeld, args.lot, {
      partName: part.part_name,
      path: places.pathOf(location.id),
      unit: stockUnitOf(part),
    });
    if ('message' in picked) return { ok: false, message: picked.message };
    const candidate: CountCandidate = picked.held;

    if (args.quantity === candidate.systemQuantity) {
      const of = candidate.lotId ? ` (${lotName(candidate)})` : '';
      return {
        ok: false,
        message:
          `${part.part_name}${of} at ${places.pathOf(location.id)} is already ` +
          `${fmt(candidate.systemQuantity)} ${candidate.unit}. Nothing was changed.`,
      };
    }

    const variance = {
      candidate,
      counted: args.quantity,
      delta: args.quantity - candidate.systemQuantity,
      movedSinceOpened: false,
    };
    const operatorId = await memberIdOf(env);
    // What `commitCount` does for each line, called directly so a refusal reaches the person as
    // the database's own sentence rather than as a line in a failure list.
    const result = await adjustStockAtLocation(part.id, location.id, args.quantity, candidate.unit, {
      notes: countNote(variance),
      operatorId,
      lotId: candidate.lotId ?? undefined,
    });

    const values = await valuesFor(env, [location.id]);
    const here = await stockAt(env, places, part.id, location.id, values);
    return {
      ok: true,
      data: {
        ...partFields(env, part, Number(result.part_quantity)),
        lot: lotRef(candidate),
        previous_quantity: candidate.systemQuantity,
        new_quantity: args.quantity,
        change: variance.delta,
        location: here.out,
      },
    };
  },
});

// ---------------------------------------------------------------------------------------------
// transfer_stock
// ---------------------------------------------------------------------------------------------

export const transferStockTool = defineCompanyTool({
  name: 'transfer_stock',
  title: 'Move stock between locations',
  description:
    'Moves a quantity of a part from one storage location to another in Jigged, as Move does on ' +
    'the Storage page, recording a depletion where it left and an addition where it arrived. A ' +
    'move larger than the source holds is refused. For a part held at the source in more than one ' +
    'lot (heat), `lot` says which; the stock keeps its lot. Returns what the part now holds at ' +
    'both locations and in total. Admins also get the value of the stock at each.',
  access: 'write',
  idempotent: false,
  input: {
    ...partInput,
    from_location_id: z.guid().optional().describe('Where the stock is now, by id.'),
    from_location: z
      .string()
      .optional()
      .describe(`Where the stock is now, by name or path ("Rack A${PATH_SEPARATOR}Shelf 2"), when you have no id.`),
    to_location_id: z.guid().optional().describe('Where it is going, by id.'),
    to_location: z.string().optional().describe('Where it is going, by name or path, when you have no id.'),
    quantity: quantityInput,
    unit: unitInput,
    lot: lotInput,
    notes: notesInput,
  },
  output: {
    ...partOutput,
    ...enteredOutput,
    lot: lotRefOutput,
    from: stockHereOutput,
    to: stockHereOutput,
  },
  run: async (args, env) => {
    if (!args.from_location_id && !args.from_location?.trim()) {
      return { ok: false, message: 'Give a from_location_id or a from_location name or path.' };
    }
    if (!args.to_location_id && !args.to_location?.trim()) {
      return { ok: false, message: 'Give a to_location_id or a to_location name or path.' };
    }
    const [foundPart, locations] = await Promise.all([findStockPart(args, env), getLocations(env.company.id)]);
    if ('message' in foundPart) return { ok: false, message: foundPart.message };
    const { part } = foundPart;
    const places = indexLocations(locations);
    const from = findLocation({ location_id: args.from_location_id, location: args.from_location }, places, env);
    if ('message' in from) return { ok: false, message: from.message };
    const to = findLocation({ location_id: args.to_location_id, location: args.to_location }, places, env);
    if ('message' in to) return { ok: false, message: to.message };
    if (from.location.id === to.location.id) {
      return { ok: false, message: `${places.pathOf(from.location.id)} is both the source and the destination. Nothing was moved.` };
    }
    for (const place of [from.location, to.location]) {
      const container = containerRefusal(place, places);
      if (container) return { ok: false, message: container };
    }
    const unit = resolveUnit(args.unit, part);
    if ('message' in unit) return { ok: false, message: unit.message };

    const path = places.pathOf(from.location.id);
    const stockUnit = stockUnitOf(part);
    const before = [...(await readPlaceBalances(from.location.id, [part.id])).values()];
    const picked = pickHeld(before, args.lot, { partName: part.part_name, path, unit: stockUnit });
    if ('message' in picked) return { ok: false, message: picked.message };
    const need = await inStockUnits(part, args.quantity, unit.unit);
    if (need - picked.held.quantity > EPSILON) {
      const of = picked.held.lotId ? ` (${lotName(picked.held)})` : '';
      return {
        ok: false,
        message:
          `Only ${fmt(picked.held.quantity)} ${stockUnit} of ${part.part_name}${of} is at ${path}, so ` +
          `${fmt(args.quantity)} ${unit.unit} can't be moved. Nothing was changed.`,
      };
    }

    const operatorId = await memberIdOf(env);
    await transferStock(part.id, from.location.id, to.location.id, args.quantity, unit.unit, {
      notes: args.notes || undefined,
      operatorId,
      lotId: picked.held.lotId ?? undefined,
    });

    const values = await valuesFor(env, [from.location.id, to.location.id]);
    const [source, destination, onHand] = await Promise.all([
      stockAt(env, places, part.id, from.location.id, values),
      stockAt(env, places, part.id, to.location.id, values),
      partOnHand(env, part.id),
    ]);
    return {
      ok: true,
      data: {
        ...partFields(env, part, onHand),
        quantity: args.quantity,
        unit: unit.unit,
        lot: lotRef(picked.held),
        from: source.out,
        to: destination.out,
      },
    };
  },
});

// ---------------------------------------------------------------------------------------------
// create_location
// ---------------------------------------------------------------------------------------------

/** Folded the way the sibling-name index folds (`lower(btrim(name))`), so the check agrees with it. */
const nameKey = (name: string) => name.trim().toLowerCase();

export const createStorageLocation = defineCompanyTool({
  name: 'create_location',
  title: 'Create a storage location',
  description:
    'Creates one storage location in Jigged: a new storage unit at the top level, as Add storage ' +
    'does on the Storage page, or a location inside an existing one, as Add one inside does. Names ' +
    'are unique among locations with the same parent. A location that holds stock directly cannot ' +
    'have locations inside it, and storage goes at most five levels deep. Returns the new ' +
    'location with its full path.',
  access: 'write',
  idempotent: false,
  input: {
    name: z.string().trim().min(1).max(LOCATION_NAME_MAX).describe('The new location\'s name, e.g. "Cabinet 3" or "Bin 4".'),
    parent_id: z.guid().optional().describe('The location to create it inside, by id. Omit both parent fields for a new top-level unit.'),
    parent: z
      .string()
      .optional()
      .describe(`The location to create it inside, by name or path ("Rack A${PATH_SEPARATOR}Shelf 2"), when you have no id.`),
  },
  output: {
    location_id: z.string(),
    name: z.string(),
    path: z.string().describe(`Full path, outermost first, e.g. "Rack A${PATH_SEPARATOR}Shelf 2".`),
    parent_id: z.string().nullable(),
    url: urlOutput.describe('The location on the Storage page in Jigged.'),
  },
  run: async (args, env) => {
    const locations = await getLocations(env.company.id);
    const places = indexLocations(locations);

    let parent: InventoryLocation | null = null;
    if (args.parent_id || args.parent?.trim()) {
      const found = findLocation({ location_id: args.parent_id, location: args.parent }, places, env);
      if ('message' in found) return { ok: false, message: found.message };
      parent = found.location;
    }

    const siblings = parent
      ? (places.childrenOf.get(parent.id) ?? [])
      : locations.filter((l) => !l.parent_id || !places.byId.has(l.parent_id));
    const taken = siblings.find((s) => nameKey(s.name) === nameKey(args.name));
    if (taken) {
      const where = parent ? places.pathOf(parent.id) : 'the top level of storage';
      return { ok: false, message: `There's already a "${taken.name}" in ${where}. Pick a different name.` };
    }

    // The two doors the Storage page has: `Add one inside` inserts one row under its parent;
    // `Add storage` with no levels writes a one-node tree through `create_location_tree`.
    const created = parent
      ? await createLocation(env.company.id, { name: args.name, parent_id: parent.id })
      : (await materializeLocationSpec(env.company.id, null, [{ key: 'unit', name: args.name, kind: null, children: [] }], 0))[0];
    if (!created) throw new Error('Jigged did not return the new location.');

    const after = indexLocations([...locations, created]);
    return {
      ok: true,
      data: {
        location_id: created.id,
        name: created.name,
        path: after.pathOf(created.id),
        parent_id: created.parent_id,
        url: locationLink(env, after, created.id),
      },
    };
  },
});

export function registerInventoryWriteTools(server: McpServer): void {
  registerCompanyTool(server, addStock);
  registerCompanyTool(server, removeStock);
  registerCompanyTool(server, adjustStock);
  registerCompanyTool(server, transferStockTool);
  registerCompanyTool(server, createStorageLocation);
}

/** Exported for the catalogue test. */
export const INVENTORY_WRITE_TOOLS = [addStock, removeStock, adjustStock, transferStockTool, createStorageLocation];
