"""Import routes for parts CSV import with AI-powered mapping.

The unified Parts importer absorbs the previous inventory_items import path.
A row is classified on ONE axis, `source`:

  - source='made'   → produced in-shop (built to order, will have a routing)
  - source='bought' → procured from a vendor

Auto-classification rules at execute time (when no explicit source mapping is
provided):
  - source='bought' if procurement fields (cost_per_unit, primary_unit,
    quantity, reorder_point) are present and there are NO operation columns
  - source='made'   if any operation columns are present, or if no procurement
    fields are set

`is_stocked` was a second axis, giving four quadrants (Custom Made /
Sub-assembly / Raw Material / Service+Drop-ship), and the importer inferred it
from a three-tier chain: explicit column, then the legacy `is_stockable` alias,
then a guess from whether primary_unit / quantity / cost_per_unit were present.
All of it is gone with the column. Every part can carry stock and starts at
quantity 0, so a CSV says how MUCH of a part there is (`quantity`) and never
whether it is "a stocked part" — which also retires the legacy
`is_manufacturable` / `is_stockable` aliases and their deprecation log entry.

Idempotent by part number: every row is upserted ON CONFLICT
(company_id, part_name), the table's real unique key — so re-importing the same
export updates parts in place rather than skipping or duplicating them. (No
dependence on a `legacy_id` column; real ERP exports don't carry one.)
"""

import logging
import re

import sentry_sdk
from typing import Optional

from fastapi import APIRouter, HTTPException, Depends
from supabase import Client

from models.parts_import_models import (
    PartValidateRequest,
    PartValidateResponse,
    PartValidationError,
    PartConflictInfo,
    PartExecuteRequest,
    PartExecuteResponse,
    PartImportError,
    parse_bool,
)
from services.uom_normalizer import (
    normalize_uom_alias,
    resolve_units_for_rows,
)
from utils.db_pagination import fetch_all_by_company

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/parts/import", tags=["parts-import"])


















def _has_routing_columns(mappings: dict[str, str]) -> bool:
    """Detect if the import includes any operation/work_center columns."""
    db_fields = set(mappings.values())
    routing_indicators = {
        "work_center_name",
        "operation_name",
        "setup_minutes",
        "cycle_minutes_per_unit",
        "labor_rate_override",
        "external_unit_price",
        "external_setup_cost",
    }
    return bool(db_fields & routing_indicators)




def _row_has_procurement_data(
    row: dict[str, str],
    reverse_mappings: dict[str, str],
) -> bool:
    """Detect if a row carries procurement data (cost/unit/qty/reorder set).

    Used to infer source='bought' when the CSV doesn't supply an explicit
    source column. A row with procurement fields and no operation columns is
    almost certainly a bought row.
    """
    for db_field in ("cost_per_unit", "primary_unit", "quantity", "reorder_point"):
        col = reverse_mappings.get(db_field)
        if col and row.get(col, "").strip():
            return True
    return False


def _legacy_manufacturable_to_source(value: str) -> Optional[str]:
    """Translate the legacy is_manufacturable boolean string into a source value.

    Returns 'made' for truthy, 'bought' for falsy, None for empty/unrecognized.
    Empty/unrecognized falls back to the auto-classification path.
    """
    parsed = parse_bool(value)
    if parsed is True:
        return "made"
    if parsed is False:
        return "bought"
    return None


def get_supabase() -> Client:
    """Get Supabase client from the main app."""
    from index import supabase

    if not supabase:
        raise HTTPException(
            status_code=500,
            detail="Supabase client not initialized",
        )
    return supabase


def _reject_customer_fields(request) -> None:
    """RAISE 400 if any customer field is present on a parts-import request.

    Parts no longer link to customers at the data layer (customer association
    lives on quotes/jobs only). Per the no-silent-fallbacks engineering
    principle we surface this as a hard error rather than dropping the value
    on the floor — accepting the field would let the caller believe a customer
    link was saved when it wasn't.

    Mirrored on /validate and /execute, plus on the column mapping (a
    `customer_name` mapping is the same kind of dead-end input).
    """
    customer_match_mode = getattr(request, "customer_match_mode", None)
    selected_customer_id = getattr(request, "selected_customer_id", None)
    mappings = getattr(request, "mappings", {}) or {}

    has_customer_field = (
        customer_match_mode is not None
        or selected_customer_id is not None
        or "customer_name" in mappings.values()
        or "customer_id" in mappings.values()
    )

    if has_customer_field:
        raise HTTPException(
            status_code=400,
            detail={
                "error": "customer_link_removed",
                "message": (
                    "Parts no longer link to customers at the data layer. "
                    "Customer association lives on quotes/jobs only. Update "
                    "the parts import flow to stop sending customer fields."
                ),
            },
        )








