import type { McpServer } from '@modelcontextprotocol/server';
import * as Sentry from '@sentry/nextjs';
import { z } from 'zod';

import { defineCompanyTool, registerCompanyTool, type CompanyToolEnv } from '@/lib/mcp/defineTool';
import {
  SOURCE_HELP,
  SOURCES,
  bomLineOutput,
  findPart,
  partLink,
  stepOutput,
  tierOutput,
} from '@/lib/mcp/tools/parts';
import { companyLink, urlOutput } from '@/lib/mcp/tools/shared';
import { isValidQuantityValue, MAX_QUANTITY_DECIMALS } from '@/lib/quantityInput';
import { STANDARD_UNITS, STANDARD_UNITS_BY_KEY } from '@/lib/standardUnits';
import { getSupabase } from '@/lib/supabase';
import { toError } from '@/lib/supabaseErrors';
import { getStandardUnitsForUnit, getSuggestedConversionFactor, resolveUnitAlias } from '@/lib/unitPresets';
import { chargeBasisForNewLine, type BomLineWithChildPart, type ChargeBasis } from '@/types/bom';
import { partToFormData, type Part, type PartFormData } from '@/types/part';
import type { PartPricingTierInput } from '@/types/partPricing';
import type { RoutingOperationWithWorkCenter } from '@/types/routings';
import { addBomLine, checkBomCycle, deleteBomLine, getBomForPart, updateBomLine } from '@/utils/bomAccess';
import { getCompany, readCompanyPricingDefaults } from '@/utils/companyAccess';
import {
  ensureStarterPricingTier,
  getTiersForPart,
  getTiersWithComputedPrices,
  replaceTiersForPart,
} from '@/utils/partPricingTiersAccess';
import {
  addPartNote,
  addPartPricingNote,
  checkPartNameExists,
  createPart as createPartRow,
  ensurePartUnitConversion,
  getPartCostExplain,
  getPartNamesByIds,
  getPartUnitConversions,
  updatePart as updatePartRow,
} from '@/utils/partsAccess';
import { getRoutingForPart, saveRoutingWithOperations, type PendingOperation } from '@/utils/routingsAccess';
import { escapeIlikePattern } from '@/utils/searchFilter';
import { addCompanyCustomUnit, getCompanyCustomUnits } from '@/utils/unitsAccess';
import { getVendorServicesForRouting } from '@/utils/vendorServicesAccess';
import { getWorkCentersForRouting } from '@/utils/workCentersAccess';

/**
 * The part write tools, each the same call the part workspace makes when a person does the same
 * thing in the browser:
 *
 *   create_part              New part (PartIdentitySection, create mode)        createPart
 *   update_part              Part details, auto-saved (same, existing mode)     updatePart
 *   set_part_pricing_tiers   the Pricing card's Save (PartPricing)              replaceTiersForPart
 *   update_part_bom          the Materials editor (PartBomPanel)                addBomLine / updateBomLine / deleteBomLine
 *   save_part_routing        the Operations editor (PartRoutingPanel)           saveRoutingWithOperations
 *   add_part_note            the Activity tab's comment box (HistoryTab)        addPartNote
 *
 * None of it is admin-only: every office user edits parts in the app.
 *
 * After a change that can give a part its first cost, the workspace gives it its first pricing
 * tier at the shop's starting markup (`ensureStarterPricingTier`, from PartWorkspace's
 * refreshAfterMutation), so "costed" and "quotable" land together. These tools do the same.
 */

const ROUTING_STEP_LIMIT = 100;
const TIER_LIMIT = 50;

// ─── shared helpers ───────────────────────────────────────────────────────────────────────────

/**
 * The caller's own membership row in this company: the author of a note. Looked up by the
 * caller's id rather than through `getCurrentMember`, whose in-flight cache is keyed by company
 * alone and on a server could hand one person's concurrent call another person's row.
 */
async function memberIdOf(env: CompanyToolEnv): Promise<string | null> {
  const { data, error } = await getSupabase()
    .from('user_company_access')
    .select('id')
    .eq('user_id', env.caller.userId)
    .eq('company_id', env.company.id)
    .maybeSingle();
  if (error) throw error;
  return data?.id ?? null;
}

/**
 * Whether the part could be quoted before this change. The workspace reads this on every load
 * and skips the starter tier when it is true; a failed read counts as not priceable, as there.
 */
async function priceableBefore(partId: string): Promise<boolean> {
  try {
    return (await getPartCostExplain(partId, 1)).is_priceable;
  } catch {
    // getPartCostExplain reports its own failures to Sentry.
    return false;
  }
}

/**
 * The workspace's post-change step: a part that wasn't quotable gets its first pricing tier once
 * it has a cost. Non-fatal there, and here: the change itself has already been saved.
 */
async function startPricingIfNeeded(env: CompanyToolEnv, part: Part, wasPriceable: boolean): Promise<boolean> {
  if (wasPriceable) return false;
  try {
    return await ensureStarterPricingTier(env.company.id, part.id, part.source);
  } catch (err) {
    Sentry.captureException(toError(err, 'ensureStarterPricingTier'), { tags: { area: 'part-pricing', mcp: 'starter_tier' } });
    return false;
  }
}

const starterOutput = z
  .boolean()
  .describe(
    'Jigged gave the part its first pricing tier at the shop\'s starting markup, as it does in the ' +
      'app the first time a part has a cost, and noted it on the part.',
  );

const vendorRefOutput = z.object({ vendor_id: z.string(), name: z.string(), url: urlOutput });
type VendorRef = z.infer<typeof vendorRefOutput>;

/**
 * A vendor named by id or by name, for a preferred vendor. The picker offers live vendors only,
 * so an archived one is refused.
 */
