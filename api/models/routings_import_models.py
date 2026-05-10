"""Pydantic models for Routings CSV import API.

One CSV row per operation, grouped by part_name. The importer creates a
`routings` row per part (UNIQUE on routings.part_id) and bulk-inserts
`routing_operations` rows.

Field set differs by work_center.kind:
  - kind='internal': uses setup_minutes, cycle_minutes_per_unit, labor_rate_override
  - kind='external': uses external_unit_price, external_setup_cost
"""

from typing import Optional
from pydantic import BaseModel

from models.import_models import ColumnMapping  # noqa: F401


class RoutingAnalyzeRequest(BaseModel):
    """Request to analyze CSV and get mapping suggestions for routings."""

    company_id: str
    headers: list[str]
    sample_rows: list[list[str]]  # First 5 rows of data


class RoutingAnalyzeResponse(BaseModel):
    """Response with AI-suggested column mappings for routings."""

    mappings: list[ColumnMapping]
    unmapped_required: list[str]  # Required DB fields with no mapping
    discarded_columns: list[str]  # CSV columns that won't be imported
    ai_provider: str  # Which AI was used


class RoutingConflictInfo(BaseModel):
    """Information about a conflicting routing row.

    conflict_type values:
      - "unknown_part": part_name doesn't match any existing part
      - "unknown_work_center": work_center_name doesn't match any existing work_center
        (and no MISCELLANEOUS fallback applies)
      - "csv_duplicate_sequence": same part+sequence appears multiple times in CSV
      - "duplicate_routing_op": part+sequence already exists in routing_operations
    """

    row_number: int
    csv_part_name: Optional[str]
    csv_work_center_name: Optional[str]
    conflict_type: str
    existing_id: str  # Empty string for non-DB conflicts
    existing_value: str  # Additional conflict info, including hints


class RoutingValidationError(BaseModel):
    """A validation error discovered during validation phase.

    error_type values:
      - "missing_part_name"
      - "invalid_setup_minutes", "invalid_cycle_minutes", "invalid_labor_rate"
      - "invalid_external_unit_price", "invalid_external_setup_cost"
      - "internal_field_on_external", "external_field_on_internal":
        cost field set doesn't match work_center.kind
    """

    row_number: int
    error_type: str
    field: str
    message: str


class RoutingFallbackInfo(BaseModel):
    """Per-row record of a MISCELLANEOUS fallback applied during validate.

    Surfaced in the validate response so the user sees which rows got routed
    where before confirming the import.
    """

    row_number: int
    csv_part_name: str
    original_work_center_name: str  # empty when row had no work_center column
    fallback_work_center_name: str  # always "MISCELLANEOUS" today
    reason: str


class RoutingValidateRequest(BaseModel):
    """Request to validate routings data before import."""

    company_id: str
    mappings: dict[str, str]  # csv_column -> db_field
    rows: list[dict[str, str]]  # All parsed CSV rows


class RoutingValidateResponse(BaseModel):
    """Response with validation results for routings."""

    has_conflicts: bool
    conflicts: list[RoutingConflictInfo]
    validation_errors: list[RoutingValidationError]
    fallbacks: list[RoutingFallbackInfo]
    valid_rows_count: int
    conflict_rows_count: int
    error_rows_count: int
    skipped_rows_count: int


class RoutingImportError(BaseModel):
    """An error that occurred during import."""

    row_number: int
    reason: str
    data: dict[str, str]


class RoutingExecuteRequest(BaseModel):
    """Request to execute the routings import."""

    company_id: str
    mappings: dict[str, str]  # csv_column -> db_field
    rows: list[dict[str, str]]  # CSV rows to import
    skip_conflicts: bool = False  # If True, skip rows with conflicts


class RoutingExecuteResponse(BaseModel):
    """Response with import results for routings."""

    success: bool
    imported_routings_count: int  # routings table rows created
    imported_operations_count: int  # routing_operations table rows created
    skipped_count: int
    errors: list[RoutingImportError]


# Target schema for routings + routing_operations (for AI mapping)
ROUTING_SCHEMA = {
    "part_name": {
        "type": "string",
        "required": True,
        "description": "Part name. Resolved against existing parts; multiple rows with the same part_name form a single routing.",
    },
    "work_center_name": {
        "type": "string",
        "required": False,
        "description": "Work center name. Resolved against existing work_centers; rows with no work_center_name fall back to MISCELLANEOUS if it exists.",
    },
    "sequence": {
        "type": "number",
        "required": False,
        "description": "Operation sequence within the routing (defaults to CSV row order grouped by part)",
    },
    "setup_minutes": {
        "type": "number",
        "required": False,
        "description": "Setup time in minutes (used when work_center.kind='internal')",
    },
    "cycle_minutes_per_unit": {
        "type": "number",
        "required": False,
        "description": "Cycle time per output unit in minutes (used when work_center.kind='internal')",
    },
    "labor_rate_override": {
        "type": "number",
        "required": False,
        "description": "Per-operation hourly rate that overrides work_center.labor_rate. Dollars per hour. Used when kind='internal'.",
    },
    "external_unit_price": {
        "type": "number",
        "required": False,
        "description": "Flat price per output unit (used when work_center.kind='external')",
    },
    "external_setup_cost": {
        "type": "number",
        "required": False,
        "description": "One-time per-job setup cost (used when work_center.kind='external')",
    },
    "instructions": {
        "type": "string",
        "required": False,
        "description": "Operation instructions for the operator",
    },
}
