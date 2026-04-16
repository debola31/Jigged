"""Import routes for operations CSV import with AI-powered mapping."""

import hashlib
import json
import logging
import os

import sentry_sdk
from pathlib import Path

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
    """Get one sample value per non-empty column."""
    samples: dict[str, str] = {}

    for row in sample_rows:
        for i, header in enumerate(headers):
            if header in samples:
                continue

            value = row[i].strip() if i < len(row) else ""
            if value:
                samples[header] = value

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
    """Analyze CSV headers and sample data to suggest column mappings for operations using AI."""
    cache_key = _get_cache_key(request.company_id, request.headers)
    cached = _get_cached_response(cache_key)
    if cached:
        return cached

    if not ai_rate_limiter.check(request.company_id):
        raise HTTPException(
            status_code=429,
            detail="Too many requests. Please wait before trying again.",
        )

    column_samples = _get_column_samples(
        headers=request.headers,
        sample_rows=request.sample_rows,
    )

    try:
        provider = await get_provider(supabase, request.company_id, "csv_mapping")

        suggestions = await provider.suggest_column_mappings(
            csv_headers=request.headers,
            sample_rows=request.sample_rows,
            target_schema=OPERATION_SCHEMA,
            column_samples=column_samples,
        )

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

        _save_to_cache(cache_key, response)

        return response

    except ValueError as e:
        sentry_sdk.capture_exception(e)
        raise HTTPException(status_code=500, detail=str(e))
    except Exception as e:
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
    """Validate operations CSV data before import."""
    try:
        operations_response = (
            supabase.table("operation_types")
            .select("id, name")
            .eq("company_id", request.company_id)
            .execute()
        )
        existing_operations = operations_response.data or []

        existing_operations_lookup: dict[str, dict] = {}
        for operation in existing_operations:
            key = operation["name"].lower()
            existing_operations_lookup[key] = operation

        reverse_mappings = {v: k for k, v in request.mappings.items()}
        name_column = reverse_mappings.get("name")
        labor_rate_column = reverse_mappings.get("labor_rate")

        name_occurrences: dict[str, list[int]] = {}

        for i, row in enumerate(request.rows):
            row_number = i + 1
            name = row.get(name_column, "").strip() if name_column else ""

            if name:
                name_key = name.lower()
                if name_key not in name_occurrences:
                    name_occurrences[name_key] = []
                name_occurrences[name_key].append(row_number)

        csv_duplicates = {k: v for k, v in name_occurrences.items() if len(v) > 1}

        validation_errors: list[OperationValidationError] = []
        conflicts: list[OperationConflictInfo] = []
        validation_error_rows: set[int] = set()
        conflict_rows: set[int] = set()

        for i, row in enumerate(request.rows):
            row_number = i + 1
            name = row.get(name_column, "").strip() if name_column else ""

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

            if name_key in csv_duplicates:
                other_rows = [r for r in csv_duplicates[name_key] if r != row_number]
                if other_rows:
                    conflicts.append(
                        OperationConflictInfo(
                            row_number=row_number,
                            csv_name=name,
                            conflict_type="csv_duplicate",
                            existing_operation_id="",
                            existing_value=f"Duplicate in CSV at rows {', '.join(map(str, other_rows))}",
                        )
                    )
                    conflict_rows.add(row_number)
                    continue

            if name_key in existing_operations_lookup:
                existing = existing_operations_lookup[name_key]
                conflicts.append(
                    OperationConflictInfo(
                        row_number=row_number,
                        csv_name=name,
                        conflict_type="duplicate_name",
                        existing_operation_id=existing["id"],
                        existing_value=f"Operation '{name}' already exists",
                    )
                )
                conflict_rows.add(row_number)
                continue

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
    """Execute the operations import."""
    try:
        validate_response = await validate_import(
            OperationValidateRequest(
                company_id=request.company_id,
                mappings=request.mappings,
                rows=request.rows,
            ),
            supabase=supabase,
        )

        if validate_response.has_conflicts and not request.skip_conflicts:
            raise HTTPException(
                status_code=400,
                detail="Conflicts detected. Set skip_conflicts=true to import non-conflicting rows only.",
            )

        skip_row_numbers = {c.row_number for c in validate_response.conflicts}
        skip_row_numbers |= {e.row_number for e in validate_response.validation_errors}

        reverse_mappings = {v: k for k, v in request.mappings.items()}

        rows_to_insert = []
        errors: list[OperationImportError] = []
        skipped = 0

        for i, row in enumerate(request.rows):
            row_number = i + 1

            if row_number in skip_row_numbers:
                skipped += 1
                continue

            operation_data = {
                "company_id": request.company_id,
                "metadata": {},
            }

            for db_field in ["name", "description"]:
                csv_column = reverse_mappings.get(db_field)
                if csv_column and csv_column in row:
                    value = row[csv_column].strip()
                    if value and value.lower() != "undefined":
                        operation_data[db_field] = value

            labor_rate_column = reverse_mappings.get("labor_rate")
            if labor_rate_column and labor_rate_column in row:
                value = row[labor_rate_column].strip()
                if value:
                    try:
                        operation_data["labor_rate"] = round(float(value), 2)
                    except ValueError:
                        pass

            legacy_id_column = reverse_mappings.get("legacy_id")
            if legacy_id_column and legacy_id_column in row:
                value = row[legacy_id_column].strip()
                if value:
                    operation_data["metadata"]["legacy_id"] = value

            rows_to_insert.append(operation_data)

        imported_count = 0
        if rows_to_insert:
            try:
                response = (
                    supabase.table("operation_types").insert(rows_to_insert).execute()
                )
                imported_count = len(response.data) if response.data else 0
            except Exception as e:
                error_str = str(e)
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