async function findLiveVendor(
  args: { preferred_vendor_id?: string | null; preferred_vendor_name?: string },
  env: CompanyToolEnv,
): Promise<VendorRef | { message: string }> {
  const name = args.preferred_vendor_name?.trim();
  const lookup = getSupabase().from('vendors').select('id, name, deleted_at').eq('company_id', env.company.id);
  const { data, error } = await (args.preferred_vendor_id
    ? lookup.eq('id', args.preferred_vendor_id)
    : lookup.ilike('name', escapeIlikePattern(name ?? ''))
  )
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    return {
      message: args.preferred_vendor_id
        ? `There is no vendor with that id in ${env.company.name}.`
        : `There is no vendor named ${name} in ${env.company.name}.`,
    };
  }
  if (data.deleted_at !== null) {
    return { message: `${data.name} is archived, so it can't be a part's preferred vendor.` };
  }
  return { vendor_id: data.id, name: data.name, url: companyLink(env, `/vendors/${data.id}`) };
}

/** The preferred vendor a part points at. A by-id read: an archived vendor still resolves. */
async function vendorRefOf(env: CompanyToolEnv, vendorId: string | null): Promise<VendorRef | null> {
  if (!vendorId) return null;
  const { data, error } = await getSupabase()
    .from('vendors')
    .select('id, name')
    .eq('company_id', env.company.id)
    .eq('id', vendorId)
    .maybeSingle();
  if (error) throw error;
  return data ? { vendor_id: data.id, name: data.name, url: companyLink(env, `/vendors/${data.id}`) } : null;
}

const sameText = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

/** A standard unit by its key, symbol or label, or an alias the importer knows ("lbs", "ea"). */
function standardUnitKey(raw: string): string | null {
  const wanted = raw.trim();
  const hit = STANDARD_UNITS.find((u) => sameText(u.key, wanted) || sameText(u.short, wanted) || sameText(u.label, wanted));
  if (hit) return hit.key;
  const alias = resolveUnitAlias(wanted);
  return STANDARD_UNITS_BY_KEY[alias] ? alias : null;
}

type UnitResolution = { unit: string } | { unknown: string; message: string };

/**
 * A part's unit as the unit picker (UnitOfMeasurementSelect) offers it: a standard unit, or one
 * of the company's own. Anything else is new, and the picker's "Add custom unit" adds it.
 */
async function resolvePartUnit(raw: string, env: CompanyToolEnv): Promise<UnitResolution> {
  const wanted = raw.trim();
  if (!wanted) return { unknown: wanted, message: 'A part needs a unit of measurement.' };
  const standard = standardUnitKey(wanted);
  if (standard) return { unit: standard };
  const custom = await getCompanyCustomUnits(env.company.id);
  const own = custom.find((u) => sameText(u.unit_name, wanted));
  if (own) return { unit: own.unit_name };
  const owned = custom.length > 0 ? ` Its own units are ${custom.map((u) => u.unit_name).join(', ')}.` : '';
  return {
    unknown: wanted,
    message:
      `${wanted} isn't one of ${env.company.name}'s units. The standard units are ` +
      `${STANDARD_UNITS.map((u) => u.key).join(', ')}.${owned} Set add_custom_unit to add ${wanted} ` +
      'as a unit of the company\'s own, as "Add custom unit" does in Jigged.',
  };
}

/**
 * A unit ready to write. An unknown one reaches here only when `add_custom_unit` asked for it,
 * and only after every other check has passed, so a refused call adds no unit.
 */
async function settleUnit(resolved: UnitResolution, env: CompanyToolEnv): Promise<{ unit: string; added: boolean }> {
  if ('unit' in resolved) return { unit: resolved.unit, added: false };
  const created = await addCompanyCustomUnit(env.company.id, resolved.unknown);
  return { unit: created.unit_name, added: true };
}

/** An unknown unit is refused unless the call asked to add it. */
const unitRefusal = (resolved: UnitResolution, addCustom: boolean | undefined): string | null =>
  'unknown' in resolved && (!addCustom || !resolved.unknown) ? resolved.message : null;

// ─── create_part / update_part ────────────────────────────────────────────────────────────────

const partRecordOutput = {
  part_id: z.string(),
  part_name: z.string().describe('The part number the shop knows it by.'),
  description: z.string().nullable(),
  source: z.enum(SOURCES).describe(SOURCE_HELP),
  unit: z.string().nullable().describe('Primary unit of measure.'),
  reorder_point: z.number().nullable().describe('Stock level that flags the part as low.'),
  preferred_vendor: vendorRefOutput.nullable(),
  url: urlOutput,
};

type PartRecord = z.infer<z.ZodObject<typeof partRecordOutput>>;

function partRecord(part: Part, vendor: VendorRef | null, env: CompanyToolEnv): PartRecord {
  return {
    part_id: part.id,
    part_name: part.part_name,
    description: part.description,
    source: part.source,
    unit: part.primary_unit,
    reorder_point: part.reorder_point,
    preferred_vendor: vendor,
    url: partLink(env, part.id),
  };
}

const vendorInput = {
  preferred_vendor_id: z.guid().optional().describe('The preferred vendor, by id. Bought parts only.'),
  preferred_vendor_name: z
    .string()
    .optional()
    .describe('The preferred vendor, by exact name (case does not matter), when you have no id. Bought parts only.'),
};

const unitHelp =
  'A standard unit (each, pieces, dozen, pounds, kilograms, ounces, grams, inches, feet, millimeters, ' +
  'centimeters, meters, gallons, liters, quarts, milliliters, fluid ounces, square inches, square feet, ' +
  'hours; symbols such as ea, lb, in work too) or one of the company\'s own units.';

const addCustomUnitInput = z
  .boolean()
  .optional()
  .describe('Add `unit` as a unit of the company\'s own when it is neither standard nor one already added.');

const ONLY_BOUGHT_HAS_VENDOR = 'Only a bought part has a preferred vendor; a made part is made in the shop.';

