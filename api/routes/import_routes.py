"""Import routes for customer CSV import with AI-powered mapping."""

import hashlib
import json
import logging
import os

import sentry_sdk
from pathlib import Path

from fastapi import APIRouter, HTTPException, Depends
from supabase import Client

from models.import_models import (
    AnalyzeRequest,
    AnalyzeResponse,
    ColumnMapping,
    ValidateRequest,
    ValidateResponse,
    ValidationError,
    ConflictInfo,
    ExecuteRequest,
    ExecuteResponse,
    ImportError,
    CUSTOMER_SCHEMA,
)
from services.ai import get_provider
from utils.rate_limiter import RateLimiter

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/customers/import", tags=["import"])

# Rate limiter: 10 AI calls per minute per company
ai_rate_limiter = RateLimiter(max_requests=10, window_seconds=60)


# Cache directory for AI responses (dev only - avoids repeated API calls)
CACHE_DIR = Path(__file__).parent.parent / ".cache" / "ai_responses"
CACHE_ENABLED = os.getenv("AI_CACHE_ENABLED", "true").lower() == "true"


def _get_cache_key(company_id: str, headers: list[str]) -> str:
    """Generate a cache key from company_id and headers."""
    content = f"{company_id}:{','.join(sorted(headers))}"
    return hashlib.md5(content.encode()).hexdigest()


def _get_cached_response(cache_key: str) -> AnalyzeResponse | None:
    """Try to get a cached response."""
    if not CACHE_ENABLED:
        return None

    cache_file = CACHE_DIR / f"{cache_key}.json"
    if cache_file.exists():
        try:
            with open(cache_file) as f:
                data = json.load(f)
            return AnalyzeResponse(**data)
        except Exception:
            return None
    return None


def _save_to_cache(cache_key: str, response: AnalyzeResponse) -> None:
    """Save response to cache."""
    if not CACHE_ENABLED:
        return

    try:
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        cache_file = CACHE_DIR / f"{cache_key}.json"
        with open(cache_file, "w") as f:
            json.dump(response.model_dump(), f, indent=2)
    except Exception:
        pass  # Silently fail cache writes


def _get_column_samples(
    headers: list[str],
    sample_rows: list[list[str]],
) -> dict[str, str]:
    """Get one sample value per non-empty column.

    Efficiently collects the first non-empty value found for each column.
    This minimizes token usage while giving AI context about data format.

    Args:
        headers: All column headers
        sample_rows: First 5 rows of sample data

    Returns:
        Dict mapping column name to one sample value (non-empty columns only)
    """
    samples: dict[str, str] = {}

    for row in sample_rows:
        for i, header in enumerate(headers):
            # Skip if we already have a sample for this column
            if header in samples:
                continue

            # Get value if exists and is non-empty
            value = row[i].strip() if i < len(row) else ""
            if value:
                samples[header] = value

        # Early exit if we have samples for all columns
        if len(samples) == len(headers):
            break

    return samples


def get_supabase() -> Client:
    """Get Supabase client from the main app."""
    from index import supabase

    if not supabase:
        raise HTTPException(
            status_code=500,
            detail="Supabase client not initialized",
        )
    return supabase


@router.post("/analyze", response_model=AnalyzeResponse)
async def analyze_csv(
    request: AnalyzeRequest,
    supabase: Client = Depends(get_supabase),
):
    """
    Analyze CSV headers and sample data to suggest column mappings using AI.

    This endpoint sends the CSV structure to an AI provider configured for the
    company and returns suggested mappings with confidence scores.

    Caching: Responses are cached by company_id + headers to avoid repeated
    API calls during development. Set AI_CACHE_ENABLED=false to disable.
    """
    # Check cache first
    cache_key = _get_cache_key(request.company_id, request.headers)
    cached = _get_cached_response(cache_key)
    if cached:
        return cached

    # Rate limiting
    if not ai_rate_limiter.check(request.company_id):
        raise HTTPException(
            status_code=429,
            detail="Too many requests. Please wait before trying again.",
        )

    # Get sample values for non-empty columns (efficient token usage)
    column_samples = _get_column_samples(
        headers=request.headers,
        sample_rows=request.sample_rows,
    )

    try:
        # Get the configured AI provider for this company
        provider = await get_provider(supabase, request.company_id, "csv_mapping")

        # Get AI suggestions for ALL columns, with sample data for non-empty ones
        suggestions = await provider.suggest_column_mappings(
            csv_headers=request.headers,
            sample_rows=request.sample_rows,
            target_schema=CUSTOMER_SCHEMA,
            column_samples=column_samples,
        )

        # Convert to response format
        mappings = []
        discarded_columns = []
        mapped_db_fields = set()

        for suggestion in suggestions:
            needs_review = suggestion.confidence < 0.7

            if suggestion.db_field is None:
                discarded_columns.append(suggestion.csv_column)
            else:
                mapped_db_fields.add(suggestion.db_field)

            mappings.append(
                ColumnMapping(
                    csv_column=suggestion.csv_column,
                    db_field=suggestion.db_field,
                    confidence=suggestion.confidence,
                    reasoning=suggestion.reasoning,
                    needs_review=needs_review,
                )
            )

        # Check for unmapped required fields
        required_fields = [
            field for field, info in CUSTOMER_SCHEMA.items() if info.get("required")
        ]
        unmapped_required = [f for f in required_fields if f not in mapped_db_fields]

        response = AnalyzeResponse(
            mappings=mappings,
            unmapped_required=unmapped_required,
            discarded_columns=discarded_columns,
            ai_provider=provider.provider_name,
        )

        # Save to cache for future requests
        _save_to_cache(cache_key, response)

        return response

    except ValueError as e:
        # AI provider configuration error
        sentry_sdk.capture_exception(e)
        raise HTTPException(status_code=500, detail="Internal server error")
    except Exception as e:
        # Unexpected error
        sentry_sdk.capture_exception(e)
        raise HTTPException(
            status_code=500,
            detail="Internal server error",
        )


