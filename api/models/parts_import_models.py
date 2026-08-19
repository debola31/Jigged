"""Pydantic models for Parts CSV import API.

The unified Parts importer absorbs the previous `inventory_items` import path.
Every imported row lives in one of four valid quadrants formed by the
(source, is_stocked) pair:

  - source='made',   !is_stocked → Custom Made
  - source='made',    is_stocked → Sub-assembly
  - source='bought',  is_stocked → Raw Material
  - source='bought', !is_stocked → Service / Drop-ship

The legacy boolean columns (`is_manufacturable`, `is_stockable`) were renamed
in the 20260504 source-enum-and-stocked-rename migration. The importer still
accepts them as legacy column-mapping aliases for one-version compatibility
with already-prepared CSVs — see the validate/execute routes for the
deprecation log entry that gets written for each legacy-mapped row.
"""

from enum import Enum
from typing import Optional
from pydantic import BaseModel

from models.import_models import ColumnMapping  # noqa: F401


class CustomerMatchMode(str, Enum):
    """How to assign customers to imported parts.

    DEPRECATED — parts no longer reference customers in the unified schema.
    Customer association lives on quotes/jobs only. The Pydantic enum is kept
    so the frontend's currently-deployed payload still parses (we want a clear
    400 from the route, not a 422 from Pydantic), but the import routes RAISE
    the moment any customer field is present rather than silently dropping it.
    See parts_import_routes._reject_customer_fields().
    """

    BY_COLUMN = "by_column"  # Match by customer_code column
    ALL_TO_ONE = "all_to_one"  # Assign all parts to selected customer
    ALL_GENERIC = "all_generic"  # No customer (generic parts)


class PricingColumnPair(BaseModel):
    """A pair of columns for quantity and price."""

    qty_column: str
    price_column: str






class PartConflictInfo(BaseModel):
    """Information about a conflicting row.

    conflict_type values:
      - "duplicate_part_name": part already exists in DB with this name
      - "csv_duplicate": same part_name appears multiple times in CSV
        (would cause an ON CONFLICT DO UPDATE collision at execute time)
      - "customer_not_found": legacy customer-name lookup failed
      - "unknown_vendor": preferred_vendor_name doesn't match any existing vendor
      - "unknown_unit": primary_unit could not be resolved (alias or AI inference)
    """

    row_number: int
    csv_part_name: Optional[str]
    csv_customer_code: Optional[str]
    conflict_type: str
    existing_part_id: str  # Empty string for non-DB conflicts
    existing_value: str  # Additional conflict info


class PartValidationError(BaseModel):
    """A validation error discovered during validation phase.

    error_type values:
      - "missing_part_name", "invalid_price", "invalid_qty"
      - "missing_primary_unit": is_stocked=true but primary_unit absent
      - "invalid_quantity": quantity is negative
      - "invalid_cost": cost_per_unit (CSV column) is negative — execute
        routes this into a part_procurement_tiers row when source='bought'.
        The parts.cost_per_unit column was dropped in migration 20260514.
      - "invalid_reorder_point": reorder_point is negative
    """

    row_number: int
    error_type: str
    field: str
    message: str


class PartValidateRequest(BaseModel):
    """Request to validate parts data before import.

    `customer_match_mode` and `selected_customer_id` are accepted-but-deprecated.
    Parts no longer link to customers at the data layer (customer association
    lives on quotes/jobs only). The route handler RAISES a 400 when either
    field is present, per the no-silent-fallbacks engineering principle —
    silently dropping them would let the frontend think a customer link was
    saved when it wasn't.
    """

    company_id: str
    mappings: dict[str, str]  # csv_column -> db_field
    pricing_columns: list[PricingColumnPair]  # Qty/price column pairs
    rows: list[dict[str, str]]  # All parsed CSV rows
    # DEPRECATED — see class docstring; kept Optional so the route can
    # detect presence and return a clear 400 rather than Pydantic 422'ing.
    customer_match_mode: Optional[CustomerMatchMode] = None
    selected_customer_id: Optional[str] = None
    # Optional: pre-resolved canonical UOMs keyed by 1-based row_number.
    # When provided (e.g. when execute_import re-validates internally), the
    # validator will skip the AI inference step and trust these values.
    pre_resolved_uoms: dict[int, str] = {}
    # When the frontend batches validate calls, this offset is added to the
    # per-batch index so conflict/error row_numbers reflect the row's true
    # position in the original CSV. Default 0 = single-shot validate.
    batch_offset: int = 0


class PartValidateResponse(BaseModel):
    """Response with validation results for parts."""

    has_conflicts: bool
    conflicts: list[PartConflictInfo]
    validation_errors: list[PartValidationError]
    valid_rows_count: int
    conflict_rows_count: int
    error_rows_count: int
    skipped_rows_count: int
    # Map of 1-based row_number to canonical UOM resolved from raw input.
    # Stockable rows without an entry will fall back to the raw value during execute.
    uom_resolutions: dict[int, str] = {}


