/**
 * Deterministic data-import analyzer — runs in the BROWSER.
 *
 * The uploaded rows already live in browser memory (parseCSV runs client-side), and the
 * review is read-only/advisory (no write path, no trust boundary), so the deterministic
 * findings are computed here — the rows never leave the machine and never hit the 4.5 MB
 * request limit. The server keeps only the two AI steps (ERP/structure detection and the
 * grounded narrative), which need the secret API key and take tiny payloads.
 *
 * Cross-file joins use the CORRECT asymmetric keys (parts identify by
 * `part_name`; vendors/work_centers/customers by `name`).
 */

import type { EntityType, Finding, Severity } from '@/types/data-import';

export interface AnalyzedFile {
  filename: string;
  entityType: EntityType;
  columnRoles: Record<string, string>; // canonical_field -> raw_header
  rows: Record<string, string>[];
  headers: string[];
}

const MAX_EXAMPLES = 5;
const INACTIVE_HEADER_TOKENS = new Set([
  'active', 'is_active', 'isactive', 'status', 'inactive', 'disabled', 'archived',
]);
const INACTIVE_STATUS_VALUES = new Set([
  'inactive', 'archived', 'disabled', 'closed', 'obsolete', 'discontinued', 'hold', 'onhold',
]);
const COMPANY_SUFFIXES = [
  'incorporated', 'corporation', 'company', 'limited',
  'inc', 'llc', 'corp', 'co', 'ltd', 'lp', 'plc',
];
const SEVERITY_ORDER: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };

// The single field that identifies a row of each entity (duplicates + join target).
const ENTITY_IDENTITY_FIELD: Partial<Record<EntityType, string>> = {
  parts: 'part_name',
  vendors: 'name',
  work_centers: 'name',
  customers: 'name',
};

// Required fields per entity (mirrors the Python import-model schemas).
const ENTITY_REQUIRED_FIELDS: Record<string, string[]> = {
  parts: ['part_name'],
  vendors: ['name'],
  work_centers: ['name'],
  routings: ['part_name'],
  bom: ['parent_part_name', 'child_part_name', 'quantity', 'unit'],
  customers: ['name'],
};

// Cross-file links: [childEntity, childField, parentEntity, parentField].
const REFERENTIAL_LINKS: [EntityType, string, EntityType, string][] = [
  ['parts', 'preferred_vendor_name', 'vendors', 'name'],
  ['work_centers', 'vendor_name', 'vendors', 'name'],
  ['routings', 'work_center_name', 'work_centers', 'name'],
  ['routings', 'part_name', 'parts', 'part_name'],
  ['bom', 'parent_part_name', 'parts', 'part_name'],
  ['bom', 'child_part_name', 'parts', 'part_name'],
];

// --------------------------------------------------------------------------- helpers
const norm = (v: string | undefined | null): string => (v ?? '').trim().toLowerCase();

function aggressiveNorm(v: string | undefined | null): string {
  let s = norm(v).replace(/[^a-z0-9]+/g, '');
  let changed = true;
  while (changed) {
    changed = false;
    for (const suf of COMPANY_SUFFIXES) {
      if (s.length > suf.length && s.endsWith(suf)) {
        s = s.slice(0, -suf.length);
        changed = true;
      }
    }
  }
  return s;
}

const roleCol = (af: AnalyzedFile, field: string): string | undefined => af.columnRoles[field];
const cell = (row: Record<string, string>, col: string | undefined): string =>
  col ? row[col] ?? '' : '';
const filesOf = (files: AnalyzedFile[], entity: EntityType) =>
  files.filter((af) => af.entityType === entity);
const entityLabel = (entity: EntityType): string => entity.replace('_', ' ');
const headerToken = (h: string): string => norm(h).replace(/[^a-z0-9_]+/g, '');

// --------------------------------------------------------------------------- checks
function recordCounts(files: AnalyzedFile[]): Finding[] {
  return files.map((af) => ({
    id: `count.${af.filename}`,
    category: 'record_count',
    severity: 'info',
    entity_type: af.entityType,
    title: `${af.rows.length} rows in ${af.filename}`,
    detail: `Detected as ${entityLabel(af.entityType)}.`,
    count: af.rows.length,
    examples: [],
    source_files: [af.filename],
    verified: true,
    recommended_action: '',
  }));
}

