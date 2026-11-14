/**
 * Purchase units against stock units (plan §3.5 "Units").
 *
 * The stock unit is `parts.primary_unit`. A PO line buys in a purchase unit, which must be the
 * stock unit itself or carry exactly ONE factor for the part — a `parts_unit_conversions` row, or a
 * same-kind preset (feet → inches, hundred → each) that the access layer writes as a row before the
 * RPC (precedent: `PartBomPanel`). The RPC freezes that factor on the line.
 *
 * Resolution follows `resolveUnitBasis` in lib/materialRequirements.ts: same unit → the part's own
 * conversion → a preset; otherwise INCOMPARABLE. It never uses `convertToBaseUnit`, which returns
 * the unconverted number when it can't convert — "3 bars" would land as 3 inches of stock.
 *
 * Quantities and prices cross units through lib/money's exact decimal arithmetic, rounded where the
 * columns round (stock quantities to 6 places, prices to the 5 a price is stored at), so a figure
 * shown before saving is the figure the database stores.
 */
import { divideDecimal, multiplyDecimal, multiplyDivideDecimal, roundDecimal } from '@/lib/money';
import { ALL_UNITS, getConversionFactor, getStandardUnitsForUnit, resolveUnitAlias } from '@/lib/unitPresets';
import { unitShortLabel } from '@/lib/standardUnits';

/** A `parts_unit_conversions` row: 1 `from_unit` = `to_primary_factor` stock units. */
export interface UnitConversionRow {
  from_unit: string;
  to_primary_factor: number;
}

/**
 * How a purchase unit relates to the stock unit. `unit` is the spelling to WRITE on the line: the
 * part's own spelling for its stock unit, a stored row's spelling for a conversion, the canonical
 * name for a preset.
 */
export type PurchaseUnitBasis =
  | { kind: 'same'; unit: string; stockUnit: string; factor: 1 }
  | { kind: 'converted'; unit: string; stockUnit: string; factor: number; source: 'conversion' | 'preset' }
  | { kind: 'incomparable'; unit: string; stockUnit: string | null };

/** Stock quantities are stored to 6 places (`stock_quantity = round(qty × factor, 6)`). */
export const STOCK_QUANTITY_PLACES = 6;
/** Unit prices are stored to 5 places (`numeric(16,5)`). */
const PRICE_PLACES = 5;
/** Prices per STOCK unit get one more place: a per-thousand price is a small number per each. */
const STOCK_PRICE_PLACES = 6;

/**
 * A unit name the way the presets read it: trimmed, aliases resolved (`ea` → `each`,
 * `in` → `inches`), and standard units matched in any case (`FT` → `feet`) as the importer does.
 * A shop's own unit keeps its spelling.
 */
export function normalizeUnitName(unit: string | null | undefined): string {
  const trimmed = (unit ?? '').trim();
  if (!trimmed) return '';
  const lower = trimmed.toLowerCase();
  // `L` and `mL` are the only aliases that are not lowercase.
  for (const candidate of [trimmed, lower, lower.replace(/l$/, 'L')]) {
    const resolved = resolveUnitAlias(candidate);
    if (ALL_UNITS.includes(resolved)) return resolved;
  }
  return trimmed;
}

/**
 * The TypeScript twin of SQL `unit_name_key` (migration 20261110043700): the trimmed name with
 * `UNIT_ALIASES` applied exactly as the database applies them — case-sensitively, so `L` and `mL`
 * survive — then lower-cased. Two names the database calls the same unit have equal keys, so
 * "Bar" IS a part's "bar" conversion to `part_unit_factor`.
 */
export function unitNameKey(unit: string | null | undefined): string {
  return resolveUnitAlias((unit ?? '').trim()).toLowerCase();
}

/**
 * Do two names mean one unit? When the database's key says so ("Bar" and "bar"), and also when
 * both are the same standard unit in any case ("FT" and "feet") — the importer's reading, which is
 * safe because whatever matches, the spelling this module hands back to WRITE is one the database
 * agrees with: the part's own stock unit, a stored row's spelling, or a preset's canonical name.
 */
