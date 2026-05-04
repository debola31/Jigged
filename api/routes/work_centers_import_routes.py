"""Import routes for Work Centers CSV import with AI-powered mapping.

Replaces the old operations import. A work center is either internal (runs
in the shop, has labor_rate) or external (vendor-performed; references a
vendor that must already exist in the company).
"""

import hashlib
import json
import logging
import os

import sentry_sdk
from pathlib import Path

from fastapi import APIRouter, HTTPException, Depends
from supabase import Client

from models.work_centers_import_models import (
    ColumnMapping,
    WorkCenterAnalyzeRequest,
    WorkCenterAnalyzeResponse,
    WorkCenterValidateRequest,
    WorkCenterValidateResponse,
    WorkCenterValidationError,
    WorkCenterConflictInfo,
    WorkCenterExecuteRequest,
    WorkCenterExecuteResponse,
    WorkCenterImportError,
    WORK_CENTER_SCHEMA,
)
from services.ai import get_provider
from utils.rate_limiter import RateLimiter

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/work-centers/import", tags=["work-centers-import"])

# Rate limiter: 10 AI calls per minute per company
ai_rate_limiter = RateLimiter(max_requests=10, window_seconds=60)

# Cache directory for AI responses (dev only - avoids repeated API calls)
CACHE_DIR = Path(__file__).parent.parent / ".cache" / "ai_responses" / "work_centers"
CACHE_ENABLED = os.getenv("AI_CACHE_ENABLED", "true").lower() == "true"


def _get_cache_key(company_id: str, headers: list[str]) -> str:
    """Generate a cache key from company_id and headers."""
    content = f"work_centers:{company_id}:{','.join(sorted(headers))}"
    return hashlib.md5(content.encode()).hexdigest()


def _get_cached_response(cache_key: str) -> WorkCenterAnalyzeResponse | None:
    """Try to get a cached response."""
    if not CACHE_ENABLED:
        return None

    cache_file = CACHE_DIR / f"{cache_key}.json"
    if cache_file.exists():
        try:
            with open(cache_file) as f:
                data = json.load(f)
            return WorkCenterAnalyzeResponse(**data)
        except Exception:
            return None
    return None


def _save_to_cache(cache_key: str, response: WorkCenterAnalyzeResponse) -> None:
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


def _normalize_kind(value: str) -> str:
    """Normalize a CSV kind value to 'internal' or 'external'.

    Falls back to 'internal' for empty values. Returns the raw lower-cased
    value for unrecognized inputs so the validator can flag them.
    """
    v = (value or "").strip().lower()
    if not v:
        return "internal"
    if v in ("internal", "in-house", "inhouse", "shop"):
        return "internal"
    if v in ("external", "outside", "outsource", "outsourced", "vendor"):
        return "external"
    return v


def get_supabase() -> Client:
    """Get Supabase client from the main app."""
    from index import supabase

    if not supabase:
        raise HTTPException(
            status_code=500,
            detail="Supabase client not initialized",
        )
    return supabase