# No longer an HTTP route. The per-entity import wizards that called /validate are gone;
# the only caller left is execute_import below, which needs the conflict report before it
# writes. Kept as a plain function so that call keeps working.
async def validate_import(
    request: PartValidateRequest,
    supabase: Client = Depends(get_supabase),
):
    """Validate parts CSV data before import.

    Checks (in order, per row):
      1. Required field: part_name
      2. Numeric ranges: quantity, cost_per_unit, reorder_point all non-negative
      3. UOM resolution for every row (alias map → AI inference fallback)
      4. preferred_vendor_name resolves against existing vendors
      5. Within-CSV duplicate part_name (csv_duplicate) — the second and later
         copies skip; the upsert can't touch the same key twice in one batch

    An existing part_name is NOT a conflict: execute upserts on
    (company_id, part_name), so a re-imported part updates in place.

    Customer fields (`customer_match_mode`, `selected_customer_id`, or a
    `customer_name`/`customer_id` mapping) are rejected with 400 — parts no
    longer link to customers at the data layer.
    """
    _reject_customer_fields(request)
    try:
        # Existing vendors (for preferred_vendor_name resolution). Paged past the 1000-row cap.
        existing_vendors = fetch_all_by_company(
            supabase, "vendors", "id, name", request.company_id
        )
        vendor_name_to_id = {
            v["name"].lower(): v["id"] for v in existing_vendors
        }

        reverse_mappings = {v: k for k, v in request.mappings.items()}
        part_name_column = reverse_mappings.get("part_name")
        primary_unit_column = reverse_mappings.get("primary_unit")
        quantity_column = reverse_mappings.get("quantity")
        cost_column = reverse_mappings.get("cost_per_unit")
        reorder_column = reverse_mappings.get("reorder_point")
        vendor_column = reverse_mappings.get("preferred_vendor_name")
        # New (chunk 11) columns:
        source_column = reverse_mappings.get("source")
        # Legacy alias (kept one-version for CSVs already prepared with the
        # old header — see module docstring):
        legacy_is_manufacturable_column = reverse_mappings.get("is_manufacturable")
        description_column = reverse_mappings.get("description")

        has_routing_cols = _has_routing_columns(request.mappings)

        # First pass: track part_name occurrences to flag within-CSV duplicates. The second and
        # later copies skip — the upsert can't touch the same (company_id, part_name) key twice
        # in one batch (Postgres 21000).
        part_occurrences: dict[str, list[int]] = {}
        for i, row in enumerate(request.rows):
            row_number = i + 1 + request.batch_offset
            part_name = (
                row.get(part_name_column, "").strip() if part_name_column else ""
            )
            if part_name:
                part_occurrences.setdefault(part_name.lower(), []).append(row_number)

        csv_duplicates = {k: v for k, v in part_occurrences.items() if len(v) > 1}

        # Second pass: per-row validation
        validation_errors: list[PartValidationError] = []
        conflicts: list[PartConflictInfo] = []
        validation_error_rows: set[int] = set()
        conflict_rows: set[int] = set()

        # Resolve UOMs for EVERY row that has a unit column — not just stocked ones.
        #
        # `parts_requires_unit` makes a unit mandatory for every part (stocked or "made"), so a
        # unit has to be resolved for every row. This previously ran only for `stocked_row_numbers`,
        # which meant a filled unit on a NON-stocked ("made") part was never resolved: it then hit
        # the "have a raw unit but no resolved unit" branch and was rejected as `unknown_unit` and
        # skipped — even a perfectly good "each". That's why filling units still skipped ~7,700
        # parts on the Tangle export (whose parts were all non-stocked). resolve_units_for_rows
        # returns 1-based indices into the rows we pass, so add batch_offset to get row_number.
        if request.pre_resolved_uoms:
            uom_resolutions: dict[int, Optional[str]] = dict(request.pre_resolved_uoms)
        elif primary_unit_column or description_column:
            partial = resolve_units_for_rows(
                request.rows,
                name_column=part_name_column,
                description_column=description_column,
                uom_column=primary_unit_column,
            )
            uom_resolutions = {k + request.batch_offset: v for k, v in partial.items()}
        else:
            uom_resolutions = {}

        for i, row in enumerate(request.rows):
            row_number = i + 1 + request.batch_offset
            part_name = (
                row.get(part_name_column, "").strip() if part_name_column else ""
            )

            # Required: part_name
            if not part_name:
                validation_errors.append(
                    PartValidationError(
                        row_number=row_number,
                        error_type="missing_part_name",
                        field="part_name",
                        message="Part name is required",
                    )
                )
                validation_error_rows.add(row_number)
                continue

            # Numeric validation: quantity
            qty_str = row.get(quantity_column, "").strip() if quantity_column else ""
            if qty_str:
                try:
                    qty_val = float(qty_str)
                    if qty_val < 0:
                        raise ValueError("negative")
                except ValueError:
                    validation_errors.append(
                        PartValidationError(
                            row_number=row_number,
                            error_type="invalid_quantity",
                            field="quantity",
                            message="Quantity must be a non-negative number",
                        )
                    )
                    validation_error_rows.add(row_number)
                    continue

            # Numeric validation: cost_per_unit
            cost_str = row.get(cost_column, "").strip() if cost_column else ""
            if cost_str:
                try:
                    cost_val = float(cost_str)
                    if cost_val < 0:
                        raise ValueError("negative")
                except ValueError:
                    validation_errors.append(
                        PartValidationError(
                            row_number=row_number,
                            error_type="invalid_cost",
                            field="cost_per_unit",
                            message="Cost per unit must be a non-negative number",
                        )
                    )
                    validation_error_rows.add(row_number)
                    continue

            # Numeric validation: reorder_point
            reorder_str = row.get(reorder_column, "").strip() if reorder_column else ""
            if reorder_str:
                try:
                    reorder_val = float(reorder_str)
                    if reorder_val < 0:
                        raise ValueError("negative")
                except ValueError:
                    validation_errors.append(
                        PartValidationError(
                            row_number=row_number,
                            error_type="invalid_reorder_point",
                            field="reorder_point",
                            message="Reorder point must be a non-negative number",
                        )
                    )
                    validation_error_rows.add(row_number)
                    continue

            # UOM is required for EVERY part, not just stocked ones — the DB
            # enforces it unconditionally via the `parts_requires_unit` check
            # constraint. Flagging it only for stocked rows let unit-less rows
            # through validate and then blew up execute's batch insert.
            resolved_unit = uom_resolutions.get(row_number)
            csv_unit = (
                row.get(primary_unit_column, "").strip()
                if primary_unit_column
                else ""
            )
            if not resolved_unit and not csv_unit:
                validation_errors.append(
                    PartValidationError(
                        row_number=row_number,
                        error_type="missing_primary_unit",
                        field="primary_unit",
                        message="Unit of measure is required — every part needs one",
                    )
                )
                validation_error_rows.add(row_number)
                continue
            if not resolved_unit and csv_unit:
                # Could not normalize — surface as conflict (unknown_unit)
                conflicts.append(
                    PartConflictInfo(
                        row_number=row_number,
                        csv_part_name=part_name,
                        csv_customer_code=None,
                        conflict_type="unknown_unit",
                        existing_part_id="",
                        existing_value=f"Could not normalize unit '{csv_unit}' to a known canonical value",
                    )
                )
                conflict_rows.add(row_number)
                continue

            # Vendor resolution
            vendor_name = (
                row.get(vendor_column, "").strip() if vendor_column else ""
            )
            if vendor_name and vendor_name.lower() not in vendor_name_to_id:
                hint = (
                    " The value looks like a numeric ID, not a vendor name — "
                    "the source row may have been split incorrectly during CSV parsing."
                    if vendor_name.isdigit()
                    else ""
                )
                conflicts.append(
                    PartConflictInfo(
                        row_number=row_number,
                        csv_part_name=part_name,
                        csv_customer_code=None,
                        conflict_type="unknown_vendor",
                        existing_part_id="",
                        existing_value=f"Vendor '{vendor_name}' not found. Import vendors first.{hint}",
                    )
                )
                conflict_rows.add(row_number)
                continue

            # CSV duplicate (only flag the second-and-later occurrences)
            key = part_name.lower()
            if key in csv_duplicates:
                other_rows = [r for r in csv_duplicates[key] if r != row_number]
                if other_rows:
                    conflicts.append(
                        PartConflictInfo(
                            row_number=row_number,
                            csv_part_name=part_name,
                            csv_customer_code=None,
                            conflict_type="csv_duplicate",
                            existing_part_id="",
                            existing_value=f"Duplicate in CSV at rows {', '.join(map(str, other_rows))}",
                        )
                    )
                    conflict_rows.add(row_number)
                    continue

            # An existing part_name is NOT a conflict — the import upserts on
            # (company_id, part_name), so it updates in place. (We used to skip it,
            # or upsert only when a curated `legacy_id` column happened to be
            # present; part_name is the DB's real unique key, so re-imports are
            # idempotent for everyone now, no legacy_id needed.)

        total_skipped = conflict_rows | validation_error_rows
        valid_rows = len(request.rows) - len(total_skipped)

        return PartValidateResponse(
            has_conflicts=len(conflicts) > 0,
            conflicts=conflicts,
            validation_errors=validation_errors,
            valid_rows_count=valid_rows,
            conflict_rows_count=len(conflict_rows),
            error_rows_count=len(validation_error_rows),
            skipped_rows_count=len(total_skipped),
            uom_resolutions={
                row: unit for row, unit in uom_resolutions.items() if unit
            },
        )

    except HTTPException:
        raise
    except Exception as e:
        sentry_sdk.capture_exception(e)
        raise HTTPException(
            status_code=500,
            detail="Internal server error",
        )