function sameUnitName(a: string, b: string): boolean {
  const keyA = unitNameKey(a);
  const keyB = unitNameKey(b);
  if (keyA === '' || keyB === '') return false;
  if (keyA === keyB) return true;
  return normalizeUnitName(a).toLowerCase() === normalizeUnitName(b).toLowerCase();
}

function usableFactor(factor: unknown): number | null {
  const n = typeof factor === 'number' ? factor : Number(factor);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * The part's stored conversion for `unit`: the exact spelling first, then any row the database
 * would call the same unit (`unitNameKey`, aliases, case) — returned in the row's own spelling.
 */
function findConversion(
  unit: string,
  conversions: readonly UnitConversionRow[],
): { unit: string; factor: number } | null {
  const usable = conversions
    .map((c) => ({ unit: (c.from_unit ?? '').trim(), factor: usableFactor(c.to_primary_factor) }))
    .filter((c): c is { unit: string; factor: number } => c.unit !== '' && c.factor !== null);
  const exact = usable.find((c) => c.unit === unit.trim());
  if (exact) return exact;
  return usable.find((c) => sameUnitName(c.unit, unit)) ?? null;
}

/**
 * How `unit` relates to the part's stock unit. A blank unit means the stock unit. Anything that
 * cannot be related is `incomparable` — never factor 1. Names compare the way the database
 * compares them, so a unit in another case is the same unit.
 */
export function resolvePurchaseUnit(
  unit: string | null | undefined,
  stockUnit: string | null | undefined,
  conversions: readonly UnitConversionRow[] = [],
): PurchaseUnitBasis {
  const stock = (stockUnit ?? '').trim();
  const typed = (unit ?? '').trim();
  if (!stock) return { kind: 'incomparable', unit: normalizeUnitName(typed), stockUnit: null };
  if (!typed || sameUnitName(typed, stock)) {
    return { kind: 'same', unit: stock, stockUnit: stock, factor: 1 };
  }
  const stored = findConversion(typed, conversions);
  if (stored) return { kind: 'converted', unit: stored.unit, stockUnit: stock, factor: stored.factor, source: 'conversion' };
  const canonical = normalizeUnitName(typed);
  const preset = usableFactor(getConversionFactor(canonical, normalizeUnitName(stock)));
  if (preset !== null) return { kind: 'converted', unit: canonical, stockUnit: stock, factor: preset, source: 'preset' };
  return { kind: 'incomparable', unit: canonical, stockUnit: stock };
}

/** A preset factor must be stored as a `parts_unit_conversions` row before the RPC sees the line. */
export function needsConversionRow(basis: PurchaseUnitBasis): boolean {
  return basis.kind === 'converted' && basis.source === 'preset';
}

/** Purchase units → stock units: `round(quantity × factor, 6)`, exactly. */
export function toStockQuantity(purchaseQuantity: number, factor: number): number {
  return multiplyDecimal(purchaseQuantity, factor, STOCK_QUANTITY_PLACES);
}

/** Stock units → purchase units, to 6 places. NaN for a factor that is not positive. */
export function toPurchaseQuantity(stockQuantity: number, factor: number): number {
  if (!(factor > 0)) return Number.NaN;
  return divideDecimal(stockQuantity, factor, STOCK_QUANTITY_PLACES);
}

const WHOLE_TOLERANCE = 1e-9;

/**
 * The whole number of purchase units that covers `stockQuantity` — 400 in is 3 bars of 144, 288 in
 * is exactly 2. Rounds up with a relative tolerance, so float noise (1.1 ÷ 0.1 is
 * 11.000000000000002) never adds a unit nobody needs. Never negative; NaN for a bad factor.
 */
export function wholePurchaseUnits(stockQuantity: number, factor: number): number {
  if (!(factor > 0) || !Number.isFinite(stockQuantity)) return Number.NaN;
  if (stockQuantity <= 0) return 0;
  const units = stockQuantity / factor;
  const nearest = Math.round(units);
  if (Math.abs(units - nearest) <= WHOLE_TOLERANCE * Math.max(1, nearest)) return nearest;
  return Math.ceil(units);
}

/** A price per purchase unit, per stock unit instead: price ÷ factor. */
export function pricePerStockUnit(unitPrice: number, factor: number): number {
  return divideDecimal(unitPrice, factor, STOCK_PRICE_PLACES);
}

/** A price per stock unit, per purchase unit instead: price × factor, at the stored 5 places. */
export function pricePerPurchaseUnit(stockUnitPrice: number, factor: number): number {
  return multiplyDecimal(stockUnitPrice, factor, PRICE_PLACES);
}

/**
 * A price quoted per one purchase unit (factor `fromFactor`) re-expressed per another
 * (`toFactor`): price × toFactor ÷ fromFactor, rounded once to the stored 5 places.
 */
export function convertUnitPrice(price: number, fromFactor: number, toFactor: number): number {
  if (!(fromFactor > 0) || !(toFactor > 0)) return Number.NaN;
  if (fromFactor === toFactor) return roundDecimal(price, PRICE_PLACES);
  return multiplyDivideDecimal(price, toFactor, fromFactor, PRICE_PLACES);
}

/** A quantity for a label: up to 6 places, thousands grouped. */
export function formatUnitQuantity(n: number): string {
  return roundDecimal(n, STOCK_QUANTITY_PLACES).toLocaleString('en-US', { maximumFractionDigits: STOCK_QUANTITY_PLACES });
}

/** The short symbol a label uses: `in`, `ft`, `ea`; a shop's own unit as written. */
export function unitLabel(unit: string): string {
  return unitShortLabel(unit) ?? unit;
}

/** "1 bar = 144 in". Nothing for the stock unit itself, or for a unit that cannot be related. */
export function factorLabel(basis: PurchaseUnitBasis): string | null {
  if (basis.kind !== 'converted') return null;
  return `1 ${unitLabel(basis.unit)} = ${formatUnitQuantity(basis.factor)} ${unitLabel(basis.stockUnit)}`;
}

/** "= 432 in" — a purchase quantity in stock units. Nothing when there is no conversion to show. */
export function stockEquivalentLabel(purchaseQuantity: number, basis: PurchaseUnitBasis): string | null {
  if (basis.kind !== 'converted' || !Number.isFinite(purchaseQuantity)) return null;
  return `= ${formatUnitQuantity(toStockQuantity(purchaseQuantity, basis.factor))} ${unitLabel(basis.stockUnit)}`;
}

/**
 * What a purchase-unit picker offers: the stock unit, the part's usable conversions, then the
 * same-kind presets it does not already cover. A unit that cannot be related appears only through
 * "Another unit…", which adds a conversion.
 */
export function purchaseUnitOptions(
  stockUnit: string | null | undefined,
  conversions: readonly UnitConversionRow[] = [],
): PurchaseUnitBasis[] {
  const stock = (stockUnit ?? '').trim();
  if (!stock) return [];
  const options: PurchaseUnitBasis[] = [resolvePurchaseUnit(stock, stock, conversions)];
  // One option per unit as the database counts units, so "Bar" and "bar" are never offered twice.
  const offered = [stock];
  const add = (unit: string) => {
    if (!unit.trim() || offered.some((u) => sameUnitName(u, unit))) return;
    const basis = resolvePurchaseUnit(unit, stock, conversions);
    if (basis.kind !== 'converted') return;
    offered.push(unit, basis.unit);
    options.push(basis);
  };
  for (const c of conversions) add(c.from_unit);
  for (const preset of getStandardUnitsForUnit(normalizeUnitName(stock))) add(preset);
  return options;
}

/**
 * The default purchase unit for a new line: the vendor's price-sheet unit, else the unit last
 * ordered for this part, else the stock unit. A candidate that no longer relates to the stock unit
 * (the part's primary unit changed since) is skipped. Returns the spelling to write.
 */
export function defaultPurchaseUnit(args: {
  sheetUnit: string | null | undefined;
  lastOrderedUnit: string | null | undefined;
  stockUnit: string | null | undefined;
  conversions?: readonly UnitConversionRow[];
}): string | null {
  const stock = (args.stockUnit ?? '').trim();
  if (!stock) return null;
  for (const candidate of [args.sheetUnit, args.lastOrderedUnit]) {
    if (!candidate || !candidate.trim()) continue;
    const basis = resolvePurchaseUnit(candidate, stock, args.conversions ?? []);
    if (basis.kind !== 'incomparable') return basis.unit;
  }
  return stock;
}
