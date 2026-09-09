/**
 * The canonical fields the owner can confirm/correct in the **Map** stage, per entity.
 *
 * This is the FULL set of fields `/execute` writes for each entity, not a slice. It used to be a
 * "review-relevant" subset (customers got 2 of 11, vendors 1 of 11), which was survivable only
 * while the per-entity wizards still exposed the rest for hand-correction. #776 retired those, so
 * a field missing from here had no correction surface anywhere: the AI maps it, it rides through
 * `mappingsFor()` to execute, and a mis-map could not be fixed by anyone (#777).
 *
 * TWO INVARIANTS, both machine-enforced by scripts/dataImportFieldParityCheck.ts:
 *
 *  1. Every key here exists in the entity's Python import schema (PART_SCHEMA, CUSTOMER_SCHEMA, …)
 *     with the same `required` flag, and every key there exists here. Those schemas are the AI's
 *     mapping vocabulary, so a field in one and not the other is either unmappable (the AI has
 *     never heard of it) or uncorrectable (the owner can't see it) — both silent.
 *  2. Every role the deterministic analyzer keys a check on (dataImportAnalyzer.ts) has an entry
 *     here — parts cost is `cost_per_unit`, and `routings.sequence` is the column the
 *     `sequence_inferred` notice explicitly tells the owner to map at this step.
 *
 * Labels are for a non-technical owner, never the DB column name ('primary_unit' → "unit of
 * measure"). Array order is display order in the details panel, and `group`ed fields sort last —
 * see ColumnMappingStep, which partitions on exactly that.
 */

import type { EntityType } from '@/types/data-import';

/**
 * Subheadings inside the Map details panel. Undefined is the common case: the fields an owner
 * came to check, rendered first and ungrouped, exactly as every entity rendered before the
 * catalog was widened. A group exists only where a block would otherwise bury them — the ten
 * contact/address columns on a customer, the four numbers on a routing step.
 */
export type FieldGroup = 'Contact & address' | 'Times & rates';

export interface CanonicalField {
  key: string; // canonical role the analyzer + importer use
  label: string; // plain-language label for a non-technical owner
  required: boolean; // needed to import this entity at all
  group?: FieldGroup; // rendered under a subheading, after the ungrouped fields
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
  vendor_services: 'Vendor services',
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
  vendor_services: 'service_name',
  work_centers: 'name',
  customers: 'name',
};

/** The entities the owner can classify a file as (excludes the passthrough 'unknown'). */
export const KNOWN_ENTITIES: EntityType[] = [
  'parts',
  'vendors',
  'vendor_services',
  'work_centers',
  'routings',
  'bom',
  'customers',
];

/** The six postal columns, character-for-character the same on customers and vendors — both
 *  land in their entity's `*_addresses` table. Shared so the two can't drift apart. */
const ADDRESS_FIELDS: CanonicalField[] = [
  { key: 'address_line1', label: 'Street address', required: false, group: 'Contact & address' },
  { key: 'address_line2', label: 'Suite / unit', required: false, group: 'Contact & address' },
  { key: 'city', label: 'City', required: false, group: 'Contact & address' },
  { key: 'state', label: 'State', required: false, group: 'Contact & address' },
  { key: 'postal_code', label: 'ZIP code', required: false, group: 'Contact & address' },
  { key: 'country', label: 'Country', required: false, group: 'Contact & address' },
];

