"""Import routes for Routings CSV import with AI-powered mapping.

One CSV row per operation, grouped by part_name. The importer creates a
`routings` row per part (UNIQUE on routings.part_id) and bulk-inserts
`routing_operations` rows.

Key rules:
  - work_center_name is resolved against existing work_centers; rows that don't
    match (and have no fallback) fail validation as `unknown_work_center`.
  - **MISCELLANEOUS fallback**: rows with no work_center_name route to the
    work_center named "MISCELLANEOUS" if it exists (case-insensitive). If it
    doesn't exist, the row fails as `unknown_work_center` with a hint.
  - Auto-create of work_centers from vendor names is **disabled** — the user
    must import work_centers explicitly first.
  - Per-row cost field set is validated against the resolved work_center's kind:
    internal → setup_minutes, cycle_minutes_per_unit, labor_rate_override
    outside step → external_unit_price (optional; inherits the service's price)
"""

import logging

import sentry_sdk

from fastapi import APIRouter, HTTPException, Depends
from supabase import Client

from models.routings_import_models import (
    RoutingValidateRequest,
    RoutingValidateResponse,
    RoutingValidationError,
    RoutingConflictInfo,
    RoutingFallbackInfo,
    RoutingExecuteRequest,
    RoutingExecuteResponse,
    RoutingImportError,
)
from utils.db_pagination import fetch_all_by_company, fetch_all_in

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/routings/import", tags=["routings-import"])





MISCELLANEOUS_WC_NAME = "MISCELLANEOUS"










def _try_float(value: str) -> tuple[bool, float]:
    """Parse a numeric string. Returns (ok, value)."""
    if not value:
        return False, 0.0
    try:
        return True, float(value)
    except ValueError:
        return False, 0.0


def get_supabase() -> Client:
    """Get Supabase client from the main app."""
    from index import supabase

    if not supabase:
        raise HTTPException(
            status_code=500,
            detail="Supabase client not initialized",
        )
    return supabase




def _load_lookups(supabase: Client, company_id: str) -> tuple[
    dict[str, dict],  # part_name_lower -> {id, part_name}
    dict[str, dict],  # work_center_name_lower -> {id, name, kind}
]:
    """Load parts + work_centers lookups for the company."""
    parts = fetch_all_by_company(supabase, "parts", "id, part_name", company_id)
    parts_lookup = {
        p["part_name"].lower(): p for p in parts if p.get("part_name")
    }

    # In-house stations. `deleted_at IS NULL` matters here in a way it did not
    # before: an archived station and a live one may now share a name with a
    # service, and routing an import at an archived row is silent nonsense.
    wcs = fetch_all_by_company(supabase, "work_centers", "id, name, deleted_at", company_id)
    wc_lookup = {
        wc["name"].lower(): wc
        for wc in wcs
        if wc.get("name") and wc.get("deleted_at") is None
    }

    # Outside services, keyed BOTH by bare name and by "vendor::service".
    #
    # The bare-name key is a LIST, not a last-wins dict. Two vendors may both
    # offer "Anodize", and the old dict silently kept whichever row PostgREST
    # returned last — routing an import step into one vendor's price when the
    # file meant the other's, with no error. A list lets the caller tell "one
    # match" from "ambiguous" and say so.
    services = fetch_all_by_company(
        supabase,
        "vendor_services",
        "id, name, unit_price, deleted_at, vendors(name)",
        company_id,
    )
    svc_by_name: dict[str, list[dict]] = {}
    svc_by_vendor_and_name: dict[str, dict] = {}
    for svc in services:
        if not svc.get("name") or svc.get("deleted_at") is not None:
            continue
        rel = svc.get("vendors")
        vendor = rel[0] if isinstance(rel, list) else rel
        vendor_name = (vendor or {}).get("name") or ""
        svc_by_name.setdefault(svc["name"].lower(), []).append(svc)
        if vendor_name:
            svc_by_vendor_and_name[f"{vendor_name.lower()}::{svc['name'].lower()}"] = svc

    return parts_lookup, wc_lookup, svc_by_name, svc_by_vendor_and_name


