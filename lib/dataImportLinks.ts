/**
 * Cross-file references, and the in-app fix for the ones that don't resolve.
 *
 * When a routing names a work center that isn't in the work-centers export, the answer is
 * NOT "go correct your CSV" — the owner exported those files from a system they may not even
 * use anymore. The answer is: show them the exact list of names we couldn't match, and offer
 * to create those records as part of the import. They confirm; we never create silently.
 *
 * Only *lookup-shaped* parents are auto-creatable: a work center or a vendor is essentially a
 * name, so creating one from a reference invents nothing. A part is a substantive record
 * (it needs a unit, a cost, a routing), so a missing part is answered by uploading the parts
 * file instead — never by fabricating a stub.
 */

import type { AddRecordsOp, EditableRow, EditOp, WorkingFile } from '@/lib/dataImportEditing';
import { ENTITY_LABELS, norm } from '@/lib/dataImportSchema';
import type { EntityType } from '@/types/data-import';

export interface ReferentialLink {
  childEntity: EntityType;
  childField: string;
  parentEntity: EntityType;
  parentField: string;
  /** Work centers are internal or outsourced, and an outsourced one implies a vendor. */
  kindable?: boolean;
}

/** Every cross-file reference we check. The analyzer reads this to find orphans; the
 *  create-missing action reads it to fix them — one registry, so they can't disagree. */
export const REFERENTIAL_LINKS: ReferentialLink[] = [
  { childEntity: 'parts', childField: 'preferred_vendor_name', parentEntity: 'vendors', parentField: 'name' },
  { childEntity: 'work_centers', childField: 'vendor_name', parentEntity: 'vendors', parentField: 'name' },
  { childEntity: 'routings', childField: 'work_center_name', parentEntity: 'work_centers', parentField: 'name', kindable: true },
  { childEntity: 'routings', childField: 'part_name', parentEntity: 'parts', parentField: 'part_name' },
  { childEntity: 'bom', childField: 'parent_part_name', parentEntity: 'parts', parentField: 'part_name' },
  { childEntity: 'bom', childField: 'child_part_name', parentEntity: 'parts', parentField: 'part_name' },
];

/** Parents that ARE their name — creating one from a reference invents nothing. A part is
 *  excluded on purpose: it needs a unit and a cost, so we ask for the file instead. */
const AUTO_CREATABLE_PARENTS: EntityType[] = ['work_centers', 'vendors', 'customers'];

export const isAutoCreatable = (parent: EntityType): boolean => AUTO_CREATABLE_PARENTS.includes(parent);

export type AutoCreateLink = ReferentialLink;

export const AUTO_CREATE_LINKS: AutoCreateLink[] = REFERENTIAL_LINKS.filter((l) => isAutoCreatable(l.parentEntity));

/** The analyzer ids orphan findings `orphan.<childEntity>.<childField>`. */
export function autoCreateLinkFor(findingId: string): AutoCreateLink | undefined {
  return AUTO_CREATE_LINKS.find((l) => findingId === `orphan.${l.childEntity}.${l.childField}`);
}

export type WorkCenterKind = 'internal' | 'external';

export interface MissingParent {
  name: string; // first-seen spelling, shown back to the owner
  refCount: number; // how many child rows point at it — the "why this matters" number
  kind?: WorkCenterKind; // suggested, for kindable links
}

/** Names that read like an outside shop rather than a machine on the floor. A SUGGESTION the
 *  owner can flip per row — never applied silently (they know their shop; we're guessing). */
const OUTSIDE_HINT = /(\binc\b|\bllc\b|\bltd\b|\bcorp\b|\bco\b|coat|plating|anodiz|heat.?treat|galvaniz|powder|finish)/i;

export function guessKind(name: string): WorkCenterKind {
  return OUTSIDE_HINT.test(name) ? 'external' : 'internal';
}

const filesFor = (working: WorkingFile[], entity: EntityType) => working.filter((wf) => wf.entityType === entity);

/** Every distinct value on the child side with no match on the parent side, most-referenced
 *  first. Uses the analyzer's normalization, so this list IS what the orphan finding counted. */
export function findMissingParents(working: WorkingFile[], link: AutoCreateLink): MissingParent[] {
  const known = new Set<string>();
  for (const wf of filesFor(working, link.parentEntity)) {
    const col = wf.columnRoles[link.parentField];
    if (!col) continue;
    for (const row of wf.rows) {
      const v = norm(row[col]);
      if (v) known.add(v);
    }
  }

  const missing = new Map<string, MissingParent>();
  for (const wf of filesFor(working, link.childEntity)) {
    const col = wf.columnRoles[link.childField];
    if (!col) continue;
    for (const row of wf.rows) {
      const raw = (row[col] ?? '').trim();
      const key = norm(raw);
      if (!key || known.has(key)) continue;
      const seen = missing.get(key);
      if (seen) seen.refCount += 1;
      else missing.set(key, { name: raw, refCount: 1, kind: link.kindable ? guessKind(raw) : undefined });
    }
  }

  return [...missing.values()].sort((a, b) => b.refCount - a.refCount || a.name.localeCompare(b.name));
}