@router.post("/analyze", response_model=WorkCenterAnalyzeResponse)
async def analyze_csv(
    request: WorkCenterAnalyzeRequest,
    supabase: Client = Depends(get_supabase),
):
    """Analyze CSV headers and sample data to suggest column mappings for work centers."""
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
            target_schema=WORK_CENTER_SCHEMA,
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
            field for field, info in WORK_CENTER_SCHEMA.items() if info.get("required")
        ]
        unmapped_required = [f for f in required_fields if f not in mapped_db_fields]

        response = WorkCenterAnalyzeResponse(
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


@router.post("/validate", response_model=WorkCenterValidateResponse)
async def validate_import(
    request: WorkCenterValidateRequest,
    supabase: Client = Depends(get_supabase),
):
    """Validate work centers CSV data before import."""
    try:
        wc_response = (
            supabase.table("work_centers")
            .select("id, name")
            .eq("company_id", request.company_id)
            .execute()
        )
        existing_wcs = wc_response.data or []
        existing_wcs_lookup = {
            wc["name"].lower(): wc for wc in existing_wcs if wc.get("name")
        }

        vendors_response = (
            supabase.table("vendors")
            .select("id, name")
            .eq("company_id", request.company_id)
            .execute()
        )
        existing_vendors = vendors_response.data or []
        vendor_name_to_id = {
            v["name"].lower(): v["id"] for v in existing_vendors
        }

        reverse_mappings = {v: k for k, v in request.mappings.items()}
        name_column = reverse_mappings.get("name")
        kind_column = reverse_mappings.get("kind")
        vendor_column = reverse_mappings.get("vendor_name")
        labor_rate_column = reverse_mappings.get("labor_rate")

        # First pass: name occurrences for CSV duplicate detection
        name_occurrences: dict[str, list[int]] = {}
        for i, row in enumerate(request.rows):
            row_number = i + 1
            name = row.get(name_column, "").strip() if name_column else ""
            if name:
                name_occurrences.setdefault(name.lower(), []).append(row_number)

        csv_duplicates = {k: v for k, v in name_occurrences.items() if len(v) > 1}

        validation_errors: list[WorkCenterValidationError] = []
        conflicts: list[WorkCenterConflictInfo] = []
        validation_error_rows: set[int] = set()
        conflict_rows: set[int] = set()

        for i, row in enumerate(request.rows):
            row_number = i + 1
            name = row.get(name_column, "").strip() if name_column else ""

            if not name:
                validation_errors.append(
                    WorkCenterValidationError(
                        row_number=row_number,
                        error_type="missing_name",
                        field="name",
                        message="Work center name is required",
                    )
                )
                validation_error_rows.add(row_number)
                continue

            kind_raw = row.get(kind_column, "").strip() if kind_column else ""
            kind = _normalize_kind(kind_raw)
            if kind not in ("internal", "external"):
                validation_errors.append(
                    WorkCenterValidationError(
                        row_number=row_number,
                        error_type="invalid_kind",
                        field="kind",
                        message=f"kind must be 'internal' or 'external' (got '{kind_raw}')",
                    )
                )
                validation_error_rows.add(row_number)
                continue

            vendor_name = (
                row.get(vendor_column, "").strip() if vendor_column else ""
            )

            if kind == "external":
                if not vendor_name:
                    validation_errors.append(
                        WorkCenterValidationError(
                            row_number=row_number,
                            error_type="vendor_required_for_external",
                            field="vendor_name",
                            message="vendor_name is required when kind='external'",
                        )
                    )
                    validation_error_rows.add(row_number)
                    continue
                if vendor_name.lower() not in vendor_name_to_id:
                    conflicts.append(
                        WorkCenterConflictInfo(
                            row_number=row_number,
                            csv_name=name,
                            conflict_type="unknown_vendor",
                            existing_work_center_id="",
                            existing_value=f"Vendor '{vendor_name}' not found. Import vendors first.",
                        )
                    )
                    conflict_rows.add(row_number)
                    continue
            else:  # internal
                if vendor_name:
                    validation_errors.append(
                        WorkCenterValidationError(
                            row_number=row_number,
                            error_type="vendor_forbidden_for_internal",
                            field="vendor_name",
                            message="vendor_name must be empty when kind='internal'",
                        )
                    )
                    validation_error_rows.add(row_number)
                    continue

            # Numeric validation: labor_rate
            if labor_rate_column:
                rate_str = row.get(labor_rate_column, "").strip()
                if rate_str:
                    try:
                        rate = float(rate_str)
                        if rate < 0:
                            raise ValueError("negative")
                    except ValueError:
                        validation_errors.append(
                            WorkCenterValidationError(
                                row_number=row_number,
                                error_type="invalid_rate",
                                field="labor_rate",
                                message=f"Invalid labor rate: '{rate_str}'",
                            )
                        )
                        validation_error_rows.add(row_number)
                        continue

            # CSV duplicate
            name_key = name.lower()
            if name_key in csv_duplicates:
                other_rows = [r for r in csv_duplicates[name_key] if r != row_number]
                if other_rows:
                    conflicts.append(
                        WorkCenterConflictInfo(
                            row_number=row_number,
                            csv_name=name,
                            conflict_type="csv_duplicate",
                            existing_work_center_id="",
                            existing_value=f"Duplicate in CSV at rows {', '.join(map(str, other_rows))}",
                        )
                    )
                    conflict_rows.add(row_number)
                    continue

            # Existing DB collision
            if name_key in existing_wcs_lookup:
                existing = existing_wcs_lookup[name_key]
                conflicts.append(
                    WorkCenterConflictInfo(
                        row_number=row_number,
                        csv_name=name,
                        conflict_type="duplicate_name",
                        existing_work_center_id=existing["id"],
                        existing_value=f"Work center '{name}' already exists",
                    )
                )
                conflict_rows.add(row_number)
                continue

        total_skipped = conflict_rows | validation_error_rows
        valid_rows = len(request.rows) - len(total_skipped)

        return WorkCenterValidateResponse(
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


@router.post("/execute", response_model=WorkCenterExecuteResponse)
async def execute_import(
    request: WorkCenterExecuteRequest,
    supabase: Client = Depends(get_supabase),
):
    """Execute the work centers import."""
    try:
        validate_response = await validate_import(
            WorkCenterValidateRequest(
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

        # Vendor lookup for execute-time resolution
        vendors_response = (
            supabase.table("vendors")
            .select("id, name")
            .eq("company_id", request.company_id)
            .execute()
        )
        vendor_name_to_id = {
            v["name"].lower(): v["id"] for v in (vendors_response.data or [])
        }

        reverse_mappings = {v: k for k, v in request.mappings.items()}
        name_column = reverse_mappings.get("name")
        kind_column = reverse_mappings.get("kind")
        vendor_column = reverse_mappings.get("vendor_name")
        labor_rate_column = reverse_mappings.get("labor_rate")
        description_column = reverse_mappings.get("description")
        legacy_id_column = reverse_mappings.get("legacy_id")

        rows_to_insert: list[dict] = []
        rows_to_upsert: list[dict] = []
        errors: list[WorkCenterImportError] = []
        skipped = 0

        for i, row in enumerate(request.rows):
            row_number = i + 1

            if row_number in skip_row_numbers:
                skipped += 1
                continue

            name = row.get(name_column, "").strip() if name_column else ""
            kind = _normalize_kind(
                row.get(kind_column, "").strip() if kind_column else ""
            )

            wc_data: dict = {
                "company_id": request.company_id,
                "name": name,
                "kind": kind,
                "metadata": {},
            }

            if description_column:
                value = row.get(description_column, "").strip()
                if value and value.lower() != "undefined":
                    wc_data["description"] = value

            if kind == "external":
                vendor_name = (
                    row.get(vendor_column, "").strip() if vendor_column else ""
                )
                vendor_id = vendor_name_to_id.get(vendor_name.lower())
                if not vendor_id:
                    # Defense-in-depth — validate already filtered this case
                    errors.append(
                        WorkCenterImportError(
                            row_number=row_number,
                            reason=f"Vendor '{vendor_name}' not found at execute time",
                            data={k: v for k, v in row.items() if v},
                        )
                    )
                    skipped += 1
                    continue
                wc_data["vendor_id"] = vendor_id
            else:
                # External-only constraint — internal must have NULL vendor
                wc_data["vendor_id"] = None
                if labor_rate_column:
                    rate_str = row.get(labor_rate_column, "").strip()
                    if rate_str:
                        try:
                            wc_data["labor_rate"] = round(float(rate_str), 2)
                        except ValueError:
                            pass

            legacy_id_val = (
                row.get(legacy_id_column, "").strip() if legacy_id_column else ""
            )
            if legacy_id_val:
                wc_data["metadata"]["legacy_id"] = legacy_id_val

            rows_to_insert.append(wc_data)

        BATCH_SIZE = 500
        imported_count = 0
        if rows_to_insert:
            try:
                total = len(rows_to_insert)
                for batch_start in range(0, total, BATCH_SIZE):
                    batch = rows_to_insert[batch_start : batch_start + BATCH_SIZE]
                    response = supabase.table("work_centers").insert(batch).execute()
                    imported_count += len(response.data) if response.data else 0
            except Exception as e:
                error_str = str(e)
                if "23505" in error_str or "duplicate key" in error_str.lower():
                    raise HTTPException(
                        status_code=400,
                        detail="Import failed: A work center with this name already exists.",
                    )
                sentry_sdk.capture_exception(e)
                raise HTTPException(
                    status_code=500,
                    detail="Internal server error",
                )

        return WorkCenterExecuteResponse(
            success=True,
            imported_count=imported_count,
            updated_count=0,
            skipped_count=skipped,
            errors=errors,
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Work centers import execution error: {str(e)}", exc_info=True)
        sentry_sdk.capture_exception(e)
        raise HTTPException(
            status_code=500,
            detail="Internal server error",
        )
