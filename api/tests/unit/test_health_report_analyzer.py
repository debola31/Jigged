"""Unit tests for the deterministic data-health analyzer (services/health_report_analyzer.py).

Pure logic — no AI, no DB. Feeds AnalyzedFile objects (which already carry the AI-produced
``column_roles``) and asserts the findings. This is where the review's correctness concerns
are locked down: asymmetric join keys, normalized matching, "never a silent 0 / never
phantom N", and misclassification tolerance.
"""

import pytest

from models.health_report_models import EntityType, FindingCategory, Severity
from services.health_report_analyzer import AnalyzedFile, analyze_bundle

pytestmark = pytest.mark.unit


def _af(filename, entity, roles, rows, headers=None):
    return AnalyzedFile(
        filename=filename,
        entity_type=entity,
        column_roles=roles,
        rows=rows,
        headers=headers if headers is not None else (list(rows[0].keys()) if rows else []),
    )


def _by_cat(findings, category):
    return [f for f in findings if f.category == category]


def _ids(findings):
    return {f.id for f in findings}


# --------------------------------------------------------------------------- record counts
def test_record_counts_one_per_file():
    parts = _af("parts.csv", EntityType.PARTS, {"part_name": "PartNo"},
                [{"PartNo": "A"}, {"PartNo": "B"}])
    findings = analyze_bundle([parts])
    counts = _by_cat(findings, FindingCategory.RECORD_COUNT)
    assert len(counts) == 1
    assert counts[0].count == 2
    assert counts[0].severity == Severity.INFO


# --------------------------------------------------------------------------- duplicates
def test_within_file_duplicate_is_case_and_space_insensitive():
    parts = _af("parts.csv", EntityType.PARTS, {"part_name": "PartNo"},
                [{"PartNo": "Widget"}, {"PartNo": " widget "}, {"PartNo": "Bolt"}])
    dups = _by_cat(analyze_bundle([parts]), FindingCategory.DUPLICATE)
    assert len(dups) == 1
    assert dups[0].count == 2  # two rows collide
    assert dups[0].severity == Severity.WARNING


def test_vendor_duplicates_key_on_name_not_vendor_name():
    vendors = _af("v.csv", EntityType.VENDORS, {"name": "VendName"},
                  [{"VendName": "Acme"}, {"VendName": "acme"}])
    dups = _by_cat(analyze_bundle([vendors]), FindingCategory.DUPLICATE)
    assert len(dups) == 1
    assert dups[0].id == "duplicate.vendors.name"


def test_no_duplicate_finding_when_unique():
    parts = _af("parts.csv", EntityType.PARTS, {"part_name": "PartNo"},
                [{"PartNo": "A"}, {"PartNo": "B"}])
    assert not _by_cat(analyze_bundle([parts]), FindingCategory.DUPLICATE)


# --------------------------------------------------------------------------- cross-file orphans
def test_orphan_parts_to_vendors_asymmetric_join():
    parts = _af("parts.csv", EntityType.PARTS,
                {"part_name": "PartNo", "preferred_vendor_name": "Vendor"},
                [{"PartNo": "A", "Vendor": "Acme"}, {"PartNo": "B", "Vendor": "Ghost Co"}])
    vendors = _af("vendors.csv", EntityType.VENDORS, {"name": "VendName"},
                  [{"VendName": "Acme"}])
    orphans = _by_cat(analyze_bundle([parts, vendors]), FindingCategory.ORPHAN_REFERENCE)
    assert len(orphans) == 1
    assert orphans[0].id == "orphan.parts.preferred_vendor_name"
    assert orphans[0].count == 1  # only "Ghost Co"
    assert orphans[0].severity == Severity.CRITICAL
    assert any("Ghost" in e for e in orphans[0].examples)


def test_orphan_join_is_normalized_no_phantom():
    # "ACME" (part) vs "Acme" (vendor) must NOT be flagged as an orphan.
    parts = _af("parts.csv", EntityType.PARTS,
                {"part_name": "PartNo", "preferred_vendor_name": "Vendor"},
                [{"PartNo": "A", "Vendor": "ACME"}])
    vendors = _af("vendors.csv", EntityType.VENDORS, {"name": "VendName"},
                  [{"VendName": "Acme"}])
    assert not _by_cat(analyze_bundle([parts, vendors]), FindingCategory.ORPHAN_REFERENCE)


