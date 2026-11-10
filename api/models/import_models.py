"""Pydantic models for CSV import API."""

from typing import Any, Iterable, Optional
from pydantic import BaseModel


class ColumnMapping(BaseModel):
    """A single column mapping suggestion from AI."""

    csv_column: str
    db_field: Optional[str]  # None means skip/discard
    confidence: float  # 0.0 to 1.0
    reasoning: str
    needs_review: bool  # True if confidence < 0.7






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
    message: str = ""


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


class SkippedRow(BaseModel):
    """A row an import leaves out, and why. Every execute route reports these, real run or dry.

    `skipped_count` has always said how many; this says which and why, so a caller that cannot
    see the validate step (an assistant, through `dry_run`) can fix the rows rather than guess.
    """

    row_number: int  # 1-based position in the request's `rows`
    type: str  # the validation error_type or conflict_type, e.g. "missing_name", "unknown_vendor"
    field: Optional[str] = None  # the offending field, for a validation error
    reason: str  # the sentence the route already wrote for it


def describe_skipped_rows(
    validation_errors: Iterable[Any],
    conflicts: Iterable[Any],
    skip_row_numbers: set[int],
) -> list[SkippedRow]:
    """The rows in `skip_row_numbers`, each with the validation error or conflict that skips it.

    Duck-typed over the seven importers' own error and conflict models: every validation error
    carries row_number / error_type / field / message, and every conflict carries row_number /
    conflict_type / existing_value. Conflicts an importer does NOT skip (an existing name it
    updates in place) are not in `skip_row_numbers` and so are not reported.
    """
    rows = [
        SkippedRow(
            row_number=e.row_number,
            type=e.error_type,
            field=e.field,
            reason=e.message or f"{e.field} is missing or invalid",
        )
        for e in validation_errors
        if e.row_number in skip_row_numbers
    ] + [
        SkippedRow(row_number=c.row_number, type=c.conflict_type, reason=c.existing_value)
        for c in conflicts
        if c.row_number in skip_row_numbers
    ]
    return sorted(rows, key=lambda r: r.row_number)


class ExecuteRequest(BaseModel):
    """Request to execute the import."""

    company_id: str
    mappings: dict[str, str]  # csv_column -> db_field
    rows: list[dict[str, str]]  # CSV rows to import
    skip_conflicts: bool = False  # If True, skip rows with conflicts
    # Validate and count exactly as a real run would, then return before the first write.
    # Needs office access but not the billing write-gate: a preview saves nothing.
    dry_run: bool = False


class ExecuteResponse(BaseModel):
    """Response with import results."""

    success: bool
    dry_run: bool = False  # True: the counts are what a real run would do; nothing was written
    imported_count: int
    updated_count: int = 0  # existing customers updated in place on re-import (upsert)
    skipped_count: int
    errors: list[ImportError]
    skipped_rows: list[SkippedRow] = []  # which rows skipped_count counts, and why


# Target schema for customers table
CUSTOMER_SCHEMA = {
    "name": {
        "type": "string",
        "required": True,
        "description": "Company/customer name",
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
}
