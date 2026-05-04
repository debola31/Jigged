"""Pydantic models for Vendors CSV import API.

A vendor is a first-class entity. What a vendor "does" (supplies materials,
performs outside operations, both, or neither yet) is derived from references
elsewhere in the schema (parts.preferred_vendor_id, work_centers.vendor_id),
so this importer carries no capability flags.

The validate step also returns `proposed_merges` — a list of vendor names that
look like the same vendor (Levenshtein distance + common-prefix matching). The
user confirms or rejects each merge in the import UI; confirmed merges are
collapsed into the canonical row at execute time.
"""

from typing import Optional
from pydantic import BaseModel

from models.import_models import ColumnMapping  # noqa: F401


class VendorAnalyzeRequest(BaseModel):
    """Request to analyze CSV and get mapping suggestions for vendors."""

    company_id: str
    headers: list[str]
    sample_rows: list[list[str]]  # First 5 rows of data


class VendorAnalyzeResponse(BaseModel):
    """Response with AI-suggested column mappings for vendors."""

    mappings: list[ColumnMapping]
    unmapped_required: list[str]  # Required DB fields with no mapping
    discarded_columns: list[str]  # CSV columns that won't be imported
    ai_provider: str  # Which AI was used


class VendorConflictInfo(BaseModel):
    """Information about a conflicting row.

    conflict_type values:
      - "duplicate_name": vendor with this name already exists in DB
      - "csv_duplicate": same name appears multiple times in CSV
    """

    row_number: int
    csv_name: Optional[str]
    conflict_type: str
    existing_vendor_id: str  # Empty string for non-DB conflicts
    existing_value: str  # Additional conflict info


class VendorValidationError(BaseModel):
    """A validation error discovered during validation phase.

    error_type values:
      - "missing_name"
    """

    row_number: int
    error_type: str
    field: str
    message: str


class VendorMergeProposal(BaseModel):
    """A proposed merge: from_name should be treated as to_name.

    The user confirms or rejects each proposal in the import UI before execute.
    confidence is in [0.0, 1.0]; higher means we're more confident the names
    refer to the same vendor (e.g. "PerformCoat of Michigan LL" vs "PerformCoat
    of Michigan LLC" → ~0.95).
    """

    from_name: str
    to_name: str
    from_csv_rows: list[int]  # 1-based CSV row indices that contain from_name
    confidence: float


class VendorValidateRequest(BaseModel):
    """Request to validate vendors data before import."""

    company_id: str
    mappings: dict[str, str]  # csv_column -> db_field
    rows: list[dict[str, str]]  # All parsed CSV rows


class VendorValidateResponse(BaseModel):
    """Response with validation results for vendors."""

    has_conflicts: bool
    conflicts: list[VendorConflictInfo]
    validation_errors: list[VendorValidationError]
    proposed_merges: list[VendorMergeProposal]
    valid_rows_count: int
    conflict_rows_count: int
    error_rows_count: int
    skipped_rows_count: int


class VendorMergeConfirmation(BaseModel):
    """A user-confirmed merge to apply at execute time."""

    from_name: str
    to_name: str


class VendorImportError(BaseModel):
    """An error that occurred during import."""

    row_number: int
    reason: str
    data: dict[str, str]


class VendorExecuteRequest(BaseModel):
    """Request to execute the vendors import.

    confirmed_merges: rows whose vendor name matches any confirmed `from_name`
    are folded into the row carrying the canonical `to_name`. Unconfirmed
    proposals are imported as separate vendors.
    """

    company_id: str
    mappings: dict[str, str]  # csv_column -> db_field
    rows: list[dict[str, str]]  # CSV rows to import
    skip_conflicts: bool = False  # If True, skip rows with conflicts
    confirmed_merges: list[VendorMergeConfirmation] = []


class VendorExecuteResponse(BaseModel):
    """Response with import results for vendors."""

    success: bool
    imported_count: int
    updated_count: int = 0  # Rows upserted via legacy_id ON CONFLICT path
    merged_count: int = 0  # Rows folded into a canonical name via confirmed_merges
    skipped_count: int
    errors: list[VendorImportError]


# Target schema for vendors table (for AI mapping)
VENDOR_SCHEMA = {
    "name": {
        "type": "string",
        "required": True,
        "description": "Vendor company name (unique per company)",
    },
    "contact_name": {
        "type": "string",
        "required": False,
        "description": "Primary contact person name",
    },
    "contact_email": {
        "type": "string",
        "required": False,
        "description": "Primary contact email address",
    },
    "contact_phone": {
        "type": "string",
        "required": False,
        "description": "Primary contact phone number",
    },
    "address_line1": {
        "type": "string",
        "required": False,
        "description": "Street address line 1",
    },
    "address_line2": {
        "type": "string",
        "required": False,
        "description": "Street address line 2 (suite, unit, etc.)",
    },
    "city": {
        "type": "string",
        "required": False,
        "description": "City name",
    },
    "state": {
        "type": "string",
        "required": False,
        "description": "State or province",
    },
    "postal_code": {
        "type": "string",
        "required": False,
        "description": "ZIP or postal code",
    },
    "country": {
        "type": "string",
        "required": False,
        "description": "Country (defaults to USA)",
    },
    "notes": {
        "type": "string",
        "required": False,
        "description": "Internal notes about this vendor",
    },
    "legacy_id": {
        "type": "string",
        "required": False,
        "description": "ID from legacy/previous system. Unique per company; enables idempotent re-import via ON CONFLICT.",
    },
}
