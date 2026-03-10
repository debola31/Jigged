"""Inventory API routes for import functionality."""

import hashlib
import json
import logging
import os

import sentry_sdk
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException, Depends
from supabase import Client

from models.inventory_models import (
    InventoryAnalyzeRequest,
    InventoryAnalyzeResponse,
    ColumnMapping,
    InventoryValidateRequest,
    InventoryValidateResponse,
    InventoryConflictInfo,
    InventoryValidationError,
    InventoryExecuteRequest,
    InventoryExecuteResponse,
    INVENTORY_SCHEMA,
)
from services.ai import get_provider
from utils.rate_limiter import RateLimiter

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/inventory", tags=["inventory"])

# Rate limiter: 10 AI calls per minute per company
ai_rate_limiter = RateLimiter(max_requests=10, window_seconds=60)

# Cache directory for AI responses (dev only)
CACHE_DIR = Path(__file__).parent.parent / ".cache" / "ai_responses" / "inventory"
CACHE_ENABLED = os.getenv("AI_CACHE_ENABLED", "true").lower() == "true"


def get_supabase() -> Client:
    """Get Supabase client from the main app."""
    from index import supabase

    if not supabase:
        raise HTTPException(
            status_code=500,
            detail="Supabase client not initialized",
        )
    return supabase


# ============================================================
# Import Routes - AI Analysis
# ============================================================

def _get_cache_key(company_id: str, headers: list[str]) -> str:
    """Generate a cache key from company_id and headers."""
    content = f"inventory:{company_id}:{','.join(sorted(headers))}"
    return hashlib.md5(content.encode()).hexdigest()


def _get_cached_response(cache_key: str) -> Optional[InventoryAnalyzeResponse]:
    """Try to get a cached response."""
    if not CACHE_ENABLED:
        return None

    cache_file = CACHE_DIR / f"{cache_key}.json"
    if cache_file.exists():
        try:
            with open(cache_file) as f:
                data = json.load(f)
            return InventoryAnalyzeResponse(**data)
        except Exception:
            return None
    return None


def _save_to_cache(cache_key: str, response: InventoryAnalyzeResponse) -> None:
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


def _get_column_samples(headers: list[str], sample_rows: list[list[str]]) -> dict[str, str]:
    """Get one sample value per non-empty column."""
    samples: dict[str, str] = {}

    for row in sample_rows:
        for i, header in enumerate(headers):
            if header in samples:
                continue
            value = row[i].strip() if i < len(row) else ""
            if value:
                samples[header] = value
        if len(samples) == len(headers):
            break

    return samples


