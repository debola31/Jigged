"""Deterministic data-health analyzer for the read-only import-readiness report.

Pure Python: NO AI, NO DB, NO writes. This is the factual backbone that grounds the
AI narrative and makes the endpoint's "no domain-table writes" guarantee trivially true
(this module imports nothing that can write).

It consumes files that have ALREADY been given ``column_roles`` by the AI "structure"
pass — a map from a canonical Jigged field to the RAW header that holds it. Every check
keys on that map, which is what lets it work on raw ERP exports whose headers are the
source system's own column names (``ItemNum``, ``PartNo``, ``Vendor``, …).

Guarantees the review demanded:
  - Cross-file joins use the CORRECT asymmetric keys (parts identify by ``part_name``;
    vendors/work_centers/customers by ``name``) via ``REFERENTIAL_LINKS``.
  - Join/duplicate matching is NORMALIZED (trim/case/whitespace) so ``ACME`` vs ``Acme``
    doesn't produce phantom orphans.
  - A check that cannot run (missing file, unidentified column) emits ONE explicit
    "not checked" finding — never a silent ``0`` and never N phantom orphans.
  - A file whose labeled entity has none of its required columns identified yields ONE
    "classification uncertain" finding, not a flood of missing-column noise.
"""

from __future__ import annotations

import re
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Optional

from models.health_report_models import (
    ENTITY_IDENTITY_FIELD,
    ENTITY_SCHEMAS,
    REFERENTIAL_LINKS,
    EntityType,
    Finding,
    FindingCategory,
    Severity,
)
from models.parts_import_models import parse_bool

_MAX_EXAMPLES = 5
_INACTIVE_HEADER_TOKENS = {"active", "is_active", "isactive", "status", "inactive", "disabled", "archived"}
_INACTIVE_STATUS_VALUES = {"inactive", "archived", "disabled", "closed", "obsolete", "discontinued", "hold", "onhold"}
_COMPANY_SUFFIXES = (
    "incorporated", "corporation", "company", "limited",
    "inc", "llc", "corp", "co", "ltd", "lp", "plc",
)
_SEVERITY_ORDER = {Severity.CRITICAL: 0, Severity.WARNING: 1, Severity.INFO: 2}


@dataclass
class AnalyzedFile:
    """One uploaded file after AI structure classification. The analyzer's unit of input."""

    filename: str
    entity_type: EntityType
    column_roles: dict[str, str]  # canonical_field -> raw_header
    rows: list[dict[str, str]]
    headers: list[str] = field(default_factory=list)


# --------------------------------------------------------------------------- helpers
def _norm(value: Optional[str]) -> str:
    return (value or "").strip().casefold()


def _aggressive_norm(value: Optional[str]) -> str:
    """Strip non-alphanumerics and common company suffixes for name-variant grouping."""
    s = re.sub(r"[^a-z0-9]+", "", _norm(value))
    changed = True
    while changed:
        changed = False
        for suf in _COMPANY_SUFFIXES:
            if len(s) > len(suf) and s.endswith(suf):
                s = s[: -len(suf)]
                changed = True
    return s


def _role_col(af: AnalyzedFile, canonical_field: str) -> Optional[str]:
    return af.column_roles.get(canonical_field)


def _cell(row: dict[str, str], col: Optional[str]) -> str:
    return row.get(col, "") if col else ""


def _files_of(files: list[AnalyzedFile], entity: EntityType) -> list[AnalyzedFile]:
    return [af for af in files if af.entity_type == entity]


def _entity_label(entity: EntityType) -> str:
    return entity.value.replace("_", " ")


# --------------------------------------------------------------------------- checks
def _record_counts(files: list[AnalyzedFile]) -> list[Finding]:
    out: list[Finding] = []
    for af in files:
        out.append(
            Finding(
                id=f"count.{af.filename}",
                category=FindingCategory.RECORD_COUNT,
                severity=Severity.INFO,
                entity_type=af.entity_type,
                title=f"{len(af.rows)} rows in {af.filename}",
                detail=f"Detected as {_entity_label(af.entity_type)}.",
                count=len(af.rows),
                source_files=[af.filename],
            )
        )
    return out


