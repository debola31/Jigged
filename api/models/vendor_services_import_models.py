"""Pydantic models for the Vendor Services CSV import API.

A vendor service is a process an outside vendor performs on your parts
(anodize, heat treat, wire EDM). It replaces what used to import as a
`work_centers` row with kind='external'.

The identity is `(vendor_id, name)`, NOT `(company_id, name)` — two vendors may
both offer "Anodize", so the vendor is part of what makes the row unique and the
upsert targets both columns.
"""

from typing import Optional
from pydantic import BaseModel

from models.import_models import ColumnMapping  # noqa: F401


class VendorServiceConflictInfo(BaseModel):
    """A row that cannot be written as-is.

    conflict_type values:
      - "unknown_vendor": names a vendor that is not in the DB yet
      - "csv_duplicate": the same (vendor, service) appears twice in the file
    """

    row_number: int
    csv_name: Optional[str]
    conflict_type: str
    existing_service_id: str  # Empty string for non-DB conflicts
    existing_value: str


class VendorServiceValidationError(BaseModel):
    """A validation error found before any write.

    error_type values:
      - "missing_vendor_name", "missing_service_name", "invalid_price"
    """

    row_number: int
    error_type: str
    field: str
    message: str


class VendorServiceValidateRequest(BaseModel):
    company_id: str
    mappings: dict[str, str]  # csv_column -> db_field
    rows: list[dict[str, str]]
    # Added to the per-batch index so row_numbers reflect the row's true
    # position in the original CSV when the frontend batches validate calls.
    batch_offset: int = 0


class VendorServiceValidateResponse(BaseModel):
    has_conflicts: bool
    conflicts: list[VendorServiceConflictInfo]
    validation_errors: list[VendorServiceValidationError]
    valid_rows_count: int
    conflict_rows_count: int
    error_rows_count: int
    skipped_rows_count: int


class VendorServiceImportError(BaseModel):
    row_number: int
    reason: str
    data: dict[str, str]


class VendorServiceExecuteRequest(BaseModel):
    company_id: str
    mappings: dict[str, str]
    rows: list[dict[str, str]]
    skip_conflicts: bool = False


class VendorServiceExecuteResponse(BaseModel):
    success: bool
    imported_count: int
    updated_count: int = 0  # Rows upserted via the (vendor_id, name) ON CONFLICT path
    skipped_count: int
    errors: list[VendorServiceImportError]


# Target schema for the vendor_services table (for AI mapping)
VENDOR_SERVICE_SCHEMA = {
    "vendor_name": {
        "type": "string",
        "required": True,
        "description": "The vendor who performs this service. Must already exist — import vendors first.",
    },
    "service_name": {
        "type": "string",
        "required": True,
        "description": "The PROCESS, not the supplier — 'Anodize', 'Heat treat', 'Wire EDM'. If the source file only has the vendor's company name here, that is the name to fix rather than import.",
    },
    "unit_price": {
        "type": "number",
        "required": False,
        "description": "Price per piece the vendor charges (e.g., 4.50). Routing steps inherit it unless they override it.",
    },
    "description": {
        "type": "string",
        "required": False,
        "description": "Notes for whoever ships the parts — spec or callout, packaging.",
    },
}
