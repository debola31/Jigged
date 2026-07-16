"""Import routes for parts CSV import with AI-powered mapping.

The unified Parts importer absorbs the previous inventory_items import path.
A row is classified by the (source, is_stocked) pair:

  - source='made',   !is_stocked → Custom Made (built to order)
  - source='made',    is_stocked → Sub-assembly
  - source='bought',  is_stocked → Raw Material
  - source='bought', !is_stocked → Service / Drop-ship

Auto-classification rules at execute time (when no explicit source mapping is
provided):
  - source='bought' if procurement fields (cost_per_unit, primary_unit,
    quantity, reorder_point) are present and there are NO operation columns
  - source='made'   if any operation columns are present, or if no procurement
    fields are set
  - is_stocked is true when primary_unit / quantity / cost_per_unit are present

Legacy column-mapping aliases. The previous (is_manufacturable, is_stockable)
booleans were renamed by the 20260504 source-enum migration. To stay
compatible with already-prepared CSVs for one version, the importer accepts
`is_manufacturable` and `is_stockable` as legacy aliases:
  - is_manufacturable=true  → source='made'
  - is_manufacturable=false → source='bought'
  - is_stockable value passes through to is_stocked
Each legacy-mapped row writes a deprecation entry to the import-event log
(visible in server logs). Plan to remove the alias once the pilot customer's
CSVs use the new headers.

`legacy_id` is unique per company; rows with a `legacy_id` set are upserted
via ON CONFLICT so re-importing the same source CSV is idempotent.
"""

import hashlib
import json
import logging
import os
import re

import sentry_sdk
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException, Depends
from supabase import Client

from models.parts_import_models import (
    PricingColumnPair,
    PartAnalyzeRequest,
    PartAnalyzeResponse,
    ColumnMapping,
    PartValidateRequest,
    PartValidateResponse,
    PartValidationError,
    PartConflictInfo,
    PartExecuteRequest,
    PartExecuteResponse,
    PartImportError,
    PART_SCHEMA,
    UNIFIED_PART_SCHEMA,
    PRICING_COLUMN_PATTERNS,
    parse_bool,
)
from services.ai import get_provider
from services.uom_normalizer import (
    normalize_uom_alias,
    resolve_units_for_rows,
)
from utils.rate_limiter import RateLimiter
from utils.db_pagination import fetch_all_by_company

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/parts/import", tags=["parts-import"])

# Rate limiter: 10 AI calls per minute per company
ai_rate_limiter = RateLimiter(max_requests=10, window_seconds=60)

# Cache directory for AI responses (dev only - avoids repeated API calls)
CACHE_DIR = Path(__file__).parent.parent / ".cache" / "ai_responses" / "parts"
CACHE_ENABLED = os.getenv("AI_CACHE_ENABLED", "true").lower() == "true"


def _get_cache_key(company_id: str, headers: list[str], variant: str = "parts") -> str:
    """Generate a cache key from company_id and headers."""
    content = f"{variant}:{company_id}:{','.join(sorted(headers))}"
    return hashlib.md5(content.encode()).hexdigest()


def _get_cached_response(cache_key: str) -> PartAnalyzeResponse | None:
    """Try to get a cached response."""
    if not CACHE_ENABLED:
        return None

    cache_file = CACHE_DIR / f"{cache_key}.json"
    if cache_file.exists():
        try:
            with open(cache_file) as f:
                data = json.load(f)
            return PartAnalyzeResponse(**data)
        except Exception:
            return None
    return None


def _save_to_cache(cache_key: str, response: PartAnalyzeResponse) -> None:
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


