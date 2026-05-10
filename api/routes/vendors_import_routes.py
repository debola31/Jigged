"""Import routes for Vendors CSV import with AI-powered mapping.

A vendor is a first-class entity. Capabilities are derived from references
elsewhere (parts.preferred_vendor_id, work_centers.vendor_id), so this importer
carries no capability flags.

Adds a `proposed_merges` step between validate and execute: vendor names that
look like the same vendor (e.g. "PerformCoat of Michigan LL" vs "PerformCoat
of Michigan LLC") are surfaced for the user to confirm or reject. Confirmed
merges collapse the duplicate row into the canonical row at execute time.

Iteration 2 (vendor multi-contact): contact info now lives in the separate
vendor_contacts table. The CSV path accepts optional primary_contact_*
columns; when present, execute inserts one vendor_contacts row per imported
vendor with is_primary=true. The validation rule "no contact rows without a
contact_name" mirrors the migration's data-quality NOTICE rationale: never
silently corrupt by using the company name as the person name.
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
    VENDOR_CONTACT_ROLE_VALUES,
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
    """Compute merge proposals across CSV vendor names."""
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

            confidence = 0.0
            if longer_lower.startswith(shorter_lower) and (
                len(longer) - len(shorter)
            ) <= 6:
                confidence = 0.95
            else:
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
        contact_name_column = reverse_mappings.get("primary_contact_name")
        contact_email_column = reverse_mappings.get("primary_contact_email")
        contact_phone_column = reverse_mappings.get("primary_contact_phone")
        contact_role_column = reverse_mappings.get("primary_contact_role")

        # Track name occurrences
        name_to_rows: dict[str, list[int]] = {}
        for i, row in enumerate(request.rows):
            row_number = i + 1
            name = row.get(name_column, "").strip() if name_column else ""
            if name:
                name_to_rows.setdefault(name, []).append(row_number)

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

            # Contact-related validation. Skip rows already in
            # validation_error_rows or conflict_rows so we don't double-up
            # error messages on the same row.
            contact_name_val = (
                row.get(contact_name_column, "").strip() if contact_name_column else ""
            )
            contact_email_val = (
                row.get(contact_email_column, "").strip() if contact_email_column else ""
            )
            contact_phone_val = (
                row.get(contact_phone_column, "").strip() if contact_phone_column else ""
            )
            contact_role_val = (
                row.get(contact_role_column, "").strip() if contact_role_column else ""
            )

            # Rule: if any contact-bearing field (email/phone) is set,
            # contact_name must also be set. We refuse to silently invent
            # a name (matches the migration's data-quality NOTICE rule).
            if (contact_email_val or contact_phone_val) and not contact_name_val:
                validation_errors.append(
                    VendorValidationError(
                        row_number=row_number,
                        error_type="missing_contact_name",
                        field="primary_contact_name",
                        message=(
                            "primary_contact_name is required when "
                            "primary_contact_email or primary_contact_phone is set"
                        ),
                    )
                )
                validation_error_rows.add(row_number)
                continue

            if contact_role_val and contact_role_val not in VENDOR_CONTACT_ROLE_VALUES:
                validation_errors.append(
                    VendorValidationError(
                        row_number=row_number,
                        error_type="invalid_contact_role",
                        field="primary_contact_role",
                        message=(
                            f"primary_contact_role '{contact_role_val}' is not valid. "
                            f"Allowed: {', '.join(VENDOR_CONTACT_ROLE_VALUES)}"
                        ),
                    )
                )
                validation_error_rows.add(row_number)
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

    Each row writes one vendors row (with merge handling); rows that have any
    primary_contact_* fields populated also write one vendor_contacts row
    with is_primary=true, role defaulting to 'sales' when not specified.
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

        merge_map: dict[str, str] = {}
        for m in request.confirmed_merges:
            merge_map[m.from_name.lower()] = m.to_name

        reverse_mappings = {v: k for k, v in request.mappings.items()}
        name_column = reverse_mappings.get("name")
        legacy_id_column = reverse_mappings.get("legacy_id")
        contact_name_column = reverse_mappings.get("primary_contact_name")
        contact_email_column = reverse_mappings.get("primary_contact_email")
        contact_phone_column = reverse_mappings.get("primary_contact_phone")
        contact_role_column = reverse_mappings.get("primary_contact_role")

        # Pending vendor_contacts rows. We can only insert these AFTER the
        # vendor row exists (we need its id). Build a list of (canonical_name,
        # contact_payload) pairs here, then resolve names → ids after the
        # vendor inserts return.
        pending_contacts: list[tuple[str, dict]] = []

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

            if canonical_name.lower() != name.lower():
                merged += 1
                # If the merged-away row carried contact info, attach it to
                # the canonical name so the canonical vendor still gets a
                # primary contact (only attach the FIRST one we see — multiple
                # merged rows with conflicting contacts would race for is_primary).
                if contact_name_column:
                    contact_name_val = row.get(contact_name_column, "").strip()
                    if contact_name_val and not any(
                        cn.lower() == canonical_name.lower()
                        for cn, _ in pending_contacts
                    ):
                        pending_contacts.append(
                            (
                                canonical_name,
                                _build_contact_payload(
                                    row,
                                    contact_name_column,
                                    contact_email_column,
                                    contact_phone_column,
                                    contact_role_column,
                                ),
                            )
                        )
                continue

            if canonical_name.lower() in seen_canonical_names:
                skipped += 1
                continue
            seen_canonical_names.add(canonical_name.lower())

            vendor_data: dict = {
                "company_id": request.company_id,
                "name": canonical_name,
            }

            for db_field in (
                "address_line1",
                "address_line2",
                "city",
                "state",
                "postal_code",
                "country",
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

            # Queue a contact insert if the row has a contact name. Email/
            # phone-only rows are caught by validation as missing_contact_name
            # and skipped before reaching here.
            if contact_name_column:
                contact_name_val = row.get(contact_name_column, "").strip()
                if contact_name_val:
                    pending_contacts.append(
                        (
                            canonical_name,
                            _build_contact_payload(
                                row,
                                contact_name_column,
                                contact_email_column,
                                contact_phone_column,
                                contact_role_column,
                            ),
                        )
                    )

        BATCH_SIZE = 500
        imported_count = 0
        updated_count = 0
        # name → vendor.id, used to attach pending_contacts after insert.
        name_to_vendor_id: dict[str, str] = {}

        if rows_to_insert:
            try:
                total = len(rows_to_insert)
                for batch_start in range(0, total, BATCH_SIZE):
                    batch = rows_to_insert[batch_start : batch_start + BATCH_SIZE]
                    response = supabase.table("vendors").insert(batch).execute()
                    if response.data:
                        imported_count += len(response.data)
                        for r in response.data:
                            if r.get("name") and r.get("id"):
                                name_to_vendor_id[r["name"].lower()] = r["id"]
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
                    if response.data:
                        updated_count += len(response.data)
                        for r in response.data:
                            if r.get("name") and r.get("id"):
                                name_to_vendor_id[r["name"].lower()] = r["id"]
            except Exception as e:
                sentry_sdk.capture_exception(e)
                raise HTTPException(status_code=500, detail="Internal server error")

        # Insert vendor_contacts rows. We treat contact insert failures as
        # non-fatal — the vendor row is already in place; surface the error
        # via the import response so the user can address it without losing
        # the vendor data.
        contacts_imported = 0
        if pending_contacts:
            contact_rows: list[dict] = []
            for canonical_name, contact_payload in pending_contacts:
                vendor_id = name_to_vendor_id.get(canonical_name.lower())
                if not vendor_id:
                    # Vendor insert may have been deduped or failed silently.
                    # Skip the contact rather than orphan it.
                    continue
                contact_rows.append({"vendor_id": vendor_id, **contact_payload})

            if contact_rows:
                try:
                    for batch_start in range(0, len(contact_rows), BATCH_SIZE):
                        batch = contact_rows[batch_start : batch_start + BATCH_SIZE]
                        response = (
                            supabase.table("vendor_contacts").insert(batch).execute()
                        )
                        if response.data:
                            contacts_imported += len(response.data)
                except Exception as e:
                    logger.error(
                        f"Vendors import: contact insert failed: {str(e)}",
                        exc_info=True,
                    )
                    sentry_sdk.capture_exception(e)
                    errors.append(
                        VendorImportError(
                            row_number=0,
                            reason=(
                                "Vendor rows imported successfully, but one or more "
                                f"contact rows failed to insert: {str(e)}. Add the "
                                "contacts manually from each vendor's detail page."
                            ),
                            data={},
                        )
                    )

        return VendorExecuteResponse(
            success=True,
            imported_count=imported_count,
            updated_count=updated_count,
            merged_count=merged,
            contacts_imported_count=contacts_imported,
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


def _build_contact_payload(
    row: dict[str, str],
    name_col: str | None,
    email_col: str | None,
    phone_col: str | None,
    role_col: str | None,
) -> dict:
    """Build a vendor_contacts insert payload from a CSV row.

    Always sets is_primary=true (the CSV path is single-contact-per-vendor;
    multi-contact import is a deferred follow-up endpoint).
    Defaults role to 'sales' when not provided.
    """
    contact_name = row.get(name_col, "").strip() if name_col else ""
    contact_email = row.get(email_col, "").strip() if email_col else ""
    contact_phone = row.get(phone_col, "").strip() if phone_col else ""
    contact_role = row.get(role_col, "").strip() if role_col else ""

    payload: dict = {
        "name": contact_name,
        "role": contact_role if contact_role else "sales",
        "is_primary": True,
    }
    if contact_email:
        payload["email"] = contact_email
    if contact_phone:
        payload["phone"] = contact_phone
    return payload
