"""Import routes for operations CSV import with AI-powered mapping."""

import hashlib
import json
import logging
import os

import sentry_sdk
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException, Depends
from supabase import Client

from models.operations_import_models import (
    ColumnMapping,
    OperationAnalyzeRequest,
    OperationAnalyzeResponse,
    OperationValidateRequest,
    OperationValidateResponse,
    OperationValidationError,
    OperationConflictInfo,
    OperationExecuteRequest,
    OperationExecuteResponse,
    OperationImportError,
    OPERATION_SCHEMA,
)
from services.ai import get_provider
from utils.rate_limiter import RateLimiter

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/operations/import", tags=["operations-import"])

# Rate limiter: 10 AI calls per minute per company
ai_rate_limiter = RateLimiter(max_requests=10, window_seconds=60)

# Cache directory for AI responses (dev only - avoids repeated API calls)
CACHE_DIR = Path(__file__).parent.parent / ".cache" / "ai_responses" / "operations"
CACHE_ENABLED = os.getenv("AI_CACHE_ENABLED", "true").lower() == "true"


def _get_cache_key(company_id: str, headers: list[str]) -> str:
    """Generate a cache key from company_id and headers."""
    content = f"operations:{company_id}:{','.join(sorted(headers))}"
    return hashlib.md5(content.encode()).hexdigest()


def _get_cached_response(cache_key: str) -> OperationAnalyzeResponse | None:
    """Try to get a cached response."""
    if not CACHE_ENABLED:
        return None

    cache_file = CACHE_DIR / f"{cache_key}.json"
    if cache_file.exists():
        try:
            with open(cache_file) as f:
                data = json.load(f)
            return OperationAnalyzeResponse(**data)
        except Exception:
            return None
    return None


