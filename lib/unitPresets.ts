/**
 * Unit Presets System
 * Predefined unit categories with common conversions for manufacturing
 */

// ============================================================
// Unit Category Definitions
// ============================================================

export interface UnitCategory {
  name: string;
  units: string[];
  /** Conversion factors to the first unit in the array (base unit) */
  conversions: Record<string, number>;
}

/**
 * Predefined unit categories with common conversions
 * Each category has a base unit (first in array) and conversion factors
 */
export const UNIT_CATEGORIES: Record<string, UnitCategory> = {
  weight: {
    name: 'Weight',
    units: ['pounds', 'kilograms', 'ounces', 'grams'],
    conversions: {
      // All conversions TO pounds (base unit)
      pounds: 1,
      kilograms: 2.20462,  // 1 kg = 2.20462 lbs
      ounces: 0.0625,      // 1 oz = 0.0625 lbs
      grams: 0.00220462,   // 1 g = 0.00220462 lbs
    }
  },
  length: {
    name: 'Length',
    units: ['inches', 'feet', 'millimeters', 'centimeters', 'meters'],
    conversions: {
      // All conversions TO inches (base unit)
      inches: 1,
      feet: 12,             // 1 ft = 12 in
      millimeters: 0.03937, // 1 mm = 0.03937 in
      centimeters: 0.3937,  // 1 cm = 0.3937 in
      meters: 39.37,        // 1 m = 39.37 in
    }
  },
  volume: {
    name: 'Volume',
    units: ['gallons', 'liters', 'quarts', 'milliliters', 'fluid ounces'],
    conversions: {
      // All conversions TO gallons (base unit)
      gallons: 1,
      liters: 0.264172,         // 1 L = 0.264172 gal
      quarts: 0.25,             // 1 qt = 0.25 gal
      milliliters: 0.000264172, // 1 mL = 0.000264172 gal
      'fluid ounces': 0.0078125, // 1 fl oz = 0.0078125 gal
    }
  },
  count: {
    name: 'Count',
    units: ['pieces', 'each', 'dozen'],
    conversions: {
      pieces: 1,
      each: 1,
      dozen: 12,
    }
  },
  area: {
    name: 'Area',
    units: ['square inches', 'square feet', 'square centimeters', 'square meters'],
    conversions: {
      // All conversions TO square inches (base unit)
      'square inches': 1,
      'square feet': 144,          // 1 sq ft = 144 sq in
      'square centimeters': 0.155, // 1 sq cm = 0.155 sq in
      'square meters': 1550,       // 1 sq m = 1550 sq in
    }
  }
};

// ============================================================
// Common Units List (flat for dropdowns)
// ============================================================

/**
 * All available units as a flat array for dropdowns
 */
export const ALL_UNITS: string[] = Object.values(UNIT_CATEGORIES)
  .flatMap((category) => category.units);

/**
 * Common units grouped by category for organized dropdowns
 */
export const UNITS_BY_CATEGORY = Object.entries(UNIT_CATEGORIES).map(
  ([_key, category]) => ({
    category: category.name,
    units: category.units
  })
);

// ============================================================
// Backward-Compatible Aliases
// ============================================================

/**
 * Maps abbreviated or deprecated unit names to their canonical full names.
 * Existing data using old names will still convert correctly.
 */
const UNIT_ALIASES: Record<string, string> = {
  // Count
  ea: 'each',
  pcs: 'pieces',
  pc: 'pieces',
  dz: 'dozen',

  // Weight
  lb: 'pounds',
  lbs: 'pounds',
  kg: 'kilograms',
  kgs: 'kilograms',
  oz: 'ounces',
  g: 'grams',

  // Length
  in: 'inches',
  ft: 'feet',
  mm: 'millimeters',
  cm: 'centimeters',
  m: 'meters',

  // Volume
  gal: 'gallons',
  L: 'liters',
  qt: 'quarts',
  mL: 'milliliters',
  'fl oz': 'fluid ounces',

  // Area
  'sq in': 'square inches',
  'sq ft': 'square feet',
  'sq cm': 'square centimeters',
  'sq m': 'square meters',
};

/**
 * Resolve a unit name, applying aliases for backward compatibility.
 */
export function resolveUnitAlias(unit: string): string {
  return UNIT_ALIASES[unit] || unit;
}

// ============================================================
// Conversion Helpers
// ============================================================

/**
 * Find which category a unit belongs to.
 * Handles deprecated unit aliases (e.g., 'ea' → 'each').
 */
