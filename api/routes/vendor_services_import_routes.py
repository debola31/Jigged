"""Import route for Vendor Services CSV import.

A vendor service is a process an outside vendor performs on your parts. These
used to import as `work_centers` rows with kind='external', which is also how
production ended up with 32 of 38 outsourced rows named after their own vendor:
the old wizard guessed "is this an outside shop?" from the NAME and then minted
a vendor of the same name to hang it on. Here the vendor is named explicitly and
the service is named for the process, so there is nothing to guess.

Identity is `(vendor_id, name)`, not `(company_id, name)`. Two vendors may both
offer "Anodize"; one vendor may not list it twice.
"""

import logging

import sentry_sdk

from fastapi import APIRouter, HTTPException, Depends
from supabase import Client

from models.vendor_services_import_models import (
    VendorServiceValidateRequest,
    VendorServiceValidateResponse,
    VendorServiceValidationError,
    VendorServiceConflictInfo,
    VendorServiceExecuteRequest,
    VendorServiceExecuteResponse,
    VendorServiceImportError,
)
from utils.db_pagination import fetch_all_by_company

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/vendor-services/import", tags=["vendor-services-import"])


def get_supabase() -> Client:
    """Get Supabase client from the main app."""
    from index import supabase

    return supabase


async def validate_import(
    request: VendorServiceValidateRequest,
    supabase: Client = Depends(get_supabase),
) -> VendorServiceValidateResponse:
    """Check every row before anything is written.

    Not an HTTP route — `execute_import` is the only caller, matching the other
    importers since the per-entity wizards were retired.
    """
    try:
        vendor_name_to_id = {
            (v.get("name") or "").lower(): v["id"]
            for v in fetch_all_by_company(supabase, "vendors", "id, name", request.company_id)
        }

        reverse_mappings = {v: k for k, v in request.mappings.items()}
        vendor_column = reverse_mappings.get("vendor_name")
        service_column = reverse_mappings.get("service_name")
        price_column = reverse_mappings.get("unit_price")

        conflicts: list[VendorServiceConflictInfo] = []
        validation_errors: list[VendorServiceValidationError] = []
        validation_error_rows: set[int] = set()
        conflict_rows: set[int] = set()

        # (vendor, service) pairs already seen in THIS file.
        seen_pairs: dict[tuple[str, str], int] = {}

        for i, row in enumerate(request.rows):
            row_number = i + 1 + request.batch_offset

            vendor_name = row.get(vendor_column, "").strip() if vendor_column else ""
            service_name = row.get(service_column, "").strip() if service_column else ""

            if not vendor_name:
                validation_errors.append(
                    VendorServiceValidationError(
                        row_number=row_number,
                        error_type="missing_vendor_name",
                        field="vendor_name",
                        message="Vendor is required — a service belongs to the vendor who performs it",
                    )
                )
                validation_error_rows.add(row_number)
                continue

            if not service_name:
                validation_errors.append(
                    VendorServiceValidationError(
                        row_number=row_number,
                        error_type="missing_service_name",
                        field="service_name",
                        message="Service name is required",
                    )
                )
                validation_error_rows.add(row_number)
                continue

            if vendor_name.lower() not in vendor_name_to_id:
                conflicts.append(
                    VendorServiceConflictInfo(
                        row_number=row_number,
                        csv_name=service_name,
                        conflict_type="unknown_vendor",
                        existing_service_id="",
                        existing_value=f"Vendor '{vendor_name}' not found. Import vendors first.",
                    )
                )
                conflict_rows.add(row_number)
                continue

            if price_column:
                price_str = row.get(price_column, "").strip()
                if price_str:
                    try:
                        if float(price_str) < 0:
                            raise ValueError
                    except ValueError:
                        validation_errors.append(
                            VendorServiceValidationError(
                                row_number=row_number,
                                error_type="invalid_price",
                                field="unit_price",
                                message=f"Price must be a non-negative number (got '{price_str}')",
                            )
                        )
                        validation_error_rows.add(row_number)
                        continue

            # Within-file duplicate on the REAL identity, which includes the
            # vendor: the same service name under two vendors is not a duplicate.
            pair = (vendor_name.lower(), service_name.lower())
            if pair in seen_pairs:
                conflicts.append(
                    VendorServiceConflictInfo(
                        row_number=row_number,
                        csv_name=service_name,
                        conflict_type="csv_duplicate",
                        existing_service_id="",
                        existing_value=(
                            f"'{service_name}' appears for {vendor_name} on row "
                            f"{seen_pairs[pair]} as well"
                        ),
                    )
                )
                conflict_rows.add(row_number)
                continue
            seen_pairs[pair] = row_number

        # An EXISTING service is deliberately not a conflict — execute upserts,
        # so a re-import updates in place.
        valid_rows = len(request.rows) - len(validation_error_rows) - len(conflict_rows)

        return VendorServiceValidateResponse(
            has_conflicts=len(conflicts) > 0,
            conflicts=conflicts,
            validation_errors=validation_errors,
            valid_rows_count=valid_rows,
            conflict_rows_count=len(conflict_rows),
            error_rows_count=len(validation_error_rows),
            skipped_rows_count=0,
        )

    except Exception as e:
        logger.error(f"Vendor services validate error: {str(e)}", exc_info=True)
        sentry_sdk.capture_exception(e)
        raise HTTPException(status_code=500, detail="Internal server error")


