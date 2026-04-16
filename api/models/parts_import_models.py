"""Pydantic models for Parts CSV import API."""

from enum import Enum
from typing import Optional
from pydantic import BaseModel

from models.import_models import ColumnMapping  # noqa: F401


class CustomerMatchMode(str, Enum):
    """How to assign customers to imported parts."""

    BY_COLUMN = "by_column"  # Match by customer_code column
    ALL_TO_ONE = "all_to_one"  # Assign all parts to selected customer
    ALL_GENERIC = "all_generic"  # No customer (generic parts)


class PricingColumnPair(BaseModel):
    """A pair of columns for quantity and price."""

    qty_column: str
    price_column: str


class PartAnalyzeRequest(BaseModel):
    """Request to analyze CSV and get mapping suggestions for parts."""

    company_id: str
    headers: list[str]
    sample_rows: list[list[str]]  # First 5 rows of data


class PartAnalyzeResponse(BaseModel):
    """Response with AI-suggested column mappings for parts."""

    mappings: list[ColumnMapping]
    pricing_columns: list[PricingColumnPair]  # Auto-detected pricing column pairs
    unmapped_required: list[str]  # Required DB fields with no mapping
    discarded_columns: list[str]  # CSV columns that won't be imported
    ai_provider: str  # Which AI was used


class PartConflictInfo(BaseModel):
    """Information about a conflicting row."""

    row_number: int
    csv_part_name: Optional[str]
    csv_customer_code: Optional[str]
    conflict_type: str  # "duplicate_part_name" | "customer_not_found" | "csv_duplicate"
    existing_part_id: str  # Empty string for non-DB conflicts
    existing_value: str  # Additional conflict info


class PartValidationError(BaseModel):
    """A validation error discovered during validation phase."""

    row_number: int
    error_type: str  # "missing_part_name" | "invalid_price" | "invalid_qty"
    field: str
    message: str


class PartValidateRequest(BaseModel):
    """Request to validate parts data before import."""

    company_id: str
    mappings: dict[str, str]  # csv_column -> db_field
    pricing_columns: list[PricingColumnPair]  # Qty/price column pairs
    rows: list[dict[str, str]]  # All parsed CSV rows
    customer_match_mode: CustomerMatchMode
    selected_customer_id: Optional[str] = None  # For ALL_TO_ONE mode


class PartValidateResponse(BaseModel):
    """Response with validation results for parts."""

    has_conflicts: bool
    conflicts: list[PartConflictInfo]
    validation_errors: list[PartValidationError]
    valid_rows_count: int
    conflict_rows_count: int
    error_rows_count: int
    skipped_rows_count: int


class PartImportError(BaseModel):
    """An error that occurred during import."""

    row_number: int
    reason: str
    data: dict[str, str]


class PartExecuteRequest(BaseModel):
    """Request to execute the parts import."""

    company_id: str
    mappings: dict[str, str]  # csv_column -> db_field
    pricing_columns: list[PricingColumnPair]  # Qty/price column pairs
    rows: list[dict[str, str]]  # CSV rows to import
    customer_match_mode: CustomerMatchMode
    selected_customer_id: Optional[str] = None  # For ALL_TO_ONE mode
    skip_conflicts: bool = False  # If True, skip rows with conflicts


class PartExecuteResponse(BaseModel):
    """Response with import results for parts."""

    success: bool
    imported_count: int
    skipped_count: int
    errors: list[PartImportError]


# Target schema for parts table (for AI mapping)
PART_SCHEMA = {
    "part_name": {
        "type": "string",
        "required": True,
        "description": "Part name identifier (unique per customer or globally for generic parts)",
    },
    "customer_name": {
        "type": "string",
        "required": False,
        "description": "Customer name to associate this part with (used when customer_match_mode is BY_COLUMN)",
    },
    "description": {
        "type": "string",
        "required": False,
        "description": "Part description or name",
    },
    "notes": {
        "type": "string",
        "required": False,
        "description": "Internal notes about this part",
    },
}

# Common patterns for pricing columns in legacy CSV files
PRICING_COLUMN_PATTERNS = [
    # qty1/price1, qty2/price2, etc.
    (r"^qty(\d+)$", r"^price(\d+)$"),
    (r"^quantity(\d+)$", r"^price(\d+)$"),
    # Qty 1/Price 1, Qty 2/Price 2, etc.
    (r"^qty\s*(\d+)$", r"^price\s*(\d+)$"),
    # MinQty1/UnitPrice1, etc.
    (r"^minqty(\d+)$", r"^unitprice(\d+)$"),
    (r"^min_qty_(\d+)$", r"^unit_price_(\d+)$"),
]