class PartImportError(BaseModel):
    """An error that occurred during import."""

    row_number: int
    reason: str
    data: dict[str, str]


class PartExecuteRequest(BaseModel):
    """Request to execute the parts import.

    `customer_match_mode` and `selected_customer_id` are accepted-but-deprecated;
    see PartValidateRequest. The route handler RAISES a 400 when either is
    present.
    """

    company_id: str
    mappings: dict[str, str]  # csv_column -> db_field
    pricing_columns: list[PricingColumnPair]  # Qty/price column pairs
    rows: list[dict[str, str]]  # CSV rows to import
    # DEPRECATED — see PartValidateRequest.
    customer_match_mode: Optional[CustomerMatchMode] = None
    selected_customer_id: Optional[str] = None
    skip_conflicts: bool = False  # If True, skip rows with conflicts
    # Map of 1-based row_number to pre-resolved canonical UOM (from validate).
    # Empty dict means execute will run alias resolution itself.
    uom_resolutions: dict[int, str] = {}


class PartExecuteResponse(BaseModel):
    """Response with import results for parts."""

    success: bool
    imported_count: int
    updated_count: int = 0  # Rows upserted via (company_id, part_name) ON CONFLICT path
    skipped_count: int
    errors: list[PartImportError]
    # Parts whose mapped quantity was deliberately NOT written because the part already holds
    # stock at a real place, where "240 on hand" cannot say which shelf to correct. Reported so
    # the UI can say which balances didn't land — a mapped column silently not applying is the
    # silent-fallback pattern CLAUDE.md bans. Everything else about those rows imported fine.
    #
    # Was `location_tracked_skipped` until 20260802015837, when `is_location_tracked` was dropped
    # and "the part is tracked by place" stopped distinguishing anything — every part is.
    quantity_skipped_already_placed: list[str] = []


# Target schema for parts table (for AI mapping).
#
# IMPORTANT: PART_SCHEMA and UNIFIED_PART_SCHEMA are intentionally identical
# in this PR. The plan separates "core part fields" from "unified parts +
# routings + inventory" conceptually; on disk the unified row is just a part
# row with classification flags. Both names are exported because the frontend
# `/api/parts/import/analyze-unified` route uses `UNIFIED_PART_SCHEMA` while
# the standard `/analyze` uses `PART_SCHEMA`.
PART_SCHEMA = {
    "part_name": {
        "type": "string",
        "required": True,
        "description": "Part name identifier (unique per company)",
    },
    "description": {
        "type": "string",
        "required": False,
        "description": "Part description or name",
    },
    "source": {
        "type": "string",
        "required": False,
        "description": "'made' if produced in-shop (with a routing); 'bought' if procured from a vendor.",
    },
    "is_stocked": {
        "type": "boolean",
        "required": False,
        "description": "Whether this part is tracked as stock-on-hand. Defaults to true for raw materials and sub-assemblies.",
    },
    "primary_unit": {
        "type": "string",
        # Required for EVERY part, not just stocked ones: the parts table has an
        # unconditional `parts_requires_unit` CHECK (primary_unit IS NOT NULL).
        # This said False, so a unit-less row passed validate and then failed the
        # batch insert with a 500.
        "required": True,
        "description": "Primary unit of measure — every part needs one (e.g., 'lbs', 'pcs', 'kg', 'in')",
    },
    "quantity": {
        "type": "number",
        "required": False,
        "description": "Initial quantity on hand (defaults to 0, must be non-negative)",
    },
    "cost_per_unit": {
        "type": "number",
        "required": False,
        "description": "Cost per primary unit (decimal, e.g., 12.50). For bought parts this is written as a NULL-vendor procurement tier at min_quantity=1; for made parts it is ignored (cost is computed live from routing + BOM).",
    },
    "reorder_point": {
        "type": "number",
        "required": False,
        "description": "Reorder point (low-stock threshold; non-negative)",
    },
    "preferred_vendor_name": {
        "type": "string",
        "required": False,
        "description": "Preferred vendor name. Resolved against existing vendors at import; fails as unknown_vendor if not found.",
    },
    "notes": {
        "type": "string",
        "required": False,
        "description": "Internal notes about this part",
    },
}


# Unified parts + routings + inventory mapping target. Identical to PART_SCHEMA;
# routing-operation columns are detected separately by the unified analyze step
# (one CSV row per part with operation columns repeated, e.g. op1_name/op1_setup).
UNIFIED_PART_SCHEMA = dict(PART_SCHEMA)


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


def parse_bool(value: str) -> Optional[bool]:
    """Parse a CSV boolean string. Returns None for empty/unrecognized values."""
    if value is None:
        return None
    v = str(value).strip().lower()
    if not v:
        return None
    if v in ("true", "t", "yes", "y", "1"):
        return True
    if v in ("false", "f", "no", "n", "0"):
        return False
    return None
