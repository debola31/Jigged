"""Pydantic models for Inventory API."""

from typing import Optional
from pydantic import BaseModel

from models.import_models import ColumnMapping  # noqa: F401


# ============================================================
# Import Models
# ============================================================


class InventoryAnalyzeRequest(BaseModel):
    """Request to analyze CSV and get mapping suggestions for inventory."""

    company_id: str
    headers: list[str]
    sample_rows: list[list[str]]  # First 5 rows of data


class InventoryAnalyzeResponse(BaseModel):
    """Response with AI-suggested column mappings for inventory."""

    mappings: list[ColumnMapping]
    unmapped_required: list[str]  # Required DB fields with no mapping
    discarded_columns: list[str]  # CSV columns that won't be imported
    ai_provider: str  # Which AI was used


class InventoryConflictInfo(BaseModel):
    """Information about a conflicting row."""

    row_number: int
    csv_name: Optional[str]
    conflict_type: str  # "duplicate_name" | "csv_duplicate_name"
    existing_item_id: str  # Empty string for CSV internal duplicates
    existing_value: str


class InventoryValidationError(BaseModel):
    """A validation error discovered during validation phase."""

    row_number: int
    error_type: str  # "missing_name" | "missing_primary_unit" | "invalid_quantity" | "invalid_cost"
    field: str
    message: str


class InventoryValidateRequest(BaseModel):
    """Request to validate inventory data before import."""

    company_id: str
    mappings: dict[str, str]  # csv_column -> db_field
    rows: list[dict[str, str]]  # All parsed CSV rows


class InventoryValidateResponse(BaseModel):
    """Response with validation results for inventory."""

    has_conflicts: bool
    conflicts: list[InventoryConflictInfo]
    validation_errors: list[InventoryValidationError]
    valid_rows_count: int
    conflict_rows_count: int
    error_rows_count: int
    skipped_rows_count: int


class InventoryImportError(BaseModel):
    """An error that occurred during import."""

    row_number: int
    reason: str
    data: dict[str, str]


class InventoryExecuteRequest(BaseModel):
    """Request to execute the inventory import."""

    company_id: str
    mappings: dict[str, str]  # csv_column -> db_field
    rows: list[dict[str, str]]  # CSV rows to import
    skip_conflicts: bool = False  # If True, skip rows with conflicts


class InventoryExecuteResponse(BaseModel):
    """Response with import results for inventory."""

    success: bool
    imported_count: int
    skipped_count: int
    errors: list[InventoryImportError]


# Target schema for inventory_items table (for AI mapping)
INVENTORY_SCHEMA = {
    "name": {
        "type": "string",
        "required": True,
        "description": "Name of the inventory item (e.g., '4140 Steel Bar', 'Aluminum 6061 Sheet')",
    },
    "description": {
        "type": "string",
        "required": False,
        "description": "Detailed description of the item",
    },
    "primary_unit": {
        "type": "string",
        "required": True,
        "description": "Primary unit of measure (e.g., 'lbs', 'pcs', 'kg', 'in', 'ft')",
    },
    "quantity": {
        "type": "number",
        "required": False,
        "description": "Initial quantity on hand (defaults to 0, must be non-negative)",
    },
    "cost_per_unit": {
        "type": "number",
        "required": False,
        "description": "Cost per primary unit (decimal, e.g., 12.50)",
    },
}