@router.post("/validate", response_model=ValidateResponse)
async def validate_import(
    request: ValidateRequest,
    supabase: Client = Depends(get_supabase),
):
    """
    Validate CSV data before import by checking for conflicts.

    Checks for duplicate name against existing records.
    Returns detailed conflict information so user can decide how to proceed.
    """
    try:
        # Get existing customers for this company
        response = (
            supabase.table("customers")
            .select("id, name")
            .eq("company_id", request.company_id)
            .execute()
        )
        existing_customers = response.data or []

        # Build lookup sets for quick conflict detection
        existing_names = {c["name"].lower(): c for c in existing_customers}

        # Find the column mapping for name
        name_column = None
        for csv_col, db_field in request.mappings.items():
            if db_field == "name":
                name_column = csv_col

        # First pass: identify ALL values that appear more than once in CSV
        # Track name -> list of row numbers
        name_occurrences: dict[str, list[int]] = {}

        for i, row in enumerate(request.rows):
            row_number = i + 1
            csv_name = row.get(name_column, "").strip() if name_column else ""

            if csv_name:
                name_lower = csv_name.lower()
                if name_lower not in name_occurrences:
                    name_occurrences[name_lower] = []
                name_occurrences[name_lower].append(row_number)

        # Find duplicate names (values that appear more than once)
        duplicate_names = {k: v for k, v in name_occurrences.items() if len(v) > 1}

        # Build reverse mappings for validation
        reverse_mappings = {v: k for k, v in request.mappings.items()}

        # Validate required fields FIRST
        validation_errors = []
        validation_error_row_set: set[int] = set()

        for i, row in enumerate(request.rows):
            row_number = i + 1

            # Build customer data to check required fields
            customer_data = {}
            for db_field in CUSTOMER_SCHEMA.keys():
                csv_column = reverse_mappings.get(db_field)
                if csv_column and csv_column in row:
                    value = row[csv_column].strip()
                    # Filter out empty values and literal "undefined" string from frontend
                    if value and value.lower() != "undefined":
                        customer_data[db_field] = value

            # Check required fields
            if not customer_data.get("name"):
                validation_errors.append(
                    ValidationError(
                        row_number=row_number,
                        error_type="missing_name",
                        field="name",
                    )
                )
                validation_error_row_set.add(row_number)
                continue

        # Second pass: flag ALL rows with conflicts
        conflicts = []
        conflict_row_set: set[int] = set()

        for i, row in enumerate(request.rows):
            row_number = i + 1

            # Skip rows with validation errors
            if row_number in validation_error_row_set:
                continue

            csv_name = row.get(name_column, "").strip() if name_column else ""

            # Check for duplicate name within CSV (all occurrences)
            if csv_name:
                name_lower = csv_name.lower()
                if name_lower in duplicate_names:
                    other_rows = [r for r in duplicate_names[name_lower] if r != row_number]
                    conflicts.append(
                        ConflictInfo(
                            row_number=row_number,
                            csv_name=csv_name,
                            conflict_type="csv_duplicate_name",
                            existing_customer_id="",
                            existing_value=f"Rows {', '.join(map(str, other_rows))}",
                        )
                    )
                    conflict_row_set.add(row_number)
                    continue  # Skip other checks for this row

            # Check for duplicate name against existing DB records
            if csv_name and csv_name.lower() in existing_names:
                existing = existing_names[csv_name.lower()]
                conflicts.append(
                    ConflictInfo(
                        row_number=row_number,
                        csv_name=csv_name,
                        conflict_type="duplicate_name",
                        existing_customer_id=existing["id"],
                        existing_value=existing["name"],
                    )
                )
                conflict_row_set.add(row_number)

        # Calculate final counts
        total_skipped_row_set = conflict_row_set | validation_error_row_set  # Union
        valid_rows = len(request.rows) - len(total_skipped_row_set)

        return ValidateResponse(
            has_conflicts=len(conflicts) > 0,
            conflicts=conflicts,
            validation_errors=validation_errors,
            valid_rows_count=valid_rows,
            conflict_rows_count=len(conflict_row_set),
            error_rows_count=len(validation_error_row_set),
            skipped_rows_count=len(total_skipped_row_set),
        )

    except Exception as e:
        sentry_sdk.capture_exception(e)
        raise HTTPException(
            status_code=500,
            detail="Internal server error",
        )


