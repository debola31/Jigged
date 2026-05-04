"""Import routes for Vendors CSV import with AI-powered mapping.

A vendor is a first-class entity. Capabilities are derived from references
elsewhere (parts.preferred_vendor_id, work_centers.vendor_id), so this importer
carries no capability flags.

Adds a `proposed_merges` step between validate and execute: vendor names that
look like the same vendor (e.g. "PerformCoat of Michigan LL" vs "PerformCoat
of Michigan LLC") are surfaced for the user to confirm or reject. Confirmed
merges collapse the duplicate row into the canonical row at execute time.

NOTE: There is no `import_events` audit table in the current schema, so the
merge log is returned in the execute response only. (Spec called this out as
a conditional choice.) If an audit table is added later, the merge details
captured in the response payload can be persisted there.
"""

import hashlib
import json
import logging
import os
from difflib import SequenceMatcher

import sentry_sdk
from pathlib import Path

from fastapi import APIRouter, HTTPException, Depends
from supabase import Client

from models.vendors_import_models import (
    ColumnMapping,
    VendorAnalyzeRequest,
    VendorAnalyzeResponse,
    VendorValidateRequest,
    VendorValidateResponse,
    VendorValidationError,
    VendorConflictInfo,
    VendorMergeProposal,
    VendorExecuteRequest,
    VendorExecuteResponse,
    VendorImportError,
    VENDOR_SCHEMA,
)
from services.ai import get_provider
from utils.rate_limiter import RateLimiter

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/vendors/import", tags=["vendors-import"])

# Rate limiter: 10 AI calls per minute per company
ai_rate_limiter = RateLimiter(max_requests=10, window_seconds=60)

# Cache directory for AI responses (dev only - avoids repeated API calls)
CACHE_DIR = Path(__file__).parent.parent / ".cache" / "ai_responses" / "vendors"
CACHE_ENABLED = os.getenv("AI_CACHE_ENABLED", "true").lower() == "true"

# Merge proposal threshold. SequenceMatcher.ratio() returns 0..1; values above
# 0.85 catch typos and "LL" vs "LLC"-style truncations without flagging "Smith
# Co" vs "Smith Inc" pairs that may legitimately be different companies.
MERGE_RATIO_THRESHOLD = 0.85


def _get_cache_key(company_id: str, headers: list[str]) -> str:
    """Generate a cache key from company_id and headers."""
    content = f"vendors:{company_id}:{','.join(sorted(headers))}"
    return hashlib.md5(content.encode()).hexdigest()


def _get_cached_response(cache_key: str) -> VendorAnalyzeResponse | None:
    """Try to get a cached response."""
    if not CACHE_ENABLED:
        return None

    cache_file = CACHE_DIR / f"{cache_key}.json"
    if cache_file.exists():
        try:
            with open(cache_file) as f:
                data = json.load(f)
            return VendorAnalyzeResponse(**data)
        except Exception:
            return None
    return None


def _save_to_cache(cache_key: str, response: VendorAnalyzeResponse) -> None:
    """Save response to cache."""
    if not CACHE_ENABLED:
        return

    try:
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        cache_file = CACHE_DIR / f"{cache_key}.json"
        with open(cache_file, "w") as f:
            json.dump(response.model_dump(), f, indent=2)
    except Exception:
        pass


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


def _propose_merges(
    name_to_rows: dict[str, list[int]],
) -> list[VendorMergeProposal]:
    """Compute merge proposals across CSV vendor names.

    Combines two cheap heuristics:
      1. Common-prefix: if name A is a prefix of name B (case-insensitive,
         length difference < 6), propose merging A → B.
      2. SequenceMatcher.ratio() above MERGE_RATIO_THRESHOLD.

    The longer of the two names becomes the canonical `to_name` because legacy
    truncations almost always lose a suffix ("LLC" → "LL"), not gain one.
    """
    proposals: dict[tuple[str, str], VendorMergeProposal] = {}
    names = list(name_to_rows.keys())

    for i in range(len(names)):
        for j in range(i + 1, len(names)):
            a, b = names[i], names[j]
            if a == b:
                continue

            a_lower = a.lower()
            b_lower = b.lower()

            longer, shorter = (a, b) if len(a) >= len(b) else (b, a)
            longer_lower = longer.lower()
            shorter_lower = shorter.lower()

            # Heuristic 1: prefix match
            confidence = 0.0
            if longer_lower.startswith(shorter_lower) and (
                len(longer) - len(shorter)
            ) <= 6:
                confidence = 0.95
            else:
                # Heuristic 2: similarity ratio
                ratio = SequenceMatcher(None, a_lower, b_lower).ratio()
                if ratio >= MERGE_RATIO_THRESHOLD:
                    confidence = ratio

            if confidence > 0:
                from_name, to_name = shorter, longer
                key = (from_name, to_name)
                if key not in proposals:
                    proposals[key] = VendorMergeProposal(
                        from_name=from_name,
                        to_name=to_name,
                        from_csv_rows=name_to_rows.get(from_name, []),
                        confidence=round(confidence, 3),
                    )

    return sorted(
        proposals.values(),
        key=lambda p: (-p.confidence, p.from_name.lower()),
    )


