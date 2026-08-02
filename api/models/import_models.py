"""Pydantic models for CSV import API."""

from typing import Optional
from pydantic import BaseModel


class ColumnMapping(BaseModel):
    """A single column mapping suggestion from AI."""

    csv_column: str
    db_field: Optional[str]  # None means skip/discard
    confidence: float  # 0.0 to 1.0
    reasoning: str
    needs_review: bool  # True if confidence < 0.7


class AnalyzeRequest(BaseModel):
    """Request to analyze CSV and get mapping suggestions."""

    company_id: str
    headers: list[str]
    sample_rows: list[list[str]]  # First 5 rows of data


class AnalyzeResponse(BaseModel):
    """Response with AI-suggested column mappings."""

    mappings: list[ColumnMapping]
    unmapped_required: list[str]  # Required DB fields with no mapping
    discarded_columns: list[str]  # CSV columns that won't be imported
    ai_provider: str  # Which AI was used


class ConflictInfo(BaseModel):
    """Information about a conflicting row."""

    row_number: int
    csv_name: Optional[str]
    conflict_type: str  # "duplicate_name" | "csv_duplicate_name"
    existing_customer_id: str  # Empty string for CSV internal duplicates
    existing_value: str  # For CSV duplicates, this is "Row N" where N is the first occurrence


class ValidateRequest(BaseModel):
    """Request to validate data before import."""

    company_id: str
    mappings: dict[str, str]  # csv_column -> db_field
    rows: list[dict[str, str]]  # All parsed CSV rows
    # When the frontend batches validate calls, this offset is added to the
    # per-batch index so conflict/error row_numbers reflect the row's true
    # position in the original CSV. Default 0 = single-shot validate.
    batch_offset: int = 0


class ValidationError(BaseModel):
    """A validation error discovered during validation phase."""

    row_number: int
    error_type: str  # "missing_name"
    field: str


class ValidateResponse(BaseModel):
    """Response with validation results."""

    has_conflicts: bool
    conflicts: list[ConflictInfo]
    validation_errors: list[ValidationError]
    valid_rows_count: int
    conflict_rows_count: int
    error_rows_count: int
    skipped_rows_count: int


class ImportError(BaseModel):
    """An error that occurred during import."""

    row_number: int
    reason: str
    data: dict[str, str]


class ExecuteRequest(BaseModel):
    """Request to execute the import."""

    company_id: str
    mappings: dict[str, str]  # csv_column -> db_field
    rows: list[dict[str, str]]  # CSV rows to import
    skip_conflicts: bool = False  # If True, skip rows with conflicts


class ExecuteResponse(BaseModel):
    """Response with import results."""

    success: bool
    imported_count: int
    updated_count: int = 0  # existing customers updated in place on re-import (upsert)
    skipped_count: int
    errors: list[ImportError]


# Target schema for customers table
CUSTOMER_SCHEMA = {
    "name": {
        "type": "string",
        "required": True,
        "description": "Company/customer name",
    },
    "website": {
        "type": "string",
        "required": False,
        "description": "Company website URL",
    },
    "contact_name": {
        "type": "string",
        "required": False,
        "description": "Primary contact person name",
    },
    "contact_phone": {
        "type": "string",
        "required": False,
        "description": "Primary contact phone number",
    },
    "contact_email": {
        "type": "string",
        "required": False,
        "description": "Primary contact email address",
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
    # Standing terms. The descriptions carry the legacy vocabulary on purpose —
    # the AI column mapper matches source headers against them, and a JobBOSS /
    # E2 export calls this column "Terms Code", not "Payment Terms".
    "default_payment_terms": {
        "type": "string",
        "required": False,
        "description": (
            "Standing payment terms for this customer, applied to new quotes "
            "(e.g. Net 30, 2% 10 Net 30, Due on Receipt). Often exported as "
            "'Terms', 'Terms Code' or 'Payment Terms'."
        ),
    },
    "default_lead_time_text": {
        "type": "string",
        "required": False,
        "description": (
            "Standing lead time quoted to this customer, as free text "
            "(e.g. '4-6 weeks ARO'). Often exported as 'Lead Time' or 'Lead Days'."
        ),
    },
    "default_fob_point": {
        "type": "string",
        "required": False,
        "description": (
            "FOB point — WHERE title and risk transfer, as a named place "
            "(e.g. 'FOB Cleveland, OH', 'FOB Origin'). Often exported as 'FOB'. "
            "Not the freight payment terms (prepaid / collect / third party), "
            "which describe who PAYS and are not imported here."
        ),
    },
}
