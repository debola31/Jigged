"""Pydantic models + shared constants for the read-only Data Health / Import-Readiness report.

This feature is an ONBOARDING aid (not a sales demo): a shop already committed to
adopting Jigged uploads its legacy ERP CSV exports, and the tool produces a read-only,
advisory report of what's in the files, what won't import cleanly, and what to fix —
plus an informative guess at the source ERP. It NEVER writes to any business system.

Design notes:
  - The report is computed on demand and returned; nothing is persisted server-side in
    this slice. The schema is kept reuse-ready (``schema_version`` + a structured
    ``ErpDetection``) so detection templates / fine-tuning data can be derived later
    (#524) without a migration now.
  - The deterministic findings layer cannot key on canonical field names directly,
    because uploaded CSVs are RAW ERP exports whose headers are the source system's own
    column names. So an AI "structure" pass first produces, per file, a
    ``column_roles`` map (canonical_field -> raw_header); the analyzer consumes that.
  - Cross-file joins are ASYMMETRIC: vendors/work_centers/customers identify by ``name``
    while parts identify by ``part_name``. See ``REFERENTIAL_LINKS``.
"""

from __future__ import annotations

from enum import Enum
from typing import Optional

from pydantic import BaseModel, Field

# Canonical target schemas reused verbatim from the import layer. Importing them here
# keeps a single source of truth for "what fields does each entity have + which are
# required" and gives the AI structure prompt the exact canonical vocabulary to map to.
from models.bom_import_models import BOM_SCHEMA
from models.import_models import CUSTOMER_SCHEMA
from models.parts_import_models import PART_SCHEMA
from models.routings_import_models import ROUTING_SCHEMA
from models.vendors_import_models import VENDOR_SCHEMA
from models.work_centers_import_models import WORK_CENTER_SCHEMA


class EntityType(str, Enum):
    """Which Jigged entity a given uploaded file holds."""

    PARTS = "parts"
    VENDORS = "vendors"
    WORK_CENTERS = "work_centers"
    ROUTINGS = "routings"
    BOM = "bom"
    CUSTOMERS = "customers"
    UNKNOWN = "unknown"  # classifier could not confidently decide — surfaced, never guessed


class Severity(str, Enum):
    INFO = "info"  # neutral facts (record counts)
    WARNING = "warning"  # duplicates, gaps, inactive flags, name variants
    CRITICAL = "critical"  # missing required columns / broken cross-file references


class FindingCategory(str, Enum):
    RECORD_COUNT = "record_count"
    DUPLICATE = "duplicate"  # within-file duplicate identity values
    ORPHAN_REFERENCE = "orphan_reference"  # cross-file reference with no matching parent
    MISSING_COLUMN = "missing_column"  # a required field's column wasn't identified
    DATA_GAP = "data_gap"  # required column present but blank in some rows
    INACTIVE_FLAG = "inactive_flag"  # rows flagged inactive/archived in the source
    COST_COVERAGE = "cost_coverage"  # parts lacking a cost/price
    NAME_VARIANT = "name_variant"  # near-duplicate names (spelling variants)
    NOT_CHECKED = "not_checked"  # a check couldn't run (missing prerequisite) — never silent
    ERP_GOTCHA = "erp_gotcha"  # AI-surfaced, informative, unverified observation (#522 hook)


# ---------------------------------------------------------------------------
# ERP detection (#520)
# ---------------------------------------------------------------------------
class MatchedHeader(BaseModel):
    """One piece of header evidence for the detected ERP."""

    header: str  # the raw CSV header that matched
    signal: str  # why it points to this ERP


class ErpAlternative(BaseModel):
    source: str
    confidence: float = Field(ge=0.0, le=1.0)


class ErpDetection(BaseModel):
    """Detected source ERP. Mirrors MappingSuggestion's 0.0-1.0 confidence contract."""

    source: str = "unknown"  # e.g. "jobboss2" | "e2" | "tangle" | "unknown" | free-form
    display_name: str = "Unknown"
    confidence: float = Field(default=0.0, ge=0.0, le=1.0)
    matched_headers: list[MatchedHeader] = []
    evidence: str = ""
    alternatives: list[ErpAlternative] = []
    # Reuse hooks (#524): the exact signal a confirmed detection can be replayed from.
    header_signature: str = ""  # MD5 of the sorted headers across the bundle
    ai_provider: str = ""
    ai_model: str = ""


# ---------------------------------------------------------------------------
# Per-file classification
# ---------------------------------------------------------------------------
class FileClassification(BaseModel):
    """AI-produced classification of one uploaded file.

    ``column_roles`` maps a canonical Jigged field to the RAW header that holds it, e.g.
    ``{"part_name": "ItemNum", "preferred_vendor_name": "Vendor"}``. The deterministic
    analyzer keys every check on this map — it is the fix for "can't run on raw headers."
    """

    filename: str
    entity_type: EntityType = EntityType.UNKNOWN
    entity_confidence: float = Field(default=0.0, ge=0.0, le=1.0)
    headers: list[str] = []
    row_count: int = 0
    column_roles: dict[str, str] = {}  # canonical_field -> raw_header


# ---------------------------------------------------------------------------
# Findings
# ---------------------------------------------------------------------------
class Finding(BaseModel):
    id: str  # stable slug, e.g. "orphan.parts.preferred_vendor_name"
    category: FindingCategory
    severity: Severity
    entity_type: EntityType = EntityType.UNKNOWN
    title: str  # plain-English one-liner
    detail: str = ""  # human explanation
    count: int = 0  # affected rows / instances
    examples: list[str] = []  # up to 5 sample values
    source_files: list[str] = []
    verified: bool = True  # deterministic == True; AI-inferred gotcha == False
    recommended_action: str = ""