def _save_to_cache(cache_key: str, response: OperationAnalyzeResponse) -> None:
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
    """
    samples: dict[str, str] = {}

    for row in sample_rows:
        for i, header in enumerate(headers):
            # Skip if we already have a sample
            if header in samples:
                continue

            # Get value if exists and is non-empty
            value = row[i].strip() if i < len(row) else ""
            if value:
                samples[header] = value

        # Early exit if we have samples for all columns
        if len(samples) >= len(headers):
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


@router.post("/analyze", response_model=OperationAnalyzeResponse)
async def analyze_csv(
    request: OperationAnalyzeRequest,
    supabase: Client = Depends(get_supabase),
):
    """
    Analyze CSV headers and sample data to suggest column mappings for operations using AI.

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

        # Get AI suggestions for all columns
        suggestions = await provider.suggest_column_mappings(
            csv_headers=request.headers,
            sample_rows=request.sample_rows,
            target_schema=OPERATION_SCHEMA,
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
            field for field, info in OPERATION_SCHEMA.items() if info.get("required")
        ]
        unmapped_required = [f for f in required_fields if f not in mapped_db_fields]

        response = OperationAnalyzeResponse(
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


@router.post("/validate", response_model=OperationValidateResponse)
async def validate_import(
    request: OperationValidateRequest,
    supabase: Client = Depends(get_supabase),
):
    """
    Validate operations CSV data before import.

    Checks:
    - Operation name uniqueness per company
    - Labor rate validity (if provided)
    - Required fields presence
    """
    try:
        # Get existing operations for this company
        operations_response = (
            supabase.table("operation_types")
            .select("id, name")
            .eq("company_id", request.company_id)
            .execute()
        )
        existing_operations = operations_response.data or []

        # Build lookup: name_lower -> operation
        existing_operations_lookup: dict[str, dict] = {}
        for operation in existing_operations:
            key = operation["name"].lower()
            existing_operations_lookup[key] = operation

        # Get existing groups for this company
        groups_response = (
            supabase.table("resource_groups")
            .select("id, name")
            .eq("company_id", request.company_id)
            .execute()
        )
        existing_groups = groups_response.data or []
        existing_group_names = {g["name"].lower() for g in existing_groups}

        # Find column mappings
        reverse_mappings = {v: k for k, v in request.mappings.items()}
        name_column = reverse_mappings.get("name")
        resource_group_column = reverse_mappings.get("resource_group")
        labor_rate_column = reverse_mappings.get("labor_rate")

        # First pass: track name occurrences for CSV duplicate detection
        name_occurrences: dict[str, list[int]] = {}

        for i, row in enumerate(request.rows):
            row_number = i + 1
            name = row.get(name_column, "").strip() if name_column else ""

            if name:
                name_key = name.lower()
                if name_key not in name_occurrences:
                    name_occurrences[name_key] = []
                name_occurrences[name_key].append(row_number)

        # Find duplicates within CSV
        csv_duplicates = {k: v for k, v in name_occurrences.items() if len(v) > 1}

        # Track groups to create
        groups_to_create: set[str] = set()

        # Second pass: validate each row
        validation_errors: list[OperationValidationError] = []
        conflicts: list[OperationConflictInfo] = []
        validation_error_rows: set[int] = set()
        conflict_rows: set[int] = set()

        for i, row in enumerate(request.rows):
            row_number = i + 1
            name = row.get(name_column, "").strip() if name_column else ""
            resource_group = (
                row.get(resource_group_column, "").strip()
                if resource_group_column
                else ""
            )

            # Check required field: name
            if not name:
                validation_errors.append(
                    OperationValidationError(
                        row_number=row_number,
                        error_type="missing_name",
                        field="name",
                        message="Operation name is required",
                    )
                )
                validation_error_rows.add(row_number)
                continue

            name_key = name.lower()

            # Check for CSV duplicates
            if name_key in csv_duplicates:
                other_rows = [r for r in csv_duplicates[name_key] if r != row_number]
                if other_rows:  # Don't flag if this is the first occurrence
                    conflicts.append(
                        OperationConflictInfo(
                            row_number=row_number,
                            csv_name=name,
                            csv_resource_group=resource_group,
                            conflict_type="csv_duplicate",
                            existing_operation_id="",
                            existing_value=f"Duplicate in CSV at rows {', '.join(map(str, other_rows))}",
                        )
                    )
                    conflict_rows.add(row_number)
                    continue

            # Check for existing operation with same name
            if name_key in existing_operations_lookup:
                existing = existing_operations_lookup[name_key]
                conflicts.append(
                    OperationConflictInfo(
                        row_number=row_number,
                        csv_name=name,
                        csv_resource_group=resource_group,
                        conflict_type="duplicate_name",
                        existing_operation_id=existing["id"],
                        existing_value=f"Operation '{name}' already exists",
                    )
                )
                conflict_rows.add(row_number)
                continue

            # Validate labor_rate if provided
            if labor_rate_column:
                labor_rate_str = row.get(labor_rate_column, "").strip()
                if labor_rate_str:
                    try:
                        labor_rate = float(labor_rate_str)
                        if labor_rate < 0:
                            validation_errors.append(
                                OperationValidationError(
                                    row_number=row_number,
                                    error_type="invalid_rate",
                                    field="labor_rate",
                                    message="Labor rate cannot be negative",
                                )
                            )
                            validation_error_rows.add(row_number)
                            continue
                    except ValueError:
                        validation_errors.append(
                            OperationValidationError(
                                row_number=row_number,
                                error_type="invalid_rate",
                                field="labor_rate",
                                message=f"Invalid labor rate: '{labor_rate_str}'",
                            )
                        )
                        validation_error_rows.add(row_number)
                        continue

            # Track groups to create
            if resource_group and request.create_groups:
                if resource_group.lower() not in existing_group_names:
                    groups_to_create.add(resource_group)

        # Calculate counts
        total_skipped = conflict_rows | validation_error_rows
        valid_rows = len(request.rows) - len(total_skipped)

        return OperationValidateResponse(
            has_conflicts=len(conflicts) > 0,
            conflicts=conflicts,
            validation_errors=validation_errors,
            valid_rows_count=valid_rows,
            conflict_rows_count=len(conflict_rows),
            error_rows_count=len(validation_error_rows),
            skipped_rows_count=len(total_skipped),
            groups_to_create=sorted(groups_to_create),
        )

    except HTTPException:
        raise
    except Exception as e:
        sentry_sdk.capture_exception(e)
        raise HTTPException(
            status_code=500,
            detail="Internal server error",
        )


@router.post("/execute", response_model=OperationExecuteResponse)
async def execute_import(
    request: OperationExecuteRequest,
    supabase: Client = Depends(get_supabase),
):
    """
    Execute the operations import.

    If skip_conflicts is True, only imports rows without conflicts.
    Otherwise, fails if any conflicts exist.

    If create_groups is True, auto-creates resource groups from data.
    """
    try:
        # First validate to get conflict info
        validate_response = await validate_import(
            OperationValidateRequest(
                company_id=request.company_id,
                mappings=request.mappings,
                rows=request.rows,
                create_groups=request.create_groups,
            ),
            supabase=supabase,
        )

        # If conflicts exist and we're not skipping them, fail
        if validate_response.has_conflicts and not request.skip_conflicts:
            raise HTTPException(
                status_code=400,
                detail="Conflicts detected. Set skip_conflicts=true to import non-conflicting rows only.",
            )

        # Build set of rows to skip
        skip_row_numbers = {c.row_number for c in validate_response.conflicts}
        skip_row_numbers |= {e.row_number for e in validate_response.validation_errors}

        # Create groups if needed
        groups_created = 0
        group_name_to_id: dict[str, str] = {}

        if request.create_groups and validate_response.groups_to_create:
            for group_name in validate_response.groups_to_create:
                try:
                    result = (
                        supabase.table("resource_groups")
                        .insert(
                            {
                                "company_id": request.company_id,
                                "name": group_name,
                                "display_order": 0,
                            }
                        )
                        .execute()
                    )
                    if result.data:
                        group_name_to_id[group_name.lower()] = result.data[0]["id"]
                        groups_created += 1
                except Exception as e:
                    logger.warning(f"Failed to create group '{group_name}': {e}")

        # Get existing groups for ID lookup
        groups_response = (
            supabase.table("resource_groups")
            .select("id, name")
            .eq("company_id", request.company_id)
            .execute()
        )
        for group in groups_response.data or []:
            group_name_to_id[group["name"].lower()] = group["id"]

        # Find column mappings
        reverse_mappings = {v: k for k, v in request.mappings.items()}

        # Prepare rows for insertion
        rows_to_insert = []
        errors: list[OperationImportError] = []
        skipped = 0

        for i, row in enumerate(request.rows):
            row_number = i + 1

            # Skip rows that failed validation or have conflicts
            if row_number in skip_row_numbers:
                skipped += 1
                continue

            # Build operation record
            operation_data = {
                "company_id": request.company_id,
                "metadata": {},
            }

            # Map standard fields
            for db_field in ["name", "description"]:
                csv_column = reverse_mappings.get(db_field)
                if csv_column and csv_column in row:
                    value = row[csv_column].strip()
                    # Filter out empty values and literal "undefined" string from frontend
                    if value and value.lower() != "undefined":
                        operation_data[db_field] = value

            # Handle labor_rate (numeric)
            labor_rate_column = reverse_mappings.get("labor_rate")
            if labor_rate_column and labor_rate_column in row:
                value = row[labor_rate_column].strip()
                if value:
                    try:
                        operation_data["labor_rate"] = round(float(value), 2)
                    except ValueError:
                        pass  # Skip invalid values (should be caught in validation)

            # Handle resource_group (lookup ID)
            resource_group_column = reverse_mappings.get("resource_group")
            if resource_group_column and resource_group_column in row:
                group_name = row[resource_group_column].strip()
                if group_name:
                    group_id = group_name_to_id.get(group_name.lower())
                    if group_id:
                        operation_data["resource_group_id"] = group_id

            # Handle legacy_id (store in metadata)
            legacy_id_column = reverse_mappings.get("legacy_id")
            if legacy_id_column and legacy_id_column in row:
                value = row[legacy_id_column].strip()
                if value:
                    operation_data["metadata"]["legacy_id"] = value

            rows_to_insert.append(operation_data)

        # Bulk insert
        imported_count = 0
        if rows_to_insert:
            try:
                response = (
                    supabase.table("operation_types").insert(rows_to_insert).execute()
                )
                imported_count = len(response.data) if response.data else 0
            except Exception as e:
                error_str = str(e)
                # Check for unique constraint violation
                if "23505" in error_str or "duplicate key" in error_str.lower():
                    raise HTTPException(
                        status_code=400,
                        detail="Import failed: An operation with this name already exists. Please check your CSV for duplicate names.",
                    )
                sentry_sdk.capture_exception(e)
                raise HTTPException(
                    status_code=500,
                    detail="Internal server error",
                )

        return OperationExecuteResponse(
            success=True,
            imported_count=imported_count,
            skipped_count=skipped,
            groups_created=groups_created,
            errors=errors,
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Operations import execution error: {str(e)}", exc_info=True)
        sentry_sdk.capture_exception(e)
        raise HTTPException(
            status_code=500,
            detail="Internal server error",
        )