export const createPart = defineCompanyTool({
  name: 'create_part',
  title: 'Create a part',
  description:
    'Adds a part to a Jigged company\'s item master: its part name (part number), made in the shop ' +
    'or bought from a vendor, unit of measure, and optionally a description, reorder point and, for ' +
    'a bought part, a preferred vendor. The part starts with no stock, routing, materials or pricing. ' +
    'Taking the name of an archived part creates a new part and renames the archived one ' +
    '"<name> (archived)". Returns the new part.',
  access: 'write',
  idempotent: false,
  input: {
    part_name: z.string().describe('The part name (part number), unique among the company\'s live parts.'),
    source: z.enum(SOURCES).optional().describe(`${SOURCE_HELP} Defaults to made.`),
    unit: z.string().describe(`Primary unit of measure. ${unitHelp}`),
    add_custom_unit: addCustomUnitInput,
    description: z.string().optional(),
    reorder_point: z.number().min(0).optional().describe('Stock level that flags the part as low.'),
    ...vendorInput,
  },
  output: {
    ...partRecordOutput,
    custom_unit_added: z.boolean().describe('`unit` was added as a unit of the company\'s own.'),
  },
  run: async (args, env) => {
    const name = args.part_name.trim();
    if (!name) return { ok: false, message: 'A part needs a part name.' };
    const source = args.source ?? 'made';
    const wantsVendor = Boolean(args.preferred_vendor_id || args.preferred_vendor_name?.trim());
    if (wantsVendor && source !== 'bought') return { ok: false, message: ONLY_BOUGHT_HAS_VENDOR };

    // The New Part form's checks, in its order: the name, then the unit.
    if (await checkPartNameExists(env.company.id, name)) {
      return { ok: false, message: `${env.company.name} already has a part named ${name}.` };
    }
    const resolved = await resolvePartUnit(args.unit, env);
    const badUnit = unitRefusal(resolved, args.add_custom_unit);
    if (badUnit) return { ok: false, message: badUnit };
    let vendor: VendorRef | null = null;
    if (wantsVendor) {
      const found = await findLiveVendor(args, env);
      if ('message' in found) return { ok: false, message: found.message };
      vendor = found;
    }

    const { unit, added } = await settleUnit(resolved, env);
    const created = await createPartRow(env.company.id, {
      part_name: name,
      description: args.description ?? '',
      source,
      primary_unit: unit,
      quantity: 0,
      reorder_point: args.reorder_point ?? null,
      preferred_vendor_id: vendor?.vendor_id ?? null,
    });
    return { ok: true, data: { ...partRecord(created, vendor, env), custom_unit_added: added } };
  },
});

const PART_FIELDS = ['part_name', 'description', 'source', 'unit', 'reorder_point', 'preferred_vendor'] as const;

export const updatePart = defineCompanyTool({
  name: 'update_part',
  title: 'Update a part',
  description:
    'Changes a part\'s details: its part name (part number), description, made or bought, unit of ' +
    'measure, reorder point, or a bought part\'s preferred vendor. Fields left out keep their ' +
    'value; null clears the description, reorder point or preferred vendor. Making a bought part ' +
    'made clears its preferred vendor. Find the part by id or by exact part name. Returns the part ' +
    'and which fields changed.',
  access: 'write',
  idempotent: true,
  input: {
    part_id: z.guid().optional().describe('The part, by id.'),
    part_name: z.string().optional().describe('The part, by its exact part name (part number), when you have no id.'),
    new_part_name: z.string().optional().describe('A new part name (part number).'),
    description: z.string().nullable().optional(),
    source: z.enum(SOURCES).optional().describe(SOURCE_HELP),
    unit: z.string().optional().describe(`A new primary unit of measure. ${unitHelp}`),
    add_custom_unit: addCustomUnitInput,
    reorder_point: z.number().min(0).nullable().optional().describe('Stock level that flags the part as low.'),
    preferred_vendor_id: z.guid().nullable().optional().describe('The preferred vendor, by id; null clears it. Bought parts only.'),
    preferred_vendor_name: vendorInput.preferred_vendor_name,
  },
  output: {
    ...partRecordOutput,
    archived: z.boolean().describe('The part is archived: kept for history, hidden from lists and pickers.'),
    changed: z.array(z.enum(PART_FIELDS)).describe('The fields this call changed; empty when every value was already so.'),
    custom_unit_added: z.boolean().describe('`unit` was added as a unit of the company\'s own.'),
    starter_pricing_added: starterOutput,
  },
  run: async (args, env) => {
    const given = [
      args.new_part_name,
      args.description,
      args.source,
      args.unit,
      args.reorder_point,
      args.preferred_vendor_id,
      args.preferred_vendor_name,
    ].some((v) => v !== undefined);
    if (!given) {
      return {
        ok: false,
        message:
          'Give at least one field to change: new_part_name, description, source, unit, reorder_point ' +
          'or a preferred vendor.',
      };
    }
    const found = await findPart(args, env);
    if ('message' in found) return { ok: false, message: found.message };
    const { part, archived } = found;

    // The identity section edits a copy of the saved part and writes the whole of it back.
    const next: PartFormData = partToFormData(part);
    if (args.new_part_name !== undefined) {
      const name = args.new_part_name.trim();
      if (!name) return { ok: false, message: 'A part name cannot be blank.' };
      if (await checkPartNameExists(env.company.id, name, part.id)) {
        return { ok: false, message: `${env.company.name} already has another part named ${name}.` };
      }
      next.part_name = name;
    }
    if (args.description !== undefined) next.description = args.description ?? '';
    if (args.reorder_point !== undefined) next.reorder_point = args.reorder_point;
    if (args.source !== undefined) {
      // Switching to made clears the vendor, as the Made / Bought toggle does.
      if (args.source === 'made' && part.source !== 'made') next.preferred_vendor_id = null;
      next.source = args.source;
    }

    let vendor: VendorRef | null | undefined;
    if (args.preferred_vendor_id === null) {
      next.preferred_vendor_id = null;
      vendor = null;
    } else if (args.preferred_vendor_id || args.preferred_vendor_name?.trim()) {
      if (next.source !== 'bought') return { ok: false, message: ONLY_BOUGHT_HAS_VENDOR };
      const hit = await findLiveVendor(args, env);
      if ('message' in hit) return { ok: false, message: hit.message };
      next.preferred_vendor_id = hit.vendor_id;
      vendor = hit;
    }

    // A unit already on the part stays valid even when it is a legacy one the picker flags.
    let resolved: UnitResolution | null = null;
    if (args.unit !== undefined && args.unit.trim() !== (part.primary_unit ?? '')) {
      resolved = await resolvePartUnit(args.unit, env);
      const badUnit = unitRefusal(resolved, args.add_custom_unit);
      if (badUnit) return { ok: false, message: badUnit };
    }
    let customUnitAdded = false;
    if (resolved) {
      const settled = await settleUnit(resolved, env);
      next.primary_unit = settled.unit;
      customUnitAdded = settled.added;
    }

    const changed = PART_FIELDS.filter((field) => {
      switch (field) {
        case 'part_name':
          return next.part_name.trim() !== part.part_name;
        case 'description':
          return (next.description.trim() || null) !== part.description;
        case 'source':
          return next.source !== part.source;
        case 'unit':
          return (next.primary_unit?.trim() || null) !== part.primary_unit;
        case 'reorder_point':
          return next.reorder_point !== part.reorder_point;
        case 'preferred_vendor':
          return (next.preferred_vendor_id || null) !== part.preferred_vendor_id;
      }
    });
    if (changed.length === 0) {
      return {
        ok: true,
        data: {
          ...partRecord(part, vendor === undefined ? await vendorRefOf(env, part.preferred_vendor_id) : vendor, env),
          archived,
          changed,
          custom_unit_added: customUnitAdded,
          starter_pricing_added: false,
        },
      };
    }

    const wasPriceable = await priceableBefore(part.id);
    const updated = await updatePartRow(part.id, {
      ...next,
      part_name: next.part_name.trim(),
      primary_unit: next.primary_unit?.trim() || null,
    });
    const started = await startPricingIfNeeded(env, updated, wasPriceable);
    return {
      ok: true,
      data: {
        ...partRecord(updated, vendor === undefined ? await vendorRefOf(env, updated.preferred_vendor_id) : vendor, env),
        archived,
        changed,
        custom_unit_added: customUnitAdded,
        starter_pricing_added: started,
      },
    };
  },
});

