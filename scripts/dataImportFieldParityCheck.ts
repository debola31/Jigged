/**
 * Import field-catalog parity checker.
 *
 * Three declarations describe the same set of columns, in three languages, and nothing used to
 * hold them together:
 *
 *   - `ENTITY_FIELDS` (lib/dataImportSchema.ts) — what the owner can SEE and CORRECT at the Map
 *     step. The only correction surface there is, since #776 retired the per-entity wizards.
 *   - the Python `*_SCHEMA` dicts (api/models/*_import_models.py) — the vocabulary the AI column
 *     mapper maps ONTO, handed to the prompt as `ENTITY_SCHEMAS`.
 *   - the roles the deterministic analyzer (lib/dataImportAnalyzer.ts) keys its checks on.
 *
 * Every way they can disagree is silent, and each has already shipped:
 *
 *   - schema-not-in-catalog: the AI maps `contact_email`, it rides through `mappingsFor()` to
 *     execute, and a MIS-map cannot be fixed by anyone — the field is on no screen (#777).
 *   - catalog-not-in-schema: `parts.location_name` was mappable by hand and readable by execute,
 *     but absent from PART_SCHEMA — so the AI had never heard of it and could never pre-fill it.
 *   - required-mismatch: `primary_unit` said `required: False` on the Python side while the parts
 *     table had an unconditional CHECK, so a unit-less row passed validate and 500'd on insert.
 *   - analyzer-role-not-in-catalog: `routings.sequence`. The `sequence_inferred` finding told the
 *     owner in so many words to "map it at the Map step", and the Map step had no such control.
 *
 * A phantom is the same bug pointing the other way — `PART_SCHEMA.notes` named a column `parts`
 * does not have, so a mapped Notes column was accepted and dropped without a word. Rule 2 is what
 * catches those, because a phantom cannot be in the catalog without being on a screen.
 *
 * WHAT THIS CANNOT DO. It compares three declarations, not declarations against the writes. A
 * field can satisfy every rule here and still be ignored by the `/execute` route that receives it
 * (which is exactly what `notes` did). Only reading the route says otherwise — see the PR
 * checklist in docs/modules/data-import.md.
 *
 * Driven through vitest like the repo's other source scanners —
 * `pnpm exec vitest run __tests__/standards/dataImportFieldParity.test.ts`.
 */

import { readFileSync } from 'fs';
import { join, resolve } from 'path';
import { REFERENTIAL_LINKS } from '../lib/dataImportLinks';
import { ENTITY_FIELDS } from '../lib/dataImportSchema';
import type { EntityType } from '../types/data-import';

// ============== Types ==============

export type ParityViolationKind =
  | 'schema-not-in-catalog'
  | 'catalog-not-in-schema'
  | 'required-mismatch'
  | 'analyzer-role-not-in-catalog';

export interface ParityViolation {
  kind: ParityViolationKind;
  entity: EntityType;
  field: string;
  detail: string;
}

export interface PythonField {
  required: boolean;
}

// ============== The three sources ==============

/** Where each entity's canonical schema lives on the Python side. */
export const SCHEMA_SOURCES: Partial<Record<EntityType, { file: string; constName: string }>> = {
  parts: { file: 'api/models/parts_import_models.py', constName: 'PART_SCHEMA' },
  vendors: { file: 'api/models/vendors_import_models.py', constName: 'VENDOR_SCHEMA' },
  vendor_services: {
    file: 'api/models/vendor_services_import_models.py',
    constName: 'VENDOR_SERVICE_SCHEMA',
  },
  work_centers: { file: 'api/models/work_centers_import_models.py', constName: 'WORK_CENTER_SCHEMA' },
  routings: { file: 'api/models/routings_import_models.py', constName: 'ROUTING_SCHEMA' },
  bom: { file: 'api/models/bom_import_models.py', constName: 'BOM_SCHEMA' },
  customers: { file: 'api/models/import_models.py', constName: 'CUSTOMER_SCHEMA' },
};

/**
 * Roles the analyzer reads a VALUE from, which `REFERENTIAL_LINKS` does not already cover. Kept
 * explicit rather than parsed out of the analyzer: a regex over `roleCol(af, 'x')` would silently
 * shrink to zero the day someone extracts a constant, and a check that can quietly stop checking
 * is worse than one that has to be edited by hand.
 */
export const ANALYZER_VALUE_ROLES: Partial<Record<EntityType, string[]>> = {
  parts: [
    'cost_per_unit', // costCoverage()
    'quantity', // quantityCoverage()
  ],
  routings: [
    'sequence', // routingSequenceNotice(), and numberRoutingOpsInFileOrder() in dataImportIngest
  ],
};

// ============== Python schema parsing ==============