function withinFileDuplicates(af: AnalyzedFile): Finding[] {
  const identity = ENTITY_IDENTITY_FIELD[af.entityType];
  if (!identity) return [];
  const col = roleCol(af, identity);
  if (!col) return [];
  const seen = new Map<string, number[]>();
  const originals = new Map<string, string>();
  af.rows.forEach((row, i) => {
    const raw = cell(row, col);
    const key = norm(raw);
    if (!key) return;
    (seen.get(key) ?? seen.set(key, []).get(key)!).push(i + 1);
    if (!originals.has(key)) originals.set(key, raw.trim());
  });
  const dupKeys = [...seen.entries()].filter(([, rows]) => rows.length > 1).map(([k]) => k);
  if (!dupKeys.length) return [];
  const affected = dupKeys.reduce((sum, k) => sum + seen.get(k)!.length, 0);
  return [{
    id: `duplicate.${af.entityType}.${identity}`,
    category: 'duplicate',
    severity: 'warning',
    entity_type: af.entityType,
    title: `${dupKeys.length} duplicate ${identity} value(s) in ${af.filename}`,
    detail: `${affected} rows share a ${identity} with another row (case/space-insensitive). Duplicate identities collide on import — merge or disambiguate them.`,
    count: affected,
    examples: dupKeys.slice(0, MAX_EXAMPLES).map((k) => originals.get(k)!),
    source_files: [af.filename],
    verified: true,
    recommended_action: `Deduplicate the ${identity} column before import.`,
  }];
}

function missingOrEmptyRequired(af: AnalyzedFile): Finding[] {
  const required = ENTITY_REQUIRED_FIELDS[af.entityType];
  if (!required || !required.length) return [];
  const identified = required.filter((k) => roleCol(af, k));
  if (!identified.length) {
    return [{
      id: `classification_uncertain.${af.filename}`,
      category: 'not_checked',
      severity: 'warning',
      entity_type: af.entityType,
      title: `Could not confidently read ${af.filename} as ${entityLabel(af.entityType)}`,
      detail: `None of the required ${entityLabel(af.entityType)} columns (${required.join(', ')}) were identified in this file. It may be a different kind of data, or use headers we couldn't map. Detailed checks were skipped to avoid misleading results.`,
      count: 0,
      examples: [],
      source_files: [af.filename],
      verified: true,
      recommended_action: "Confirm this file's type and column headers.",
    }];
  }
  const out: Finding[] = [];
  const total = af.rows.length;
  for (const key of required) {
    const col = roleCol(af, key);
    if (!col) {
      out.push({
        id: `missing.${af.entityType}.${key}`,
        category: 'missing_column',
        severity: 'critical',
        entity_type: af.entityType,
        title: `Required field '${key}' not found in ${af.filename}`,
        detail: `No column in ${af.filename} maps to the required field '${key}'.`,
        count: 0,
        examples: [],
        source_files: [af.filename],
        verified: true,
        recommended_action: `Add or map a column for '${key}'.`,
      });
      continue;
    }
    const blanks = af.rows.filter((row) => !norm(cell(row, col))).length;
    if (total && blanks === total) {
      out.push({
        id: `missing.${af.entityType}.${key}`,
        category: 'missing_column',
        severity: 'critical',
        entity_type: af.entityType,
        title: `Required field '${key}' is entirely blank in ${af.filename}`,
        detail: `The column mapped to '${key}' has no values in any row.`,
        count: total,
        examples: [],
        source_files: [af.filename],
        verified: true,
        recommended_action: `Populate the '${key}' column before import.`,
      });
    } else if (blanks) {
      out.push({
        id: `gap.${af.entityType}.${key}`,
        category: 'data_gap',
        severity: 'warning',
        entity_type: af.entityType,
        title: `${blanks} of ${total} rows missing '${key}' in ${af.filename}`,
        detail: `'${key}' is required but blank in ${blanks} row(s).`,
        count: blanks,
        examples: [],
        source_files: [af.filename],
        verified: true,
        recommended_action: `Fill in the missing '${key}' values.`,
      });
    }
  }
  return out;
}