@router.post("/execute", response_model=ExecuteResponse)
async def execute_import(
    request: ExecuteRequest,
    supabase: Client = Depends(get_supabase),
):
    """
    Execute the customer import.

    If skip_conflicts is True, only imports rows without conflicts.
    Otherwise, fails if any conflicts exist.
    """
    try:
        # First validate to get conflict info
        validate_response = await validate_import(
            ValidateRequest(
                company_id=request.company_id,
                mappings=request.mappings,
                rows=request.rows,
            ),
            supabase=supabase,
        )

        # If conflicts exist and we're not skipping them, fail
        if validate_response.has_conflicts and not request.skip_conflicts:
            raise HTTPException(
                status_code=400,
                detail="Conflicts detected. Set skip_conflicts=true to import non-conflicting rows only.",
            )

        # Build combined set of rows to skip (conflicts + validation errors)
        skip_row_numbers = {c.row_number for c in validate_response.conflicts}
        skip_row_numbers |= {e.row_number for e in validate_response.validation_errors}

        # Find column mappings
        reverse_mappings = {v: k for k, v in request.mappings.items()}

        # Prepare rows for insertion
        rows_to_insert = []
        errors = []
        skipped = 0

        for i, row in enumerate(request.rows):
            row_number = i + 1

            # Skip rows that failed validation or have conflicts
            if row_number in skip_row_numbers:
                skipped += 1
                continue

            # Build customer record
            customer_data = {
                "company_id": request.company_id,
            }

            for db_field in CUSTOMER_SCHEMA.keys():
                csv_column = reverse_mappings.get(db_field)
                if csv_column and csv_column in row:
                    value = row[csv_column].strip()
                    # Filter out empty values and literal "undefined" string from frontend
                    if value and value.lower() != "undefined":
                        customer_data[db_field] = value

            # Set default country if not provided
            if "country" not in customer_data or not customer_data.get("country"):
                customer_data["country"] = "USA"

            # Trust validation already checked required fields
            rows_to_insert.append(customer_data)

        # Bulk insert
        imported_count = 0
        if rows_to_insert:
            try:
                response = supabase.table("customers").insert(rows_to_insert).execute()
                imported_count = len(response.data) if response.data else 0
            except Exception as e:
                error_str = str(e)
                # Check for PostgreSQL unique constraint violation (code 23505)
                if "23505" in error_str or "duplicate key" in error_str.lower():
                    # Parse which constraint was violated
                    if "name" in error_str.lower():
                        raise HTTPException(
                            status_code=400,
                            detail="Import failed: A customer with this name already exists. Please check your CSV for duplicate company names.",
                        )
                    else:
                        raise HTTPException(
                            status_code=400,
                            detail="Import failed: Duplicate values detected. Please ensure all customer names are unique.",
                        )
                # Generic database error with sanitized message
                sentry_sdk.capture_exception(e)
                raise HTTPException(
                    status_code=500,
                    detail="Internal server error",
                )

        return ExecuteResponse(
            success=True,
            imported_count=imported_count,
            skipped_count=skipped,  # Now matches validation's skipped_rows_count
            errors=errors,  # Only unexpected DB errors
        )

    except HTTPException:
        raise
    except Exception as e:
        # Log the actual error for debugging
        logger.error(f"Import execution error: {str(e)}", exc_info=True)
        sentry_sdk.capture_exception(e)
        raise HTTPException(
            status_code=500,
            detail="Internal server error",
        )
