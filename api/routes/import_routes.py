"""Import routes for customer CSV import with AI-powered mapping."""

import logging

import sentry_sdk

from fastapi import APIRouter, HTTPException, Depends
from supabase import Client

from models.import_models import (
    ValidateRequest,
    ValidateResponse,
    ValidationError,
    ConflictInfo,
    ExecuteRequest,
    ExecuteResponse,
    CUSTOMER_SCHEMA,
)
from utils.db_pagination import fetch_all_by_company

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/customers/import", tags=["import"])














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
            row_number = i + 1 + request.batch_offset
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
            row_number = i + 1 + request.batch_offset

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
            row_number = i + 1 + request.batch_offset

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

        # An existing-name customer is NOT skipped — execute upserts it (updates in place),
        # mirroring vendors/work centers. Only within-CSV duplicate names (csv_duplicate_name)
        # and validation errors are skipped.
        skip_row_numbers = {
            c.row_number
            for c in validate_response.conflicts
            if c.conflict_type != "duplicate_name"
        }
        skip_row_numbers |= {e.row_number for e in validate_response.validation_errors}

        # Existing customer names (paged past PostgREST's 1000-row cap). Drives (a) attaching a
        # contact/address only to NEW customers — re-attaching a primary contact to an existing
        # customer would duplicate it and trip the one-primary index — and (b) the
        # created-vs-updated split in the summary.
        # Keyed by the CASEFOLDED name, valued by the name EXACTLY as stored. The
        # value is load-bearing: the upsert's on_conflict is the case-sensitive
        # (company_id, name) constraint, so a CSV row spelled "acme corp" against
        # a stored "Acme Corp" would not conflict — it would insert a SECOND
        # customer while is_new (decided case-insensitively, just below) reported
        # it as existing. Rewriting the payload to the stored spelling makes the
        # upsert land on the row it was always meant to update.
        #
        # Consequence worth knowing: a re-import cannot RE-CASE a customer. That
        # is the right trade — a silent duplicate of the entity every quote, job
        # and invoice hangs off is far worse than a capitalisation fix the user
        # can make on the customer page.
        existing_customer_names = {
            c["name"].strip().lower(): c["name"]
            for c in fetch_all_by_company(supabase, "customers", "name", request.company_id)
            if c.get("name")
        }

        # Find column mappings
        reverse_mappings = {v: k for k, v in request.mappings.items()}

        # Contact + address fields live on customer_contacts / customer_addresses
        # respectively. Split each CSV row into a customers payload + (optional)
        # contact row + (optional) address row so we can insert the parent first,
        # then the children with the returned id.
        contact_field_keys = {"contact_name", "contact_email", "contact_phone"}
        address_field_keys = {
            "address_line1",
            "address_line2",
            "city",
            "state",
            "postal_code",
            "country",
        }

        prepared = []  # list of dicts: customer_data / name_lower / is_new / contact_row / address_data
        errors = []
        skipped = 0

        for i, row in enumerate(request.rows):
            row_number = i + 1

            if row_number in skip_row_numbers:
                skipped += 1
                continue

            customer_data = {"company_id": request.company_id}
            contact_data: dict = {}
            address_data: dict = {}

            for db_field in CUSTOMER_SCHEMA.keys():
                csv_column = reverse_mappings.get(db_field)
                if csv_column and csv_column in row:
                    value = row[csv_column].strip()
                    if value and value.lower() != "undefined":
                        if db_field in address_field_keys:
                            address_data[db_field] = value
                        elif db_field in contact_field_keys:
                            # contact_name → name, contact_email → email, etc.
                            contact_data[db_field.replace("contact_", "")] = value
                        else:
                            customer_data[db_field] = value

            if address_data and "country" not in address_data:
                address_data["country"] = "USA"

            name_lower = customer_data.get("name", "").strip().lower()
            stored_name = existing_customer_names.get(name_lower)
            is_new = stored_name is None
            if stored_name is not None:
                # Match the stored spelling so the upsert conflicts (and updates)
                # instead of inserting a case-variant duplicate.
                customer_data["name"] = stored_name

            # Attach a contact/address ONLY to a NEW customer — a re-imported (existing)
            # customer updates in place; re-inserting its primary contact/address would
            # duplicate it (and trip the one-primary index). Never invent a contact without
            # a real name.
            contact_row = None
            if is_new and contact_data.get("name"):
                contact_row = {
                    "name": contact_data["name"],
                    "role": "buyer",
                    "email": contact_data.get("email"),
                    "phone": contact_data.get("phone"),
                    "is_primary": True,
                }

            prepared.append(
                {
                    "customer_data": customer_data,
                    "name_lower": name_lower,
                    "is_new": is_new,
                    "contact_row": contact_row,
                    "address_data": address_data if (is_new and address_data) else None,
                }
            )

        # Idempotent write: upsert on (company_id, name). Existing customers update in place,
        # new ones insert. Contacts/addresses are attached only to NEW customers (see above),
        # keyed by the customer id read back from the upsert.
        imported_count = sum(1 for p in prepared if p["is_new"])
        updated_count = len(prepared) - imported_count
        if prepared:
            try:
                BATCH_SIZE = 500
                name_to_customer_id: dict[str, str] = {}
                customers_payload = [p["customer_data"] for p in prepared]
                # Reusing an archived customer's name revives it: clearing deleted_at on the
                # upsert's DO UPDATE un-archives the row instead of leaving it hidden.
                for row in customers_payload:
                    row["deleted_at"] = None
                for batch_start in range(0, len(customers_payload), BATCH_SIZE):
                    batch = customers_payload[batch_start : batch_start + BATCH_SIZE]
                    response = (
                        supabase.table("customers")
                        .upsert(batch, on_conflict="company_id,name")
                        .execute()
                    )
                    for r in response.data or []:
                        if r.get("name") and r.get("id"):
                            # Same normalisation as name_lower above, or the
                            # lookup below misses and the row's contact/address
                            # is silently dropped.
                            name_to_customer_id[r["name"].strip().lower()] = r["id"]

                contact_rows_to_insert = []
                address_rows_to_insert = []
                for p in prepared:
                    if not (p["contact_row"] or p["address_data"]):
                        continue
                    customer_id = name_to_customer_id.get(p["name_lower"])
                    if not customer_id:
                        continue
                    if p["contact_row"]:
                        contact_rows_to_insert.append(
                            {"customer_id": customer_id, **p["contact_row"]}
                        )
                    if p["address_data"]:
                        address_rows_to_insert.append(
                            {
                                "customer_id": customer_id,
                                **p["address_data"],
                                "default_billing": True,
                                "default_shipping": True,
                            }
                        )
                if contact_rows_to_insert:
                    supabase.table("customer_contacts").insert(contact_rows_to_insert).execute()
                if address_rows_to_insert:
                    supabase.table("customer_addresses").insert(address_rows_to_insert).execute()
            except Exception as e:
                error_str = str(e)
                # Check for PostgreSQL unique constraint violation (code 23505)
                if "23505" in error_str or "duplicate key" in error_str.lower():
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
            updated_count=updated_count,
            skipped_count=skipped,
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
