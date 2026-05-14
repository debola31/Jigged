"""Pydantic models for Work Centers CSV import API.

Replaces the old operations_import_models — work_centers is the renamed
capacity-bucket table (Mazak Lathe, PerformCoat). A work center is either
internal (runs in the shop) or external (vendor-performed outside operation).
"""

from typing import Optional
from pydantic import BaseModel

from models.import_models import ColumnMapping  # noqa: F401


class WorkCenterAnalyzeRequest(BaseModel):
    """Request to analyze CSV and get mapping suggestions for work centers."""

    company_id: str
    headers: list[str]
    sample_rows: list[list[str]]  # First 5 rows of data


class WorkCenterAnalyzeResponse(BaseModel):
    """Response with AI-suggested column mappings for work centers."""

    mappings: list[ColumnMapping]
    unmapped_required: list[str]  # Required DB fields with no mapping
    discarded_columns: list[str]  # CSV columns that won't be imported
    ai_provider: str  # Which AI was used


class WorkCenterConflictInfo(BaseModel):
    """Information about a conflicting row.

    conflict_type values:
      - "duplicate_name": work_center with this name already exists in DB
      - "csv_duplicate": same name appears multiple times in CSV
      - "unknown_vendor": kind='external' row references vendor not in DB
    """

    row_number: int
    csv_name: Optional[str]
    conflict_type: str
    existing_work_center_id: str  # Empty string for non-DB conflicts
    existing_value: str  # Additional conflict info


class WorkCenterValidationError(BaseModel):
    """A validation error discovered during validation phase.

    error_type values:
      - "missing_name", "invalid_rate", "invalid_kind"
      - "vendor_required_for_external": kind='external' but vendor_name is empty
      - "vendor_forbidden_for_internal": kind='internal' but vendor_name set
    """

    row_number: int
    error_type: str
    field: str
    message: str


class WorkCenterValidateRequest(BaseModel):
    """Request to validate work centers data before import."""

    company_id: str
    mappings: dict[str, str]  # csv_column -> db_field
    rows: list[dict[str, str]]  # All parsed CSV rows
    # When the frontend batches validate calls, this offset is added to the
    # per-batch index so conflict/error row_numbers reflect the row's true
    # position in the original CSV. Default 0 = single-shot validate.
    batch_offset: int = 0


class WorkCenterValidateResponse(BaseModel):
    """Response with validation results for work centers."""

    has_conflicts: bool
    conflicts: list[WorkCenterConflictInfo]
    validation_errors: list[WorkCenterValidationError]
    valid_rows_count: int
    conflict_rows_count: int
    error_rows_count: int
    skipped_rows_count: int


class WorkCenterImportError(BaseModel):
    """An error that occurred during import."""

    row_number: int
    reason: str
    data: dict[str, str]


class WorkCenterExecuteRequest(BaseModel):
    """Request to execute the work centers import."""

    company_id: str
    mappings: dict[str, str]  # csv_column -> db_field
    rows: list[dict[str, str]]  # CSV rows to import
    skip_conflicts: bool = False  # If True, skip rows with conflicts


class WorkCenterExecuteResponse(BaseModel):
    """Response with import results for work centers."""

    success: bool
    imported_count: int
    updated_count: int = 0  # Rows upserted via legacy_id ON CONFLICT path
    skipped_count: int
    errors: list[WorkCenterImportError]


# Target schema for work_centers table (for AI mapping)
WORK_CENTER_SCHEMA = {
    "name": {
        "type": "string",
        "required": True,
        "description": "Work center name (e.g., 'HURCO Mill', 'PerformCoat')",
    },
    "kind": {
        "type": "string",
        "required": False,
        "description": "internal = work center inside the shop; external = vendor-performed outside operation. Defaults to 'internal'.",
    },
    "vendor_name": {
        "type": "string",
        "required": False,
        "description": "Vendor name (required when kind='external'; resolved against existing vendors).",
    },
    "labor_rate": {
        "type": "number",
        "required": False,
        "description": "Hourly labor rate in dollars (e.g., 135.00). Used when kind='internal'.",
    },
    "description": {
        "type": "string",
        "required": False,
        "description": "Additional notes or description",
    },
    "legacy_id": {
        "type": "string",
        "required": False,
        "description": "ID from legacy/previous system (preserved in metadata for re-import idempotency)",
    },
}
