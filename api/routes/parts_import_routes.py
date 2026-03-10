"""Import routes for parts CSV import with AI-powered mapping."""

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
    CustomerMatchMode,
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
    PRICING_COLUMN_PATTERNS,
)
from services.ai import get_provider
from utils.rate_limiter import RateLimiter

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/parts/import", tags=["parts-import"])

# Rate limiter: 10 AI calls per minute per company
ai_rate_limiter = RateLimiter(max_requests=10, window_seconds=60)

# Cache directory for AI responses (dev only - avoids repeated API calls)
CACHE_DIR = Path(__file__).parent.parent / ".cache" / "ai_responses" / "parts"
CACHE_ENABLED = os.getenv("AI_CACHE_ENABLED", "true").lower() == "true"


def _get_cache_key(company_id: str, headers: list[str]) -> str:
    """Generate a cache key from company_id and headers."""
    content = f"parts:{company_id}:{','.join(sorted(headers))}"
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
    """
    Auto-detect pricing column pairs from headers.

    Looks for patterns like qty1/price1, qty2/price2, etc.
    Returns list of matched column pairs sorted by tier number.
    """
    pricing_pairs: list[tuple[int, str, str]] = []  # (tier_num, qty_col, price_col)
    headers_lower = {h.lower().replace(" ", ""): h for h in headers}
    matched_columns: set[str] = set()  # Track already matched columns to avoid duplicates

    # Try each pattern
    for qty_pattern, price_pattern in PRICING_COLUMN_PATTERNS:
        qty_regex = re.compile(qty_pattern, re.IGNORECASE)
        price_regex = re.compile(price_pattern, re.IGNORECASE)

        # Find all qty columns matching this pattern
        for header_lower, original in headers_lower.items():
            # Skip if this column was already matched
            if original in matched_columns:
                continue

            qty_match = qty_regex.match(header_lower)
            if qty_match:
                tier_num = int(qty_match.group(1))
                # Look for matching price column
                for price_lower, price_original in headers_lower.items():
                    # Skip if price column was already matched
                    if price_original in matched_columns:
                        continue

                    price_match = price_regex.match(price_lower)
                    if price_match and int(price_match.group(1)) == tier_num:
                        pricing_pairs.append((tier_num, original, price_original))
                        matched_columns.add(original)
                        matched_columns.add(price_original)
                        break

    # Sort by tier number and return as PricingColumnPair objects
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
    """Get one sample value per non-empty column.

    Efficiently collects the first non-empty value found for each column.
    This minimizes token usage while giving AI context about data format.

    Args:
        headers: All column headers
        sample_rows: First 5 rows of sample data
        skip_columns: Columns to skip (e.g., pricing pairs already handled)

    Returns:
        Dict mapping column name to one sample value (non-empty columns only)
    """
    samples: dict[str, str] = {}

    for row in sample_rows:
        for i, header in enumerate(headers):
            # Skip if in skip_columns or we already have a sample
            if header in skip_columns or header in samples:
                continue

            # Get value if exists and is non-empty
            value = row[i].strip() if i < len(row) else ""
            if value:
                samples[header] = value

        # Early exit if we have samples for all eligible columns
        eligible_count = len(headers) - len(skip_columns)
        if len(samples) >= eligible_count:
            break

    return samples


def _transform_pricing_to_jsonb(
    row: dict[str, str], pricing_columns: list[PricingColumnPair]
) -> list[dict]:
    """
    Transform pricing columns from a CSV row into JSONB array format.

    Returns list of {qty: int, price: float} sorted by qty.
    """
    tiers = []
    for pair in pricing_columns:
        qty_str = row.get(pair.qty_column, "").strip()
        price_str = row.get(pair.price_column, "").strip()

        if qty_str and price_str:
            try:
                qty = int(float(qty_str))  # Handle "100.0" format
                price = round(float(price_str), 2)
                if qty > 0 and price >= 0:
                    tiers.append({"qty": qty, "price": price})
            except ValueError:
                continue  # Skip invalid values

    # Sort by quantity ascending
    tiers.sort(key=lambda t: t["qty"])
    return tiers


def get_supabase() -> Client:
    """Get Supabase client from the main app."""
    from index import supabase

    if not supabase:
        raise HTTPException(
            status_code=500,
            detail="Supabase client not initialized",
        )
    return supabase