def _detect_pricing_columns(headers: list[str]) -> list[PricingColumnPair]:
    """Auto-detect pricing column pairs from headers."""
    pricing_pairs: list[tuple[int, str, str]] = []  # (tier_num, qty_col, price_col)
    headers_lower = {h.lower().replace(" ", ""): h for h in headers}
    matched_columns: set[str] = set()

    for qty_pattern, price_pattern in PRICING_COLUMN_PATTERNS:
        qty_regex = re.compile(qty_pattern, re.IGNORECASE)
        price_regex = re.compile(price_pattern, re.IGNORECASE)

        for header_lower, original in headers_lower.items():
            if original in matched_columns:
                continue

            qty_match = qty_regex.match(header_lower)
            if qty_match:
                tier_num = int(qty_match.group(1))
                for price_lower, price_original in headers_lower.items():
                    if price_original in matched_columns:
                        continue

                    price_match = price_regex.match(price_lower)
                    if price_match and int(price_match.group(1)) == tier_num:
                        pricing_pairs.append((tier_num, original, price_original))
                        matched_columns.add(original)
                        matched_columns.add(price_original)
                        break

    pricing_pairs.sort(key=lambda x: x[0])
    return [
        PricingColumnPair(qty_column=qty, price_column=price)
        for _, qty, price in pricing_pairs
    ]


def _get_column_samples(
    headers: list[str],
    sample_rows: list[list[str]],
    skip_columns: set[str],
) -> dict[str, str]:
    """Get one sample value per non-empty column."""
    samples: dict[str, str] = {}

    for row in sample_rows:
        for i, header in enumerate(headers):
            if header in skip_columns or header in samples:
                continue

            value = row[i].strip() if i < len(row) else ""
            if value:
                samples[header] = value

        eligible_count = len(headers) - len(skip_columns)
        if len(samples) >= eligible_count:
            break

    return samples


def _transform_pricing_to_jsonb(
    row: dict[str, str], pricing_columns: list[PricingColumnPair]
) -> list[dict]:
    """Transform pricing columns from a CSV row into JSONB array format."""
    tiers = []
    for pair in pricing_columns:
        qty_str = row.get(pair.qty_column, "").strip()
        price_str = row.get(pair.price_column, "").strip()

        if qty_str and price_str:
            try:
                qty = int(float(qty_str))
                price = round(float(price_str), 2)
                if qty > 0 and price >= 0:
                    tiers.append({"qty": qty, "price": price})
            except ValueError:
                continue

    tiers.sort(key=lambda t: t["qty"])
    return tiers


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


def _row_has_inventory_data(
    row: dict[str, str],
    reverse_mappings: dict[str, str],
) -> bool:
    """Detect if a row carries inventory data (quantity/unit/cost set)."""
    for db_field in ("primary_unit", "quantity", "cost_per_unit"):
        col = reverse_mappings.get(db_field)
        if col and row.get(col, "").strip():
            return True
    return False


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


