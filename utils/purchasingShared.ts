/**
 * Plumbing shared by the purchasing access layer — `vendorPoAccess`, `partVendorsAccess`,
 * `vendorRfqAccess`, `buyListAccess` and `purchasingSettingsAccess` (plan §3.14).
 *
 * WHY RPC FAILURES ARE REPORTED BY HAND. `.rpc()` is deliberately outside the Sentry Supabase
 * integration (lib/supabase.ts), exactly as `utils/outsideShipmentsAccess.ts` explains, so every
 * purchasing write reports its own failure. `.from()` reads are NOT reported here: the integration
 * already files those with the query attached, and a second capture files one failure twice.
 *
 * WHY P0001 IS NOT REPORTED. Every purchasing RPC pre-validates its CHECKs and raises them as
 * P0001 sentences ("PO-1042 is closed. Reopen it to change it."), and not-found and non-member
 * share "That record is not available." Those are refusals the person can act on, not defects:
 * the sentence reaches them through `toFriendlyError` (which passes P0001 text through) and the
 * issue queue never sees it. 42501 (an operator, a lapsed subscription) and XX000 (our own bug:
 * an unknown jsonb key, a missing p_today) still report, through `shouldReportSupabaseError`.
 *
 * NO CACHES. The MCP tools call these same functions on the server, once per request, with that
 * request's client (`getSupabase()` resolves it); a module-level cache would leak one company's
 * rows into another's request.
 */
import * as Sentry from '@sentry/nextjs';
import { z } from 'zod';

import { getSupabase } from '@/lib/supabase';
import { ID_CHUNK } from '@/lib/queryLimits';
import { shouldReportSupabaseError, toError, toFriendlyError } from '@/lib/supabaseErrors';
import {
  resolvePurchaseUnit,
  formatUnitQuantity,
  unitLabel,
  type PurchaseUnitBasis,
  type UnitConversionRow,
} from '@/lib/purchasing/purchaseUnits';
import { ensurePartUnitConversion } from '@/utils/partsAccess';
import type { AddressSnapshot, ContactSnapshot } from '@/types/documentSnapshot';

/** `raise_exception` — a sentence one of our own functions wrote for a person. */
const REFUSAL_CODE = 'P0001';

/** A refusal the person can act on, raised as a sentence by a purchasing RPC. */
export function isPurchasingRefusal(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as { code?: unknown }).code === REFUSAL_CODE);
}

/** Report an RPC failure by hand, unless it is a P0001 sentence or an expected non-failure. */
export function reportPurchasingRpcError(error: unknown, op: string): void {
  if (isPurchasingRefusal(error)) return;
  if (!shouldReportSupabaseError(error)) return;
  Sentry.captureException(toError(error, `Failed to ${op}`), { tags: { area: 'purchasing', op } });
}

/**
 * The error a purchasing write throws for a failed RPC: reported (see above), then translated.
 * A P0001 keeps its sentence; anything `toFriendlyError` cannot place reads "Failed to …", which
 * is how the MCP server tells our own failure from a rule the person broke.
 */
export function purchasingRpcFailure(error: unknown, op: string, entity: string): Error {
  reportPurchasingRpcError(error, op);
  return toFriendlyError(error, { entity, fallback: `Failed to ${op}.` });
}

/** A `.from()` read failure: already reported by the integration, so only translated. */
export function purchasingReadFailure(error: unknown, op: string, entity: string): Error {
  return toFriendlyError(error, { entity, fallback: `Failed to ${op}.` });
}

/**
 * Parse an RPC's jsonb result. Never `as unknown as`: a result that does not fit is OUR bug (the
 * function and this layer disagree), so it is reported and thrown as "Failed to …". For a write
 * the change has already been made, so the sentence says to reload before trying again.
 */
export function parsePurchasingResult<T>(schema: z.ZodType<T>, data: unknown, op: string): T {
  return parseOrThrow(
    schema,
    data,
    op,
    `Failed to read the reply to "${op}". Reload before trying again, so nothing is done twice.`,
  );
}

function parseOrThrow<T>(schema: z.ZodType<T>, data: unknown, op: string, message: string): T {
  const parsed = schema.safeParse(data);
  if (parsed.success) return parsed.data;
  const err = new Error(message);
  Sentry.captureException(err, {
    tags: { area: 'purchasing', op, kind: 'result_shape' },
    extra: { issues: parsed.error.issues.slice(0, 10) },
  });
  throw err;
}