def get_supabase() -> Client:
    """Get Supabase client from the main app."""
    from index import supabase

    if not supabase:
        raise HTTPException(
            status_code=500,
            detail="Supabase client not initialized",
        )
    return supabase


@router.post("/analyze", response_model=VendorAnalyzeResponse)
async def analyze_csv(
    request: VendorAnalyzeRequest,
    supabase: Client = Depends(get_supabase),
):
    """Analyze CSV headers and sample data to suggest column mappings for vendors."""
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
            target_schema=VENDOR_SCHEMA,
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
            field for field, info in VENDOR_SCHEMA.items() if info.get("required")
        ]
        unmapped_required = [f for f in required_fields if f not in mapped_db_fields]

        response = VendorAnalyzeResponse(
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


@router.post("/validate", response_model=VendorValidateResponse)
async def validate_import(
    request: VendorValidateRequest,
    supabase: Client = Depends(get_supabase),
):
    """Validate vendors CSV data before import."""
    try:
        existing_response = (
            supabase.table("vendors")
            .select("id, name")
            .eq("company_id", request.company_id)
            .execute()
        )
        existing_vendors = existing_response.data or []
        existing_names = {
            v["name"].lower(): v for v in existing_vendors if v.get("name")
        }

        reverse_mappings = {v: k for k, v in request.mappings.items()}
        name_column = reverse_mappings.get("name")

        # Track name occurrences
        name_to_rows: dict[str, list[int]] = {}
        for i, row in enumerate(request.rows):
            row_number = i + 1
            name = row.get(name_column, "").strip() if name_column else ""
            if name:
                name_to_rows.setdefault(name, []).append(row_number)

        # Lower-keyed for duplicate detection
        lowered_occurrences: dict[str, list[int]] = {}
        for name, rows in name_to_rows.items():
            lowered_occurrences.setdefault(name.lower(), []).extend(rows)
        csv_duplicates = {k: v for k, v in lowered_occurrences.items() if len(v) > 1}

        validation_errors: list[VendorValidationError] = []
        conflicts: list[VendorConflictInfo] = []
        validation_error_rows: set[int] = set()
        conflict_rows: set[int] = set()

        for i, row in enumerate(request.rows):
            row_number = i + 1
            name = row.get(name_column, "").strip() if name_column else ""

            if not name:
                validation_errors.append(
                    VendorValidationError(
                        row_number=row_number,
                        error_type="missing_name",
                        field="name",
                        message="Vendor name is required",
                    )
                )
                validation_error_rows.add(row_number)
                continue

            name_lower = name.lower()
            if name_lower in csv_duplicates:
                other_rows = [
                    r for r in csv_duplicates[name_lower] if r != row_number
                ]
                if other_rows:
                    conflicts.append(
                        VendorConflictInfo(
                            row_number=row_number,
                            csv_name=name,
                            conflict_type="csv_duplicate",
                            existing_vendor_id="",
                            existing_value=f"Duplicate in CSV at rows {', '.join(map(str, other_rows))}",
                        )
                    )
                    conflict_rows.add(row_number)
                    continue

            if name_lower in existing_names:
                existing = existing_names[name_lower]
                conflicts.append(
                    VendorConflictInfo(
                        row_number=row_number,
                        csv_name=name,
                        conflict_type="duplicate_name",
                        existing_vendor_id=existing["id"],
                        existing_value=f"Vendor '{name}' already exists",
                    )
                )
                conflict_rows.add(row_number)
                continue

        # Compute merge proposals across the cleaned (non-error) name set
        eligible_name_to_rows = {
            name: rows
            for name, rows in name_to_rows.items()
            if all(r not in validation_error_rows for r in rows)
        }
        proposed_merges = _propose_merges(eligible_name_to_rows)

        total_skipped = conflict_rows | validation_error_rows
        valid_rows = len(request.rows) - len(total_skipped)

        return VendorValidateResponse(
            has_conflicts=len(conflicts) > 0,
            conflicts=conflicts,
            validation_errors=validation_errors,
            proposed_merges=proposed_merges,
            valid_rows_count=valid_rows,
            conflict_rows_count=len(conflict_rows),
            error_rows_count=len(validation_error_rows),
            skipped_rows_count=len(total_skipped),
        )

    except Exception as e:
        sentry_sdk.capture_exception(e)
        raise HTTPException(
            status_code=500,
            detail="Internal server error",
        )


@router.post("/execute", response_model=VendorExecuteResponse)
async def execute_import(
    request: VendorExecuteRequest,
    supabase: Client = Depends(get_supabase),
):
    """Execute the vendors import.

    Confirmed merges are applied at execute time: rows whose name matches any
    confirmed `from_name` are folded into the row carrying the canonical `to_name`.
    Unconfirmed proposals are imported as separate vendors.
    """
    try:
        validate_response = await validate_import(
            VendorValidateRequest(
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

        # Build merge map (case-insensitive) from confirmed merges
        merge_map: dict[str, str] = {}
        for m in request.confirmed_merges:
            merge_map[m.from_name.lower()] = m.to_name

        reverse_mappings = {v: k for k, v in request.mappings.items()}
        name_column = reverse_mappings.get("name")
        legacy_id_column = reverse_mappings.get("legacy_id")

        rows_to_insert: list[dict] = []
        rows_to_upsert: list[dict] = []
        errors: list[VendorImportError] = []
        skipped = 0
        merged = 0
        seen_canonical_names: set[str] = set()

        for i, row in enumerate(request.rows):
            row_number = i + 1

            if row_number in skip_row_numbers:
                skipped += 1
                continue

            name = row.get(name_column, "").strip() if name_column else ""
            canonical_name = merge_map.get(name.lower(), name)

            # If this row is being merged into another, count it and skip the
            # row insert (the canonical row will carry forward).
            if canonical_name.lower() != name.lower():
                merged += 1
                continue

            # Avoid inserting the canonical name multiple times within one batch
            if canonical_name.lower() in seen_canonical_names:
                skipped += 1
                continue
            seen_canonical_names.add(canonical_name.lower())

            vendor_data: dict = {
                "company_id": request.company_id,
                "name": canonical_name,
            }

            for db_field in (
                "contact_name",
                "contact_email",
                "contact_phone",
                "address_line1",
                "address_line2",
                "city",
                "state",
                "postal_code",
                "country",
                "notes",
            ):
                csv_column = reverse_mappings.get(db_field)
                if csv_column and csv_column in row:
                    value = row[csv_column].strip()
                    if value and value.lower() != "undefined":
                        vendor_data[db_field] = value

            if "country" not in vendor_data or not vendor_data.get("country"):
                vendor_data["country"] = "USA"

            legacy_id_val = (
                row.get(legacy_id_column, "").strip() if legacy_id_column else ""
            )
            if legacy_id_val:
                vendor_data["legacy_id"] = legacy_id_val
                rows_to_upsert.append(vendor_data)
            else:
                rows_to_insert.append(vendor_data)

        BATCH_SIZE = 500
        imported_count = 0
        updated_count = 0

        if rows_to_insert:
            try:
                total = len(rows_to_insert)
                for batch_start in range(0, total, BATCH_SIZE):
                    batch = rows_to_insert[batch_start : batch_start + BATCH_SIZE]
                    response = supabase.table("vendors").insert(batch).execute()
                    imported_count += len(response.data) if response.data else 0
            except Exception as e:
                error_str = str(e)
                if "23505" in error_str or "duplicate key" in error_str.lower():
                    raise HTTPException(
                        status_code=400,
                        detail="Import failed: A vendor with this name already exists.",
                    )
                sentry_sdk.capture_exception(e)
                raise HTTPException(status_code=500, detail="Internal server error")

        if rows_to_upsert:
            try:
                total = len(rows_to_upsert)
                for batch_start in range(0, total, BATCH_SIZE):
                    batch = rows_to_upsert[batch_start : batch_start + BATCH_SIZE]
                    response = (
                        supabase.table("vendors")
                        .upsert(batch, on_conflict="company_id,legacy_id")
                        .execute()
                    )
                    updated_count += len(response.data) if response.data else 0
            except Exception as e:
                sentry_sdk.capture_exception(e)
                raise HTTPException(status_code=500, detail="Internal server error")

        return VendorExecuteResponse(
            success=True,
            imported_count=imported_count,
            updated_count=updated_count,
            merged_count=merged,
            skipped_count=skipped,
            errors=errors,
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Vendors import execution error: {str(e)}", exc_info=True)
        sentry_sdk.capture_exception(e)
        raise HTTPException(
            status_code=500,
            detail="Internal server error",
        )