@router.post("/execute", response_model=VendorServiceExecuteResponse)
async def execute_import(
    request: VendorServiceExecuteRequest,
    supabase: Client = Depends(get_supabase),
):
    """Execute the vendor services import."""
    try:
        validate_response = await validate_import(
            VendorServiceValidateRequest(
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

        vendor_name_to_id = {
            (v.get("name") or "").lower(): v["id"]
            for v in fetch_all_by_company(supabase, "vendors", "id, name", request.company_id)
        }

        reverse_mappings = {v: k for k, v in request.mappings.items()}
        vendor_column = reverse_mappings.get("vendor_name")
        service_column = reverse_mappings.get("service_name")
        price_column = reverse_mappings.get("unit_price")
        description_column = reverse_mappings.get("description")

        rows_to_write: list[dict] = []
        errors: list[VendorServiceImportError] = []
        skipped = 0

        for i, row in enumerate(request.rows):
            row_number = i + 1

            if row_number in skip_row_numbers:
                skipped += 1
                continue

            vendor_name = row.get(vendor_column, "").strip() if vendor_column else ""
            service_name = row.get(service_column, "").strip() if service_column else ""
            vendor_id = vendor_name_to_id.get(vendor_name.lower())

            if not vendor_id:
                # Defence in depth — validate already filtered this case.
                errors.append(
                    VendorServiceImportError(
                        row_number=row_number,
                        reason=f"Vendor '{vendor_name}' not found at execute time",
                        data={k: v for k, v in row.items() if v},
                    )
                )
                skipped += 1
                continue

            service_data: dict = {
                "company_id": request.company_id,
                "vendor_id": vendor_id,
                "name": service_name,
            }

            if price_column:
                price_str = row.get(price_column, "").strip()
                if price_str:
                    try:
                        service_data["unit_price"] = round(float(price_str), 4)
                    except ValueError:
                        pass

            if description_column:
                value = row.get(description_column, "").strip()
                if value and value.lower() != "undefined":
                    service_data["description"] = value

            rows_to_write.append(service_data)

        # Idempotent write: upsert on (vendor_id, name), which is the table's own
        # unique constraint. Existing services update in place.
        BATCH_SIZE = 500
        existing_pairs = {
            (s.get("vendor_id"), (s.get("name") or "").lower())
            for s in fetch_all_by_company(
                supabase, "vendor_services", "vendor_id, name", request.company_id
            )
        }
        imported_count = sum(
            1
            for r in rows_to_write
            if (r["vendor_id"], r["name"].lower()) not in existing_pairs
        )
        updated_count = len(rows_to_write) - imported_count

        # Re-importing an archived service revives it, matching every other
        # importer: clearing deleted_at on the DO UPDATE un-archives the row
        # rather than leaving the re-imported service hidden.
        for row_data in rows_to_write:
            row_data["deleted_at"] = None

        if rows_to_write:
            try:
                for batch_start in range(0, len(rows_to_write), BATCH_SIZE):
                    batch = rows_to_write[batch_start : batch_start + BATCH_SIZE]
                    (
                        supabase.table("vendor_services")
                        .upsert(batch, on_conflict="vendor_id,name")
                        .execute()
                    )
            except Exception as e:
                logger.error(f"Vendor services import upsert error: {str(e)}", exc_info=True)
                sentry_sdk.capture_exception(e)
                raise HTTPException(status_code=500, detail="Internal server error")

        return VendorServiceExecuteResponse(
            success=True,
            imported_count=imported_count,
            updated_count=updated_count,
            skipped_count=skipped,
            errors=errors,
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Vendor services import error: {str(e)}", exc_info=True)
        sentry_sdk.capture_exception(e)
        raise HTTPException(status_code=500, detail="Internal server error")