def _within_file_duplicates(af: AnalyzedFile) -> list[Finding]:
    identity = ENTITY_IDENTITY_FIELD.get(af.entity_type)
    if not identity:
        return []
    col = _role_col(af, identity)
    if not col:
        return []  # missing-required check reports the unidentified column separately
    seen: dict[str, list[int]] = defaultdict(list)
    originals: dict[str, str] = {}
    for i, row in enumerate(af.rows):
        raw = _cell(row, col)
        key = _norm(raw)
        if not key:
            continue
        seen[key].append(i + 1)
        originals.setdefault(key, raw.strip())
    dup_keys = [k for k, rows in seen.items() if len(rows) > 1]
    if not dup_keys:
        return []
    affected = sum(len(seen[k]) for k in dup_keys)
    examples = [originals[k] for k in dup_keys[:_MAX_EXAMPLES]]
    return [
        Finding(
            id=f"duplicate.{af.entity_type.value}.{identity}",
            category=FindingCategory.DUPLICATE,
            severity=Severity.WARNING,
            entity_type=af.entity_type,
            title=f"{len(dup_keys)} duplicate {identity} value(s) in {af.filename}",
            detail=(
                f"{affected} rows share a {identity} with another row (case/space-insensitive). "
                "Duplicate identities collide on import — merge or disambiguate them."
            ),
            count=affected,
            examples=examples,
            source_files=[af.filename],
            recommended_action=f"Deduplicate the {identity} column before import.",
        )
    ]


def _missing_or_empty_required(af: AnalyzedFile) -> list[Finding]:
    schema = ENTITY_SCHEMAS.get(af.entity_type)
    if not schema:
        return []
    required = [k for k, v in schema.items() if v.get("required")]
    if not required:
        return []
    identified = [k for k in required if _role_col(af, k)]
    if not identified:
        # None of the required columns were found — the file is probably misclassified.
        return [
            Finding(
                id=f"classification_uncertain.{af.filename}",
                category=FindingCategory.NOT_CHECKED,
                severity=Severity.WARNING,
                entity_type=af.entity_type,
                title=f"Could not confidently read {af.filename} as {_entity_label(af.entity_type)}",
                detail=(
                    f"None of the required {_entity_label(af.entity_type)} columns "
                    f"({', '.join(required)}) were identified in this file. It may be a "
                    "different kind of data, or use headers we couldn't map. Detailed "
                    "checks were skipped to avoid misleading results."
                ),
                source_files=[af.filename],
                recommended_action="Confirm this file's type and column headers.",
            )
        ]
    out: list[Finding] = []
    total = len(af.rows)
    for key in required:
        col = _role_col(af, key)
        if not col:
            out.append(
                Finding(
                    id=f"missing.{af.entity_type.value}.{key}",
                    category=FindingCategory.MISSING_COLUMN,
                    severity=Severity.CRITICAL,
                    entity_type=af.entity_type,
                    title=f"Required field '{key}' not found in {af.filename}",
                    detail=f"No column in {af.filename} maps to the required field '{key}'.",
                    source_files=[af.filename],
                    recommended_action=f"Add or map a column for '{key}'.",
                )
            )
            continue
        blanks = sum(1 for row in af.rows if not _norm(_cell(row, col)))
        if total and blanks == total:
            out.append(
                Finding(
                    id=f"missing.{af.entity_type.value}.{key}",
                    category=FindingCategory.MISSING_COLUMN,
                    severity=Severity.CRITICAL,
                    entity_type=af.entity_type,
                    title=f"Required field '{key}' is entirely blank in {af.filename}",
                    detail=f"The column mapped to '{key}' has no values in any row.",
                    count=total,
                    source_files=[af.filename],
                    recommended_action=f"Populate the '{key}' column before import.",
                )
            )
        elif blanks:
            out.append(
                Finding(
                    id=f"gap.{af.entity_type.value}.{key}",
                    category=FindingCategory.DATA_GAP,
                    severity=Severity.WARNING,
                    entity_type=af.entity_type,
                    title=f"{blanks} of {total} rows missing '{key}' in {af.filename}",
                    detail=f"'{key}' is required but blank in {blanks} row(s).",
                    count=blanks,
                    source_files=[af.filename],
                    recommended_action=f"Fill in the missing '{key}' values.",
                )
            )
    return out


def _not_checked(link_id: str, entity: EntityType, title: str, detail: str, files: list[str]) -> Finding:
    return Finding(
        id=f"not_checked.{link_id}",
        category=FindingCategory.NOT_CHECKED,
        severity=Severity.WARNING,
        entity_type=entity,
        title=title,
        detail=detail,
        source_files=files,
    )