/**
 * Read `{key: required}` out of a top-level Python schema dict.
 *
 * The dicts are plain literals with a fixed shape — a key at four spaces opening a block, and a
 * `"required": True|False` inside it — so this needs no Python. Values are ignored beyond that;
 * a multi-line or concatenated description (VENDOR_SCHEMA's `primary_contact_role`) is inert
 * because nothing inside a block can match the four-space key pattern.
 *
 * Throws rather than returning empty when the constant is missing: an empty parse would make
 * every rule below vacuously pass, which is the one outcome a guard must never have.
 */
export function parsePythonSchema(src: string, constName: string): Record<string, PythonField> {
  const start = src.indexOf(`\n${constName} = {\n`);
  if (start === -1) throw new Error(`${constName} not found (or not a top-level dict literal)`);
  const bodyStart = start + `\n${constName} = {\n`.length;
  const end = src.indexOf('\n}', bodyStart);
  if (end === -1) throw new Error(`${constName} has no closing brace at column 0`);
  const body = src.slice(bodyStart, end);

  const out: Record<string, PythonField> = {};
  const keyRe = /^ {4}"(\w+)": \{$/;
  let current: string | null = null;
  for (const line of body.split('\n')) {
    const key = keyRe.exec(line);
    if (key) {
      current = key[1];
      out[current] = { required: false };
      continue;
    }
    if (current && /^ {8}"required": True,?$/.test(line)) out[current].required = true;
  }
  if (Object.keys(out).length === 0) throw new Error(`${constName} parsed to zero fields`);
  return out;
}

// ============== The check ==============

export function findParityViolations(repoRoot: string): ParityViolation[] {
  const out: ParityViolation[] = [];

  for (const [entityKey, source] of Object.entries(SCHEMA_SOURCES)) {
    const entity = entityKey as EntityType;
    const schema = parsePythonSchema(readFileSync(join(repoRoot, source.file), 'utf8'), source.constName);
    const catalog = ENTITY_FIELDS[entity] ?? [];
    const byKey = new Map(catalog.map((f) => [f.key, f]));

    for (const [key, pyField] of Object.entries(schema)) {
      const field = byKey.get(key);
      if (!field) {
        out.push({
          kind: 'schema-not-in-catalog',
          entity,
          field: key,
          detail: `${source.constName} declares '${key}', so the AI can map it and execute receives it, but ENTITY_FIELDS.${entity} has no entry — a mis-map would not be correctable anywhere.`,
        });
        continue;
      }
      if (field.required !== pyField.required) {
        out.push({
          kind: 'required-mismatch',
          entity,
          field: key,
          detail: `'${key}' is required: ${field.required} at Map but ${pyField.required} in ${source.constName}. Row-loss counting (rowsAtRisk) and the analyzer both read the Map side.`,
        });
      }
    }

    for (const field of catalog) {
      if (schema[field.key]) continue;
      out.push({
        kind: 'catalog-not-in-schema',
        entity,
        field: field.key,
        detail: `ENTITY_FIELDS.${entity} offers '${field.key}' but ${source.constName} does not declare it, so the AI has no name for it and can never pre-fill the mapping.`,
      });
    }
  }

  const analyzerRoles: [EntityType, string, string][] = [
    ...REFERENTIAL_LINKS.flatMap(({ childEntity, childField, parentEntity, parentField }): [EntityType, string, string][] => [
      [childEntity, childField, 'REFERENTIAL_LINKS (child side)'],
      [parentEntity, parentField, 'REFERENTIAL_LINKS (parent side)'],
    ]),
    ...Object.entries(ANALYZER_VALUE_ROLES).flatMap(([entity, roles]): [EntityType, string, string][] =>
      roles.map((role) => [entity as EntityType, role, 'ANALYZER_VALUE_ROLES']),
    ),
  ];

  const seen = new Set<string>();
  for (const [entity, role, origin] of analyzerRoles) {
    const id = `${entity}.${role}`;
    if (seen.has(id)) continue;
    seen.add(id);
    if ((ENTITY_FIELDS[entity] ?? []).some((f) => f.key === role)) continue;
    out.push({
      kind: 'analyzer-role-not-in-catalog',
      entity,
      field: role,
      detail: `The analyzer keys a check on '${id}' (${origin}) but ENTITY_FIELDS.${entity} does not offer it, so a finding about it points at a control the owner cannot reach.`,
    });
  }

  return out;
}

/** One line per violation, grouped so a failure reads as a to-do list rather than a dump. */
export function formatViolations(violations: ParityViolation[]): string {
  return violations
    .map((v) => `  [${v.kind}] ${v.entity}.${v.field}\n      ${v.detail}`)
    .join('\n');
}

export const REPO_ROOT = resolve(__dirname, '..');