def test_routing_to_work_center_and_part_orphans():
    routings = _af("rout.csv", EntityType.ROUTINGS,
                   {"part_name": "Part", "work_center_name": "WC"},
                   [{"Part": "P1", "WC": "Mill"}, {"Part": "P1", "WC": "Laser"}])
    work_centers = _af("wc.csv", EntityType.WORK_CENTERS, {"name": "Name"},
                       [{"Name": "Mill"}])
    parts = _af("parts.csv", EntityType.PARTS, {"part_name": "PartNo"},
                [{"PartNo": "P1"}])
    findings = analyze_bundle([routings, work_centers, parts])
    orphans = {f.id: f for f in _by_cat(findings, FindingCategory.ORPHAN_REFERENCE)}
    assert "orphan.routings.work_center_name" in orphans  # "Laser" missing
    assert orphans["orphan.routings.work_center_name"].count == 1
    assert "orphan.routings.part_name" not in orphans  # P1 present


def test_bom_child_and_parent_orphans_join_on_part_name():
    bom = _af("bom.csv", EntityType.BOM,
              {"parent_part_name": "Parent", "child_part_name": "Child", "quantity": "Qty", "unit": "U"},
              [{"Parent": "ASM", "Child": "BOLT", "Qty": "2", "U": "pcs"}])
    parts = _af("parts.csv", EntityType.PARTS, {"part_name": "PartNo"},
                [{"PartNo": "ASM"}])  # BOLT missing
    orphans = {f.id for f in _by_cat(analyze_bundle([bom, parts]), FindingCategory.ORPHAN_REFERENCE)}
    assert "orphan.bom.child_part_name" in orphans
    assert "orphan.bom.parent_part_name" not in orphans


def test_referenced_file_absent_single_not_checked_never_phantom():
    parts = _af("parts.csv", EntityType.PARTS,
                {"part_name": "PartNo", "preferred_vendor_name": "Vendor"},
                [{"PartNo": "A", "Vendor": "Acme"}, {"PartNo": "B", "Vendor": "Beta"}])
    findings = analyze_bundle([parts])  # no vendors file
    nc = [f for f in _by_cat(findings, FindingCategory.NOT_CHECKED)
          if f.id == "not_checked.parts.preferred_vendor_name"]
    assert len(nc) == 1  # exactly one, not N
    assert not _by_cat(findings, FindingCategory.ORPHAN_REFERENCE)


def test_parent_column_unidentified_not_checked():
    parts = _af("parts.csv", EntityType.PARTS,
                {"part_name": "PartNo", "preferred_vendor_name": "Vendor"},
                [{"PartNo": "A", "Vendor": "Acme"}])
    vendors = _af("vendors.csv", EntityType.VENDORS, {},  # name role NOT identified
                  [{"Mystery": "Acme"}])
    findings = analyze_bundle([parts, vendors])
    assert "not_checked.parts.preferred_vendor_name" in _ids(findings)
    assert not _by_cat(findings, FindingCategory.ORPHAN_REFERENCE)


def test_child_column_unidentified_no_orphan_and_no_noise():
    # parts file present but the vendor reference column wasn't identified -> skip silently
    parts = _af("parts.csv", EntityType.PARTS, {"part_name": "PartNo"},
                [{"PartNo": "A"}])
    vendors = _af("vendors.csv", EntityType.VENDORS, {"name": "VendName"},
                  [{"VendName": "Acme"}])
    findings = analyze_bundle([parts, vendors])
    assert not _by_cat(findings, FindingCategory.ORPHAN_REFERENCE)
    assert "not_checked.parts.preferred_vendor_name" not in _ids(findings)


# --------------------------------------------------------------------------- required columns
def test_missing_required_column_is_critical():
    # vendors requires `name`; role not identified
    vendors = _af("v.csv", EntityType.VENDORS, {"legacy_id": "ID"},
                  [{"ID": "1"}])
    findings = analyze_bundle([vendors])
    missing = _by_cat(findings, FindingCategory.MISSING_COLUMN)
    # `name` unidentified -> whole file reads as "classification uncertain" (single finding)
    assert "classification_uncertain.v.csv" in _ids(findings)
    assert not missing  # we don't spam missing when nothing required was identified