@router.post("/import/analyze", response_model=InventoryAnalyzeResponse)
async def analyze_csv(
    request: InventoryAnalyzeRequest,
    supabase: Client = Depends(get_supabase),
):
    """
    Analyze CSV headers and sample data to suggest column mappings using AI.
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

    column_samples = _get_column_samples(request.headers, request.sample_rows)

    try:
        provider = await get_provider(supabase, request.company_id, "csv_mapping")

        suggestions = await provider.suggest_column_mappings(
            csv_headers=request.headers,
            sample_rows=request.sample_rows,
            target_schema=INVENTORY_SCHEMA,
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
            field for field, info in INVENTORY_SCHEMA.items() if info.get("required")
        ]
        unmapped_required = [f for f in required_fields if f not in mapped_db_fields]

        response = InventoryAnalyzeResponse(
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
        raise HTTPException(status_code=500, detail="Internal server error")


# ============================================================
# Import Routes - Validation
# ============================================================

@router.post("/import/validate", response_model=InventoryValidateResponse)
async def validate_import(
    request: InventoryValidateRequest,
    supabase: Client = Depends(get_supabase),
):
    """
    Validate CSV data before import by checking for conflicts.

    Checks for duplicate SKU against existing records.
    """
    try:
        # Get existing inventory items for this company
        response = supabase.table("inventory_items").select(
            "id, sku, name"
        ).eq("company_id", request.company_id).execute()

        existing_items = response.data or []

        # Build lookup sets for quick conflict detection
        existing_skus = {
            i["sku"].lower(): i for i in existing_items if i.get("sku")
        }

        # Find column mappings
        sku_column = None
        name_column = None
        primary_unit_column = None
        quantity_column = None
        cost_column = None

        for csv_col, db_field in request.mappings.items():
            if db_field == "sku":
                sku_column = csv_col
            elif db_field == "name":
                name_column = csv_col
            elif db_field == "primary_unit":
                primary_unit_column = csv_col
            elif db_field == "quantity":
                quantity_column = csv_col
            elif db_field == "cost_per_unit":
                cost_column = csv_col

        # Track occurrences for internal duplicate detection
        sku_occurrences: dict[str, list[int]] = {}

        for i, row in enumerate(request.rows):
            row_number = i + 1
            csv_sku = row.get(sku_column, "").strip() if sku_column else ""

            if csv_sku:
                sku_lower = csv_sku.lower()
                if sku_lower not in sku_occurrences:
                    sku_occurrences[sku_lower] = []
                sku_occurrences[sku_lower].append(row_number)

        duplicate_skus = {k: v for k, v in sku_occurrences.items() if len(v) > 1}

        # Validate rows
        validation_errors = []
        validation_error_rows: set[int] = set()
        conflicts = []
        conflict_rows: set[int] = set()

        for i, row in enumerate(request.rows):
            row_number = i + 1

            csv_name = row.get(name_column, "").strip() if name_column else ""
            csv_sku = row.get(sku_column, "").strip() if sku_column else ""
            csv_unit = row.get(primary_unit_column, "").strip() if primary_unit_column else ""
            csv_quantity = row.get(quantity_column, "").strip() if quantity_column else ""
            csv_cost = row.get(cost_column, "").strip() if cost_column else ""

            # Required field validation
            if not csv_name:
                validation_errors.append(
                    InventoryValidationError(
                        row_number=row_number,
                        error_type="missing_name",
                        field="name",
                        message="Item name is required",
                    )
                )
                validation_error_rows.add(row_number)
                continue

            if not csv_unit:
                validation_errors.append(
                    InventoryValidationError(
                        row_number=row_number,
                        error_type="missing_primary_unit",
                        field="primary_unit",
                        message="Primary unit is required",
                    )
                )
                validation_error_rows.add(row_number)
                continue

            # Numeric field validation
            if csv_quantity:
                try:
                    qty = float(csv_quantity)
                    if qty < 0:
                        raise ValueError("negative")
                except ValueError:
                    validation_errors.append(
                        InventoryValidationError(
                            row_number=row_number,
                            error_type="invalid_quantity",
                            field="quantity",
                            message="Quantity must be a non-negative number",
                        )
                    )
                    validation_error_rows.add(row_number)
                    continue

            if csv_cost:
                try:
                    cost = float(csv_cost)
                    if cost < 0:
                        raise ValueError("negative")
                except ValueError:
                    validation_errors.append(
                        InventoryValidationError(
                            row_number=row_number,
                            error_type="invalid_cost",
                            field="cost_per_unit",
                            message="Cost per unit must be a non-negative number",
                        )
                    )
                    validation_error_rows.add(row_number)
                    continue

        # Check for conflicts (after validation)
        for i, row in enumerate(request.rows):
            row_number = i + 1

            if row_number in validation_error_rows:
                continue

            csv_name = row.get(name_column, "").strip() if name_column else ""
            csv_sku = row.get(sku_column, "").strip() if sku_column else ""

            # Check for CSV internal duplicate SKU
            if csv_sku:
                sku_lower = csv_sku.lower()
                if sku_lower in duplicate_skus:
                    other_rows = [r for r in duplicate_skus[sku_lower] if r != row_number]
                    conflicts.append(
                        InventoryConflictInfo(
                            row_number=row_number,
                            csv_name=csv_name,
                            csv_sku=csv_sku,
                            conflict_type="csv_duplicate_sku",
                            existing_item_id="",
                            existing_value=f"Rows {', '.join(map(str, other_rows))}",
                        )
                    )
                    conflict_rows.add(row_number)
                    continue

                # Check for DB duplicate SKU
                if sku_lower in existing_skus:
                    existing = existing_skus[sku_lower]
                    conflicts.append(
                        InventoryConflictInfo(
                            row_number=row_number,
                            csv_name=csv_name,
                            csv_sku=csv_sku,
                            conflict_type="duplicate_sku",
                            existing_item_id=existing["id"],
                            existing_value=existing["sku"],
                        )
                    )
                    conflict_rows.add(row_number)

        total_skipped = conflict_rows | validation_error_rows
        valid_rows = len(request.rows) - len(total_skipped)

        return InventoryValidateResponse(
            has_conflicts=len(conflicts) > 0,
            conflicts=conflicts,
            validation_errors=validation_errors,
            valid_rows_count=valid_rows,
            conflict_rows_count=len(conflict_rows),
            error_rows_count=len(validation_error_rows),
            skipped_rows_count=len(total_skipped),
        )

    except Exception as e:
        logger.error(f"Error validating data: {str(e)}", exc_info=True)
        sentry_sdk.capture_exception(e)
        raise HTTPException(status_code=500, detail="Internal server error")


# ============================================================
# Import Routes - Execute
# ============================================================

@router.post("/import/execute", response_model=InventoryExecuteResponse)
async def execute_import(
    request: InventoryExecuteRequest,
    supabase: Client = Depends(get_supabase),
):
    """
    Execute the inventory import.

    If skip_conflicts is True, only imports rows without conflicts.
    """
    try:
        # First validate
        validate_response = await validate_import(
            InventoryValidateRequest(
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

        # Build skip set
        skip_row_numbers = {c.row_number for c in validate_response.conflicts}
        skip_row_numbers |= {e.row_number for e in validate_response.validation_errors}

        # Find column mappings
        reverse_mappings = {v: k for k, v in request.mappings.items()}

        # Prepare rows
        rows_to_insert = []
        errors = []
        skipped = 0

        for i, row in enumerate(request.rows):
            row_number = i + 1

            if row_number in skip_row_numbers:
                skipped += 1
                continue

            item_data = {"company_id": request.company_id}

            for db_field in INVENTORY_SCHEMA.keys():
                csv_column = reverse_mappings.get(db_field)
                if csv_column and csv_column in row:
                    value = row[csv_column].strip()
                    if value and value.lower() != "undefined":
                        # Convert numeric fields
                        if db_field in ("quantity", "cost_per_unit"):
                            try:
                                item_data[db_field] = float(value)
                            except ValueError:
                                pass
                        else:
                            item_data[db_field] = value

            # Set defaults
            if "quantity" not in item_data:
                item_data["quantity"] = 0

            rows_to_insert.append(item_data)

        # Bulk insert
        imported_count = 0
        if rows_to_insert:
            try:
                response = supabase.table("inventory_items").insert(rows_to_insert).execute()
                imported_count = len(response.data) if response.data else 0
            except Exception as e:
                error_str = str(e)
                if "23505" in error_str or "duplicate key" in error_str.lower():
                    if "sku" in error_str.lower():
                        raise HTTPException(
                            status_code=400,
                            detail="Import failed: An item with this SKU already exists.",
                        )
                    raise HTTPException(
                        status_code=400,
                        detail="Import failed: Duplicate values detected.",
                    )
                sentry_sdk.capture_exception(e)
                raise HTTPException(
                    status_code=500,
                    detail="Internal server error",
                )

        return InventoryExecuteResponse(
            success=True,
            imported_count=imported_count,
            skipped_count=skipped,
            errors=errors,
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Import execution error: {str(e)}", exc_info=True)
        sentry_sdk.capture_exception(e)
        raise HTTPException(status_code=500, detail="Internal server error")