// ─── set_part_pricing_tiers ───────────────────────────────────────────────────────────────────

const partRefInput = {
  part_id: z.guid().optional().describe('The part, by id.'),
  part_name: z.string().optional().describe('The part, by its exact part name (part number), when you have no id.'),
};

type TierOut = z.infer<typeof tierOutput>;

async function pricedTiers(partId: string): Promise<TierOut[]> {
  const tiers = await getTiersWithComputedPrices(partId);
  return tiers.map((t) => ({
    quantity: Number(t.quantity),
    unit_price: t.unit_price,
    markup_percent: t.markup_percent === null ? null : Number(t.markup_percent),
    cost_per_unit: t.cost_per_unit === null ? null : Number(t.cost_per_unit),
  }));
}

const numOrNull = (n: number | string | null): number | null => (n === null ? null : Number(n));

export const setPartPricingTiers = defineCompanyTool({
  name: 'set_part_pricing_tiers',
  title: 'Set a part\'s pricing tiers',
  description:
    'Replaces a part\'s pricing tiers with the ones given, as saving the Pricing card does. Each ' +
    'tier is a quantity break whose price holds from that quantity up to the next break: a markup ' +
    'percent over the part\'s cost, and for a bought part what it costs at that break (a made ' +
    'part\'s cost comes from its routing and materials). Tiers left out are removed; a break kept ' +
    'at the same quantity keeps its identity, so quotes on the part do not read as changed. The ' +
    'change is logged in the part\'s notes. Returns the tiers with the unit price each now gives.',
  access: 'write',
  idempotent: true,
  input: {
    ...partRefInput,
    tiers: z
      .array(
        z.object({
          quantity: z
            .number()
            .positive()
            .describe(`The quantity break, greater than zero, up to ${MAX_QUANTITY_DECIMALS} decimal places.`),
          markup_percent: z
            .number()
            .min(0)
            .nullable()
            .optional()
            .describe('Percent over cost. Null leaves the tier without a markup, so it gives no price.'),
          cost_per_unit: z
            .number()
            .min(0)
            .nullable()
            .optional()
            .describe('What one costs at this break, in dollars. Bought parts only.'),
        }),
      )
      .min(1)
      .max(TIER_LIMIT)
      .describe('Every tier the part should have.'),
  },
  output: {
    part_id: z.string(),
    part_name: z.string(),
    source: z.enum(SOURCES).describe(SOURCE_HELP),
    pricing_tiers: z.array(tierOutput),
    changed: z.boolean().describe('False when the part already had exactly these tiers, so nothing was written.'),
    starter_pricing_added: starterOutput,
    url: urlOutput,
  },
  run: async (args, env) => {
    const found = await findPart(args, env);
    if ('message' in found) return { ok: false, message: found.message };
    const { part } = found;
    const bought = part.source === 'bought';

    // The Pricing card's own checks before it saves.
    const bad = args.tiers.find((t) => !isValidQuantityValue(t.quantity));
    if (bad) {
      return {
        ok: false,
        message: `Every tier needs a quantity greater than 0 with at most ${MAX_QUANTITY_DECIMALS} decimal places; ${bad.quantity} is not.`,
      };
    }
    const quantities = args.tiers.map((t) => t.quantity);
    const dupes = [...new Set(quantities.filter((q, i) => quantities.indexOf(q) !== i))];
    if (dupes.length > 0) {
      return {
        ok: false,
        message: `Two tiers share the same quantity (${dupes.join(', ')}). One break, one row: give them different quantities or drop one.`,
      };
    }
    if (!bought && args.tiers.some((t) => t.cost_per_unit != null)) {
      return {
        ok: false,
        message: `${part.part_name} is made in the shop, so its cost comes from its routing and materials. cost_per_unit is for bought parts.`,
      };
    }

    // A break at the same quantity is the same row: it keeps its id and sequence, the way a row
    // edited in place does in the card. New breaks take sequences above every existing one, and
    // the rows that go are deleted first, so neither unique constraint is crossed mid-save.
    const existing = await getTiersForPart(part.id);
    let nextSequence = existing.reduce((max, t) => Math.max(max, t.sequence), 0);
    const sorted = [...args.tiers].sort((a, b) => a.quantity - b.quantity);
    const payload: PartPricingTierInput[] = sorted.map((t) => {
      const same = existing.find((e) => Number(e.quantity) === t.quantity);
      return {
        id: same?.id,
        sequence: same ? same.sequence : (nextSequence += 10),
        quantity: t.quantity,
        // A made part stores no cost: its base is the routing + BOM rollup.
        cost_per_unit: bought ? (t.cost_per_unit ?? null) : null,
        markup_percent: t.markup_percent ?? null,
      };
    });

    const unchanged =
      existing.length === payload.length &&
      payload.every((p) => {
        const row = existing.find((e) => e.id === p.id);
        return (
          row !== undefined &&
          numOrNull(row.markup_percent) === p.markup_percent &&
          numOrNull(row.cost_per_unit) === (p.cost_per_unit ?? null)
        );
      });
    if (unchanged) {
      return {
        ok: true,
        data: {
          part_id: part.id,
          part_name: part.part_name,
          source: part.source,
          pricing_tiers: await pricedTiers(part.id),
          changed: false,
          starter_pricing_added: false,
          url: partLink(env, part.id),
        },
      };
    }

    const wasPriceable = await priceableBefore(part.id);
    await replaceTiersForPart(env.company.id, part.id, payload);
    // The card logs every save as a 'pricing' note, and a note that fails never fails the save.
    try {
      const authorId = await memberIdOf(env);
      if (authorId) {
        const summary = payload.map((t) => `@${t.quantity} → ${t.markup_percent ?? '—'}%`).join(', ');
        const label = payload.length === 1 ? 'tier' : 'tiers';
        await addPartPricingNote(part.id, env.company.id, authorId, `Pricing updated — ${payload.length} ${label}: ${summary}`);
      }
    } catch (err) {
      Sentry.captureException(toError(err, 'addPartPricingNote'), { tags: { area: 'part-pricing', mcp: 'pricing_note' } });
    }
    const started = await startPricingIfNeeded(env, part, wasPriceable);
    return {
      ok: true,
      data: {
        part_id: part.id,
        part_name: part.part_name,
        source: part.source,
        pricing_tiers: await pricedTiers(part.id),
        changed: true,
        starter_pricing_added: started,
        url: partLink(env, part.id),
      },
    };
  },
});