@router.post("/analyze", response_model=PartAnalyzeResponse)
async def analyze_csv(
    request: PartAnalyzeRequest,
    supabase: Client = Depends(get_supabase),
):
    """
    Analyze CSV headers and sample data to suggest column mappings for parts using AI.

    Also auto-detects pricing columns (qty1/price1, qty2/price2, etc.).

    Caching: Responses are cached by company_id + headers to avoid repeated
    API calls during development. Set AI_CACHE_ENABLED=false to disable.
    """
    # Check cache first
    cache_key = _get_cache_key(request.company_id, request.headers)
    cached = _get_cached_response(cache_key)
    if cached:
        return cached

    # Rate limiting
    if not ai_rate_limiter.check(request.company_id):
        raise HTTPException(
            status_code=429,
            detail="Too many requests. Please wait before trying again.",
        )

    # Auto-detect pricing columns first
    pricing_columns = _detect_pricing_columns(request.headers)
    pricing_column_names = set()
    for pair in pricing_columns:
        pricing_column_names.add(pair.qty_column)
        pricing_column_names.add(pair.price_column)

    # Get sample values for non-empty columns (efficient token usage)
    column_samples = _get_column_samples(
        headers=request.headers,
        sample_rows=request.sample_rows,
        skip_columns=pricing_column_names,
    )

    # Filter out pricing columns from the headers we send to AI
    headers_for_ai = [h for h in request.headers if h not in pricing_column_names]

    try:
        # Get the configured AI provider for this company
        provider = await get_provider(supabase, request.company_id, "csv_mapping")

        # Get AI suggestions for ALL columns (except pricing), with sample data for non-empty ones
        suggestions = await provider.suggest_column_mappings(
            csv_headers=headers_for_ai,
            sample_rows=request.sample_rows,
            target_schema=PART_SCHEMA,
            column_samples=column_samples,
        )

        # Convert to response format
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

        # Add pricing columns to discarded list (they're handled separately)
        for col in pricing_column_names:
            if col not in discarded_columns:
                discarded_columns.append(col)

        # Check for unmapped required fields
        required_fields = [
            field for field, info in PART_SCHEMA.items() if info.get("required")
        ]
        unmapped_required = [f for f in required_fields if f not in mapped_db_fields]

        response = PartAnalyzeResponse(
            mappings=mappings,
            pricing_columns=pricing_columns,
            unmapped_required=unmapped_required,
            discarded_columns=discarded_columns,
            ai_provider=provider.provider_name,
        )

        # Save to cache for future requests
        _save_to_cache(cache_key, response)

        return response

    except ValueError as e:
        # AI provider configuration error
        sentry_sdk.capture_exception(e)
        raise HTTPException(status_code=500, detail="Internal server error")
    except Exception as e:
        # Unexpected error
        sentry_sdk.capture_exception(e)
        raise HTTPException(
            status_code=500,
            detail="Internal server error",
        )