def _cross_file_orphans(files: list[AnalyzedFile]) -> list[Finding]:
    out: list[Finding] = []
    for child_entity, child_field, parent_entity, parent_field in REFERENTIAL_LINKS:
        child_files = _files_of(files, child_entity)
        if not child_files:
            continue
        link_id = f"{child_entity.value}.{child_field}"
        child_cols = {af.filename: _role_col(af, child_field) for af in child_files}
        if not any(child_cols.values()):
            continue  # this reference isn't present in the uploaded child files — nothing to check

        parent_files = _files_of(files, parent_entity)
        if not parent_files:
            out.append(
                _not_checked(
                    link_id,
                    child_entity,
                    f"{_entity_label(child_entity)} reference {_entity_label(parent_entity)}, "
                    f"but no {_entity_label(parent_entity)} file was uploaded",
                    f"Could not verify that every {child_field} exists — upload the "
                    f"{_entity_label(parent_entity)} file to check these references.",
                    [af.filename for af in child_files],
                )
            )
            continue
        parent_cols = [_role_col(af, parent_field) for af in parent_files]
        if not any(parent_cols):
            out.append(
                _not_checked(
                    link_id,
                    child_entity,
                    f"Could not verify {_entity_label(child_entity)} → {_entity_label(parent_entity)} references",
                    f"The '{parent_field}' column could not be identified in the "
                    f"{_entity_label(parent_entity)} file(s).",
                    [af.filename for af in parent_files],
                )
            )
            continue

        parent_values: set[str] = set()
        for af in parent_files:
            pcol = _role_col(af, parent_field)
            if not pcol:
                continue
            for row in af.rows:
                v = _norm(_cell(row, pcol))
                if v:
                    parent_values.add(v)

        orphan_count = 0
        orphan_examples: list[str] = []
        seen_examples: set[str] = set()
        for af in child_files:
            ccol = child_cols.get(af.filename)
            if not ccol:
                continue
            for row in af.rows:
                raw = _cell(row, ccol)
                v = _norm(raw)
                if not v:
                    continue
                if v not in parent_values:
                    orphan_count += 1
                    if v not in seen_examples and len(orphan_examples) < _MAX_EXAMPLES:
                        orphan_examples.append(raw.strip())
                        seen_examples.add(v)
        if orphan_count:
            out.append(
                Finding(
                    id=f"orphan.{link_id}",
                    category=FindingCategory.ORPHAN_REFERENCE,
                    severity=Severity.CRITICAL,
                    entity_type=child_entity,
                    title=(
                        f"{orphan_count} {_entity_label(child_entity)} row(s) reference a "
                        f"{_entity_label(parent_entity)} that isn't in the upload"
                    ),
                    detail=(
                        f"The {child_field} value on these rows has no matching "
                        f"{parent_field} in the {_entity_label(parent_entity)} file. These "
                        "references will break on import."
                    ),
                    count=orphan_count,
                    examples=orphan_examples,
                    source_files=[af.filename for af in child_files if child_cols.get(af.filename)],
                    recommended_action=(
                        f"Add the missing {_entity_label(parent_entity)} records, or correct "
                        f"the {child_field} values."
                    ),
                )
            )
    return out


def _cost_coverage(files: list[AnalyzedFile]) -> list[Finding]:
    out: list[Finding] = []
    for af in _files_of(files, EntityType.PARTS):
        col = _role_col(af, "cost_per_unit")
        total = len(af.rows)
        if not col or not total:
            continue
        missing = sum(1 for row in af.rows if not _norm(_cell(row, col)))
        if not missing:
            continue
        pct = round(100 * missing / total)
        out.append(
            Finding(
                id=f"cost_coverage.{af.filename}",
                category=FindingCategory.COST_COVERAGE,
                severity=Severity.WARNING if pct >= 10 else Severity.INFO,
                entity_type=EntityType.PARTS,
                title=f"{pct}% of parts in {af.filename} have no cost/price",
                detail=(
                    f"{missing} of {total} parts have no value in the cost column. Parts "
                    "without a cost can't be quoted or costed accurately."
                ),
                count=missing,
                source_files=[af.filename],
                recommended_action="Fill in unit costs where available before import.",
            )
        )
    return out


