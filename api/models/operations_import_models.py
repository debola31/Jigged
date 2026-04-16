"""Pydantic models for Operations CSV import API."""

from typing import Optional
from pydantic import BaseModel

from models.import_models import ColumnMapping  # noqa: F401


class OperationAnalyzeRequest(BaseModel):
    """Request to analyze CSV and get mapping suggestions for operations."""

    company_id: str
    headers: list[str]
    sample_rows: list[list[str]]  # First 5 rows of data


class OperationAnalyzeResponse(BaseModel):
    """Response with AI-suggested column mappings for operations."""

    mappings: list[ColumnMapping]
    unmapped_required: list[str]  # Required DB fields with no mapping
    discarded_columns: list[str]  # CSV columns that won't be imported
    ai_provider: str  # Which AI was used


class OperationConflictInfo(BaseModel):
    """Information about a conflicting row."""

    row_number: int
    csv_name: Optional[str]
    conflict_type: str  # "duplicate_name" | "csv_duplicate"
    existing_operation_id: str  # Empty string for non-DB conflicts
    existing_value: str  # Additional conflict info


class OperationValidationError(BaseModel):
    """A validation error discovered during validation phase."""

    row_number: int
    error_type: str  # "missing_name" | "invalid_rate"
    field: str
    message: str


class OperationValidateRequest(BaseModel):
    """Request to validate operations data before import."""

    company_id: str
    mappings: dict[str, str]  # csv_column -> db_field
    rows: list[dict[str, str]]  # All parsed CSV rows


class OperationValidateResponse(BaseModel):
    """Response with validation results for operations."""

    has_conflicts: bool
    conflicts: list[OperationConflictInfo]
    validation_errors: list[OperationValidationError]
    valid_rows_count: int
    conflict_rows_count: int
    error_rows_count: int
    skipped_rows_count: int


class OperationImportError(BaseModel):
    """An error that occurred during import."""

    row_number: int
    reason: str
    data: dict[str, str]


class OperationExecuteRequest(BaseModel):
    """Request to execute the operations import."""

    company_id: str
    mappings: dict[str, str]  # csv_column -> db_field
    rows: list[dict[str, str]]  # CSV rows to import
    skip_conflicts: bool = False  # If True, skip rows with conflicts


class OperationExecuteResponse(BaseModel):
    """Response with import results for operations."""

    success: bool
    imported_count: int
    skipped_count: int
    errors: list[OperationImportError]


# Target schema for operation_types table (for AI mapping)
OPERATION_SCHEMA = {
    "name": {
        "type": "string",
        "required": True,
        "description": "Operation/resource name (e.g., 'HURCO Mill', 'Mazak Lathe')",
    },
    "labor_rate": {
        "type": "number",
        "required": False,
        "description": "Hourly labor rate in dollars (e.g., 135.00)",
    },
    "description": {
        "type": "string",
        "required": False,
        "description": "Additional notes or description",
    },
    "legacy_id": {
        "type": "string",
        "required": False,
        "description": "ID from legacy/previous system (preserved in metadata)",
    },
}