// ─── update_part_bom ──────────────────────────────────────────────────────────────────────────

type BomOut = z.infer<typeof bomLineOutput>;

function bomOut(lines: BomLineWithChildPart[], env: CompanyToolEnv): BomOut[] {
  return lines.map((line) => ({
    part_id: line.child_part.id,
    part_name: line.child_part.part_name,
    description: line.child_part.description,
    source: line.child_part.source,
    quantity: line.quantity,
    unit: line.unit,
    charge_basis: line.charge_basis,
    url: partLink(env, line.child_part.id),
  }));
}

/**
 * The units a material line may use (MaterialRowEditor): the child's primary unit, the standard
 * units of the same kind (feet for an inches part), and conversions already defined on the child.
 */
async function materialUnits(child: Part): Promise<string[]> {
  const primary = child.primary_unit;
  if (!primary) return [];
  const conversions = await getPartUnitConversions(child.id);
  return [...new Set([primary, ...getStandardUnitsForUnit(primary), ...conversions.map((c) => c.from_unit)])];
}

function matchUnit(raw: string, allowed: string[]): string | null {
  const wanted = raw.trim();
  const key = standardUnitKey(wanted);
  return allowed.find((u) => sameText(u, wanted) || (key !== null && u === key)) ?? null;
}

/** However the part's materials are charged already; null when it has none or they disagree. */
function materialsStance(lines: BomLineWithChildPart[]): ChargeBasis | null {
  if (lines.length === 0) return null;
  if (lines.every((l) => l.charge_basis === 'price')) return 'price';
  if (lines.every((l) => l.charge_basis === 'cost')) return 'cost';
  return null;
}

const BOM_ACTIONS = ['add', 'update', 'remove'] as const;