def _name_variants(files: list[AnalyzedFile]) -> list[Finding]:
    out: list[Finding] = []
    for entity in (EntityType.PARTS, EntityType.VENDORS):
        identity = ENTITY_IDENTITY_FIELD.get(entity)
        if not identity:
            continue
        for af in _files_of(files, entity):
            col = _role_col(af, identity)
            if not col:
                continue
            groups: dict[str, set[str]] = defaultdict(set)
            for row in af.rows:
                raw = _cell(row, col).strip()
                if not raw:
                    continue
                key = _aggressive_norm(raw)
                if key:
                    groups[key].add(raw)
            variant_groups = [sorted(v) for v in groups.values() if len(v) > 1]
            if not variant_groups:
                continue
            examples = [" / ".join(g) for g in variant_groups[:_MAX_EXAMPLES]]
            out.append(
                Finding(
                    id=f"name_variant.{entity.value}.{af.filename}",
                    category=FindingCategory.NAME_VARIANT,
                    severity=Severity.WARNING,
                    entity_type=entity,
                    title=f"{len(variant_groups)} likely name variant group(s) in {af.filename}",
                    detail=(
                        "These names look like spelling variants of the same "
                        f"{_entity_label(entity)} (e.g. differing case, punctuation, or "
                        "Inc/LLC suffixes). They import as separate records."
                    ),
                    count=len(variant_groups),
                    examples=examples,
                    source_files=[af.filename],
                    recommended_action="Standardize each name to a single spelling before import.",
                )
            )
    return out


def _inactive_flags(af: AnalyzedFile) -> list[Finding]:
    header_by_norm = {re.sub(r"[^a-z0-9_]+", "", _norm(h)): h for h in af.headers}
    match = next((orig for n, orig in header_by_norm.items() if n in _INACTIVE_HEADER_TOKENS), None)
    if not match:
        return []
    n = re.sub(r"[^a-z0-9_]+", "", _norm(match))
    inactive = 0
    for row in af.rows:
        val = _cell(row, match)
        if n in ("active", "is_active", "isactive"):
            if parse_bool(val) is False:
                inactive += 1
        elif n in ("inactive", "disabled", "archived"):
            if parse_bool(val) is True:
                inactive += 1
        else:  # status
            if _norm(val) in _INACTIVE_STATUS_VALUES:
                inactive += 1
    if not inactive:
        return []
    return [
        Finding(
            id=f"inactive.{af.filename}",
            category=FindingCategory.INACTIVE_FLAG,
            severity=Severity.INFO,
            entity_type=af.entity_type,
            title=f"{inactive} inactive/archived record(s) in {af.filename}",
            detail=(
                f"The '{match}' column marks {inactive} row(s) as inactive. Decide whether "
                "to import these historical records or leave them behind."
            ),
            count=inactive,
            source_files=[af.filename],
            recommended_action="Confirm whether inactive records should be migrated.",
        )
    ]


def needed_raw_columns(
    entity_type: EntityType, column_roles: dict[str, str], headers: list[str]
) -> list[str]:
    """The RAW headers this analyzer actually reads for a file.

    Lets the caller upload only these columns (not the whole file), which keeps the
    request small. Covers: the identity field (duplicates + join target), referential
    child fields (orphans), required fields (missing/gap), parts cost (coverage), and any
    status/inactive column (read directly, not via column_roles).
    """
    needed_canonical: set[str] = set()
    identity = ENTITY_IDENTITY_FIELD.get(entity_type)
    if identity:
        needed_canonical.add(identity)
    for child_entity, child_field, _pe, _pf in REFERENTIAL_LINKS:
        if child_entity == entity_type:
            needed_canonical.add(child_field)
    schema = ENTITY_SCHEMAS.get(entity_type) or {}
    needed_canonical |= {k for k, v in schema.items() if v.get("required")}
    if entity_type == EntityType.PARTS:
        needed_canonical.add("cost_per_unit")

    out: list[str] = []
    seen: set[str] = set()
    for canonical in needed_canonical:
        col = column_roles.get(canonical)
        if col and col not in seen:
            out.append(col)
            seen.add(col)
    for h in headers:
        token = re.sub(r"[^a-z0-9_]+", "", _norm(h))
        if token in _INACTIVE_HEADER_TOKENS and h not in seen:
            out.append(h)
            seen.add(h)
    return out


def analyze_bundle(files: list[AnalyzedFile]) -> list[Finding]:
    """Run every deterministic check and return findings sorted by severity."""
    findings: list[Finding] = []
    findings += _record_counts(files)
    for af in files:
        findings += _within_file_duplicates(af)
        findings += _missing_or_empty_required(af)
        findings += _inactive_flags(af)
    findings += _cross_file_orphans(files)
    findings += _cost_coverage(files)
    findings += _name_variants(files)
    findings.sort(key=lambda f: (_SEVERITY_ORDER.get(f.severity, 99), f.id))
    return findings