@router.post("/validate", response_model=PartValidateResponse)
async def validate_import(
    request: PartValidateRequest,
    supabase: Client = Depends(get_supabase),
):
    """
    Validate parts CSV data before import.

    Checks:
    - Part number uniqueness per company+customer
    - Customer existence (for BY_COLUMN mode)
    - Pricing data validity
    """
    try:
        # Get existing parts for this company
        parts_response = (
            supabase.table("parts")
            .select("id, part_number, customer_id")
            .eq("company_id", request.company_id)
            .execute()
        )
        existing_parts = parts_response.data or []

        # Build lookup: (part_number_lower, customer_id) -> part
        existing_parts_lookup: dict[tuple[str, Optional[str]], dict] = {}
        for part in existing_parts:
            key = (part["part_number"].lower(), part["customer_id"])
            existing_parts_lookup[key] = part

        # Get customers for this company (for name lookup)
        customers_response = (
            supabase.table("customers")
            .select("id, name")
            .eq("company_id", request.company_id)
            .execute()
        )
        existing_customers = customers_response.data or []
        customer_name_to_id = {
            c["name"].lower(): c["id"] for c in existing_customers
        }

        # Validate selected customer exists (for ALL_TO_ONE mode)
        selected_customer_id: Optional[str] = None
        if request.customer_match_mode == CustomerMatchMode.ALL_TO_ONE:
            if not request.selected_customer_id:
                raise HTTPException(
                    status_code=400,
                    detail="selected_customer_id is required when customer_match_mode is ALL_TO_ONE",
                )
            # Verify customer exists
            customer_check = (
                supabase.table("customers")
                .select("id")
                .eq("id", request.selected_customer_id)
                .eq("company_id", request.company_id)
                .execute()
            )
            if not customer_check.data:
                raise HTTPException(
                    status_code=400,
                    detail="Selected customer not found",
                )
            selected_customer_id = request.selected_customer_id

        # Find column mappings
        reverse_mappings = {v: k for k, v in request.mappings.items()}
        part_number_column = reverse_mappings.get("part_number")
        customer_name_column = reverse_mappings.get("customer_name")

        # First pass: track part_number occurrences for CSV duplicate detection
        part_occurrences: dict[tuple[str, Optional[str]], list[int]] = {}

        for i, row in enumerate(request.rows):
            row_number = i + 1
            part_number = (
                row.get(part_number_column, "").strip() if part_number_column else ""
            )

            # Determine customer_id based on match mode
            customer_id: Optional[str] = None
            if request.customer_match_mode == CustomerMatchMode.ALL_TO_ONE:
                customer_id = selected_customer_id
            elif request.customer_match_mode == CustomerMatchMode.BY_COLUMN:
                customer_name = (
                    row.get(customer_name_column, "").strip()
                    if customer_name_column
                    else ""
                )
                if customer_name:
                    customer_id = customer_name_to_id.get(customer_name.lower())
                    # Note: customer_id will be None if customer not found (handled in validation)
            # ALL_GENERIC: customer_id stays None

            if part_number:
                key = (part_number.lower(), customer_id)
                if key not in part_occurrences:
                    part_occurrences[key] = []
                part_occurrences[key].append(row_number)

        # Find duplicates within CSV
        csv_duplicates = {k: v for k, v in part_occurrences.items() if len(v) > 1}

        # Second pass: validate each row
        validation_errors: list[PartValidationError] = []
        conflicts: list[PartConflictInfo] = []
        validation_error_rows: set[int] = set()
        conflict_rows: set[int] = set()

        for i, row in enumerate(request.rows):
            row_number = i + 1
            part_number = (
                row.get(part_number_column, "").strip() if part_number_column else ""
            )

            # Check required field: part_number
            if not part_number:
                validation_errors.append(
                    PartValidationError(
                        row_number=row_number,
                        error_type="missing_part_number",
                        field="part_number",
                        message="Part number is required",
                    )
                )
                validation_error_rows.add(row_number)
                continue

            # Determine customer for this row
            customer_id: Optional[str] = None
            customer_name = ""

            if request.customer_match_mode == CustomerMatchMode.ALL_TO_ONE:
                customer_id = selected_customer_id
            elif request.customer_match_mode == CustomerMatchMode.BY_COLUMN:
                customer_name = (
                    row.get(customer_name_column, "").strip()
                    if customer_name_column
                    else ""
                )
                if customer_name:
                    customer_id = customer_name_to_id.get(customer_name.lower())
                    # If customer_name provided but not found, that's a conflict
                    if not customer_id:
                        conflicts.append(
                            PartConflictInfo(
                                row_number=row_number,
                                csv_part_number=part_number,
                                csv_customer_code=customer_name,
                                conflict_type="customer_not_found",
                                existing_part_id="",
                                existing_value=f"Customer name '{customer_name}' not found",
                            )
                        )
                        conflict_rows.add(row_number)
                        continue
            # ALL_GENERIC: customer_id stays None

            # Check for CSV duplicates
            key = (part_number.lower(), customer_id)
            if key in csv_duplicates:
                other_rows = [r for r in csv_duplicates[key] if r != row_number]
                if other_rows:  # Don't flag if this is the first occurrence
                    conflicts.append(
                        PartConflictInfo(
                            row_number=row_number,
                            csv_part_number=part_number,
                            csv_customer_code=customer_name,
                            conflict_type="csv_duplicate",
                            existing_part_id="",
                            existing_value=f"Duplicate in CSV at rows {', '.join(map(str, other_rows))}",
                        )
                    )
                    conflict_rows.add(row_number)
                    continue

            # Check for existing part with same part_number + customer_id
            if key in existing_parts_lookup:
                existing = existing_parts_lookup[key]
                conflicts.append(
                    PartConflictInfo(
                        row_number=row_number,
                        csv_part_number=part_number,
                        csv_customer_code=customer_name,
                        conflict_type="duplicate_part_number",
                        existing_part_id=existing["id"],
                        existing_value=f"Part '{part_number}' already exists for this customer",
                    )
                )
                conflict_rows.add(row_number)
                continue

            # Validate pricing data
            pricing = _transform_pricing_to_jsonb(row, request.pricing_columns)
            # Pricing can be empty - that's valid (cost-plus pricing)

        # Calculate counts
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
    """
    Execute the parts import.

    If skip_conflicts is True, only imports rows without conflicts.
    Otherwise, fails if any conflicts exist.
    """
    logger.info(f"Parts import execute started: {len(request.rows)} rows, company_id={request.company_id}")
    logger.info(f"Customer match mode: {request.customer_match_mode}, skip_conflicts: {request.skip_conflicts}")

    try:
        # First validate to get conflict info
        logger.info("Running validation...")
        validate_response = await validate_import(
            PartValidateRequest(
                company_id=request.company_id,
                mappings=request.mappings,
                pricing_columns=request.pricing_columns,
                rows=request.rows,
                customer_match_mode=request.customer_match_mode,
                selected_customer_id=request.selected_customer_id,
            ),
            supabase=supabase,
        )
        logger.info(f"Validation complete: {len(validate_response.conflicts)} conflicts, {len(validate_response.validation_errors)} validation errors")

        # If conflicts exist and we're not skipping them, fail
        if validate_response.has_conflicts and not request.skip_conflicts:
            raise HTTPException(
                status_code=400,
                detail="Conflicts detected. Set skip_conflicts=true to import non-conflicting rows only.",
            )

        # Build set of rows to skip
        skip_row_numbers = {c.row_number for c in validate_response.conflicts}
        skip_row_numbers |= {e.row_number for e in validate_response.validation_errors}

        # Get customer lookup for BY_COLUMN mode
        customer_name_to_id: dict[str, str] = {}
        if request.customer_match_mode == CustomerMatchMode.BY_COLUMN:
            customers_response = (
                supabase.table("customers")
                .select("id, name")
                .eq("company_id", request.company_id)
                .execute()
            )
            customer_name_to_id = {
                c["name"].lower(): c["id"]
                for c in (customers_response.data or [])
            }

        # Find column mappings
        reverse_mappings = {v: k for k, v in request.mappings.items()}

        # Prepare rows for insertion
        rows_to_insert = []
        errors: list[PartImportError] = []
        skipped = 0

        for i, row in enumerate(request.rows):
            row_number = i + 1

            # Skip rows that failed validation or have conflicts
            if row_number in skip_row_numbers:
                skipped += 1
                continue

            # Determine customer_id
            customer_id: Optional[str] = None
            if request.customer_match_mode == CustomerMatchMode.ALL_TO_ONE:
                customer_id = request.selected_customer_id
            elif request.customer_match_mode == CustomerMatchMode.BY_COLUMN:
                customer_name_column = reverse_mappings.get("customer_name")
                customer_name = (
                    row.get(customer_name_column, "").strip()
                    if customer_name_column
                    else ""
                )
                if customer_name:
                    customer_id = customer_name_to_id.get(customer_name.lower())
            # ALL_GENERIC: customer_id stays None

            # Build part record
            part_data = {
                "company_id": request.company_id,
                "customer_id": customer_id,
            }

            # Map standard fields
            for db_field in ["part_number", "description"]:
                csv_column = reverse_mappings.get(db_field)
                if csv_column and csv_column in row:
                    value = row[csv_column].strip()
                    # Filter out empty values and literal "undefined" string from frontend
                    if value and value.lower() != "undefined":
                        part_data[db_field] = value

            # Transform pricing columns to JSONB
            pricing = _transform_pricing_to_jsonb(row, request.pricing_columns)
            part_data["pricing"] = pricing

            rows_to_insert.append(part_data)

        # Bulk insert in batches to avoid payload size limits
        BATCH_SIZE = 500
        imported_count = 0
        total_rows = len(rows_to_insert)
        logger.info(f"Starting parts import: {total_rows} rows to insert in batches of {BATCH_SIZE}")

        if rows_to_insert:
            try:
                total_batches = (total_rows + BATCH_SIZE - 1) // BATCH_SIZE
                for batch_num, i in enumerate(range(0, total_rows, BATCH_SIZE), 1):
                    batch = rows_to_insert[i:i + BATCH_SIZE]
                    logger.info(f"Inserting batch {batch_num}/{total_batches} ({len(batch)} rows)")
                    response = supabase.table("parts").insert(batch).execute()
                    batch_count = len(response.data) if response.data else 0
                    imported_count += batch_count
                    logger.info(f"Batch {batch_num} complete: {batch_count} rows inserted")
            except Exception as e:
                error_str = str(e)
                logger.error(f"Parts import database error: {error_str}", exc_info=True)
                logger.error(f"Failed at batch starting index {i}, rows imported so far: {imported_count}")
                # Log sample of failed batch for debugging
                if batch:
                    logger.error(f"Sample row from failed batch: {batch[0]}")
                # Check for unique constraint violation
                if "23505" in error_str or "duplicate key" in error_str.lower():
                    raise HTTPException(
                        status_code=400,
                        detail="Import failed: A part with this number already exists. Please check your CSV for duplicate part numbers.",
                    )
                sentry_sdk.capture_exception(e)
                raise HTTPException(
                    status_code=500,
                    detail="Internal server error",
                )

        logger.info(f"Parts import complete: {imported_count} rows imported, {skipped} skipped")

        return PartExecuteResponse(
            success=True,
            imported_count=imported_count,
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