function notChecked(linkId: string, entity: EntityType, title: string, detail: string, files: string[]): Finding {
  return {
    id: `not_checked.${linkId}`,
    category: 'not_checked',
    severity: 'warning',
    entity_type: entity,
    title,
    detail,
    count: 0,
    examples: [],
    source_files: files,
    verified: true,
    recommended_action: '',
  };
}

function crossFileOrphans(files: AnalyzedFile[]): Finding[] {
  const out: Finding[] = [];
  for (const [childEntity, childField, parentEntity, parentField] of REFERENTIAL_LINKS) {
    const childFiles = filesOf(files, childEntity);
    if (!childFiles.length) continue;
    const linkId = `${childEntity}.${childField}`;
    const childCols = new Map(childFiles.map((af) => [af.filename, roleCol(af, childField)]));
    if (![...childCols.values()].some(Boolean)) continue;

    const parentFiles = filesOf(files, parentEntity);
    if (!parentFiles.length) {
      out.push(notChecked(
        linkId, childEntity,
        `${entityLabel(childEntity)} reference ${entityLabel(parentEntity)}, but no ${entityLabel(parentEntity)} file was uploaded`,
        `Could not verify that every ${childField} exists — upload the ${entityLabel(parentEntity)} file to check these references.`,
        childFiles.map((af) => af.filename),
      ));
      continue;
    }
    if (!parentFiles.some((af) => roleCol(af, parentField))) {
      out.push(notChecked(
        linkId, childEntity,
        `Could not verify ${entityLabel(childEntity)} → ${entityLabel(parentEntity)} references`,
        `The '${parentField}' column could not be identified in the ${entityLabel(parentEntity)} file(s).`,
        parentFiles.map((af) => af.filename),
      ));
      continue;
    }

    const parentValues = new Set<string>();
    for (const af of parentFiles) {
      const pcol = roleCol(af, parentField);
      if (!pcol) continue;
      for (const row of af.rows) {
        const v = norm(cell(row, pcol));
        if (v) parentValues.add(v);
      }
    }

    let orphanCount = 0;
    const orphanExamples: string[] = [];
    const seenExamples = new Set<string>();
    for (const af of childFiles) {
      const ccol = childCols.get(af.filename);
      if (!ccol) continue;
      for (const row of af.rows) {
        const raw = cell(row, ccol);
        const v = norm(raw);
        if (!v) continue;
        if (!parentValues.has(v)) {
          orphanCount += 1;
          if (!seenExamples.has(v) && orphanExamples.length < MAX_EXAMPLES) {
            orphanExamples.push(raw.trim());
            seenExamples.add(v);
          }
        }
      }
    }
    if (orphanCount) {
      out.push({
        id: `orphan.${linkId}`,
        category: 'orphan_reference',
        severity: 'critical',
        entity_type: childEntity,
        title: `${orphanCount} ${entityLabel(childEntity)} row(s) reference a ${entityLabel(parentEntity)} that isn't in the upload`,
        detail: `The ${childField} value on these rows has no matching ${parentField} in the ${entityLabel(parentEntity)} file. These references will break on import.`,
        count: orphanCount,
        examples: orphanExamples,
        source_files: childFiles.filter((af) => childCols.get(af.filename)).map((af) => af.filename),
        verified: true,
        recommended_action: `Add the missing ${entityLabel(parentEntity)} records, or correct the ${childField} values.`,
      });
    }
  }
  return out;
}

