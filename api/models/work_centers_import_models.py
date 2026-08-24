"""Pydantic models for Work Centers CSV import API.

A work center is IN-HOUSE capacity (Mazak Lathe, Deburr Bench). It used to be
either internal or external; the external half is now vendor_services and
imports through vendor_services_import_models.
"""

from typing import Optional
from pydantic import BaseModel

from models.import_models import ColumnMapping  # noqa: F401






class WorkCenterConflictInfo(BaseModel):
    """Information about a conflicting row.

    conflict_type values:
      - "duplicate_name": work_center with this name already exists in DB
      - "csv_duplicate": same name appears multiple times in CSV
      - "unknown_vendor": retired with kind; kept so old payloads still parse
    """

    row_number: int
    csv_name: Optional[str]
    conflict_type: str
    existing_work_center_id: str  # Empty string for non-DB conflicts
    existing_value: str  # Additional conflict info


class WorkCenterValidationError(BaseModel):
    """A validation error discovered during validation phase.

    error_type values:
      - "missing_name", "invalid_rate"
      - "kind_no_longer_supported" / "vendor_no_longer_supported": the file was
        written for the old two-kind model; the row names an outsourced process,
        which imports as a vendor service instead
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
    updated_count: int = 0  # Rows upserted via (company_id, name) ON CONFLICT path
    skipped_count: int
    errors: list[WorkCenterImportError]


# Target schema for work_centers table (for AI mapping)
WORK_CENTER_SCHEMA = {
    "name": {
        "type": "string",
        "required": True,
        "description": "Work center name — a machine or station in YOUR shop (e.g., 'HURCO Mill', 'Deburr Bench'). NOT an outside vendor's process.",
    },
    "labor_rate": {
        "type": "number",
        "required": False,
        "description": "Hourly labor rate in dollars (e.g., 135.00).",
    },
    "description": {
        "type": "string",
        "required": False,
        "description": "Additional notes or description",
    },
}
