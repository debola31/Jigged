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

import { isAutoCreatable, REFERENTIAL_LINKS } from '@/lib/dataImportLinks';
import { ENTITY_FIELDS, ENTITY_LABELS, fieldLabel, norm } from '@/lib/dataImportSchema';
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

/** Derived from the Map catalog rather than restated — the two agreeing is the whole
 *  point, and `parts.primary_unit` is exactly the kind of entry that drifts. Mirrors the
 *  Python import-model schemas; `parts` also has a DB-level CHECK for the unit. */
const requiredFields = (entity: EntityType): string[] =>
  (ENTITY_FIELDS[entity] ?? []).filter((f) => f.required).map((f) => f.key);

// --------------------------------------------------------------------------- helpers

export function aggressiveNorm(v: string | undefined | null): string {
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
/** Plain, owner-facing entity words ('bom' → 'bill of materials'), shared with the Map step. */
const entityLabel = (entity: EntityType): string =>
  entity === 'unknown' ? 'unrecognized' : ENTITY_LABELS[entity].toLowerCase();
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
    detail: `${affected.toLocaleString()} rows share a name with another row (ignoring case and spacing). Each name becomes one record, so the repeats won't come in twice.`,
    count: affected,
    examples: dupKeys.slice(0, MAX_EXAMPLES).map((k) => originals.get(k)!),
    source_files: [af.filename],
    verified: true,
    recommended_action: `That's usually right — if any are meant to be separate, rename them in the table below.`,
  }];
}

function missingOrEmptyRequired(af: AnalyzedFile): Finding[] {
  const required = requiredFields(af.entityType);
  if (!required.length) return [];
  const identified = required.filter((k) => roleCol(af, k));
  if (!identified.length) {
    return [{
      id: `classification_uncertain.${af.filename}`,
      category: 'not_checked',
      // Nothing in this file can be created until we know what it is — that's the
      // whole file lost, so it can't read as a soft 'review'.
      severity: 'critical',
      entity_type: af.entityType,
      title: `We couldn't read ${af.filename} as ${entityLabel(af.entityType)}`,
      detail: `None of the columns we need (${required.map((k) => fieldLabel(af.entityType, k)).join(', ')}) turned up in this file. It might hold something else, or use headings we don't know yet — so we've left it alone rather than guess.`,
      count: 0,
      examples: [],
      source_files: [af.filename],
      verified: true,
      recommended_action: 'Go back to "Check your files" and tell us what this file holds.',
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
        title: `We couldn't find the ${fieldLabel(af.entityType, key)} in ${af.filename}`,
        detail: `Every ${entityLabel(af.entityType).replace(/s$/, '')} needs one, and no column in this file looks like it.`,
        count: 0,
        examples: [],
        source_files: [af.filename],
        verified: true,
        recommended_action: `Go back to "Check your files" and point us at the right column — or add a file that has it.`,
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
        title: `No ${entityLabel(af.entityType)} in ${af.filename} have a ${fieldLabel(af.entityType, key)}`,
        detail: `We found the column, but every row is blank — and we can't bring these in without it.`,
        count: total,
        examples: [],
        source_files: [af.filename],
        verified: true,
        recommended_action: `Use "Fill blanks" below to set one value for every row.`,
      });
    } else if (blanks) {
      out.push({
        id: `gap.${af.entityType}.${key}`,
        category: 'data_gap',
        // A blank REQUIRED value costs the row — the importer skips it, same as a
        // missing column costs the file. It read as 'warning' next to genuinely
        // harmless things like "no cost", so "4 to review" covered both "91% of your
        // parts will be dropped" and "cosmetic". Severity means consequence now.
        severity: 'critical',
        entity_type: af.entityType,
        title: `${blanks.toLocaleString()} of ${total.toLocaleString()} ${entityLabel(af.entityType)} have no ${fieldLabel(af.entityType, key)}`,
        detail: `We need one for each of them before they can come in.`,
        count: blanks,
        examples: [],
        source_files: [af.filename],
        verified: true,
        recommended_action: `Use "Fill blanks" below to set the empty ones all at once.`,
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
  for (const { childEntity, childField, parentEntity, parentField } of REFERENTIAL_LINKS) {
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
    // Distinct names, not rows — the missing RECORDS are what the owner acts on.
    const distinctOrphans = new Set<string>();
    for (const af of childFiles) {
      const ccol = childCols.get(af.filename);
      if (!ccol) continue;
      for (const row of af.rows) {
        const raw = cell(row, ccol);
        const v = norm(raw);
        if (!v) continue;
        if (!parentValues.has(v)) {
          orphanCount += 1;
          if (!distinctOrphans.has(v)) {
            distinctOrphans.add(v);
            if (orphanExamples.length < MAX_EXAMPLES) orphanExamples.push(raw.trim());
          }
        }
      }
    }
    if (orphanCount) {
      const parentLabel = entityLabel(parentEntity);
      const childLabel = entityLabel(childEntity);
      const distinct = distinctOrphans.size;
      out.push({
        id: `orphan.${linkId}`,
        category: 'orphan_reference',
        severity: 'critical',
        entity_type: childEntity,
        // Lead with what's MISSING (a short, fixable list) rather than how many rows break.
        title: `${distinct} ${parentLabel} your ${childLabel} use aren't in your ${parentLabel}`,
        detail: `${orphanCount.toLocaleString()} ${childLabel} row(s) point to them, so those rows have nothing to connect to yet.`,
        count: orphanCount,
        examples: orphanExamples,
        source_files: childFiles.filter((af) => childCols.get(af.filename)).map((af) => af.filename),
        verified: true,
        recommended_action: isAutoCreatable(parentEntity)
          ? `We can add these ${distinct} ${parentLabel} for you — have a look and confirm.`
          : `Add the file with these ${parentLabel} and we'll connect the rows up.`,
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
      detail: `${missing.toLocaleString()} of ${total.toLocaleString()} parts have nothing in the cost column. You can quote them once they have one.`,
      count: missing,
      examples: [],
      source_files: [af.filename],
      verified: true,
      // Cost isn't required to import — say so, rather than implying a blocker.
      recommended_action: 'Add costs in the table below if you have them — or bring these in now and price them in Jigged later.',
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
        recommended_action: 'Use "Merge look-alikes" below to combine each group into one.',
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
    detail: `The '${match}' column marks ${inactive.toLocaleString()} row(s) as inactive — old records you may not need day to day.`,
    count: inactive,
    examples: [],
    source_files: [af.filename],
    verified: true,
    recommended_action: "They'll come in with everything else — that's usually fine, and you can archive them in Jigged any time.",
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