export const ENTITY_FIELDS: Partial<Record<EntityType, CanonicalField[]>> = {
  parts: [
    { key: 'part_name', label: 'Part number / name', required: true },
    { key: 'description', label: 'Description', required: false },
    { key: 'primary_unit', label: 'Unit of measure', required: true }, // parts can't import without one
    { key: 'source', label: 'Made in-house or bought', required: false },
    { key: 'preferred_vendor_name', label: 'Preferred vendor', required: false },
    { key: 'cost_per_unit', label: 'Cost / price', required: false },
    { key: 'quantity', label: 'Quantity on hand', required: false },
    // Where that quantity IS. Optional as a column, but a quantity without one is
    // refused at import: since 20260906182638 stock cannot exist without a location,
    // so a CSV that says "we have 240" and not where has not said enough to record.
    { key: 'location_name', label: 'Location (needed with a quantity)', required: false },
    { key: 'reorder_point', label: 'Reorder point', required: false },
  ],
  vendors: [
    { key: 'name', label: 'Vendor name', required: true },
    { key: 'primary_contact_name', label: 'Contact name', required: false, group: 'Contact & address' },
    { key: 'primary_contact_email', label: 'Contact email', required: false, group: 'Contact & address' },
    { key: 'primary_contact_phone', label: 'Contact phone', required: false, group: 'Contact & address' },
    // One of VENDOR_CONTACT_ROLE_VALUES, defaulting to 'sales'. 'other' is in that enum but fails
    // the DB CHECK on this path, which has nowhere to carry the role_label 'other' requires — so
    // the label deliberately doesn't invite it.
    { key: 'primary_contact_role', label: "Contact's role", required: false, group: 'Contact & address' },
    ...ADDRESS_FIELDS,
  ],
  // In-house only. The `vendor_name` column is GONE: a work centre has no
  // vendor, and leaving the field here is what let the wizard keep minting the
  // concept the split removed.
  work_centers: [
    { key: 'name', label: 'Work center name', required: true },
    { key: 'labor_rate', label: 'Hourly rate', required: false },
    { key: 'description', label: 'Notes', required: false },
  ],
  vendor_services: [
    { key: 'vendor_name', label: 'Vendor', required: true },
    { key: 'service_name', label: 'Service (e.g. Anodize)', required: true },
    { key: 'unit_price', label: 'Price per piece', required: false },
    { key: 'description', label: 'Notes for whoever ships it', required: false },
  ],
  routings: [
    { key: 'part_name', label: 'Part number / name', required: true },
    { key: 'work_center_name', label: 'Work center or outside service', required: false },
    // Optional, and only meaningful for an outside step. Two vendors may both
    // offer "Anodize", so a bare name can be ambiguous — this is what
    // disambiguates it. Absent, the importer resolves an in-house station first
    // and only falls back to a service when exactly one matches.
    { key: 'vendor_name', label: 'Vendor (for an outside step)', required: false },
    // The column the `sequence_inferred` notice tells the owner to map. Left unmapped, the ingest
    // driver numbers each part's ops by their order across the WHOLE file
    // (numberRoutingOpsInFileOrder) — right for essentially every export, but a guess.
    { key: 'sequence', label: 'Step number', required: false },
    { key: 'instructions', label: 'Instructions for the operator', required: false },
    // Cost-bearing, every one of them: a mis-mapped column here is silently wrong money rather
    // than a visibly wrong record, which is why they are shown rather than left to the AI alone.
    { key: 'setup_minutes', label: 'Setup time (minutes)', required: false, group: 'Times & rates' },
    { key: 'cycle_minutes_per_unit', label: 'Run time per piece (minutes)', required: false, group: 'Times & rates' },
    { key: 'labor_rate_override', label: 'Hourly rate for this step', required: false, group: 'Times & rates' },
    { key: 'external_unit_price', label: 'Outside price per piece', required: false, group: 'Times & rates' },
  ],
  bom: [
    { key: 'parent_part_name', label: 'Assembly (parent part)', required: true },
    { key: 'child_part_name', label: 'Component (child part)', required: true },
    { key: 'quantity', label: 'Quantity', required: true },
    { key: 'unit', label: 'Unit', required: true },
  ],
  customers: [
    { key: 'name', label: 'Customer name', required: true },
    // A legacy customer master nearly always carries a terms code — it's the one
    // commercial field every job-shop ERP ships — so mapping it on import is the
    // difference between arriving populated and being typed in per customer later.
    { key: 'default_payment_terms', label: 'Payment terms', required: false },
    { key: 'contact_name', label: 'Contact name', required: false, group: 'Contact & address' },
    { key: 'contact_email', label: 'Contact email', required: false, group: 'Contact & address' },
    { key: 'contact_phone', label: 'Contact phone', required: false, group: 'Contact & address' },
    ...ADDRESS_FIELDS,
  ],
};