async def _run_analyze(
    request: PartAnalyzeRequest,
    supabase: Client,
    schema: dict,
    cache_variant: str,
) -> PartAnalyzeResponse:
    """Shared analyze implementation for both /analyze and /analyze-unified."""
    cache_key = _get_cache_key(request.company_id, request.headers, variant=cache_variant)
    cached = _get_cached_response(cache_key)
    if cached:
        return cached

    if not ai_rate_limiter.check(request.company_id):
        raise HTTPException(
            status_code=429,
            detail="Too many requests. Please wait before trying again.",
        )

    pricing_columns = _detect_pricing_columns(request.headers)
    pricing_column_names: set[str] = set()
    for pair in pricing_columns:
        pricing_column_names.add(pair.qty_column)
        pricing_column_names.add(pair.price_column)

    column_samples = _get_column_samples(
        headers=request.headers,
        sample_rows=request.sample_rows,
        skip_columns=pricing_column_names,
    )

    headers_for_ai = [h for h in request.headers if h not in pricing_column_names]

    try:
        provider = await get_provider(supabase, request.company_id, "csv_mapping")

        suggestions = await provider.suggest_column_mappings(
            csv_headers=headers_for_ai,
            sample_rows=request.sample_rows,
            target_schema=schema,
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

        for col in pricing_column_names:
            if col not in discarded_columns:
                discarded_columns.append(col)

        required_fields = [
            field for field, info in schema.items() if info.get("required")
        ]
        unmapped_required = [f for f in required_fields if f not in mapped_db_fields]

        response = PartAnalyzeResponse(
            mappings=mappings,
            pricing_columns=pricing_columns,
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


@router.post("/analyze", response_model=PartAnalyzeResponse)
async def analyze_csv(
    request: PartAnalyzeRequest,
    supabase: Client = Depends(get_supabase),
):
    """Analyze CSV headers for the standard parts import (PART_SCHEMA)."""
    return await _run_analyze(request, supabase, PART_SCHEMA, "parts")


@router.post("/analyze-unified", response_model=PartAnalyzeResponse)
async def analyze_csv_unified(
    request: PartAnalyzeRequest,
    supabase: Client = Depends(get_supabase),
):
    """Analyze CSV headers for the unified parts import (UNIFIED_PART_SCHEMA).

    Unified imports may include any combination of inventory fields, classification
    flags, and routing-operation columns on the same row.
    """
    return await _run_analyze(request, supabase, UNIFIED_PART_SCHEMA, "parts_unified")


@router.post("/validate", response_model=PartValidateResponse)
async def validate_import(
    request: PartValidateRequest,
    supabase: Client = Depends(get_supabase),
):
    """Validate parts CSV data before import.

    Checks (in order, per row):
      1. Required field: part_name
      2. Numeric ranges: quantity, cost_per_unit, reorder_point all non-negative
      3. UOM resolution for stockable rows (alias map → AI inference fallback)
      4. preferred_vendor_name resolves against existing vendors
      5. CSV duplicate part_name (csv_duplicate)
      6. legacy_id collision against existing parts is NOT a conflict — it's
         an upsert path, handled at execute time
      7. part_name collision against existing parts (duplicate_part_name) — only
         when no legacy_id provided (otherwise upsert)

    Customer fields (`customer_match_mode`, `selected_customer_id`, or a
    `customer_name`/`customer_id` mapping) are rejected with 400 — parts no
    longer link to customers at the data layer.
    """
    _reject_customer_fields(request)
    try:
        # Existing parts (for collision detection and legacy_id upsert path). Paged: a company
        # with >1000 parts would otherwise only compare against the first 1000, so re-importing
        # the rest would 500 on the unique constraint.
        existing_parts = fetch_all_by_company(
            supabase, "parts", "id, part_name, legacy_id", request.company_id
        )

        existing_parts_by_name: dict[str, dict] = {}
        existing_parts_by_legacy_id: dict[str, dict] = {}
        for part in existing_parts:
            if part.get("part_name"):
                existing_parts_by_name[part["part_name"].lower()] = part
            if part.get("legacy_id"):
                existing_parts_by_legacy_id[part["legacy_id"]] = part

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
        legacy_id_column = reverse_mappings.get("legacy_id")
        # New (chunk 11) columns:
        source_column = reverse_mappings.get("source")
        is_stocked_column = reverse_mappings.get("is_stocked")
        # Legacy aliases (kept one-version for CSVs already prepared with the
        # old headers — see module docstring):
        legacy_is_stockable_column = reverse_mappings.get("is_stockable")
        legacy_is_manufacturable_column = reverse_mappings.get("is_manufacturable")
        description_column = reverse_mappings.get("description")

        has_routing_cols = _has_routing_columns(request.mappings)

        # First pass: track part_name and legacy_id occurrences for CSV duplicate
        # detection. legacy_id duplicates matter because the execute path upserts
        # via ON CONFLICT (company_id, legacy_id) — two rows in the same batch
        # sharing a legacy_id cause a Postgres 21000 error otherwise.
        part_occurrences: dict[str, list[int]] = {}
        legacy_id_occurrences: dict[str, list[int]] = {}
        for i, row in enumerate(request.rows):
            row_number = i + 1 + request.batch_offset
            part_name = (
                row.get(part_name_column, "").strip() if part_name_column else ""
            )
            if part_name:
                key = part_name.lower()
                part_occurrences.setdefault(key, []).append(row_number)
            legacy_id_val = (
                row.get(legacy_id_column, "").strip() if legacy_id_column else ""
            )
            if legacy_id_val:
                legacy_id_occurrences.setdefault(legacy_id_val, []).append(row_number)

        csv_duplicates = {k: v for k, v in part_occurrences.items() if len(v) > 1}
        csv_legacy_id_duplicates = {
            k: v for k, v in legacy_id_occurrences.items() if len(v) > 1
        }

        # Second pass: per-row validation
        validation_errors: list[PartValidationError] = []
        conflicts: list[PartConflictInfo] = []
        validation_error_rows: set[int] = set()
        conflict_rows: set[int] = set()

        # Determine which rows look stocked (so we know whether to require unit)
        stocked_row_numbers: set[int] = set()
        for i, row in enumerate(request.rows):
            row_number = i + 1 + request.batch_offset
            explicit_stocked: Optional[bool] = None
            if is_stocked_column:
                explicit_stocked = parse_bool(row.get(is_stocked_column, ""))
            elif legacy_is_stockable_column:
                explicit_stocked = parse_bool(row.get(legacy_is_stockable_column, ""))
            if explicit_stocked is True:
                stocked_row_numbers.add(row_number)
            elif explicit_stocked is None and _row_has_inventory_data(
                row, reverse_mappings
            ):
                stocked_row_numbers.add(row_number)

        # Resolve UOMs for stocked rows that have a unit column
        if request.pre_resolved_uoms:
            uom_resolutions: dict[int, Optional[str]] = dict(request.pre_resolved_uoms)
        elif primary_unit_column or description_column:
            stocked_rows = [
                row
                for i, row in enumerate(request.rows)
                if (i + 1 + request.batch_offset) in stocked_row_numbers
            ]
            stocked_index_map = {
                idx + 1: orig_idx + 1 + request.batch_offset
                for idx, orig_idx in enumerate(
                    [
                        i
                        for i in range(len(request.rows))
                        if (i + 1 + request.batch_offset) in stocked_row_numbers
                    ]
                )
            }
            partial = resolve_units_for_rows(
                stocked_rows,
                name_column=part_name_column,
                description_column=description_column,
                uom_column=primary_unit_column,
            )
            uom_resolutions = {
                stocked_index_map[k]: v for k, v in partial.items()
            }
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

            # legacy_id idempotency: if provided, this is an upsert — not a conflict
            legacy_id_val = (
                row.get(legacy_id_column, "").strip() if legacy_id_column else ""
            )
            has_legacy_id = bool(legacy_id_val)

            # In-CSV legacy_id duplicate: the upsert can't resolve the same
            # ON CONFLICT (company_id, legacy_id) key twice in one batch
            # (Postgres 21000).
            if has_legacy_id and legacy_id_val in csv_legacy_id_duplicates:
                other_rows = [
                    r
                    for r in csv_legacy_id_duplicates[legacy_id_val]
                    if r != row_number
                ]
                if other_rows:
                    conflicts.append(
                        PartConflictInfo(
                            row_number=row_number,
                            csv_part_name=part_name,
                            csv_customer_code=None,
                            conflict_type="csv_duplicate_legacy_id",
                            existing_part_id="",
                            existing_value=(
                                f"Legacy ID '{legacy_id_val}' duplicated in CSV at rows "
                                f"{', '.join(map(str, other_rows))}"
                            ),
                        )
                    )
                    conflict_rows.add(row_number)
                    continue

            # Existing part_name collision (only conflicts when not upserting via legacy_id)
            if not has_legacy_id and key in existing_parts_by_name:
                existing = existing_parts_by_name[key]
                conflicts.append(
                    PartConflictInfo(
                        row_number=row_number,
                        csv_part_name=part_name,
                        csv_customer_code=None,
                        conflict_type="duplicate_part_name",
                        existing_part_id=existing["id"],
                        existing_value=f"Part '{part_name}' already exists",
                    )
                )
                conflict_rows.add(row_number)
                continue

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

    - Auto-classifies rows by (source, is_stocked):
      - source='made'   if any operation columns are present, OR if there are
        no procurement fields (cost/unit/qty/reorder)
      - source='bought' if procurement fields are present and there are no
        operation columns
      - is_stocked=true if primary_unit / quantity / cost_per_unit are present
    - Accepts the legacy headers `is_manufacturable` and `is_stockable` as
      column-mapping aliases (one-version compat). Each legacy-mapped row
      writes a deprecation log entry. See the module docstring.
    - Resolves preferred_vendor_name to vendor_id (rows that failed validation
      have already been excluded from the insert set).
    - Splits insert and upsert paths: rows with legacy_id are upserted via
      ON CONFLICT (company_id, legacy_id), rows without legacy_id are plain inserts.

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
        legacy_id_column = reverse_mappings.get("legacy_id")
        # New (chunk 11) columns:
        source_column = reverse_mappings.get("source")
        is_stocked_column = reverse_mappings.get("is_stocked")
        # Legacy aliases (one-version compat — see module docstring):
        legacy_is_stockable_column = reverse_mappings.get("is_stockable")
        legacy_is_manufacturable_column = reverse_mappings.get("is_manufacturable")
        if legacy_is_stockable_column or legacy_is_manufacturable_column:
            logger.warning(
                "Parts import using legacy headers is_manufacturable/is_stockable. "
                "These are deprecated; use 'source' (made|bought) and 'is_stocked' instead. "
                "company_id=%s",
                request.company_id,
            )

        has_routing_cols = _has_routing_columns(request.mappings)

        rows_to_insert: list[dict] = []
        rows_to_upsert: list[dict] = []
        # parts.cost_per_unit was dropped in migration 20260514. For bought
        # rows with a CSV cost, we stage NULL-vendor procurement tiers
        # (min_quantity=1) and insert them after the parts rows commit. Each
        # entry is (legacy_id_or_none, part_name, cost_val) — we resolve to
        # part_id by querying parts by (company_id, legacy_id|part_name) once
        # all rows are persisted.
        pending_procurement_tiers: list[tuple[Optional[str], str, float]] = []
        errors: list[PartImportError] = []
        skipped = 0

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

            # Auto-classification: (source, is_stocked).
            #
            # is_stocked: explicit > legacy is_stockable > inferred from
            # primary_unit/quantity/cost.
            explicit_stocked: Optional[bool] = None
            if is_stocked_column:
                explicit_stocked = parse_bool(row.get(is_stocked_column, ""))
            elif legacy_is_stockable_column:
                explicit_stocked = parse_bool(
                    row.get(legacy_is_stockable_column, "")
                )

            inferred_stocked = bool(
                primary_unit or quantity_val is not None or cost_val is not None
            )
            is_stocked_val = (
                explicit_stocked if explicit_stocked is not None else inferred_stocked
            )

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

            part_data["is_stocked"] = is_stocked_val
            part_data["source"] = source_val

            if legacy_is_stockable_column or legacy_is_manufacturable_column:
                logger.info(
                    "Parts import row %s used legacy header(s) "
                    "is_manufacturable/is_stockable (deprecated). Mapped to "
                    "source=%s, is_stocked=%s. company_id=%s",
                    row_number,
                    source_val,
                    is_stocked_val,
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
            if quantity_val is not None:
                part_data["quantity"] = quantity_val
            else:
                # Schema NOT NULL DEFAULT 0; explicit for clarity
                part_data["quantity"] = 0
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

            # legacy_id (also drives the upsert path)
            legacy_id_val = (
                row.get(legacy_id_column, "").strip() if legacy_id_column else ""
            )
            if legacy_id_val:
                part_data["legacy_id"] = legacy_id_val
                rows_to_upsert.append(part_data)
            else:
                rows_to_insert.append(part_data)

            # Stage a procurement tier for bought rows that supplied a cost.
            if source_val == "bought" and cost_val is not None and cost_val > 0:
                pending_procurement_tiers.append(
                    (legacy_id_val or None, part_name, cost_val)
                )

        # Bulk insert in batches
        BATCH_SIZE = 500
        imported_count = 0
        updated_count = 0
        # Capture the inserted/upserted parts so we can correlate them to
        # `pending_procurement_tiers` by part_name (or legacy_id) and grab
        # their ids. Saves a round-trip vs re-querying after the writes.
        id_by_legacy_id: dict[str, str] = {}
        id_by_part_name: dict[str, str] = {}

        if rows_to_insert:
            try:
                total = len(rows_to_insert)
                for batch_start in range(0, total, BATCH_SIZE):
                    batch = rows_to_insert[batch_start : batch_start + BATCH_SIZE]
                    response = supabase.table("parts").insert(batch).execute()
                    imported_count += len(response.data) if response.data else 0
                    for inserted in response.data or []:
                        pid = inserted.get("id")
                        if not pid:
                            continue
                        if inserted.get("part_name"):
                            id_by_part_name[inserted["part_name"]] = pid
                        if inserted.get("legacy_id"):
                            id_by_legacy_id[inserted["legacy_id"]] = pid
            except Exception as e:
                error_str = str(e)
                logger.error(f"Parts import insert error: {error_str}", exc_info=True)
                if "23505" in error_str or "duplicate key" in error_str.lower():
                    raise HTTPException(
                        status_code=400,
                        detail="Import failed: A part with this name already exists.",
                    )
                sentry_sdk.capture_exception(e)
                raise HTTPException(status_code=500, detail="Internal server error")

        if rows_to_upsert:
            try:
                total = len(rows_to_upsert)
                for batch_start in range(0, total, BATCH_SIZE):
                    batch = rows_to_upsert[batch_start : batch_start + BATCH_SIZE]
                    response = (
                        supabase.table("parts")
                        .upsert(batch, on_conflict="company_id,legacy_id")
                        .execute()
                    )
                    updated_count += len(response.data) if response.data else 0
                    for upserted in response.data or []:
                        pid = upserted.get("id")
                        if not pid:
                            continue
                        if upserted.get("part_name"):
                            id_by_part_name[upserted["part_name"]] = pid
                        if upserted.get("legacy_id"):
                            id_by_legacy_id[upserted["legacy_id"]] = pid
            except Exception as e:
                error_str = str(e)
                logger.error(f"Parts import upsert error: {error_str}", exc_info=True)
                sentry_sdk.capture_exception(e)
                raise HTTPException(status_code=500, detail="Internal server error")

        # ── Procurement tiers for bought rows ──────────────────────────────
        # CSV imports historically wrote cost into parts.cost_per_unit. With
        # that column dropped, route the same value into a NULL-vendor
        # procurement tier (min_quantity=1) on each imported bought row. The
        # tier lookup at quote time prefers vendor-specific tiers when the
        # user later adds them.
        if pending_procurement_tiers:
            try:
                tier_rows: list[dict] = []
                for lid, name, cost in pending_procurement_tiers:
                    part_id = (
                        id_by_legacy_id.get(lid) if lid else id_by_part_name.get(name)
                    )
                    if not part_id and name:
                        part_id = id_by_part_name.get(name)
                    if not part_id:
                        # Row was skipped/conflicted earlier; just drop the
                        # tier — the parent insert never happened.
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

        logger.info(
            f"Parts import complete: {imported_count} inserted, {updated_count} upserted, {skipped} skipped"
        )

        return PartExecuteResponse(
            success=True,
            imported_count=imported_count,
            updated_count=updated_count,
            skipped_count=skipped,
            errors=errors,
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