export function getUnitCategory(unit: string): UnitCategory | undefined {
  const resolved = resolveUnitAlias(unit);
  return Object.values(UNIT_CATEGORIES).find((category) =>
    category.units.includes(resolved)
  );
}

/**
 * Get the base unit for a given unit
 */
export function getBaseUnit(unit: string): string | undefined {
  const category = getUnitCategory(unit);
  return category?.units[0];
}

/**
 * Get conversion factor from one unit to another within the same category.
 * Handles deprecated unit aliases automatically.
 * Returns undefined if units are not in the same category.
 */
export function getConversionFactor(
  fromUnit: string,
  toUnit: string
): number | undefined {
  const resolvedFrom = resolveUnitAlias(fromUnit);
  const resolvedTo = resolveUnitAlias(toUnit);

  const category = getUnitCategory(resolvedFrom);
  if (!category || !category.units.includes(resolvedTo)) {
    return undefined;
  }

  const fromFactor = category.conversions[resolvedFrom];
  const toFactor = category.conversions[resolvedTo];

  if (fromFactor === undefined || toFactor === undefined) {
    return undefined;
  }

  // Convert: fromUnit -> base -> toUnit
  // fromUnit * fromFactor = base
  // base / toFactor = toUnit
  return fromFactor / toFactor;
}

/**
 * Convert a quantity from one unit to another
 * Uses preset conversions if available, otherwise returns undefined
 */
export function convertUnits(
  quantity: number,
  fromUnit: string,
  toUnit: string
): number | undefined {
  const resolvedFrom = resolveUnitAlias(fromUnit);
  const resolvedTo = resolveUnitAlias(toUnit);

  if (resolvedFrom === resolvedTo) {
    return quantity;
  }

  const factor = getConversionFactor(fromUnit, toUnit);
  if (factor === undefined) {
    return undefined;
  }

  return quantity * factor;
}

/**
 * Convert quantity to base unit using custom conversions
 * Used when item has custom unit conversions defined
 */
export function convertToBaseUnit(
  quantity: number,
  fromUnit: string,
  primaryUnit: string,
  customConversions: { from_unit: string; to_primary_factor: number }[]
): number {
  // If already in primary unit, return as-is
  if (fromUnit === primaryUnit) {
    return quantity;
  }

  // Check custom conversions first
  const customConversion = customConversions.find(
    (c) => c.from_unit === fromUnit
  );
  if (customConversion) {
    return quantity * customConversion.to_primary_factor;
  }

  // Fall back to preset conversions if both units are in same category
  const presetConversion = convertUnits(quantity, fromUnit, primaryUnit);
  if (presetConversion !== undefined) {
    return presetConversion;
  }

  // If no conversion found, return original (shouldn't happen with validation)
  console.warn(`No conversion found from ${fromUnit} to ${primaryUnit}`);
  return quantity;
}

/**
 * Get suggested conversion factor for a unit to a primary unit
 * Returns preset factor if units are in same category, otherwise 1
 */
export function getSuggestedConversionFactor(
  fromUnit: string,
  primaryUnit: string
): number {
  const factor = getConversionFactor(fromUnit, primaryUnit);
  return factor !== undefined ? factor : 1;
}

/**
 * Check if two units are compatible (in same category or convertible)
 */
export function areUnitsCompatible(unit1: string, unit2: string): boolean {
  if (unit1 === unit2) return true;

  const category1 = getUnitCategory(unit1);
  const category2 = getUnitCategory(unit2);

  if (!category1 || !category2) return false;

  return category1 === category2;
}

// ============================================================
// Standard Unit Discovery
// ============================================================

/**
 * Get all standard units that can automatically convert to/from the given unit.
 * Returns other units in the same category (all have known conversion factors).
 * Handles deprecated aliases automatically.
 */
export function getStandardUnitsForUnit(primaryUnit: string): string[] {
  const resolved = resolveUnitAlias(primaryUnit);
  const category = getUnitCategory(resolved);
  if (!category) return [];

  return category.units.filter((u) => u !== resolved);
}

// ============================================================
// Display Helpers
// ============================================================

/**
 * Get unit display name (same as unit for now, but could be extended)
 */
export function getUnitDisplayName(unit: string): string {
  return unit;
}

/**
 * Format unit for display with optional plural handling
 */
export function formatUnit(unit: string, _quantity: number): string {
  // For now, just return the unit as-is
  // Could be extended for proper pluralization
  return unit;
}