/**
 * A column the generated types call nullable but the schema never leaves empty (a view column,
 * which PostgreSQL always reports as nullable). A null here is a broken read, not "no value", so
 * it is reported and thrown rather than defaulted.
 */
export function present<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) {
    const err = new Error(`Failed to read ${what}.`);
    Sentry.captureException(err, { tags: { area: 'purchasing', kind: 'missing_column' } });
    throw err;
  }
  return value;
}

/** PostgREST hands back a RETURNS TABLE result as an array, even for one row. */
export function firstRow<T>(data: T[] | T | null | undefined): T | null {
  if (data === null || data === undefined) return null;
  return Array.isArray(data) ? (data[0] ?? null) : data;
}

/** Split ids into `.in()`-sized chunks (lib/queryLimits.ts: 220 ids is already a 414). */
export function chunkIds<T>(ids: readonly T[], size: number = ID_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}

/** A Supabase embed comes back as an object, an array of one, or null. */
export function one<T>(rel: T | T[] | null | undefined): T | null {
  if (!rel) return null;
  return Array.isArray(rel) ? (rel[0] ?? null) : rel;
}

/** A trimmed string, or null for blank. */
export function textOrNull(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed === '' ? null : trimmed;
}

// ------------------------------------------------------------------------------------------------
// Snapshots (jsonb columns): parsed, never cast
// ------------------------------------------------------------------------------------------------

const snapshotText = z
  .string()
  .nullish()
  .transform((v) => v ?? null);

const addressSnapshotSchema = z.object({
  address_line1: snapshotText,
  address_line2: snapshotText,
  city: snapshotText,
  state: snapshotText,
  postal_code: snapshotText,
  country: snapshotText,
  attention_to: snapshotText,
});

const contactSnapshotSchema = z.object({
  name: snapshotText,
  email: snapshotText,
  phone: snapshotText,
});

/** A frozen address block (AddressSnapshot), or null when none was frozen. */
export function parseAddressSnapshot(value: unknown, what: string): AddressSnapshot | null {
  if (value === null || value === undefined) return null;
  return parseOrThrow(addressSnapshotSchema, value, 'read address snapshot', `Failed to read ${what}.`);
}

/** A frozen contact block (ContactSnapshot), or null when none was frozen. */
export function parseContactSnapshot(value: unknown, what: string): ContactSnapshot | null {
  if (value === null || value === undefined) return null;
  return parseOrThrow(contactSnapshotSchema, value, 'read contact snapshot', `Failed to read ${what}.`);
}

// ------------------------------------------------------------------------------------------------
// Purchase units: every non-stock unit is a stored conversion BEFORE the RPC sees it
// ------------------------------------------------------------------------------------------------

/**
 * The TypeScript twin of SQL `unit_name_key` — ONE copy, in lib/purchasing/purchaseUnits.ts,
 * re-exported here for the access layer's callers (the MCP tools among them).
 */
export { unitNameKey } from '@/lib/purchasing/purchaseUnits';

/**
 * How a unit relates to a part's stock unit, the way the DATABASE compares unit names
 * (`unit_name_key`): "Bar" on a part with a "bar" conversion is that conversion, as
 * `part_unit_factor` finds it. Every unit this access layer resolves goes through here, so a sheet
 * or a line stored as "Bar" is never mistaken for an incomparable unit.
 *
 * It is `resolvePurchaseUnit`, which the PO form calls directly: that compares names as the
 * database does itself now, so the access layer and the form cannot read one unit two ways. (This
 * used to respell the unit first, from before `resolvePurchaseUnit` compared names in any case.)
 */
export function resolvePartUnit(
  unit: string | null | undefined,
  stockUnit: string | null | undefined,
  conversions: readonly UnitConversionRow[],
): PurchaseUnitBasis {
  return resolvePurchaseUnit(unit, stockUnit, conversions);
}

/** One unit a write is about to name for a part. */
export interface PurchaseUnitRequest {
  /** Matches the result back to the caller's line. */
  key: string;
  partId: string;
  unit: string | null | undefined;
  /** "Another unit…": stock units in one `unit`. Only used when the part has no factor for it. */
  unitFactor?: number | null;
}

