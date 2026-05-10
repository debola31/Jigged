/**
 * Standard manufacturing units library — the curated list shown in the UOM
 * combobox (`components/parts/UnitOfMeasurementSelect.tsx`).
 *
 * The `key` values MUST match the canonical names in
 * `api/services/uom_normalizer.py` (CANONICAL_UNITS) and `lib/unitPresets.ts`
 * (UNIT_CATEGORIES). The CSV importer normalizes `lbs` -> `pounds`, `in` ->
 * `inches`, etc., so the picker has to use the same canonical names —
 * otherwise an imported part wouldn't match a unit in the dropdown.
 *
 * If you add a unit here, mirror it into `unitPresets.ts` (with conversion
 * factors) and `uom_normalizer.py` (with any common aliases). Conversely, if
 * a customer needs a one-off non-standard unit, they add it via the
 * "+ Add custom unit" affordance — that writes to `company_custom_units` and
 * shows up under the "Custom" group, no code change required.
 */

export type UnitCategoryKey =
  | 'count'
  | 'weight'
  | 'length'
  | 'volume'
  | 'area'
  | 'time';

export interface StandardUnit {
  /** Canonical key — matches CANONICAL_UNITS in uom_normalizer.py. */
  key: string;
  /** Display label shown in the dropdown (e.g. "Pounds (lb)"). */
  label: string;
  /** Short symbol used in compact UI contexts (e.g. on row chips). */
  short: string;
  /** Grouping bucket for the Autocomplete `groupBy`. */
  category: UnitCategoryKey;
}

export const CATEGORY_LABELS: Record<UnitCategoryKey, string> = {
  count: 'Count',
  weight: 'Weight',
  length: 'Length',
  volume: 'Volume',
  area: 'Area',
  time: 'Time',
};

/**
 * The order here drives the visual order in the combobox. Categories are
 * grouped together by `groupBy` on the Autocomplete; within a category the
 * order below is preserved.
 */
export const STANDARD_UNITS: StandardUnit[] = [
  // count
  { key: 'each', label: 'Each (ea)', short: 'ea', category: 'count' },
  { key: 'pieces', label: 'Pieces (pcs)', short: 'pcs', category: 'count' },
  { key: 'dozen', label: 'Dozen (dz)', short: 'dz', category: 'count' },
  // weight
  { key: 'pounds', label: 'Pounds (lb)', short: 'lb', category: 'weight' },
  { key: 'kilograms', label: 'Kilograms (kg)', short: 'kg', category: 'weight' },
  { key: 'ounces', label: 'Ounces (oz)', short: 'oz', category: 'weight' },
  { key: 'grams', label: 'Grams (g)', short: 'g', category: 'weight' },
  // length
  { key: 'inches', label: 'Inches (in)', short: 'in', category: 'length' },
  { key: 'feet', label: 'Feet (ft)', short: 'ft', category: 'length' },
  { key: 'millimeters', label: 'Millimeters (mm)', short: 'mm', category: 'length' },
  { key: 'centimeters', label: 'Centimeters (cm)', short: 'cm', category: 'length' },
  { key: 'meters', label: 'Meters (m)', short: 'm', category: 'length' },
  // volume
  { key: 'gallons', label: 'Gallons (gal)', short: 'gal', category: 'volume' },
  { key: 'liters', label: 'Liters (L)', short: 'L', category: 'volume' },
  { key: 'quarts', label: 'Quarts (qt)', short: 'qt', category: 'volume' },
  { key: 'milliliters', label: 'Milliliters (mL)', short: 'mL', category: 'volume' },
  { key: 'fluid ounces', label: 'Fluid ounces (fl oz)', short: 'fl oz', category: 'volume' },
  // area
  { key: 'square inches', label: 'Square inches (sq in)', short: 'sq in', category: 'area' },
  { key: 'square feet', label: 'Square feet (sq ft)', short: 'sq ft', category: 'area' },
  // time
  { key: 'hours', label: 'Hours (hr)', short: 'hr', category: 'time' },
];

/** Map of canonical key -> StandardUnit for O(1) lookup. */
export const STANDARD_UNITS_BY_KEY: Record<string, StandardUnit> =
  STANDARD_UNITS.reduce<Record<string, StandardUnit>>((acc, u) => {
    acc[u.key] = u;
    return acc;
  }, {});
