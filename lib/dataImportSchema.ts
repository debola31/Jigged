/**
 * The canonical fields the owner can confirm/correct in the **Map** stage, per entity.
 *
 * This is the review-relevant slice — identity, required, referential, cost, and **stock**
 * fields. Most are ones the deterministic analyzer (dataImportAnalyzer.ts) keys its checks on,
 * so a correction here visibly changes the review. Keys MUST match the analyzer's roles
 * (e.g. parts cost is `cost_per_unit`); keep the two in step when the check set changes.
 *
 * `quantity` / `reorder_point` are a deliberate widening beyond "what the analyzer checks":
 * the backend has always accepted them (PART_SCHEMA in api/models/parts_import_models.py),
 * but with no entry here they were invisible at Map, so an owner could neither see nor correct
 * a mis-detected on-hand column. Opening balances are journey J1 in docs/modules/inventory.md.
 */

import type { EntityType } from '@/types/data-import';

export interface CanonicalField {
  key: string; // canonical role the analyzer + importer use
  label: string; // plain-language label for a non-technical owner
  required: boolean; // needed to import this entity at all
}

/**
 * Identity matching for names, everywhere. The orphan check, the "create the missing ones"
 * list, and the duplicate check MUST agree on what counts as the same name — otherwise the
 * review says 47 are missing and the fix creates 46. One normalization, one truth.
 */
export const norm = (v: string | undefined | null): string => (v ?? '').trim().toLowerCase();

/** Plain label for a canonical field, for copy an owner reads ('primary_unit' → 'unit of
 *  measure'). Falls back to the raw key for fields outside the Map catalog. */
export function fieldLabel(entity: EntityType, key: string): string {
  return ENTITY_FIELDS[entity]?.find((f) => f.key === key)?.label.toLowerCase() ?? key;
}

/** Friendly names for the "this file is…" picker (covers every EntityType). */
export const ENTITY_LABELS: Record<EntityType, string> = {
  parts: 'Parts',
  vendors: 'Vendors',
  work_centers: 'Work centers',
  routings: 'Routings',
  bom: 'Bill of materials',
  customers: 'Customers',
  unknown: "Not sure — skip this file",
};

/** The single name-like identity column per entity (the natural default for merge-look-alikes).
 *  routings/bom have no single identity, so merge falls back to a user-picked column. */
export const ENTITY_IDENTITY_FIELD: Partial<Record<EntityType, string>> = {
  parts: 'part_name',
  vendors: 'name',
  work_centers: 'name',
  customers: 'name',
};

/** The entities the owner can classify a file as (excludes the passthrough 'unknown'). */
export const KNOWN_ENTITIES: EntityType[] = [
  'parts',
  'vendors',
  'work_centers',
  'routings',
  'bom',
  'customers',
];

export const ENTITY_FIELDS: Partial<Record<EntityType, CanonicalField[]>> = {
  parts: [
    { key: 'part_name', label: 'Part number / name', required: true },
    { key: 'primary_unit', label: 'Unit of measure', required: true }, // parts can't import without one
    { key: 'preferred_vendor_name', label: 'Preferred vendor', required: false },
    { key: 'cost_per_unit', label: 'Cost / price', required: false },
    { key: 'quantity', label: 'Quantity on hand', required: false },
    { key: 'reorder_point', label: 'Reorder point', required: false },
  ],
  vendors: [{ key: 'name', label: 'Vendor name', required: true }],
  work_centers: [
    { key: 'name', label: 'Work center name', required: true },
    { key: 'vendor_name', label: 'Outside vendor (if outsourced)', required: false },
  ],
  routings: [
    { key: 'part_name', label: 'Part number / name', required: true },
    { key: 'work_center_name', label: 'Work center', required: false },
  ],
  bom: [
    { key: 'parent_part_name', label: 'Assembly (parent part)', required: true },
    { key: 'child_part_name', label: 'Component (child part)', required: true },
    { key: 'quantity', label: 'Quantity', required: true },
    { key: 'unit', label: 'Unit', required: true },
  ],
  customers: [{ key: 'name', label: 'Customer name', required: true }],
};