def _resolve_target(
    wc_name: str,
    vendor_name: str,
    wc_lookup: dict,
    svc_by_name: dict,
    svc_by_vendor: dict,
) -> tuple[dict | None, dict | None, str | None]:
    """Resolve one step's name to an in-house station OR an outside service.

    Returns `(work_center, vendor_service, error_message)`; exactly one of the
    first two is non-None when there is no error.

    Resolution order, and why:
      1. `vendor_name` given -> look up (vendor, service) exactly. This is the
         unambiguous path and the reason the column exists.
      2. An in-house station of that name wins next. A shop's own station list
         is the smaller, better-curated namespace, and a name collision between
         a station and a service is far more likely to mean the station.
      3. Exactly ONE service of that name -> use it.
      4. SEVERAL services of that name -> an error naming the vendors, never a
         guess. The old code kept whichever row came back last, which routed
         cost-bearing steps into the wrong vendor's price with no warning.
    """
    key = wc_name.lower()

    if vendor_name:
        svc = svc_by_vendor.get(f"{vendor_name.lower()}::{key}")
        if svc:
            return None, svc, None
        return (
            None,
            None,
            f"'{wc_name}' is not a service offered by '{vendor_name}'.",
        )

    station = wc_lookup.get(key)
    if station:
        return station, None, None

    matches = svc_by_name.get(key, [])
    if len(matches) == 1:
        return None, matches[0], None
    if len(matches) > 1:
        vendors = ", ".join(
            sorted(
                (
                    (m.get("vendors") or [{}])[0]
                    if isinstance(m.get("vendors"), list)
                    else (m.get("vendors") or {})
                ).get("name")
                or "?"
                for m in matches
            )
        )
        return (
            None,
            None,
            f"'{wc_name}' is offered by more than one vendor ({vendors}). "
            f"Add a vendor_name column to say which.",
        )

    return None, None, None