/** Where new records of an entity should land: the file already holding them (so they merge
 *  into the owner's own data), or a new one we introduce. */
function targetFile(working: WorkingFile[], entity: EntityType, identityField: string) {
  const existing = filesFor(working, entity).find((wf) => wf.columnRoles[identityField]);
  return existing ?? null;
}

const newFilename = (entity: EntityType) => `Added in Jigged — ${ENTITY_LABELS[entity].toLowerCase()}`;

/** Build one AddRecordsOp for `entity`, giving each requested column a home (an existing
 *  mapped header, or a header we add). Rows are keyed by RAW header, like every other row. */
function addRecords(
  working: WorkingFile[],
  entity: EntityType,
  identityField: string,
  values: Record<string, string>[], // canonical_field -> value, per new record
): AddRecordsOp | null {
  if (!values.length) return null;
  const wf = targetFile(working, entity, identityField);
  const fields = [...new Set(values.flatMap((v) => Object.keys(v)))];

  const addHeaders: string[] = [];
  const addRoles: Record<string, string> = {};
  const headerFor: Record<string, string> = {};
  for (const field of fields) {
    const mapped = wf?.columnRoles[field];
    if (mapped) {
      headerFor[field] = mapped;
    } else {
      headerFor[field] = field; // introduce a column named for the field itself
      addHeaders.push(field);
      addRoles[field] = field;
    }
  }

  const filename = wf?.filename ?? newFilename(entity);
  const blanks: Record<string, string> = {};
  for (const h of [...(wf?.headers ?? []), ...addHeaders]) blanks[h] = '';

  const rows: EditableRow[] = values.map((v) => {
    const row: EditableRow = { ...blanks, __rowId: `${filename}#new:${norm(v[identityField])}` };
    for (const [field, val] of Object.entries(v)) row[headerFor[field]] = val;
    return row;
  });

  return { filename, entityType: entity, createFile: !wf, addHeaders, addRoles, rows };
}

export interface CreateEntry {
  name: string;
  kind?: WorkCenterKind;
}

/**
 * Create the parent records the owner confirmed. Returns an {@link EditOp} so it lands on the
 * undo journal and re-analyzes like any other fix — one action layer.
 *
 * The outsourced-work-center cascade is why this returns up to two AddRecordsOps: the importer
 * rejects `kind=external` without a vendor that exists, so marking a work center "outside"
 * also creates the vendor of the same name (if one isn't already there).
 */
export function createMissingParents(working: WorkingFile[], link: AutoCreateLink, entries: CreateEntry[]): EditOp {
  const chosen = entries.filter((e) => e.name.trim());
  const parentLabel = ENTITY_LABELS[link.parentEntity].toLowerCase();
  if (!chosen.length) return { label: `Create ${parentLabel}`, edits: [] };

  const parentValues = chosen.map((e) => {
    const v: Record<string, string> = { [link.parentField]: e.name };
    if (link.kindable) {
      const kind = e.kind ?? 'internal';
      v.kind = kind;
      // internal must have an EMPTY vendor; external is vendored by the shop of the same name.
      if (kind === 'external') v.vendor_name = e.name;
    }
    return v;
  });

  const ops: AddRecordsOp[] = [];
  const parentOp = addRecords(working, link.parentEntity, link.parentField, parentValues);
  if (parentOp) ops.push(parentOp);

  if (link.kindable) {
    const known = new Set<string>();
    for (const wf of filesFor(working, 'vendors')) {
      const col = wf.columnRoles.name;
      if (!col) continue;
      for (const row of wf.rows) {
        const v = norm(row[col]);
        if (v) known.add(v);
      }
    }
    const vendorNames = chosen.filter((e) => e.kind === 'external' && !known.has(norm(e.name)));
    const vendorOp = addRecords(
      working,
      'vendors',
      'name',
      vendorNames.map((e) => ({ name: e.name })),
    );
    if (vendorOp) ops.push(vendorOp);
  }

  const created = ops.reduce((n, o) => n + o.rows.length, 0);
  const extra = ops.length > 1 ? ` (plus ${ops[1].rows.length} vendor(s) for the outside work)` : '';
  return { label: `Created ${created} ${parentLabel}${extra}`, edits: [], addRecords: ops };
}