export const updatePartBom = defineCompanyTool({
  name: 'update_part_bom',
  title: 'Change a part\'s bill of materials',
  description:
    'Changes one line of a made part\'s bill of materials (the parts and stock it consumes), as the ' +
    'Materials editor does. `add` puts a child part on it with how much goes into one of this part; ' +
    '`update` changes that quantity or unit; `remove` takes the line off (the child part itself is ' +
    'untouched). A line may use the child\'s own unit, a standard unit of the same kind (converted ' +
    'at the standard rate) or a unit the child already has a conversion for. A new line is ' +
    'charged the way the part\'s other materials are, else at the shop\'s default. Find the part and ' +
    'the child by id or exact part name. Returns the whole bill of materials.',
  access: 'write',
  idempotent: false,
  input: {
    ...partRefInput,
    action: z.enum(BOM_ACTIONS),
    child_part_id: z.guid().optional().describe('The material, by part id.'),
    child_part_name: z.string().optional().describe('The material, by exact part name, when you have no id.'),
    quantity: z
      .number()
      .positive()
      .optional()
      .describe('How much of the child goes into one of this part, in `unit`. Below 1 is a yield: 0.05 means one makes 20. Needed to add.'),
    unit: z.string().optional().describe('The unit `quantity` is in. Defaults to the child\'s own unit when adding.'),
  },
  output: {
    part_id: z.string(),
    part_name: z.string(),
    bill_of_materials: z.array(bomLineOutput),
    starter_pricing_added: starterOutput,
    url: urlOutput,
  },
  run: async (args, env) => {
    const found = await findPart(args, env);
    if ('message' in found) return { ok: false, message: found.message };
    const { part } = found;
    if (!args.child_part_id && !args.child_part_name?.trim()) {
      return { ok: false, message: 'Name the material: give a child_part_id or a child_part_name.' };
    }
    const childFound = await findPart({ part_id: args.child_part_id, part_name: args.child_part_name }, env);
    if ('message' in childFound) return { ok: false, message: childFound.message };
    const child = childFound.part;

    const lines = await getBomForPart(part.id);
    const line = lines.find((l) => l.child_part_id === child.id);

    let write: () => Promise<unknown>;
    if (args.action === 'add') {
      // The Materials panel shows for a made part, or a bought one still carrying old lines.
      if (part.source === 'bought' && lines.length === 0) {
        return { ok: false, message: `${part.part_name} is bought, so it has no bill of materials.` };
      }
      if (child.id === part.id) return { ok: false, message: 'A part cannot be a material of itself.' };
      // The child picker offers live parts only.
      if (childFound.archived) {
        return { ok: false, message: `${child.part_name} is archived, so it can't be added as a material.` };
      }
      if (line) {
        return {
          ok: false,
          message: `${child.part_name} is already in ${part.part_name}'s bill of materials. Use update to change its quantity or unit.`,
        };
      }
      if (args.quantity === undefined) {
        return { ok: false, message: `Give how much ${child.part_name} goes into one ${part.part_name}.` };
      }
      const allowed = await materialUnits(child);
      const unit = args.unit === undefined ? child.primary_unit : matchUnit(args.unit, allowed);
      if (!unit) {
        return {
          ok: false,
          message:
            `${child.part_name} can't be measured in ${args.unit ?? 'that unit'} here. Its units are ` +
            `${allowed.join(', ') || 'none yet'}; another needs a unit conversion on ${child.part_name} in Jigged.`,
        };
      }
      const cycle = await checkBomCycle(part.id, child.id);
      if (cycle.would_create_cycle) {
        const names = await getPartNamesByIds(cycle.cycle_path ?? []);
        const path = (cycle.cycle_path ?? []).map((id) => names.get(id) ?? id).join(' → ');
        return { ok: false, message: `Adding ${child.part_name} to ${part.part_name} would make a loop: ${path}.` };
      }
      const company = await getCompany(env.company.id);
      const basis = chargeBasisForNewLine(materialsStance(lines), readCompanyPricingDefaults(company).materialChargeBasis);
      write = async () => {
        await ensureConversion(child, unit);
        await addBomLine(part.id, { child_part_id: child.id, quantity: String(args.quantity), unit, charge_basis: basis });
      };
    } else if (!line) {
      return {
        ok: false,
        message: `${child.part_name} is not in ${part.part_name}'s bill of materials.${args.action === 'update' ? ' Use add to put it on.' : ''}`,
      };
    } else if (args.action === 'update') {
      if (args.quantity === undefined && args.unit === undefined) {
        return { ok: false, message: 'Give a quantity or a unit to change.' };
      }
      let unit = line.unit;
      if (args.unit !== undefined) {
        const allowed = await materialUnits(child);
        const matched = matchUnit(args.unit, allowed);
        if (!matched) {
          return {
            ok: false,
            message:
              `${child.part_name} can't be measured in ${args.unit} here. Its units are ` +
              `${allowed.join(', ') || 'none yet'}; another needs a unit conversion on ${child.part_name} in Jigged.`,
          };
        }
        unit = matched;
      }
      const quantity = args.quantity ?? line.quantity;
      write = async () => {
        if (unit !== line.unit) await ensureConversion(child, unit);
        // An edit keeps the line's own charge basis.
        await updateBomLine(line.id, {
          child_part_id: line.child_part_id,
          quantity: String(quantity),
          unit,
          charge_basis: line.charge_basis,
        });
      };
    } else {
      write = () => deleteBomLine(line.id);
    }

    const wasPriceable = await priceableBefore(part.id);
    await write();
    const started = await startPricingIfNeeded(env, part, wasPriceable);
    return {
      ok: true,
      data: {
        part_id: part.id,
        part_name: part.part_name,
        bill_of_materials: bomOut(await getBomForPart(part.id), env),
        starter_pricing_added: started,
        url: partLink(env, part.id),
      },
    };
  },
});

/**
 * A line in a standard unit other than the child's own (feet on an inches part): the cost engine
 * converts only through parts_unit_conversions, so the editor writes that row at the standard
 * rate. An existing conversion is left as it is.
 */
async function ensureConversion(child: Part, unit: string): Promise<void> {
  const primary = child.primary_unit;
  if (primary && unit !== primary) {
    await ensurePartUnitConversion(child.id, unit, getSuggestedConversionFactor(unit, primary));
  }
}

// ─── save_part_routing ────────────────────────────────────────────────────────────────────────

const stepInput = z.object({
  work_center_id: z.guid().optional().describe('An in-house step: the work center, by id.'),
  work_center_name: z.string().optional().describe('An in-house step: the work center, by exact name.'),
  outside_service_id: z.guid().optional().describe('An outside step: the vendor service, by id.'),
  outside_service_name: z.string().optional().describe('An outside step: the vendor service, by exact name.'),
  outside_vendor_name: z
    .string()
    .optional()
    .describe('The vendor performing an outside service, when more than one offers a service by that name.'),
  setup_minutes: z.number().min(0).nullable().optional().describe('In-house: one-time setup for the batch, in minutes.'),
  run_minutes_per_unit: z.number().min(0).nullable().optional().describe('In-house: run time per piece, in minutes.'),
  labor_rate_per_hour: z
    .number()
    .min(0)
    .nullable()
    .optional()
    .describe('In-house: an hourly rate for this step only. Null follows the work center\'s rate.'),
  price_per_piece: z
    .number()
    .positive()
    .nullable()
    .optional()
    .describe('Outside: a price per piece for this step only. Null follows the service\'s price.'),
  instructions: z.string().nullable().optional().describe('Notes for the shop floor. Null or blank clears them.'),
});

type StepIn = z.infer<typeof stepInput>;

type Station = { kind: 'in_house'; id: string; name: string; rate: number | null };
type Service = { kind: 'outside'; id: string; name: string; price: number | null; vendor: string | null };
type StepTarget = Station | Service;

const targetKey = (t: { kind: StepTarget['kind']; id: string }): string => `${t.kind}:${t.id}`;

function opTarget(op: RoutingOperationWithWorkCenter): StepTarget | null {
  if (op.vendor_service) {
    return {
      kind: 'outside',
      id: op.vendor_service.id,
      name: op.vendor_service.name,
      price: op.vendor_service.unit_price,
      vendor: op.vendor_service.vendor?.name ?? null,
    };
  }
  if (op.work_center) {
    return { kind: 'in_house', id: op.work_center.id, name: op.work_center.name, rate: op.work_center.labor_rate };
  }
  return null;
}

/**
 * What a step runs at, from the editor's picker: live work centers and live vendor services. A
 * step already on the routing keeps its target even after that was archived, as the editor does.
 */