function costCoverage(files: AnalyzedFile[]): Finding[] {
  const out: Finding[] = [];
  for (const af of filesOf(files, 'parts')) {
    const col = roleCol(af, 'cost_per_unit');
    const total = af.rows.length;
    if (!col || !total) continue;
    const missing = af.rows.filter((row) => !norm(cell(row, col))).length;
    if (!missing) continue;
    const pct = Math.round((100 * missing) / total);
    out.push({
      id: `cost_coverage.${af.filename}`,
      category: 'cost_coverage',
      severity: pct >= 10 ? 'warning' : 'info',
      entity_type: 'parts',
      title: `${pct}% of parts in ${af.filename} have no cost/price`,
      detail: `${missing} of ${total} parts have no value in the cost column. Parts without a cost can't be quoted or costed accurately.`,
      count: missing,
      examples: [],
      source_files: [af.filename],
      verified: true,
      recommended_action: 'Fill in unit costs where available before import.',
    });
  }
  return out;
}

function nameVariants(files: AnalyzedFile[]): Finding[] {
  const out: Finding[] = [];
  for (const entity of ['parts', 'vendors'] as EntityType[]) {
    const identity = ENTITY_IDENTITY_FIELD[entity];
    if (!identity) continue;
    for (const af of filesOf(files, entity)) {
      const col = roleCol(af, identity);
      if (!col) continue;
      const groups = new Map<string, Set<string>>();
      for (const row of af.rows) {
        const raw = cell(row, col).trim();
        if (!raw) continue;
        const key = aggressiveNorm(raw);
        if (!key) continue;
        (groups.get(key) ?? groups.set(key, new Set()).get(key)!).add(raw);
      }
      const variantGroups = [...groups.values()].filter((s) => s.size > 1).map((s) => [...s].sort());
      if (!variantGroups.length) continue;
      out.push({
        id: `name_variant.${entity}.${af.filename}`,
        category: 'name_variant',
        severity: 'warning',
        entity_type: entity,
        title: `${variantGroups.length} likely name variant group(s) in ${af.filename}`,
        detail: `These names look like spelling variants of the same ${entityLabel(entity)} (e.g. differing case, punctuation, or Inc/LLC suffixes). They import as separate records.`,
        count: variantGroups.length,
        examples: variantGroups.slice(0, MAX_EXAMPLES).map((g) => g.join(' / ')),
        source_files: [af.filename],
        verified: true,
        recommended_action: 'Standardize each name to a single spelling before import.',
      });
    }
  }
  return out;
}

function inactiveFlags(af: AnalyzedFile): Finding[] {
  const match = af.headers.find((h) => INACTIVE_HEADER_TOKENS.has(headerToken(h)));
  if (!match) return [];
  const token = headerToken(match);
  let inactive = 0;
  for (const row of af.rows) {
    const val = norm(cell(row, match));
    if (token === 'active' || token === 'is_active' || token === 'isactive') {
      if (['false', 'f', 'no', 'n', '0'].includes(val)) inactive += 1;
    } else if (token === 'inactive' || token === 'disabled' || token === 'archived') {
      if (['true', 't', 'yes', 'y', '1'].includes(val)) inactive += 1;
    } else if (INACTIVE_STATUS_VALUES.has(val)) {
      inactive += 1;
    }
  }
  if (!inactive) return [];
  return [{
    id: `inactive.${af.filename}`,
    category: 'inactive_flag',
    severity: 'info',
    entity_type: af.entityType,
    title: `${inactive} inactive/archived record(s) in ${af.filename}`,
    detail: `The '${match}' column marks ${inactive} row(s) as inactive. Decide whether to import these historical records or leave them behind.`,
    count: inactive,
    examples: [],
    source_files: [af.filename],
    verified: true,
    recommended_action: 'Confirm whether inactive records should be migrated.',
  }];
}

/** Run every deterministic check and return findings sorted by severity. */
export function analyzeBundle(files: AnalyzedFile[]): Finding[] {
  const findings: Finding[] = [];
  findings.push(...recordCounts(files));
  for (const af of files) {
    findings.push(...withinFileDuplicates(af));
    findings.push(...missingOrEmptyRequired(af));
    findings.push(...inactiveFlags(af));
  }
  findings.push(...crossFileOrphans(files));
  findings.push(...costCoverage(files));
  findings.push(...nameVariants(files));
  findings.sort((a, b) => (SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]) || a.id.localeCompare(b.id));
  return findings;
}
