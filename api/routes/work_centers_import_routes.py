"""Import routes for Work Centers CSV import with AI-powered mapping.

Replaces the old operations import. A work center is either internal (runs
in the shop, has labor_rate) or external (vendor-performed; references a
vendor that must already exist in the company).
"""

import logging

import sentry_sdk

from fastapi import APIRouter, HTTPException, Depends
from supabase import Client

from models.work_centers_import_models import (
    WorkCenterValidateRequest,
    WorkCenterValidateResponse,
    WorkCenterValidationError,
    WorkCenterConflictInfo,
    WorkCenterExecuteRequest,
    WorkCenterExecuteResponse,
    WorkCenterImportError,
)
from utils.db_pagination import fetch_all_by_company

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/work-centers/import", tags=["work-centers-import"])














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




# No longer an HTTP route. The per-entity import wizards that called /validate are gone;
# the only caller left is execute_import below, which needs the conflict report before it
# writes. Kept as a plain function so that call keeps working.
async def validate_import(
    request: WorkCenterValidateRequest,
    supabase: Client = Depends(get_supabase),
):
    """Validate work centers CSV data before import."""
    try:
        existing_wcs = fetch_all_by_company(supabase, "work_centers", "id, name", request.company_id)
        existing_wcs_lookup = {
            wc["name"].lower(): wc for wc in existing_wcs if wc.get("name")
        }

        existing_vendors = fetch_all_by_company(supabase, "vendors", "id, name", request.company_id)
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
            row_number = i + 1 + request.batch_offset
            name = row.get(name_column, "").strip() if name_column else ""
            if name:
                name_occurrences.setdefault(name.lower(), []).append(row_number)

        csv_duplicates = {k: v for k, v in name_occurrences.items() if len(v) > 1}

        validation_errors: list[WorkCenterValidationError] = []
        conflicts: list[WorkCenterConflictInfo] = []
        validation_error_rows: set[int] = set()
        conflict_rows: set[int] = set()

        for i, row in enumerate(request.rows):
            row_number = i + 1 + request.batch_offset
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

            # An existing work center is NOT a conflict — execute upserts on
            # (company_id, name), so a re-imported one updates in place.

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

        # Vendor lookup for execute-time resolution (paged past the 1000-row cap).
        vendor_name_to_id = {
            v["name"].lower(): v["id"]
            for v in fetch_all_by_company(supabase, "vendors", "id, name", request.company_id)
        }

        reverse_mappings = {v: k for k, v in request.mappings.items()}
        name_column = reverse_mappings.get("name")
        kind_column = reverse_mappings.get("kind")
        vendor_column = reverse_mappings.get("vendor_name")
        labor_rate_column = reverse_mappings.get("labor_rate")
        description_column = reverse_mappings.get("description")

        rows_to_write: list[dict] = []
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

            rows_to_write.append(wc_data)

        # Idempotent write: upsert on (company_id, name). Existing work centers update in place,
        # new ones insert — split by which names existed before this run.
        BATCH_SIZE = 500
        existing_names = {
            (w.get("name") or "").lower()
            for w in fetch_all_by_company(supabase, "work_centers", "name", request.company_id)
        }
        imported_count = sum(1 for r in rows_to_write if r["name"].lower() not in existing_names)
        updated_count = len(rows_to_write) - imported_count
        # Reusing an archived work center's name revives it: clearing deleted_at on the upsert's
        # DO UPDATE un-archives the row instead of leaving the re-imported work center hidden.
        for row in rows_to_write:
            row["deleted_at"] = None
        if rows_to_write:
            try:
                for batch_start in range(0, len(rows_to_write), BATCH_SIZE):
                    batch = rows_to_write[batch_start : batch_start + BATCH_SIZE]
                    (
                        supabase.table("work_centers")
                        .upsert(batch, on_conflict="company_id,name")
                        .execute()
                    )
            except Exception as e:
                logger.error(f"Work centers import upsert error: {str(e)}", exc_info=True)
                sentry_sdk.capture_exception(e)
                raise HTTPException(
                    status_code=500,
                    detail="Internal server error",
                )

        return WorkCenterExecuteResponse(
            success=True,
            imported_count=imported_count,
            updated_count=updated_count,
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