# No longer an HTTP route. The per-entity import wizards that called /validate are gone;
# the only caller left is execute_import below, which needs the conflict report before it
# writes. Kept as a plain function so that call keeps working.
async def validate_import(
    request: RoutingValidateRequest,
    supabase: Client = Depends(get_supabase),
):
    """Validate routings CSV data before import."""
    try:
        parts_lookup, wc_lookup, svc_by_name, svc_by_vendor = _load_lookups(
            supabase, request.company_id
        )
        miscellaneous = wc_lookup.get(MISCELLANEOUS_WC_NAME.lower())

        # Existing routing_operations for the company's parts
        existing_part_ids = [p["id"] for p in parts_lookup.values()]
        existing_routing_ops: list[dict] = []
        if existing_part_ids:
            routings_response = (
                supabase.table("routings")
                .select("id, part_id")
                .eq("company_id", request.company_id)
                .execute()
            )
            existing_routings = routings_response.data or []
            existing_routing_id_to_part = {
                r["id"]: r["part_id"] for r in existing_routings
            }
            if existing_routings:
                ops_response = (
                    supabase.table("routing_operations")
                    .select("id, routing_id, sequence")
                    .in_("routing_id", list(existing_routing_id_to_part.keys()))
                    .execute()
                )
                existing_routing_ops = ops_response.data or []
        else:
            existing_routing_id_to_part = {}

        existing_op_pairs: set[tuple[str, int]] = set()
        for op in existing_routing_ops:
            part_id = existing_routing_id_to_part.get(op["routing_id"])
            seq = op.get("sequence")
            if part_id is not None and seq is not None:
                existing_op_pairs.add((part_id, int(seq)))

        reverse_mappings = {v: k for k, v in request.mappings.items()}
        part_column = reverse_mappings.get("part_name")
        wc_column = reverse_mappings.get("work_center_name")
        sequence_column = reverse_mappings.get("sequence")
        setup_column = reverse_mappings.get("setup_minutes")
        cycle_column = reverse_mappings.get("cycle_minutes_per_unit")
        rate_column = reverse_mappings.get("labor_rate_override")
        ext_unit_column = reverse_mappings.get("external_unit_price")
        vendor_column = reverse_mappings.get("vendor_name")

        validation_errors: list[RoutingValidationError] = []
        conflicts: list[RoutingConflictInfo] = []
        fallbacks: list[RoutingFallbackInfo] = []
        validation_error_rows: set[int] = set()
        conflict_rows: set[int] = set()

        # Track sequence within CSV per (part_name, sequence) for csv_duplicate_sequence
        csv_seq_pairs: dict[tuple[str, int], list[int]] = {}
        # Track per-part next-sequence for rows missing an explicit sequence
        per_part_next_seq: dict[str, int] = {}

        for i, row in enumerate(request.rows):
            row_number = i + 1
            part_name = (
                row.get(part_column, "").strip() if part_column else ""
            )

            if not part_name:
                validation_errors.append(
                    RoutingValidationError(
                        row_number=row_number,
                        error_type="missing_part_name",
                        field="part_name",
                        message="Part name is required",
                    )
                )
                validation_error_rows.add(row_number)
                continue

            # Resolve work_center_name with MISCELLANEOUS fallback
            wc_name_raw = (
                row.get(wc_column, "").strip() if wc_column else ""
            )
            vendor_name_raw = (
                row.get(vendor_column, "").strip() if vendor_column else ""
            )
            resolved_wc = None
            resolved_svc = None
            if wc_name_raw:
                resolved_wc, resolved_svc, resolve_error = _resolve_target(
                    wc_name_raw, vendor_name_raw, wc_lookup, svc_by_name, svc_by_vendor
                )
                if resolve_error or (not resolved_wc and not resolved_svc):
                    conflicts.append(
                        RoutingConflictInfo(
                            row_number=row_number,
                            csv_part_name=part_name,
                            csv_work_center_name=wc_name_raw,
                            conflict_type=(
                                "ambiguous_work_center_name"
                                if resolve_error
                                else "unknown_work_center"
                            ),
                            existing_id="",
                            existing_value=(
                                resolve_error
                                or f"'{wc_name_raw}' is neither a work center nor an outside service. Import those first."
                            ),
                        )
                    )
                    conflict_rows.add(row_number)
                    continue
            else:
                # No work_center_name → MISCELLANEOUS fallback
                if miscellaneous:
                    resolved_wc = miscellaneous
                    fallbacks.append(
                        RoutingFallbackInfo(
                            row_number=row_number,
                            csv_part_name=part_name,
                            original_work_center_name="",
                            fallback_work_center_name=miscellaneous["name"],
                            reason="No work_center_name provided; routed to MISCELLANEOUS",
                        )
                    )
                else:
                    conflicts.append(
                        RoutingConflictInfo(
                            row_number=row_number,
                            csv_part_name=part_name,
                            csv_work_center_name="",
                            conflict_type="unknown_work_center",
                            existing_id="",
                            existing_value="Row has no work_center_name and no MISCELLANEOUS work_center exists. Import or create a work_center named 'MISCELLANEOUS' to enable the fallback.",
                        )
                    )
                    conflict_rows.add(row_number)
                    continue

            kind = "external" if resolved_svc else "internal"

            # Cost field validation against which target the step resolved to
            internal_fields = (
                ("setup_minutes", setup_column, "invalid_setup_minutes"),
                ("cycle_minutes_per_unit", cycle_column, "invalid_cycle_minutes"),
                ("labor_rate_override", rate_column, "invalid_labor_rate"),
            )
            external_fields = (
                ("external_unit_price", ext_unit_column, "invalid_external_unit_price"),
            )

            row_failed = False
            if kind == "internal":
                # Reject any external fields present on this row
                for db_field, csv_col, _ in external_fields:
                    if csv_col:
                        v = row.get(csv_col, "").strip()
                        if v:
                            validation_errors.append(
                                RoutingValidationError(
                                    row_number=row_number,
                                    error_type="external_field_on_internal",
                                    field=db_field,
                                    message=f"{db_field} cannot be set when work_center.kind='internal'",
                                )
                            )
                            validation_error_rows.add(row_number)
                            row_failed = True
                            break
                if row_failed:
                    continue
                for db_field, csv_col, err_type in internal_fields:
                    if csv_col:
                        v = row.get(csv_col, "").strip()
                        if v:
                            ok, val = _try_float(v)
                            if not ok or val < 0:
                                validation_errors.append(
                                    RoutingValidationError(
                                        row_number=row_number,
                                        error_type=err_type,
                                        field=db_field,
                                        message=f"{db_field} must be a non-negative number",
                                    )
                                )
                                validation_error_rows.add(row_number)
                                row_failed = True
                                break
                if row_failed:
                    continue
            else:  # external
                for db_field, csv_col, _ in internal_fields:
                    if csv_col:
                        v = row.get(csv_col, "").strip()
                        if v:
                            validation_errors.append(
                                RoutingValidationError(
                                    row_number=row_number,
                                    error_type="internal_field_on_external",
                                    field=db_field,
                                    message=f"{db_field} cannot be set when work_center.kind='external'",
                                )
                            )
                            validation_error_rows.add(row_number)
                            row_failed = True
                            break
                if row_failed:
                    continue
                for db_field, csv_col, err_type in external_fields:
                    if csv_col:
                        v = row.get(csv_col, "").strip()
                        if v:
                            ok, val = _try_float(v)
                            if not ok or val < 0:
                                validation_errors.append(
                                    RoutingValidationError(
                                        row_number=row_number,
                                        error_type=err_type,
                                        field=db_field,
                                        message=f"{db_field} must be a non-negative number",
                                    )
                                )
                                validation_error_rows.add(row_number)
                                row_failed = True
                                break
                if row_failed:
                    continue

            # Resolve sequence (CSV order grouped by part if not given)
            seq_str = (
                row.get(sequence_column, "").strip() if sequence_column else ""
            )
            if seq_str:
                ok, seq_val = _try_float(seq_str)
                if not ok:
                    validation_errors.append(
                        RoutingValidationError(
                            row_number=row_number,
                            error_type="invalid_sequence",
                            field="sequence",
                            message=f"Sequence must be a number",
                        )
                    )
                    validation_error_rows.add(row_number)
                    continue
                sequence = int(seq_val)
            else:
                sequence = per_part_next_seq.get(part_name.lower(), 0) + 1

            per_part_next_seq[part_name.lower()] = sequence

            # CSV duplicate sequence within same part
            seq_key = (part_name.lower(), sequence)
            csv_seq_pairs.setdefault(seq_key, []).append(row_number)

            # Resolve part for existing-op duplicate check
            part = parts_lookup.get(part_name.lower())
            if not part:
                conflicts.append(
                    RoutingConflictInfo(
                        row_number=row_number,
                        csv_part_name=part_name,
                        csv_work_center_name=resolved_wc["name"],
                        conflict_type="unknown_part",
                        existing_id="",
                        existing_value=f"Part '{part_name}' not found. Import parts first.",
                    )
                )
                conflict_rows.add(row_number)
                continue

            if (part["id"], sequence) in existing_op_pairs:
                conflicts.append(
                    RoutingConflictInfo(
                        row_number=row_number,
                        csv_part_name=part_name,
                        csv_work_center_name=resolved_wc["name"],
                        conflict_type="duplicate_routing_op",
                        existing_id="",
                        existing_value=f"Routing operation for {part_name} sequence {sequence} already exists",
                    )
                )
                conflict_rows.add(row_number)
                continue

        # Flag CSV-internal sequence duplicates
        for (part_lower, seq), rows in csv_seq_pairs.items():
            if len(rows) > 1:
                for row_number in rows[1:]:
                    if row_number in validation_error_rows or row_number in conflict_rows:
                        continue
                    conflicts.append(
                        RoutingConflictInfo(
                            row_number=row_number,
                            csv_part_name=part_lower,
                            csv_work_center_name=None,
                            conflict_type="csv_duplicate_sequence",
                            existing_id="",
                            existing_value=f"Duplicate sequence {seq} for part '{part_lower}' in CSV at rows {', '.join(map(str, rows))}",
                        )
                    )
                    conflict_rows.add(row_number)

        total_skipped = conflict_rows | validation_error_rows
        valid_rows = len(request.rows) - len(total_skipped)

        return RoutingValidateResponse(
            has_conflicts=len(conflicts) > 0,
            conflicts=conflicts,
            validation_errors=validation_errors,
            fallbacks=fallbacks,
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


@router.post("/execute", response_model=RoutingExecuteResponse)
async def execute_import(
    request: RoutingExecuteRequest,
    supabase: Client = Depends(get_supabase),
):
    """Execute the routings import.

    Groups rows by part_name. For each part, creates a `routings` row if one
    doesn't already exist (the schema's UNIQUE on routings.part_id makes this
    idempotent), then bulk-inserts the routing_operations.
    """
    try:
        validate_response = await validate_import(
            RoutingValidateRequest(
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

        # Existing operations (conflict_type "duplicate_routing_op") are NOT skipped: on a
        # re-import we upsert them in place (idempotent), the same way parts/vendors update
        # rather than error. Only genuine problems — unknown part, unresolved work center,
        # invalid or duplicated-in-CSV sequence — get skipped.
        skip_row_numbers = {
            c.row_number
            for c in validate_response.conflicts
            if c.conflict_type != "duplicate_routing_op"
        }
        skip_row_numbers |= {e.row_number for e in validate_response.validation_errors}

        parts_lookup, wc_lookup, svc_by_name, svc_by_vendor = _load_lookups(
            supabase, request.company_id
        )
        miscellaneous = wc_lookup.get(MISCELLANEOUS_WC_NAME.lower())

        reverse_mappings = {v: k for k, v in request.mappings.items()}
        part_column = reverse_mappings.get("part_name")
        wc_column = reverse_mappings.get("work_center_name")
        sequence_column = reverse_mappings.get("sequence")
        setup_column = reverse_mappings.get("setup_minutes")
        cycle_column = reverse_mappings.get("cycle_minutes_per_unit")
        rate_column = reverse_mappings.get("labor_rate_override")
        ext_unit_column = reverse_mappings.get("external_unit_price")
        vendor_column = reverse_mappings.get("vendor_name")
        instructions_column = reverse_mappings.get("instructions")

        # Group skipped-aware rows by part_name
        per_part_next_seq: dict[str, int] = {}
        per_part_ops: dict[str, list[dict]] = {}
        errors: list[RoutingImportError] = []
        skipped = 0

        for i, row in enumerate(request.rows):
            row_number = i + 1
            if row_number in skip_row_numbers:
                skipped += 1
                continue

            part_name = (
                row.get(part_column, "").strip() if part_column else ""
            )
            part = parts_lookup.get(part_name.lower())
            if not part:
                errors.append(
                    RoutingImportError(
                        row_number=row_number,
                        reason=f"Part '{part_name}' not found at execute time",
                        data={k: v for k, v in row.items() if v},
                    )
                )
                skipped += 1
                continue

            wc_name_raw = (
                row.get(wc_column, "").strip() if wc_column else ""
            )
            vendor_name_raw = (
                row.get(vendor_column, "").strip() if vendor_column else ""
            )
            resolved_svc = None
            if wc_name_raw:
                resolved_wc, resolved_svc, resolve_error = _resolve_target(
                    wc_name_raw, vendor_name_raw, wc_lookup, svc_by_name, svc_by_vendor
                )
            else:
                resolved_wc, resolve_error = miscellaneous, None
            if not resolved_wc and not resolved_svc:
                errors.append(
                    RoutingImportError(
                        row_number=row_number,
                        reason=resolve_error or "Step target could not be resolved for row",
                        data={k: v for k, v in row.items() if v},
                    )
                )
                skipped += 1
                continue

            seq_str = (
                row.get(sequence_column, "").strip() if sequence_column else ""
            )
            if seq_str:
                try:
                    sequence = int(float(seq_str))
                except ValueError:
                    skipped += 1
                    continue
            else:
                sequence = per_part_next_seq.get(part_name.lower(), 0) + 1
            per_part_next_seq[part_name.lower()] = sequence

            # Exactly one target, per routing_operations_exactly_one_target.
            op_data: dict = {
                "work_center_id": resolved_wc["id"] if resolved_wc else None,
                "vendor_service_id": resolved_svc["id"] if resolved_svc else None,
                "sequence": sequence,
                "metadata": {},
            }

            kind = "external" if resolved_svc else "internal"
            if kind == "internal":
                if setup_column:
                    v = row.get(setup_column, "").strip()
                    if v:
                        try:
                            op_data["setup_minutes"] = round(float(v), 2)
                        except ValueError:
                            pass
                if cycle_column:
                    v = row.get(cycle_column, "").strip()
                    if v:
                        try:
                            op_data["cycle_minutes_per_unit"] = round(float(v), 4)
                        except ValueError:
                            pass
                if rate_column:
                    v = row.get(rate_column, "").strip()
                    if v:
                        try:
                            op_data["labor_rate_override"] = round(float(v), 2)
                        except ValueError:
                            pass
            else:
                if ext_unit_column:
                    v = row.get(ext_unit_column, "").strip()
                    if v:
                        try:
                            op_data["external_unit_price"] = round(float(v), 4)
                        except ValueError:
                            pass

            if instructions_column:
                v = row.get(instructions_column, "").strip()
                if v and v.lower() != "undefined":
                    op_data["instructions"] = v

            per_part_ops.setdefault(part["id"], []).append(op_data)

        # Look up existing routings (we need to upsert by part_id)
        if per_part_ops:
            existing_routings_response = (
                supabase.table("routings")
                .select("id, part_id")
                .in_("part_id", list(per_part_ops.keys()))
                .execute()
            )
            existing_routings = existing_routings_response.data or []
        else:
            existing_routings = []
        part_id_to_routing_id = {r["part_id"]: r["id"] for r in existing_routings}

        # Existing (routing_id, sequence) pairs, so we can (a) upsert without colliding and
        # (b) report created-vs-updated honestly. Paged past PostgREST's 1000-row cap: an
        # unpaged lookup only saw the first 1000, so a re-import of thousands of operations
        # tried a plain INSERT on the rest and 500'd every batch — that WAS the "N errors" a
        # full re-import showed.
        existing_op_pairs: set[tuple[str, int]] = set()
        if part_id_to_routing_id:
            for op in fetch_all_in(
                supabase,
                "routing_operations",
                "routing_id, sequence",
                "routing_id",
                list(part_id_to_routing_id.values()),
            ):
                seq = op.get("sequence")
                if seq is not None:
                    existing_op_pairs.add((op["routing_id"], int(seq)))

        imported_routings = 0
        imported_operations = 0
        updated_operations = 0

        # Create routings rows for parts that don't yet have one
        new_routings_payload = []
        for part_id in per_part_ops.keys():
            if part_id not in part_id_to_routing_id:
                # Look up part_name for the routing.name field (defensive — if
                # part_name is missing we still want a non-null name)
                part_name = "Imported routing"
                for name_lower, p in parts_lookup.items():
                    if p["id"] == part_id:
                        part_name = p.get("part_name") or part_name
                        break
                new_routings_payload.append(
                    {
                        "company_id": request.company_id,
                        "part_id": part_id,
                        "name": f"Routing for {part_name}",
                    }
                )
        if new_routings_payload:
            try:
                response = (
                    supabase.table("routings").insert(new_routings_payload).execute()
                )
                created = response.data or []
                imported_routings = len(created)
                for r in created:
                    part_id_to_routing_id[r["part_id"]] = r["id"]
            except Exception as e:
                sentry_sdk.capture_exception(e)
                raise HTTPException(status_code=500, detail="Internal server error")

        # Build the write set. Existing (routing_id, sequence) rows UPDATE in place; new ones
        # insert — one idempotent upsert on the table's unique key, so a re-import never
        # collides. (Assumes a stable `sequence` per row, which routing exports carry; rows
        # auto-numbered because the CSV had no sequence column are the pre-existing exception.)
        ops_to_write: list[dict] = []
        for part_id, ops in per_part_ops.items():
            routing_id = part_id_to_routing_id.get(part_id)
            if not routing_id:
                continue
            for op in ops:
                op_with_routing = dict(op)
                op_with_routing["routing_id"] = routing_id
                if (routing_id, int(op["sequence"])) in existing_op_pairs:
                    updated_operations += 1
                ops_to_write.append(op_with_routing)

        if ops_to_write:
            BATCH_SIZE = 500
            try:
                total = len(ops_to_write)
                for batch_start in range(0, total, BATCH_SIZE):
                    batch = ops_to_write[batch_start : batch_start + BATCH_SIZE]
                    response = (
                        supabase.table("routing_operations")
                        .upsert(batch, on_conflict="routing_id,sequence")
                        .execute()
                    )
                    imported_operations += len(response.data) if response.data else 0
            except Exception as e:
                error_str = str(e)
                if "23505" in error_str or "duplicate key" in error_str.lower():
                    raise HTTPException(
                        status_code=400,
                        detail="Import failed: A routing operation for this part+sequence already exists.",
                    )
                sentry_sdk.capture_exception(e)
                raise HTTPException(status_code=500, detail="Internal server error")

        # imported_operations counts everything upsert wrote (inserts + updates); split the
        # updates back out so the summary reads "created" vs "updated" like the other imports.
        created_operations = max(0, imported_operations - updated_operations)

        return RoutingExecuteResponse(
            success=True,
            imported_routings_count=imported_routings,
            imported_operations_count=created_operations,
            updated_count=updated_operations,
            skipped_count=skipped,
            errors=errors,
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Routings import execution error: {str(e)}", exc_info=True)
        sentry_sdk.capture_exception(e)
        raise HTTPException(
            status_code=500,
            detail="Internal server error",
        )