@router.post("/execute", response_model=PartExecuteResponse)
async def execute_import(
    request: PartExecuteRequest,
    supabase: Client = Depends(get_supabase),
):
    """Execute the parts import.

    - Auto-classifies rows by source:
      - source='made'   if any operation columns are present, OR if there are
        no procurement fields (cost/unit/qty/reorder)
      - source='bought' if procurement fields are present and there are no
        operation columns
    - Accepts the legacy header `is_manufacturable` as a column-mapping alias
      (one-version compat). Each legacy-mapped row writes a deprecation log
      entry. See the module docstring.
    - Resolves preferred_vendor_name to vendor_id (rows that failed validation
      have already been excluded from the write set).
    - Idempotent: every row is upserted ON CONFLICT (company_id, part_name), the
      table's real unique key — so re-importing the same export updates parts in
      place instead of skipping or duplicating them, with no dependence on a
      curated `legacy_id` column that real ERP exports don't have.

    Customer fields on the request are rejected with 400 — parts no longer
    link to customers at the data layer.
    """
    _reject_customer_fields(request)
    logger.info(
        f"Parts import execute started: {len(request.rows)} rows, company_id={request.company_id}"
    )

    try:
        validate_response = await validate_import(
            PartValidateRequest(
                company_id=request.company_id,
                mappings=request.mappings,
                pricing_columns=request.pricing_columns,
                rows=request.rows,
                pre_resolved_uoms=request.uom_resolutions,
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

        # UOM resolutions (prefer the ones the frontend already received from validate)
        uom_resolutions = (
            request.uom_resolutions or validate_response.uom_resolutions
        )

        reverse_mappings = {v: k for k, v in request.mappings.items()}
        part_name_column = reverse_mappings.get("part_name")
        description_column = reverse_mappings.get("description")
        primary_unit_column = reverse_mappings.get("primary_unit")
        quantity_column = reverse_mappings.get("quantity")
        cost_column = reverse_mappings.get("cost_per_unit")
        reorder_column = reverse_mappings.get("reorder_point")
        vendor_column = reverse_mappings.get("preferred_vendor_name")
        # New (chunk 11) columns:
        source_column = reverse_mappings.get("source")
        # Legacy alias (one-version compat — see module docstring):
        legacy_is_manufacturable_column = reverse_mappings.get("is_manufacturable")
        if legacy_is_manufacturable_column:
            logger.warning(
                "Parts import using the legacy header is_manufacturable. "
                "It is deprecated; use 'source' (made|bought) instead. "
                "company_id=%s",
                request.company_id,
            )

        has_routing_cols = _has_routing_columns(request.mappings)

        rows_to_upsert: list[dict] = []
        # parts.cost_per_unit was dropped in migration 20260514. For bought rows with a CSV
        # cost, stage NULL-vendor procurement tiers (min_quantity=1) and write them after the
        # parts commit. Each entry is (part_name, cost_val) — resolved to part_id by part_name
        # once the rows are persisted.
        pending_procurement_tiers: list[tuple[str, float]] = []
        errors: list[PartImportError] = []
        skipped = 0

        # Existing parts, keyed by lowercased name. Fetched BEFORE the row loop because the
        # loop needs three things from it: whether the part is location-tracked (its quantity
        # must not be written directly — see below), its prior quantity (the delta on the
        # provenance ledger row), and its primary_unit. Also drives the created/updated split,
        # which the upsert response can't tell apart.
        existing_by_name: dict[str, dict] = {
            (p.get("part_name") or "").lower(): p
            for p in fetch_all_by_company(
                supabase,
                "parts",
                "id, part_name, quantity, primary_unit",
                request.company_id,
            )
        }

        # Opening balances staged for after the upsert, when the part ids are known.
        # Each entry is (part_name, prior_qty, new_qty, unit).
        pending_balances: list[tuple[str, float, float, str]] = []
        # Rows whose quantity was deliberately NOT written because the part already holds stock
        # at a real place. Surfaced in the response — never silently dropped.
        already_placed_skips: list[str] = []

        for i, row in enumerate(request.rows):
            row_number = i + 1

            if row_number in skip_row_numbers:
                skipped += 1
                continue

            part_name = (
                row.get(part_name_column, "").strip() if part_name_column else ""
            )
            part_data: dict = {
                "company_id": request.company_id,
                "part_name": part_name,
            }

            if description_column:
                value = row.get(description_column, "").strip()
                if value and value.lower() != "undefined":
                    part_data["description"] = value

            # Inventory fields
            primary_unit = ""
            if primary_unit_column:
                primary_unit = row.get(primary_unit_column, "").strip()
            resolved_unit = uom_resolutions.get(row_number)
            if not resolved_unit and primary_unit:
                resolved_unit = normalize_uom_alias(primary_unit)

            quantity_str = (
                row.get(quantity_column, "").strip() if quantity_column else ""
            )
            cost_str = row.get(cost_column, "").strip() if cost_column else ""
            reorder_str = (
                row.get(reorder_column, "").strip() if reorder_column else ""
            )

            quantity_val: Optional[float] = None
            if quantity_str:
                try:
                    quantity_val = float(quantity_str)
                except ValueError:
                    quantity_val = None
            cost_val: Optional[float] = None
            if cost_str:
                try:
                    cost_val = float(cost_str)
                except ValueError:
                    cost_val = None
            reorder_val: Optional[float] = None
            if reorder_str:
                try:
                    reorder_val = float(reorder_str)
                except ValueError:
                    reorder_val = None

            # Auto-classification: source, and only source.
            #
            # There was a parallel three-tier chain here for is_stocked (explicit column >
            # legacy is_stockable alias > inferred from primary_unit/quantity/cost). The
            # column is gone: every part can carry stock and starts at 0, so `quantity`
            # already says everything the flag was guessing at.
            #
            # source: explicit 'source' column > legacy is_manufacturable
            # alias > inferred from operation columns vs procurement fields.
            explicit_source: Optional[str] = None
            if source_column:
                raw = row.get(source_column, "").strip().lower()
                if raw in ("made", "bought"):
                    explicit_source = raw
            if explicit_source is None and legacy_is_manufacturable_column:
                explicit_source = _legacy_manufacturable_to_source(
                    row.get(legacy_is_manufacturable_column, "")
                )

            if explicit_source is not None:
                source_val = explicit_source
            else:
                # Inference rule: routing columns ⇒ made; procurement-only ⇒
                # bought; otherwise default to 'made' (matches the migration's
                # orphan-default rule, and is the safe default for hand-created
                # rows).
                has_proc = _row_has_procurement_data(row, reverse_mappings)
                if has_routing_cols:
                    source_val = "made"
                elif has_proc:
                    source_val = "bought"
                else:
                    source_val = "made"

            part_data["source"] = source_val

            if legacy_is_manufacturable_column:
                logger.info(
                    "Parts import row %s used the legacy header is_manufacturable "
                    "(deprecated). Mapped to source=%s. company_id=%s",
                    row_number,
                    source_val,
                    request.company_id,
                )

            # Backstop for `parts_requires_unit` — an UNCONDITIONAL check
            # constraint (CHECK (primary_unit IS NOT NULL)). Validate above
            # should already have skipped this row; this catches it if the two
            # ever drift apart again. Worth the redundancy: the insert below is
            # batched 500 at a time, so ONE unit-less row reaching Postgres
            # raises APIError and loses the entire batch — every good row with
            # it. That's how this shipped as a 500 rather than a skipped row.
            if not resolved_unit:
                errors.append(
                    PartImportError(
                        row_number=row_number,
                        reason=(
                            "Unit of measure is required — every part needs one "
                            "(e.g. 'each', 'lbs', 'in')."
                        ),
                        data={"part_name": part_name},
                    )
                )
                continue

            part_data["primary_unit"] = resolved_unit

            # `quantity` is NEVER written here — not on insert, not on update.
            #
            # It stopped being a column you set in 20260802015837: every part has a place now, so
            # `parts.quantity` is a trigger-maintained rollup of `part_location_stock` for all of
            # them, and `enforce_tracked_part_quantity` (BEFORE UPDATE) raises on any direct write
            # that disagrees with the sum. Because upserts are batched 500 at a time, one such row
            # failed all 500 with an opaque 500. An INSERT slips past that trigger, which is worse:
            # it lands a part whose quantity has no balances behind it, breaking at rest the very
            # invariant the migration asserts.
            #
            # So the number goes where the number lives — a balance at the company's `Unassigned`
            # bucket, written after the upsert once part ids are known. The rollup trigger then
            # sets `parts.quantity` itself.
            #
            # Still never written when unmapped: `quantity_val is None` means the CSV said nothing,
            # and an explicit 0 on a re-import used to zero every existing part's stock.
            existing = existing_by_name.get(part_name.lower())
            if quantity_val is not None:
                prior_qty = float(existing.get("quantity") or 0) if existing else 0.0
                pending_balances.append(
                    (part_name, prior_qty, float(quantity_val), resolved_unit)
                )
            # parts.cost_per_unit was dropped (migration 20260514). For bought
            # rows we stage a NULL-vendor procurement tier post-insert; made
            # rows' cost_val is ignored — compute_part_cost_at_qty recomputes
            # live from routing + BOM.
            if reorder_val is not None:
                part_data["reorder_point"] = reorder_val

            # Vendor resolution
            vendor_name = (
                row.get(vendor_column, "").strip() if vendor_column else ""
            )
            if vendor_name:
                vendor_id = vendor_name_to_id.get(vendor_name.lower())
                if vendor_id:
                    part_data["preferred_vendor_id"] = vendor_id

            rows_to_upsert.append(part_data)

            # Stage a procurement tier for bought rows that supplied a cost.
            if source_val == "bought" and cost_val is not None and cost_val > 0:
                pending_procurement_tiers.append((part_name, cost_val))

        # Idempotent write: upsert every row on (company_id, part_name) — existing parts update
        # in place, new ones insert. Split created vs updated by which names existed before this
        # run (the upsert response can't tell them apart). id_by_part_name lets us attach the
        # staged procurement tiers without a re-query.
        BATCH_SIZE = 500
        imported_count = sum(
            1 for r in rows_to_upsert if r["part_name"].lower() not in existing_by_name
        )
        updated_count = len(rows_to_upsert) - imported_count
        id_by_part_name: dict[str, str] = {}

        # Reusing an archived part's name CREATES a new part; it no longer revives the
        # archived one. Move any archived namesake aside first, so the upsert's
        # ON CONFLICT finds nothing and inserts. Without this the two create paths
        # disagree — the part form and the drawings importer would create while a CSV
        # of the same names revived — and which one a shop got would depend on how it
        # happened to add the parts.
        #
        # Only names actually in this batch move. Part names are read live by quotes and
        # invoices, so a rename is not free and archived parts nobody is asking for keep
        # theirs. See migration 20260818141141.
        for name in {r["part_name"] for r in rows_to_upsert}:
            try:
                supabase.rpc(
                    "reclaim_part_name",
                    {"p_company_id": request.company_id, "p_name": name},
                ).execute()
            except Exception as e:
                # Fail before writing anything, rather than half-applying the rule.
                # If the rename did not happen, ON CONFLICT matches the ARCHIVED row
                # and DO UPDATE writes into it without clearing deleted_at — the
                # import would report success over a part that stays invisible.
                # Nothing has been upserted yet at this point, so raising is clean.
                logger.error("reclaim_part_name failed: %s", type(e).__name__)
                raise HTTPException(
                    status_code=500,
                    detail="Could not prepare archived part names for this import. Nothing was imported.",
                ) from e

        if rows_to_upsert:
            try:
                for batch_start in range(0, len(rows_to_upsert), BATCH_SIZE):
                    batch = rows_to_upsert[batch_start : batch_start + BATCH_SIZE]
                    response = (
                        supabase.table("parts")
                        .upsert(batch, on_conflict="company_id,part_name")
                        .execute()
                    )
                    for row in response.data or []:
                        if row.get("id") and row.get("part_name"):
                            id_by_part_name[row["part_name"]] = row["id"]
            except Exception as e:
                error_str = str(e)
                logger.error(f"Parts import upsert error: {error_str}", exc_info=True)
                sentry_sdk.capture_exception(e)
                raise HTTPException(status_code=500, detail="Internal server error")

        # ── Opening balances ───────────────────────────────────────────────
        # The imported quantity is written as a BALANCE at the company's `Unassigned` bucket,
        # not as `parts.quantity`. The rollup trigger on `part_location_stock` derives the part
        # total from it, which is the only way that column is allowed to change now.
        #
        # Written directly rather than through `adjust_stock_at_location`, deliberately: that RPC
        # is per-part, and an onboarding import is thousands of rows — Contour's parts file alone
        # would be ~8k sequential round trips. The batched upsert keeps the same trigger as the
        # single source of truth for the rollup; only the ledger row is hand-written, exactly as
        # it already was.
        #
        # A quantity is skipped when the part ALREADY holds stock at a real place. "240 on hand"
        # from a spreadsheet cannot say which shelf to correct, and dumping it into `Unassigned`
        # would silently inflate the total. This is the same refusal the old
        # `is_location_tracked` check made, on the condition that actually matters.
        if pending_balances:
            try:
                unassigned_id = supabase.rpc(
                    "inv_get_or_create_unassigned", {"p_company_id": request.company_id}
                ).execute().data

                staged = [
                    (name, prior_qty, new_qty, unit)
                    for name, prior_qty, new_qty, unit in pending_balances
                    if name in id_by_part_name
                ]
                part_ids = [id_by_part_name[name] for name, _, _, _ in staged]

                # Any stock at a place that isn't the Unassigned bucket makes the CSV number
                # ambiguous. The `.gt("quantity", 0)` is KEPT after 20260802144310 deleted the
                # zero-row residue: here it is a business predicate ("is this actually placed
                # somewhere?"), not residue-hiding, so it stays correct under either data state
                # and states its own intent at the point of use.
                placed: set[str] = set()
                for batch_start in range(0, len(part_ids), BATCH_SIZE):
                    res = (
                        supabase.table("part_location_stock")
                        .select("part_id, location_id")
                        .in_("part_id", part_ids[batch_start : batch_start + BATCH_SIZE])
                        .gt("quantity", 0)
                        .execute()
                    )
                    for r in res.data or []:
                        if r["location_id"] != unassigned_id:
                            placed.add(r["part_id"])

                balance_rows: list[dict] = []
                zeroed_part_ids: list[str] = []
                ledger_rows: list[dict] = []
                for name, prior_qty, new_qty, unit in staged:
                    part_id = id_by_part_name[name]
                    if part_id in placed:
                        already_placed_skips.append(name)
                        continue
                    # Unchanged numbers need no write and no ledger row — re-importing the same
                    # file twice should be a no-op, not a wall of zero-delta "adjustments".
                    if prior_qty == new_qty:
                        continue
                    # A zero opening balance is a DELETE, not an upsert: `part_location_stock`
                    # CHECKs `quantity > 0` since 20260802144310, so writing a 0 raises.
                    if new_qty == 0:
                        zeroed_part_ids.append(part_id)
                    else:
                        balance_rows.append(
                            {
                                "company_id": request.company_id,
                                "part_id": part_id,
                                "location_id": unassigned_id,
                                "quantity": new_qty,
                            }
                        )
                    # Shape matches the location RPCs so there is ONE adjustment convention per
                    # table: quantity is abs(delta) in the primary unit (the
                    # inventory_transactions_quantity_positive CHECK makes a signed delta
                    # unstorable), and direction lives in the notes text.
                    delta = abs(new_qty - prior_qty)
                    ledger_rows.append(
                        {
                            "company_id": request.company_id,
                            "part_id": part_id,
                            "item_name": name,
                            "type": "adjustment",
                            "quantity": delta,
                            "unit": unit,
                            "converted_quantity": delta,
                            "location_id": unassigned_id,
                            "notes": (
                                f"Opening balance from import — set from {prior_qty} "
                                f"to {new_qty} {unit}"
                            ),
                        }
                    )

                for batch_start in range(0, len(balance_rows), BATCH_SIZE):
                    (
                        supabase.table("part_location_stock")
                        .upsert(
                            balance_rows[batch_start : batch_start + BATCH_SIZE],
                            # `lot_key` joined the key in 20260906121901, so a part can hold
                            # two heats in one bin. It is a generated column and is never
                            # written -- but it has to be NAMED, or PostgREST cannot infer the
                            # index and every row fails with "no unique or exclusion constraint
                            # matching the ON CONFLICT specification". An import carries no
                            # heats, so these land as lot-less rows, which is exactly what an
                            # untracked part is.
                            on_conflict="part_id,location_id,lot_key",
                        )
                        .execute()
                    )

                # "The CSV says this part is at zero" removes its row rather than storing a 0.
                for batch_start in range(0, len(zeroed_part_ids), BATCH_SIZE):
                    (
                        supabase.table("part_location_stock")
                        .delete()
                        .eq("location_id", unassigned_id)
                        .in_("part_id", zeroed_part_ids[batch_start : batch_start + BATCH_SIZE])
                        .execute()
                    )
            except Exception as e:
                # Unlike the ledger below, this one IS the data — fail loudly rather than report
                # a successful import whose quantities never landed.
                logger.error(f"Parts import balance write failed: {e}", exc_info=True)
                sentry_sdk.capture_exception(e)
                raise HTTPException(status_code=500, detail="Internal server error")

            # A balance with no transaction explaining it is exactly what inventory.md J1
            # forbids — but the balances are already committed and correct by here, so a missing
            # ledger row is a provenance gap, not a data error. Log loudly, don't fail.
            try:
                for batch_start in range(0, len(ledger_rows), BATCH_SIZE):
                    supabase.table("inventory_transactions").insert(
                        ledger_rows[batch_start : batch_start + BATCH_SIZE]
                    ).execute()
            except Exception as e:
                logger.error(f"Parts import ledger write failed: {e}", exc_info=True)
                sentry_sdk.capture_exception(e)

        # ── Procurement tiers for bought rows ──────────────────────────────
        # CSV imports historically wrote cost into parts.cost_per_unit. With
        # that column dropped, route the same value into a NULL-vendor
        # procurement tier (min_quantity=1) on each imported bought row. The
        # tier lookup at quote time prefers vendor-specific tiers when the
        # user later adds them.
        if pending_procurement_tiers:
            try:
                tier_rows: list[dict] = []
                for name, cost in pending_procurement_tiers:
                    part_id = id_by_part_name.get(name)
                    if not part_id:
                        # Row was skipped/conflicted earlier; just drop the
                        # tier — the parent write never happened.
                        continue
                    tier_rows.append(
                        {
                            "part_id": part_id,
                            "min_quantity": 1,
                            "cost_per_unit": cost,
                        }
                    )

                if tier_rows:
                    # Upsert on (part_id, min_quantity) so re-importing the same
                    # CSV updates the imported cost instead of failing with a
                    # duplicate-key error. (Was keyed on vendor_id too until the
                    # per-vendor tier model was collapsed — migration
                    # 20260714173443 dropped the column.)
                    for batch_start in range(0, len(tier_rows), BATCH_SIZE):
                        batch = tier_rows[batch_start : batch_start + BATCH_SIZE]
                        (
                            supabase.table("part_procurement_tiers")
                            .upsert(
                                batch,
                                on_conflict="part_id,min_quantity",
                            )
                            .execute()
                        )
            except Exception as e:
                logger.error(
                    f"Parts import procurement-tier insert error: {str(e)}",
                    exc_info=True,
                )
                sentry_sdk.capture_exception(e)
                # Don't fail the whole import — the parts are in. The tier
                # write failure is logged and the user can re-import or fix
                # via the UI.

        # ── Starter pricing tiers ──────────────────────────────────────────
        # A part is not quotable until it carries a pricing tier with a markup:
        # get_priceable_part_ids requires one, and since #727 the BOM rollup has
        # no shop-wide fallback to stand in for a missing one. The part page
        # writes that first tier the moment a part has a cost — but only for a
        # part somebody opens, and an onboarding import is thousands of parts
        # nobody will open one at a time. Without this, an imported catalogue
        # arrives un-quotable.
        #
        # Same rule as the part page, at the other entry point: the shop's
        # starting markup for the part's source, written ONCE into the part's own
        # tier. Read here, never by the rollup.
        #
        # Only for parts that (a) this run created and (b) have a cost to mark up
        # — which at import time means a bought row that supplied one. A made row
        # has no routing yet, so it gets its tier from the part page later, and
        # seeding a markup against a $0 cost would make it quotable for nothing.
        # Never touches a part that already has tiers: an import must not
        # overwrite a price somebody chose.
        newly_created_with_cost = [
            id_by_part_name[name]
            for name, _cost in pending_procurement_tiers
            if name in id_by_part_name and name.lower() not in existing_by_name
        ]
        if newly_created_with_cost:
            try:
                company = (
                    supabase.table("companies")
                    .select("default_markup_bought_percent")
                    .eq("id", request.company_id)
                    .single()
                    .execute()
                ).data or {}
                starter_markup = company.get("default_markup_bought_percent") or 0

                # Belt and braces: a part created by THIS run should have no
                # tiers, but a concurrent import or a revived archived part could
                # mean otherwise, and silently rewriting a markup is the one
                # thing this must never do.
                already_priced: set[str] = set()
                for batch_start in range(0, len(newly_created_with_cost), BATCH_SIZE):
                    res = (
                        supabase.table("part_pricing_tiers")
                        .select("part_id")
                        .in_(
                            "part_id",
                            newly_created_with_cost[batch_start : batch_start + BATCH_SIZE],
                        )
                        .execute()
                    )
                    for r in res.data or []:
                        already_priced.add(r["part_id"])

                starter_rows = [
                    {
                        "part_id": part_id,
                        "company_id": request.company_id,
                        "sequence": 10,
                        "quantity": 1,
                        "markup_percent": starter_markup,
                    }
                    for part_id in newly_created_with_cost
                    if part_id not in already_priced
                ]
                for batch_start in range(0, len(starter_rows), BATCH_SIZE):
                    (
                        supabase.table("part_pricing_tiers")
                        .insert(starter_rows[batch_start : batch_start + BATCH_SIZE])
                        .execute()
                    )
                if starter_rows:
                    logger.info(
                        f"Parts import: seeded {len(starter_rows)} starter pricing tiers "
                        f"at {starter_markup}%"
                    )
            except Exception as e:
                logger.error(
                    f"Parts import starter-tier insert error: {str(e)}", exc_info=True
                )
                sentry_sdk.capture_exception(e)
                # Don't fail the import — the parts and their costs are in. The
                # part page will seed the tier when someone opens it.

        logger.info(
            f"Parts import complete: {imported_count} created, {updated_count} updated, {skipped} skipped"
        )

        if already_placed_skips:
            logger.info(
                f"Parts import: {len(already_placed_skips)} quantities not written "
                f"(part already holds stock at a place): {already_placed_skips[:10]}"
            )

        return PartExecuteResponse(
            success=True,
            imported_count=imported_count,
            updated_count=updated_count,
            skipped_count=skipped,
            errors=errors,
            quantity_skipped_already_placed=already_placed_skips,
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Parts import execution error: {str(e)}", exc_info=True)
        sentry_sdk.capture_exception(e)
        raise HTTPException(
            status_code=500,
            detail="Internal server error",
        )
