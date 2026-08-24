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

import logging
from difflib import SequenceMatcher

import sentry_sdk

from fastapi import APIRouter, HTTPException, Depends
from supabase import Client

from models.vendors_import_models import (
    VendorValidateRequest,
    VendorValidateResponse,
    VendorValidationError,
    VendorConflictInfo,
    VendorMergeProposal,
    VendorExecuteRequest,
    VendorExecuteResponse,
    VendorImportError,
    VENDOR_CONTACT_ROLE_VALUES,
)
from utils.db_pagination import fetch_all_by_company

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/vendors/import", tags=["vendors-import"])





# Merge proposal threshold. SequenceMatcher.ratio() returns 0..1; values above
# 0.85 catch typos and "LL" vs "LLC"-style truncations without flagging "Smith
# Co" vs "Smith Inc" pairs that may legitimately be different companies.
MERGE_RATIO_THRESHOLD = 0.85










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




# No longer an HTTP route. The per-entity import wizards that called /validate are gone;
# the only caller left is execute_import below, which needs the conflict report before it
# writes. Kept as a plain function so that call keeps working.
async def validate_import(
    request: VendorValidateRequest,
    supabase: Client = Depends(get_supabase),
):
    """Validate vendors CSV data before import."""
    try:
        reverse_mappings = {v: k for k, v in request.mappings.items()}
        name_column = reverse_mappings.get("name")
        contact_name_column = reverse_mappings.get("primary_contact_name")
        contact_email_column = reverse_mappings.get("primary_contact_email")
        contact_phone_column = reverse_mappings.get("primary_contact_phone")
        contact_role_column = reverse_mappings.get("primary_contact_role")

        # Track name occurrences
        name_to_rows: dict[str, list[int]] = {}
        for i, row in enumerate(request.rows):
            row_number = i + 1 + request.batch_offset
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
            row_number = i + 1 + request.batch_offset
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

            # An existing vendor is NOT a conflict — execute upserts on
            # (company_id, name), so a re-imported vendor updates in place.

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
        contact_name_column = reverse_mappings.get("primary_contact_name")
        contact_email_column = reverse_mappings.get("primary_contact_email")
        contact_phone_column = reverse_mappings.get("primary_contact_phone")
        contact_role_column = reverse_mappings.get("primary_contact_role")

        # Names already in Jigged — drives the created/updated split and, crucially, means we
        # only queue contacts for NEW vendors. Re-importing an existing vendor updates it in
        # place; re-inserting its contact would duplicate the row.
        existing_vendor_names = {
            (v.get("name") or "").lower()
            for v in fetch_all_by_company(supabase, "vendors", "name", request.company_id)
        }

        # Pending vendor_contacts rows. We can only insert these AFTER the
        # vendor row exists (we need its id). Build a list of (canonical_name,
        # contact_payload) pairs here, then resolve names → ids after the
        # vendor inserts return.
        pending_contacts: list[tuple[str, dict]] = []
        pending_addresses: list[tuple[str, dict]] = []

        rows_to_write: list[dict] = []
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
                if contact_name_column and canonical_name.lower() not in existing_vendor_names:
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

            rows_to_write.append(vendor_data)

            # The address no longer lives on the vendor row, so it is queued the
            # same way a contact is and written after the upsert, once the row
            # has an id. ONLY for a NEW vendor: a re-import updates the vendor in
            # place, and re-inserting its address would give it a second copy of
            # the one it already had — the duplicate the contact path already
            # guards against for the same reason.
            if canonical_name.lower() not in existing_vendor_names:
                address_payload: dict = {}
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
                            address_payload[db_field] = value

                # `country` alone is not an address. Every row would default to
                # USA, so treating it as content would give every imported
                # vendor an address consisting of one word.
                if any(k != "country" for k in address_payload):
                    address_payload.setdefault("country", "USA")
                    address_payload["is_default"] = True
                    pending_addresses.append((canonical_name, address_payload))

            # Queue a contact insert if the row has a contact name — but ONLY for a NEW vendor.
            # A re-imported (existing) vendor updates in place; re-inserting its contact would
            # duplicate the row. Email/phone-only rows are caught by validation as
            # missing_contact_name and skipped before reaching here.
            if contact_name_column and canonical_name.lower() not in existing_vendor_names:
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

        # Idempotent write: upsert on (company_id, name). Existing vendors update in place, new
        # ones insert — split by which names existed before this run.
        BATCH_SIZE = 500
        imported_count = sum(
            1 for r in rows_to_write if r["name"].lower() not in existing_vendor_names
        )
        updated_count = len(rows_to_write) - imported_count
        # name → vendor.id, used to attach pending_contacts (new vendors only) after the write.
        name_to_vendor_id: dict[str, str] = {}

        # Reusing an archived vendor's name revives it: clearing deleted_at on the upsert's
        # DO UPDATE un-archives the row instead of leaving the re-imported vendor hidden.
        for row in rows_to_write:
            row["deleted_at"] = None

        if rows_to_write:
            try:
                for batch_start in range(0, len(rows_to_write), BATCH_SIZE):
                    batch = rows_to_write[batch_start : batch_start + BATCH_SIZE]
                    response = (
                        supabase.table("vendors")
                        .upsert(batch, on_conflict="company_id,name")
                        .execute()
                    )
                    for r in response.data or []:
                        if r.get("name") and r.get("id"):
                            name_to_vendor_id[r["name"].lower()] = r["id"]
            except Exception as e:
                logger.error(f"Vendors import upsert error: {str(e)}", exc_info=True)
                sentry_sdk.capture_exception(e)
                raise HTTPException(status_code=500, detail="Internal server error")

        # Insert vendor_contacts rows. We treat contact insert failures as
        # non-fatal — the vendor row is already in place; surface the error
        # via the import response so the user can address it without losing
        # the vendor data.
        # Addresses first: one per newly-created vendor, marked default. Failures
        # are non-fatal for the same reason contacts' are — the vendor row is
        # already in place, and losing an address should not lose the vendor.
        if pending_addresses:
            address_rows: list[dict] = []
            for canonical_name, address_payload in pending_addresses:
                vendor_id = name_to_vendor_id.get(canonical_name.lower())
                if not vendor_id:
                    continue
                address_rows.append({"vendor_id": vendor_id, **address_payload})

            if address_rows:
                try:
                    for batch_start in range(0, len(address_rows), BATCH_SIZE):
                        batch = address_rows[batch_start : batch_start + BATCH_SIZE]
                        supabase.table("vendor_addresses").insert(batch).execute()
                except Exception as e:
                    logger.error(
                        f"Vendors import: address insert failed: {str(e)}",
                        exc_info=True,
                    )
                    sentry_sdk.capture_exception(e)

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