function resolveTarget(
  step: StepIn,
  n: number,
  stations: Station[],
  services: Service[],
  onRouting: StepTarget[],
  env: CompanyToolEnv,
): StepTarget | { message: string } {
  const wcName = step.work_center_name?.trim();
  const svcName = step.outside_service_name?.trim();
  const vendorName = step.outside_vendor_name?.trim();
  const inHouse = Boolean(step.work_center_id || wcName);
  const outside = Boolean(step.outside_service_id || svcName);
  if (inHouse && outside) {
    return { message: `Step ${n}: give a work center or an outside service, not both.` };
  }
  if (!inHouse && !outside) {
    return { message: `Step ${n}: name the work center or outside service it runs at.` };
  }
  if (inHouse) {
    const known = [...stations, ...onRouting.filter((t): t is Station => t.kind === 'in_house')];
    const hit = known.find((s) => (step.work_center_id ? s.id === step.work_center_id : sameText(s.name, wcName ?? '')));
    if (hit) return hit;
    return {
      message: step.work_center_id
        ? `Step ${n}: there is no work center with that id in ${env.company.name}.`
        : `Step ${n}: there is no work center named ${wcName} in ${env.company.name}.`,
    };
  }
  if (step.outside_service_id) {
    const known = [...services, ...onRouting.filter((t): t is Service => t.kind === 'outside')];
    const hit = known.find((s) => s.id === step.outside_service_id);
    return hit ?? { message: `Step ${n}: there is no outside service with that id in ${env.company.name}.` };
  }
  const named = (list: Service[]): Service[] =>
    list.filter((s) => sameText(s.name, svcName ?? '') && (!vendorName || sameText(s.vendor ?? '', vendorName)));
  let hits = named(services);
  if (hits.length === 0) hits = named(onRouting.filter((t): t is Service => t.kind === 'outside'));
  const unique = [...new Map(hits.map((s) => [s.id, s])).values()];
  if (unique.length === 1) return unique[0];
  if (unique.length > 1) {
    return {
      message:
        `Step ${n}: more than one vendor offers ${svcName} (${unique.map((s) => s.vendor ?? 'unknown vendor').join(', ')}). ` +
        'Give outside_vendor_name to choose.',
    };
  }
  return {
    message: vendorName
      ? `Step ${n}: ${vendorName} has no outside service named ${svcName} in ${env.company.name}.`
      : `Step ${n}: no vendor in ${env.company.name} offers an outside service named ${svcName}.`,
  };
}

type StepOut = z.infer<typeof stepOutput> & { labor_rate_per_hour: number | null; price_per_piece: number | null };

function stepsOut(ops: RoutingOperationWithWorkCenter[]): StepOut[] {
  return ops.map((op) => {
    const outside = op.vendor_service !== null;
    const num = (v: number | null): number | null => (v === null ? null : Number(v));
    return {
      sequence: op.sequence,
      operation: op.vendor_service?.name ?? op.work_center?.name ?? 'Unknown step',
      kind: outside ? 'outside' : 'in_house',
      outside_vendor: op.vendor_service?.vendor?.name ?? null,
      setup_minutes: outside ? null : num(op.setup_minutes),
      run_minutes_per_unit: outside ? null : num(op.cycle_minutes_per_unit),
      labor_rate_per_hour: outside ? null : num(op.labor_rate_override ?? op.work_center?.labor_rate ?? null),
      price_per_piece: outside ? num(op.external_unit_price ?? op.vendor_service?.unit_price ?? null) : null,
      instructions: op.instructions,
    };
  });
}

const isGiven = <T>(v: T | undefined): v is T => v !== undefined;