def test_partial_blank_required_is_data_gap():
    parts = _af("parts.csv", EntityType.PARTS, {"part_name": "PartNo"},
                [{"PartNo": "A"}, {"PartNo": ""}, {"PartNo": "C"}])
    gaps = _by_cat(analyze_bundle([parts]), FindingCategory.DATA_GAP)
    assert len(gaps) == 1
    assert gaps[0].count == 1
    assert gaps[0].severity == Severity.WARNING


def test_bom_missing_one_required_among_several():
    # quantity role missing, others present -> a real MISSING_COLUMN (others identified)
    bom = _af("bom.csv", EntityType.BOM,
              {"parent_part_name": "P", "child_part_name": "C", "unit": "U"},
              [{"P": "ASM", "C": "BOLT", "U": "pcs"}])
    missing = _by_cat(analyze_bundle([bom]), FindingCategory.MISSING_COLUMN)
    assert any(f.id == "missing.bom.quantity" for f in missing)


def test_misclassified_file_yields_single_uncertain_finding():
    # labeled parts, but no required part column identified -> one uncertain finding, no spam
    bogus = _af("junk.csv", EntityType.PARTS, {},
                [{"Foo": "1", "Bar": "2"}])
    findings = analyze_bundle([bogus])
    assert "classification_uncertain.junk.csv" in _ids(findings)
    assert not _by_cat(findings, FindingCategory.MISSING_COLUMN)


# --------------------------------------------------------------------------- cost coverage
def test_cost_coverage_percentage():
    parts = _af("parts.csv", EntityType.PARTS,
                {"part_name": "PartNo", "cost_per_unit": "Cost"},
                [{"PartNo": "A", "Cost": "1.50"}, {"PartNo": "B", "Cost": ""},
                 {"PartNo": "C", "Cost": ""}, {"PartNo": "D", "Cost": "9"}])
    cov = _by_cat(analyze_bundle([parts]), FindingCategory.COST_COVERAGE)
    assert len(cov) == 1
    assert cov[0].count == 2
    assert "50%" in cov[0].title


# --------------------------------------------------------------------------- name variants
def test_name_variants_group_spelling_differences():
    vendors = _af("v.csv", EntityType.VENDORS, {"name": "VendName"},
                  [{"VendName": "Acme Inc."}, {"VendName": "ACME"}, {"VendName": "Beta LLC"}])
    variants = _by_cat(analyze_bundle([vendors]), FindingCategory.NAME_VARIANT)
    assert len(variants) == 1
    assert variants[0].count == 1  # one group: {Acme Inc., ACME}


# --------------------------------------------------------------------------- inactive flags
def test_inactive_flag_status_column():
    parts = _af("parts.csv", EntityType.PARTS, {"part_name": "PartNo"},
                [{"PartNo": "A", "Status": "active"}, {"PartNo": "B", "Status": "obsolete"}],
                headers=["PartNo", "Status"])
    inactive = _by_cat(analyze_bundle([parts]), FindingCategory.INACTIVE_FLAG)
    assert len(inactive) == 1
    assert inactive[0].count == 1


def test_inactive_flag_boolean_active_column():
    parts = _af("parts.csv", EntityType.PARTS, {"part_name": "PartNo"},
                [{"PartNo": "A", "Active": "yes"}, {"PartNo": "B", "Active": "no"},
                 {"PartNo": "C", "Active": "false"}],
                headers=["PartNo", "Active"])
    inactive = _by_cat(analyze_bundle([parts]), FindingCategory.INACTIVE_FLAG)
    assert inactive and inactive[0].count == 2


# --------------------------------------------------------------------------- edges
def test_empty_bundle_returns_no_findings():
    assert analyze_bundle([]) == []


def test_headers_only_file_no_crash():
    parts = _af("parts.csv", EntityType.PARTS, {"part_name": "PartNo"}, [], headers=["PartNo"])
    findings = analyze_bundle([parts])
    counts = _by_cat(findings, FindingCategory.RECORD_COUNT)
    assert counts[0].count == 0


def test_findings_sorted_critical_first():
    parts = _af("parts.csv", EntityType.PARTS,
                {"part_name": "PartNo", "preferred_vendor_name": "Vendor"},
                [{"PartNo": "A", "Vendor": "Ghost"}])
    vendors = _af("vendors.csv", EntityType.VENDORS, {"name": "VendName"},
                  [{"VendName": "Acme"}])
    findings = analyze_bundle([parts, vendors])
    severities = [f.severity for f in findings]
    # first non-info should be critical before any warning/info ordering within
    assert severities[0] == Severity.CRITICAL