# ---------------------------------------------------------------------------
# Request / response
# ---------------------------------------------------------------------------
class UploadedFile(BaseModel):
    filename: str
    headers: list[str]
    rows: list[dict[str, str]]  # header -> value, matching the import-route row shape


class HealthReportRequest(BaseModel):
    company_id: str
    files: list[UploadedFile]


class HealthReport(BaseModel):
    """The advisory report. Kept reuse-ready (schema_version + structured detection)."""

    schema_version: int = 1
    erp_detection: ErpDetection
    files: list[FileClassification]
    findings: list[Finding]  # sorted by severity at render time
    summary: str = ""  # AI narrative, plain text (no markdown)
    recommendations: list[str] = []
    narrative_available: bool = True  # False -> UI shows "AI summary unavailable"
    ai_provider: str = ""
    ai_model: str = ""
    generated_at: str = ""  # ISO 8601, stamped by the route


class HealthReportResponse(BaseModel):
    report: HealthReport


# ---------------------------------------------------------------------------
# Two-phase request/response.
#
# A single "upload every row of every file" request blows past Vercel's ~4.5 MB body
# limit for a real bundle. So the flow is split: a tiny `/structure` call (headers + a
# few sample rows) returns the column roles, then a `/findings` call uploads ONLY the
# columns the analyzer needs (role columns + a status column), keeping each request
# small no matter how many extra columns the export carries.
# ---------------------------------------------------------------------------
class StructureFileInput(BaseModel):
    filename: str
    headers: list[str]
    sample_rows: list[list[str]] = []  # small: first N rows, positional (values only)
    row_count: int = 0


class StructureRequest(BaseModel):
    company_id: str
    files: list[StructureFileInput]


class StructureResponse(BaseModel):
    erp_detection: ErpDetection
    files: list[FileClassification]


class FindingsFileInput(BaseModel):
    filename: str
    entity_type: EntityType = EntityType.UNKNOWN
    entity_confidence: float = 0.0
    column_roles: dict[str, str] = {}
    headers: list[str] = []  # the subset of headers actually included in rows
    rows: list[dict[str, str]] = []  # only the needed columns' values


class FindingsRequest(BaseModel):
    company_id: str
    erp_detection: ErpDetection
    files: list[FindingsFileInput]


class FindingsResponse(BaseModel):
    findings: list[Finding]
    summary: str = ""
    recommendations: list[str] = []
    narrative_available: bool = True
    ai_provider: str = ""
    ai_model: str = ""


# ---------------------------------------------------------------------------
# Shared constants (single source of truth for the analyzer + the AI structure prompt)
# ---------------------------------------------------------------------------

# Entity -> its canonical import schema.
ENTITY_SCHEMAS: dict[EntityType, dict] = {
    EntityType.PARTS: PART_SCHEMA,
    EntityType.VENDORS: VENDOR_SCHEMA,
    EntityType.WORK_CENTERS: WORK_CENTER_SCHEMA,
    EntityType.ROUTINGS: ROUTING_SCHEMA,
    EntityType.BOM: BOM_SCHEMA,
    EntityType.CUSTOMERS: CUSTOMER_SCHEMA,
}

# The single field that identifies a row of each entity (for duplicate + join targets).
# NOTE the asymmetry: parts identify by ``part_name``; vendors/work_centers/customers by
# ``name``. Routings and BOM have no single identity row (they are line-item files).
ENTITY_IDENTITY_FIELD: dict[EntityType, str] = {
    EntityType.PARTS: "part_name",
    EntityType.VENDORS: "name",
    EntityType.WORK_CENTERS: "name",
    EntityType.CUSTOMERS: "name",
}

# Cross-file referential links: (child_entity, child_field) -> (parent_entity, parent_field).
# A child value that has no matching parent identity value is an orphan reference.
REFERENTIAL_LINKS: list[tuple[EntityType, str, EntityType, str]] = [
    (EntityType.PARTS, "preferred_vendor_name", EntityType.VENDORS, "name"),
    (EntityType.WORK_CENTERS, "vendor_name", EntityType.VENDORS, "name"),
    (EntityType.ROUTINGS, "work_center_name", EntityType.WORK_CENTERS, "name"),
    (EntityType.ROUTINGS, "part_name", EntityType.PARTS, "part_name"),
    (EntityType.BOM, "parent_part_name", EntityType.PARTS, "part_name"),
    (EntityType.BOM, "child_part_name", EntityType.PARTS, "part_name"),
]

# ERP catalog — prompt grounding ONLY (not a detection lookup). E2 and JobBOSS² are
# merged branding (ECI folded E2 Shop into JobBOSS²), so hints are intentionally loose.
ERP_CATALOG: list[dict[str, str]] = [
    {
        "source": "jobboss2",
        "display_name": "JobBOSS²",
        "header_hint": "ECI JobBOSS²/E2 lineage; job-shop fields like Job, WorkCenter, OperationType, PartNo.",
    },
    {
        "source": "e2",
        "display_name": "E2 (Shoptech)",
        "header_hint": "E2 Shop System (now part of JobBOSS²); similar job-shop vocabulary.",
    },
    {
        "source": "tangle",
        "display_name": "Tangle",
        "header_hint": "Legacy job-shop system; exports to Excel/CSV for all data elements.",
    },
]


def entity_type_from_str(value: Optional[str]) -> EntityType:
    """Coerce an AI-provided entity string to EntityType, defaulting to UNKNOWN."""
    if not value:
        return EntityType.UNKNOWN
    try:
        return EntityType(str(value).strip().lower())
    except ValueError:
        return EntityType.UNKNOWN