export const savePartRouting = defineCompanyTool({
  name: 'save_part_routing',
  title: 'Set a part\'s routing',
  description:
    'Sets a made part\'s routing: the ordered steps it is made by, as the Operations editor saves ' +
    'them. Each step runs either at an in-house work center (setup minutes, run minutes per piece, ' +
    'optionally its own labour rate) or as an outside vendor service (priced by the piece, ' +
    'optionally at its own price), with optional instructions. Steps run in the order given; steps ' +
    'left out are removed. A step at the same work center or service as one already on the routing ' +
    'is that step, edited: fields left out keep their saved value. Returns the routing as saved.',
  access: 'write',
  idempotent: true,
  input: {
    ...partRefInput,
    steps: z.array(stepInput).max(ROUTING_STEP_LIMIT).describe('Every step, in the order they run.'),
  },
  output: {
    part_id: z.string(),
    part_name: z.string(),
    routing: z.array(
      stepOutput.extend({
        labor_rate_per_hour: z
          .number()
          .nullable()
          .describe('In-house: the hourly rate the step is costed at, its own or its work center\'s.'),
        price_per_piece: z.number().nullable().describe('Outside: the price per piece, its own or the service\'s.'),
      }),
    ),
    starter_pricing_added: starterOutput,
    url: urlOutput,
  },
  run: async (args, env) => {
    const found = await findPart(args, env);
    if ('message' in found) return { ok: false, message: found.message };
    const { part } = found;
    // The Operations card is on made parts only.
    if (part.source !== 'made') {
      return { ok: false, message: `${part.part_name} is bought, so it has no routing. Only parts made in the shop do.` };
    }

    const [routing, stationRows, serviceRows] = await Promise.all([
      getRoutingForPart(part.id),
      getWorkCentersForRouting(env.company.id),
      getVendorServicesForRouting(env.company.id),
    ]);
    const ops = routing?.operations ?? [];
    if (args.steps.length === 0 && ops.length === 0) {
      return { ok: false, message: `${part.part_name} has no routing steps to remove.` };
    }
    const stations: Station[] = stationRows.map((s) => ({ kind: 'in_house', id: s.id, name: s.name, rate: s.labor_rate }));
    const services: Service[] = serviceRows.map((s) => ({
      kind: 'outside',
      id: s.id,
      name: s.name,
      price: s.unit_price,
      vendor: s.vendor_name,
    }));
    const onRouting = ops.map(opTarget).filter((t): t is StepTarget => t !== null);

    // Saved steps not yet claimed, per target, in their saved order.
    const unclaimed = new Map<string, RoutingOperationWithWorkCenter[]>();
    for (const op of ops) {
      const target = opTarget(op);
      if (!target) continue;
      const key = targetKey(target);
      unclaimed.set(key, [...(unclaimed.get(key) ?? []), op]);
    }

    const pending: PendingOperation[] = [];
    for (const [i, step] of args.steps.entries()) {
      const n = i + 1;
      const target = resolveTarget(step, n, stations, services, onRouting, env);
      if ('message' in target) return { ok: false, message: target.message };
      const saved = unclaimed.get(targetKey(target))?.shift() ?? null;
      const instructions = isGiven(step.instructions) ? step.instructions?.trim() || null : (saved?.instructions ?? null);

      if (target.kind === 'in_house') {
        if (isGiven(step.price_per_piece) && step.price_per_piece !== null) {
          return { ok: false, message: `Step ${n}: ${target.name} is a work center; price_per_piece is for an outside step.` };
        }
        const setup = isGiven(step.setup_minutes) ? step.setup_minutes : (saved?.setup_minutes ?? null);
        const run = isGiven(step.run_minutes_per_unit) ? step.run_minutes_per_unit : (saved?.cycle_minutes_per_unit ?? null);
        // The editor saves a step only with some time on it. A saved step re-sent untouched is
        // not re-checked, as the editor does not re-check a step when another one moves.
        const timed = (setup ?? 0) > 0 || (run ?? 0) > 0;
        if (!timed && (!saved || isGiven(step.setup_minutes) || isGiven(step.run_minutes_per_unit))) {
          return { ok: false, message: `Step ${n} at ${target.name} needs setup minutes or run minutes greater than zero.` };
        }
        // A rate equal to the work center's is no override: the step keeps following the centre.
        const rate = isGiven(step.labor_rate_per_hour)
          ? step.labor_rate_per_hour === null || step.labor_rate_per_hour === target.rate
            ? null
            : step.labor_rate_per_hour
          : (saved?.labor_rate_override ?? null);
        pending.push({
          tempId: saved?.id ?? `new-step-${n}`,
          workCenterId: target.id,
          vendorServiceId: null,
          workCenterName: target.name,
          vendorName: null,
          setupMinutes: setup,
          cycleMinutesPerUnit: run,
          laborRateOverride: rate,
          externalUnitPrice: null,
          instructions,
        });
      } else {
        const timed = [step.setup_minutes, step.run_minutes_per_unit, step.labor_rate_per_hour].some((v) => v != null);
        if (timed) {
          return {
            ok: false,
            message: `Step ${n}: ${target.name} is an outside service, priced by the piece; it has no setup, run time or labour rate.`,
          };
        }
        // As with the rate: a price equal to the service's own follows the service.
        const price = isGiven(step.price_per_piece)
          ? step.price_per_piece === null || step.price_per_piece === target.price
            ? null
            : step.price_per_piece
          : (saved?.external_unit_price ?? null);
        if ((!saved || isGiven(step.price_per_piece)) && !((price ?? target.price ?? 0) > 0)) {
          return {
            ok: false,
            message: `Step ${n}: ${target.name}${target.vendor ? ` from ${target.vendor}` : ''} has no price per piece; give price_per_piece.`,
          };
        }
        pending.push({
          tempId: saved?.id ?? `new-step-${n}`,
          workCenterId: null,
          vendorServiceId: target.id,
          workCenterName: target.name,
          vendorName: target.vendor,
          setupMinutes: null,
          cycleMinutesPerUnit: null,
          laborRateOverride: null,
          externalUnitPrice: price,
          instructions,
        });
      }
    }

    const wasPriceable = await priceableBefore(part.id);
    await saveRoutingWithOperations(
      env.company.id,
      part.id,
      routing?.id ?? null,
      pending,
      new Set(ops.map((op) => op.id)),
    );
    const started = await startPricingIfNeeded(env, part, wasPriceable);
    const saved = await getRoutingForPart(part.id);
    return {
      ok: true,
      data: {
        part_id: part.id,
        part_name: part.part_name,
        routing: stepsOut(saved?.operations ?? []),
        starter_pricing_added: started,
        url: partLink(env, part.id),
      },
    };
  },
});

// ─── add_part_note ────────────────────────────────────────────────────────────────────────────

export const addPartNoteTool = defineCompanyTool({
  name: 'add_part_note',
  title: 'Add a note to a part',
  description:
    'Adds a note to a part\'s Activity tab, as typing in its comment box does: text for the office, ' +
    'kept with the part. Find the part by id or by exact part name (part number). Returns the note.',
  access: 'write',
  idempotent: false,
  input: {
    ...partRefInput,
    body: z.string().describe('The note, as it should read.'),
  },
  output: {
    part_id: z.string(),
    part_name: z.string(),
    note: z.object({
      body: z.string(),
      note_type: z.enum(['user', 'pricing']),
      created_at: z.string(),
    }),
    url: urlOutput.describe('The part\'s Activity tab in Jigged.'),
  },
  run: async (args, env) => {
    if (!args.body.trim()) return { ok: false, message: 'A note cannot be empty.' };
    const found = await findPart(args, env);
    if ('message' in found) return { ok: false, message: found.message };
    const { part } = found;
    const authorId = await memberIdOf(env);
    if (!authorId) {
      return { ok: false, message: `Jigged couldn't find your membership in ${env.company.name}, so the note was not added.` };
    }
    const note = await addPartNote(part.id, env.company.id, authorId, args.body);
    // Who wrote it is deliberately absent: the body and the date are the record.
    return {
      ok: true,
      data: {
        part_id: part.id,
        part_name: part.part_name,
        note: { body: note.body, note_type: note.note_type, created_at: note.created_at },
        url: companyLink(env, `/parts/${part.id}?tab=history`),
      },
    };
  },
});

export function registerPartWriteTools(server: McpServer): void {
  registerCompanyTool(server, createPart);
  registerCompanyTool(server, updatePart);
  registerCompanyTool(server, setPartPricingTiers);
  registerCompanyTool(server, updatePartBom);
  registerCompanyTool(server, savePartRouting);
  registerCompanyTool(server, addPartNoteTool);
}

/** Exported for the catalogue test. */
export const PART_WRITE_TOOLS = [
  createPart,
  updatePart,
  setPartPricingTiers,
  updatePartBom,
  savePartRouting,
  addPartNoteTool,
];
