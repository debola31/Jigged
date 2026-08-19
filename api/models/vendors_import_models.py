"""Pydantic models for Vendors CSV import API.

A vendor is a first-class entity. What a vendor "does" (supplies materials,
performs outside operations, both, or neither yet) is derived from references
elsewhere in the schema (parts.preferred_vendor_id, work_centers.vendor_id),
so this importer carries no capability flags.

The validate step also returns `proposed_merges` — a list of vendor names that
look like the same vendor (Levenshtein distance + common-prefix matching). The
user confirms or rejects each merge in the import UI; confirmed merges are
collapsed into the canonical row at execute time.

Iteration 2 (vendor multi-contact): the embedded contact_name / contact_email /
contact_phone columns and the notes column were dropped from the vendors
table. Contacts now live in the separate vendor_contacts table. To keep the
single-row CSV import path useful, this importer accepts optional
primary_contact_* fields per row; when present, execute inserts one
vendor_contacts row per imported vendor with is_primary=true. Multi-contact
import (multiple contacts per vendor in one CSV) is deferred to a separate
/api/vendors/contacts/import endpoint.
"""

from typing import Optional
from pydantic import BaseModel

from models.import_models import ColumnMapping  # noqa: F401






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
      - "missing_contact_name": primary_contact_email or _phone was set but
        primary_contact_name was empty. We refuse to create contacts with no
        name (would silently corrupt data — see the migration's data-quality
        NOTICE rationale).
      - "invalid_contact_role": primary_contact_role is set to a value not in
        the allowed enum.
    """

    row_number: int
    error_type: str
    field: str
    message: str


class VendorMergeProposal(BaseModel):
    """A proposed merge: from_name should be treated as to_name."""

    from_name: str
    to_name: str
    from_csv_rows: list[int]  # 1-based CSV row indices that contain from_name
    confidence: float


class VendorValidateRequest(BaseModel):
    """Request to validate vendors data before import."""

    company_id: str
    mappings: dict[str, str]  # csv_column -> db_field
    rows: list[dict[str, str]]  # All parsed CSV rows
    # When the frontend batches validate calls, this offset is added to the
    # per-batch index so conflict/error row_numbers reflect the row's true
    # position in the original CSV. Default 0 = single-shot validate.
    batch_offset: int = 0


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
    """Request to execute the vendors import."""

    company_id: str
    mappings: dict[str, str]  # csv_column -> db_field
    rows: list[dict[str, str]]  # CSV rows to import
    skip_conflicts: bool = False  # If True, skip rows with conflicts
    confirmed_merges: list[VendorMergeConfirmation] = []


class VendorExecuteResponse(BaseModel):
    """Response with import results for vendors."""

    success: bool
    imported_count: int
    updated_count: int = 0  # Rows upserted via (company_id, name) ON CONFLICT path
    merged_count: int = 0  # Rows folded into a canonical name via confirmed_merges
    contacts_imported_count: int = 0  # vendor_contacts rows created from primary_contact_* fields
    skipped_count: int
    errors: list[VendorImportError]


# Allowed values for primary_contact_role (mirrors the vendor_contacts.role
# CHECK enum). Order matches the UI dropdown order.
VENDOR_CONTACT_ROLE_VALUES = (
    "sales",
    "accounts_payable",
    "quality",
    "engineering",
    "shipping_receiving",
    "customer_service",
    "other",
)

# Target schema for vendors table (for AI mapping).
#
# Iteration 2 changes:
#   - Removed: contact_name, contact_email, contact_phone, notes
#   - Added: primary_contact_name, primary_contact_email, primary_contact_phone,
#     primary_contact_role (defaults to 'sales' if omitted; validated against
#     VENDOR_CONTACT_ROLE_VALUES)
VENDOR_SCHEMA = {
    "name": {
        "type": "string",
        "required": True,
        "description": "Vendor company name (unique per company)",
    },
    "primary_contact_name": {
        "type": "string",
        "required": False,
        "description": "Name of the primary contact person at this vendor. When set, a vendor_contacts row is created with is_primary=true. Required when primary_contact_email or primary_contact_phone is set.",
    },
    "primary_contact_email": {
        "type": "string",
        "required": False,
        "description": "Email of the primary contact person. Stored on the vendor_contacts row, not on the vendor itself.",
    },
    "primary_contact_phone": {
        "type": "string",
        "required": False,
        "description": "Phone of the primary contact person. Stored on the vendor_contacts row.",
    },
    "primary_contact_role": {
        "type": "string",
        "required": False,
        "description": (
            "Role of the primary contact. One of: "
            + ", ".join(VENDOR_CONTACT_ROLE_VALUES)
            + ". Defaults to 'sales' when omitted. Use 'other' for shop-specific roles "
            "(but in the CSV path there's no place to capture role_label, so 'other' "
            "rows will fail the DB CHECK constraint — prefer one of the named values)."
        ),
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
}
