"""Pydantic models for BOM (parts_bom) CSV import API.

The BOM import lands rows in `parts_bom` (parent_part_id, child_part_id, qty,
unit). Both parts must already exist in the company. Cycle detection runs
pre-flight via a recursive walk so the user sees every cycle at once instead
of one-at-a-time when the DB trigger fires during execute.
"""

from typing import Optional
from pydantic import BaseModel

from models.import_models import ColumnMapping  # noqa: F401


class BomAnalyzeRequest(BaseModel):
    """Request to analyze CSV and get mapping suggestions for BOM rows."""

    company_id: str
    headers: list[str]
    sample_rows: list[list[str]]  # First 5 rows of data


class BomAnalyzeResponse(BaseModel):
    """Response with AI-suggested column mappings for BOM rows."""

    mappings: list[ColumnMapping]
    unmapped_required: list[str]  # Required DB fields with no mapping
    discarded_columns: list[str]  # CSV columns that won't be imported
    ai_provider: str  # Which AI was used


class BomConflictInfo(BaseModel):
    """Information about a conflicting BOM row.

    conflict_type values:
      - "unknown_parent_part": parent_part_name doesn't match any existing part
      - "unknown_child_part": child_part_name doesn't match any existing part
      - "bom_self_reference": parent_part_name == child_part_name
      - "csv_duplicate": same parent+child appears multiple times in CSV
      - "duplicate_bom_line": parent+child already exists in parts_bom
      - "would_create_cycle": adding this edge would close a cycle
    """

    row_number: int
    csv_parent: Optional[str]
    csv_child: Optional[str]
    conflict_type: str
    existing_bom_id: str  # Empty string for non-DB conflicts
    existing_value: str  # Additional conflict info


class BomValidationError(BaseModel):
    """A validation error discovered during validation phase.

    error_type values:
      - "missing_parent_part_name", "missing_child_part_name"
      - "missing_quantity", "invalid_quantity"
      - "missing_unit"
    """

    row_number: int
    error_type: str
    field: str
    message: str


class BomValidateRequest(BaseModel):
    """Request to validate BOM data before import."""

    company_id: str
    mappings: dict[str, str]  # csv_column -> db_field
    rows: list[dict[str, str]]  # All parsed CSV rows


class BomValidateResponse(BaseModel):
    """Response with validation results for BOM."""

    has_conflicts: bool
    conflicts: list[BomConflictInfo]
    validation_errors: list[BomValidationError]
    valid_rows_count: int
    conflict_rows_count: int
    error_rows_count: int
    skipped_rows_count: int


class BomImportError(BaseModel):
    """An error that occurred during import."""

    row_number: int
    reason: str
    data: dict[str, str]


class BomExecuteRequest(BaseModel):
    """Request to execute the BOM import."""

    company_id: str
    mappings: dict[str, str]  # csv_column -> db_field
    rows: list[dict[str, str]]  # CSV rows to import
    skip_conflicts: bool = False  # If True, skip rows with conflicts


class BomExecuteResponse(BaseModel):
    """Response with import results for BOM."""

    success: bool
    imported_count: int
    skipped_count: int
    errors: list[BomImportError]


# Target schema for parts_bom table (for AI mapping)
BOM_SCHEMA = {
    "parent_part_name": {
        "type": "string",
        "required": True,
        "description": "Parent part name (the assembly that contains the child)",
    },
    "child_part_name": {
        "type": "string",
        "required": True,
        "description": "Child part name (the component consumed by the parent)",
    },
    "quantity": {
        "type": "number",
        "required": True,
        "description": "Quantity of child consumed per parent (positive number)",
    },
    "unit": {
        "type": "string",
        "required": True,
        "description": "Unit of measure for the BOM line (e.g., 'pcs', 'lbs', 'in')",
    },
    "notes": {
        "type": "string",
        "required": False,
        "description": "Notes about this BOM line (assembly instructions, etc.)",
    },
}