/**
 * Make every purchase unit something the database can freeze (plan §3.5 "Units").
 *
 * The RPCs refuse a unit with no `parts_unit_conversions` row (`part_unit_factor`), and freeze the
 * factor they find. So, before the call, each requested unit is resolved the way the PO form shows
 * it (`resolvePurchaseUnit`: the stock unit, the part's own conversion, then a same-kind preset):
 *   - the stock unit, or a unit the part already converts: nothing to write;
 *   - a preset (feet on an inches part, hundred on an each part): stored as a row first — the
 *     `PartBomPanel` precedent, through the same `ensurePartUnitConversion`;
 *   - "Another unit…" with a factor: stored as a row first, add-only;
 *   - anything else: refused here with the sentence the RPC would give, before a round trip.
 * Aliases are normalised (`ea` → `each`): the spelling returned is the one to send.
 *
 * Returns the unit to send, per request key. A blank unit is left out (the RPC uses the stock
 * unit), and a part this caller cannot see is left to the RPC's own "not available".
 */
export async function preparePurchaseUnits(
  requests: readonly PurchaseUnitRequest[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const wanted = requests.filter((r) => (r.unit ?? '').trim() !== '');
  if (wanted.length === 0) return out;

  const supabase = getSupabase();
  const partIds = [...new Set(wanted.map((r) => r.partId))];
  const parts = new Map<string, { name: string; stockUnit: string | null; conversions: UnitConversionRow[] }>();
  for (const ids of chunkIds(partIds)) {
    const { data, error } = await supabase
      .from('parts')
      .select('id, part_name, primary_unit, parts_unit_conversions(from_unit, to_primary_factor)')
      .in('id', ids);
    if (error) throw purchasingReadFailure(error, 'read the units these parts are bought in', 'part');
    for (const row of data ?? []) {
      parts.set(row.id, {
        name: row.part_name,
        stockUnit: row.primary_unit,
        conversions: (row.parts_unit_conversions ?? []).map((c) => ({
          from_unit: c.from_unit,
          to_primary_factor: c.to_primary_factor,
        })),
      });
    }
  }

  const toStore = new Map<string, { partId: string; unit: string; factor: number }>();
  for (const request of wanted) {
    const part = parts.get(request.partId);
    if (!part) continue; // the RPC answers "That record is not available."
    const typed = (request.unit ?? '').trim();
    // The database compares units by `unit_name_key`, so "Bar" IS the part's "bar": resolving
    // without that would refuse here what the RPC accepts.
    const basis = resolvePartUnit(typed, part.stockUnit, part.conversions);
    const factor = request.unitFactor ?? null;
    const stock = part.stockUnit ? unitLabel(part.stockUnit) : 'its stock unit';

    if (basis.kind === 'same') {
      out.set(request.key, basis.unit);
      continue;
    }
    if (basis.kind === 'converted') {
      if (factor !== null && Math.abs(factor - basis.factor) > 1e-9 * Math.max(1, basis.factor)) {
        throw new Error(
          basis.source === 'conversion'
            ? `${part.name} already has 1 ${unitLabel(basis.unit)} = ${formatUnitQuantity(basis.factor)} ${stock}. Use that, or give the other size its own unit name.`
            : `1 ${unitLabel(basis.unit)} is always ${formatUnitQuantity(basis.factor)} ${stock}. Give a different size its own unit name.`,
        );
      }
      if (basis.source === 'preset') {
        toStore.set(`${request.partId}:${basis.unit}`, { partId: request.partId, unit: basis.unit, factor: basis.factor });
      }
      out.set(request.key, basis.unit);
      continue;
    }
    // Incomparable: only a factor the person typed can relate it.
    if (factor === null || !(factor > 0) || !Number.isFinite(factor)) {
      throw new Error(
        `${part.name} has no conversion for "${typed}". Say how many ${stock} are in one ${typed} first.`,
      );
    }
    toStore.set(`${request.partId}:${basis.unit}`, { partId: request.partId, unit: basis.unit, factor });
    out.set(request.key, basis.unit);
  }

  for (const row of toStore.values()) {
    try {
      await ensurePartUnitConversion(row.partId, row.unit, row.factor);
    } catch (err) {
      throw toFriendlyError(err, { entity: 'unit conversion', fallback: 'Failed to save the unit conversion.' });
    }
  }
  return out;
}
