"""Import routes for BOM (parts_bom) CSV import with AI-powered mapping.

Validates that both parent and child parts exist, that the row isn't a self
reference, and that the new edge wouldn't close a cycle. Cycle detection is
done pre-flight (in the validate step) so the user sees every cycle at once
instead of one-at-a-time when the DB trigger fires during execute.

The cycle walk reads the existing parts_bom rows once, layers the in-flight
CSV rows on top, then for each proposed (parent, child) edge walks descendants
of the child to see if `parent` is reachable. If yes, the edge would close a
cycle.
"""

import hashlib
import json
import logging
import os

import sentry_sdk
from pathlib import Path

from fastapi import APIRouter, HTTPException, Depends
from supabase import Client

from models.bom_import_models import (
    ColumnMapping,
    BomAnalyzeRequest,
    BomAnalyzeResponse,
    BomValidateRequest,
    BomValidateResponse,
    BomValidationError,
    BomConflictInfo,
    BomExecuteRequest,
    BomExecuteResponse,
    BomImportError,
    BOM_SCHEMA,
)
from services.ai import get_provider
from utils.rate_limiter import RateLimiter
from utils.db_pagination import fetch_all_in

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/bom/import", tags=["bom-import"])

# Rate limiter: 10 AI calls per minute per company
ai_rate_limiter = RateLimiter(max_requests=10, window_seconds=60)

# Cache directory for AI responses (dev only - avoids repeated API calls)
CACHE_DIR = Path(__file__).parent.parent / ".cache" / "ai_responses" / "bom"
CACHE_ENABLED = os.getenv("AI_CACHE_ENABLED", "true").lower() == "true"

# Defensive bound for the recursive walk; matches the SQL trigger's bound.
MAX_BOM_DEPTH = 50


def _get_cache_key(company_id: str, headers: list[str]) -> str:
    """Generate a cache key from company_id and headers."""
    content = f"bom:{company_id}:{','.join(sorted(headers))}"
    return hashlib.md5(content.encode()).hexdigest()


def _get_cached_response(cache_key: str) -> BomAnalyzeResponse | None:
    """Try to get a cached response."""
    if not CACHE_ENABLED:
        return None

    cache_file = CACHE_DIR / f"{cache_key}.json"
    if cache_file.exists():
        try:
            with open(cache_file) as f:
                data = json.load(f)
            return BomAnalyzeResponse(**data)
        except Exception:
            return None
    return None


def _save_to_cache(cache_key: str, response: BomAnalyzeResponse) -> None:
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


def _walk_descendants_reaches(
    edges: dict[str, set[str]],
    start: str,
    target: str,
) -> bool:
    """BFS from `start` over `edges` (parent → set of children). Return True
    if `target` is reachable. Bounded by MAX_BOM_DEPTH levels."""
    if start == target:
        return True
    visited: set[str] = {start}
    frontier: list[str] = [start]
    depth = 0
    while frontier and depth < MAX_BOM_DEPTH:
        next_frontier: list[str] = []
        for node in frontier:
            for child in edges.get(node, ()):
                if child == target:
                    return True
                if child not in visited:
                    visited.add(child)
                    next_frontier.append(child)
        frontier = next_frontier
        depth += 1
    return False


def get_supabase() -> Client:
    """Get Supabase client from the main app."""
    from index import supabase

    if not supabase:
        raise HTTPException(
            status_code=500,
            detail="Supabase client not initialized",
        )
    return supabase


@router.post("/analyze", response_model=BomAnalyzeResponse)
async def analyze_csv(
    request: BomAnalyzeRequest,
    supabase: Client = Depends(get_supabase),
):
    """Analyze CSV headers and sample data to suggest column mappings for BOM rows."""
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
            target_schema=BOM_SCHEMA,
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
            field for field, info in BOM_SCHEMA.items() if info.get("required")
        ]
        unmapped_required = [f for f in required_fields if f not in mapped_db_fields]

        response = BomAnalyzeResponse(
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


@router.post("/validate", response_model=BomValidateResponse)
async def validate_import(
    request: BomValidateRequest,
    supabase: Client = Depends(get_supabase),
):
    """Validate BOM CSV data before import.

    Conflict types: unknown_parent_part, unknown_child_part, bom_self_reference,
    csv_duplicate, duplicate_bom_line, would_create_cycle.
    """
    try:
        # Existing parts (for parent/child name resolution). Supabase caps
        # `.select()` at 1000 rows by default — paginate so a company with
        # more than 1000 parts can still resolve BOM references without
        # silently producing fake "unknown_parent_part" conflicts.
        existing_parts: list[dict] = []
        page_size = 1000
        offset = 0
        while True:
            page = (
                supabase.table("parts")
                .select("id, part_name")
                .eq("company_id", request.company_id)
                .range(offset, offset + page_size - 1)
                .execute()
            )
            rows = page.data or []
            existing_parts.extend(rows)
            if len(rows) < page_size:
                break
            offset += page_size
        part_name_to_id: dict[str, str] = {
            p["part_name"].lower(): p["id"]
            for p in existing_parts
            if p.get("part_name")
        }

        # Existing parts_bom (for duplicate detection and cycle walk seed).
        # PostgREST encodes `.in_()` values into the URL — with thousands of
        # part IDs the URL exceeds the request line limit. Batch the lookup
        # in chunks of 200 IDs (~50 chars each = ~10KB URL) to stay safe.
        existing_part_ids = [p["id"] for p in existing_parts]
        existing_bom_rows: list[dict] = []
        IN_CLAUSE_BATCH = 200
        for chunk_start in range(0, len(existing_part_ids), IN_CLAUSE_BATCH):
            chunk = existing_part_ids[chunk_start : chunk_start + IN_CLAUSE_BATCH]
            bom_response = (
                supabase.table("parts_bom")
                .select("id, parent_part_id, child_part_id")
                .in_("parent_part_id", chunk)
                .execute()
            )
            existing_bom_rows.extend(bom_response.data or [])

        existing_bom_pairs: dict[tuple[str, str], str] = {}
        existing_edges: dict[str, set[str]] = {}
        for r in existing_bom_rows:
            parent_id = r.get("parent_part_id")
            child_id = r.get("child_part_id")
            bom_id = r.get("id", "")
            if parent_id and child_id:
                existing_bom_pairs[(parent_id, child_id)] = bom_id
                existing_edges.setdefault(parent_id, set()).add(child_id)

        reverse_mappings = {v: k for k, v in request.mappings.items()}
        parent_column = reverse_mappings.get("parent_part_name")
        child_column = reverse_mappings.get("child_part_name")
        quantity_column = reverse_mappings.get("quantity")
        unit_column = reverse_mappings.get("unit")

        # Track CSV duplicate (parent, child)
        pair_occurrences: dict[tuple[str, str], list[int]] = {}
        for i, row in enumerate(request.rows):
            row_number = i + 1
            parent = row.get(parent_column, "").strip() if parent_column else ""
            child = row.get(child_column, "").strip() if child_column else ""
            if parent and child:
                key = (parent.lower(), child.lower())
                pair_occurrences.setdefault(key, []).append(row_number)

        csv_duplicates = {k: v for k, v in pair_occurrences.items() if len(v) > 1}

        validation_errors: list[BomValidationError] = []
        conflicts: list[BomConflictInfo] = []
        validation_error_rows: set[int] = set()
        conflict_rows: set[int] = set()

        # Layer in-flight CSV edges on top of existing edges for cycle detection
        proposed_edges: dict[str, set[str]] = {
            k: set(v) for k, v in existing_edges.items()
        }

        # First pass: per-row validation that doesn't depend on cycle walk
        per_row_resolution: dict[int, tuple[str, str]] = {}
        for i, row in enumerate(request.rows):
            row_number = i + 1
            parent_name = (
                row.get(parent_column, "").strip() if parent_column else ""
            )
            child_name = (
                row.get(child_column, "").strip() if child_column else ""
            )

            if not parent_name:
                validation_errors.append(
                    BomValidationError(
                        row_number=row_number,
                        error_type="missing_parent_part_name",
                        field="parent_part_name",
                        message="Parent part name is required",
                    )
                )
                validation_error_rows.add(row_number)
                continue

            if not child_name:
                validation_errors.append(
                    BomValidationError(
                        row_number=row_number,
                        error_type="missing_child_part_name",
                        field="child_part_name",
                        message="Child part name is required",
                    )
                )
                validation_error_rows.add(row_number)
                continue

            qty_str = (
                row.get(quantity_column, "").strip() if quantity_column else ""
            )
            if not qty_str:
                validation_errors.append(
                    BomValidationError(
                        row_number=row_number,
                        error_type="missing_quantity",
                        field="quantity",
                        message="Quantity is required",
                    )
                )
                validation_error_rows.add(row_number)
                continue
            try:
                qty_val = float(qty_str)
                if qty_val <= 0:
                    raise ValueError("not positive")
            except ValueError:
                validation_errors.append(
                    BomValidationError(
                        row_number=row_number,
                        error_type="invalid_quantity",
                        field="quantity",
                        message="Quantity must be a positive number",
                    )
                )
                validation_error_rows.add(row_number)
                continue

            unit = row.get(unit_column, "").strip() if unit_column else ""
            if not unit:
                validation_errors.append(
                    BomValidationError(
                        row_number=row_number,
                        error_type="missing_unit",
                        field="unit",
                        message="Unit is required",
                    )
                )
                validation_error_rows.add(row_number)
                continue

            # Self-reference
            if parent_name.lower() == child_name.lower():
                conflicts.append(
                    BomConflictInfo(
                        row_number=row_number,
                        csv_parent=parent_name,
                        csv_child=child_name,
                        conflict_type="bom_self_reference",
                        existing_bom_id="",
                        existing_value="A part cannot be a child of itself",
                    )
                )
                conflict_rows.add(row_number)
                continue

            # Parent existence
            parent_id = part_name_to_id.get(parent_name.lower())
            if not parent_id:
                conflicts.append(
                    BomConflictInfo(
                        row_number=row_number,
                        csv_parent=parent_name,
                        csv_child=child_name,
                        conflict_type="unknown_parent_part",
                        existing_bom_id="",
                        existing_value=f"Parent part '{parent_name}' not found. Import parts first.",
                    )
                )
                conflict_rows.add(row_number)
                continue

            # Child existence
            child_id = part_name_to_id.get(child_name.lower())
            if not child_id:
                conflicts.append(
                    BomConflictInfo(
                        row_number=row_number,
                        csv_parent=parent_name,
                        csv_child=child_name,
                        conflict_type="unknown_child_part",
                        existing_bom_id="",
                        existing_value=f"Child part '{child_name}' not found. Import parts first.",
                    )
                )
                conflict_rows.add(row_number)
                continue

            # CSV duplicate
            pair_key = (parent_name.lower(), child_name.lower())
            if pair_key in csv_duplicates:
                other_rows = [
                    r for r in csv_duplicates[pair_key] if r != row_number
                ]
                if other_rows:
                    conflicts.append(
                        BomConflictInfo(
                            row_number=row_number,
                            csv_parent=parent_name,
                            csv_child=child_name,
                            conflict_type="csv_duplicate",
                            existing_bom_id="",
                            existing_value=f"Duplicate parent+child in CSV at rows {', '.join(map(str, other_rows))}",
                        )
                    )
                    conflict_rows.add(row_number)
                    continue

            # Existing BOM line
            existing_pair_key = (parent_id, child_id)
            if existing_pair_key in existing_bom_pairs:
                conflicts.append(
                    BomConflictInfo(
                        row_number=row_number,
                        csv_parent=parent_name,
                        csv_child=child_name,
                        conflict_type="duplicate_bom_line",
                        existing_bom_id=existing_bom_pairs[existing_pair_key],
                        existing_value=f"BOM line for {parent_name} → {child_name} already exists",
                    )
                )
                conflict_rows.add(row_number)
                continue

            per_row_resolution[row_number] = (parent_id, child_id)

        # Second pass: cycle detection (uses in-flight edges layered on existing)
        for row_number, (parent_id, child_id) in per_row_resolution.items():
            # Walk descendants from `child_id` over current proposed_edges. If
            # `parent_id` is reachable, adding parent → child closes a cycle.
            if _walk_descendants_reaches(proposed_edges, child_id, parent_id):
                # Look up CSV names for the message
                row = request.rows[row_number - 1]
                parent_name = (
                    row.get(parent_column, "").strip() if parent_column else ""
                )
                child_name = (
                    row.get(child_column, "").strip() if child_column else ""
                )
                conflicts.append(
                    BomConflictInfo(
                        row_number=row_number,
                        csv_parent=parent_name,
                        csv_child=child_name,
                        conflict_type="would_create_cycle",
                        existing_bom_id="",
                        existing_value=f"Adding {parent_name} → {child_name} would create a BOM cycle",
                    )
                )
                conflict_rows.add(row_number)
            else:
                # Layer the edge into proposed_edges so subsequent CSV rows see it
                proposed_edges.setdefault(parent_id, set()).add(child_id)

        total_skipped = conflict_rows | validation_error_rows
        valid_rows = len(request.rows) - len(total_skipped)

        return BomValidateResponse(
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
        logger.error(f"BOM import validate error: {str(e)}", exc_info=True)
        sentry_sdk.capture_exception(e)
        raise HTTPException(
            status_code=500,
            detail="Internal server error",
        )


@router.post("/execute", response_model=BomExecuteResponse)
async def execute_import(
    request: BomExecuteRequest,
    supabase: Client = Depends(get_supabase),
):
    """Execute the BOM import."""
    try:
        validate_response = await validate_import(
            BomValidateRequest(
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

        # An existing (parent, child) BOM line is NOT skipped — execute upserts it (updates
        # quantity/unit in place). Only within-CSV duplicate pairs (csv_duplicate), cycles,
        # self-references, and unknown parts stay skipped.
        skip_row_numbers = {
            c.row_number
            for c in validate_response.conflicts
            if c.conflict_type != "duplicate_bom_line"
        }
        skip_row_numbers |= {e.row_number for e in validate_response.validation_errors}

        # Resolve part names (the validate already returned valid rows but we
        # need the IDs again for the insert). Paginate to handle companies
        # with more than Supabase's 1000-row default page size.
        existing_parts: list[dict] = []
        page_size = 1000
        offset = 0
        while True:
            page = (
                supabase.table("parts")
                .select("id, part_name")
                .eq("company_id", request.company_id)
                .range(offset, offset + page_size - 1)
                .execute()
            )
            rows = page.data or []
            existing_parts.extend(rows)
            if len(rows) < page_size:
                break
            offset += page_size
        part_name_to_id = {
            p["part_name"].lower(): p["id"]
            for p in existing_parts
            if p.get("part_name")
        }

        # Existing (parent_part_id, child_part_id) pairs — so we upsert without colliding and
        # report created vs updated honestly. Paged past PostgREST's 1000-row cap.
        existing_bom_pairs = {
            (r["parent_part_id"], r["child_part_id"])
            for r in fetch_all_in(
                supabase,
                "parts_bom",
                "parent_part_id, child_part_id",
                "parent_part_id",
                list(part_name_to_id.values()),
            )
        }

        reverse_mappings = {v: k for k, v in request.mappings.items()}
        parent_column = reverse_mappings.get("parent_part_name")
        child_column = reverse_mappings.get("child_part_name")
        quantity_column = reverse_mappings.get("quantity")
        unit_column = reverse_mappings.get("unit")

        rows_to_insert: list[dict] = []
        errors: list[BomImportError] = []
        skipped = 0
        updated_count = 0

        for i, row in enumerate(request.rows):
            row_number = i + 1

            if row_number in skip_row_numbers:
                skipped += 1
                continue

            parent_name = (
                row.get(parent_column, "").strip() if parent_column else ""
            )
            child_name = (
                row.get(child_column, "").strip() if child_column else ""
            )
            parent_id = part_name_to_id.get(parent_name.lower())
            child_id = part_name_to_id.get(child_name.lower())
            if not parent_id or not child_id:
                # Defense-in-depth — validate already filtered this case
                errors.append(
                    BomImportError(
                        row_number=row_number,
                        reason=f"Missing part at execute time (parent={parent_name}, child={child_name})",
                        data={k: v for k, v in row.items() if v},
                    )
                )
                skipped += 1
                continue

            qty_str = (
                row.get(quantity_column, "").strip() if quantity_column else ""
            )
            unit = row.get(unit_column, "").strip() if unit_column else ""
            try:
                quantity = float(qty_str)
            except ValueError:
                skipped += 1
                continue

            bom_data: dict = {
                "parent_part_id": parent_id,
                "child_part_id": child_id,
                "quantity": quantity,
                "unit": unit,
            }

            if (parent_id, child_id) in existing_bom_pairs:
                updated_count += 1
            rows_to_insert.append(bom_data)

        BATCH_SIZE = 500
        written_count = 0
        if rows_to_insert:
            try:
                total = len(rows_to_insert)
                for batch_start in range(0, total, BATCH_SIZE):
                    batch = rows_to_insert[batch_start : batch_start + BATCH_SIZE]
                    # Idempotent: existing (parent, child) lines update quantity/unit in place,
                    # new ones insert. Updating an existing edge can't introduce a cycle (the
                    # edge was already in the acyclic graph); new edges were cycle-validated.
                    response = (
                        supabase.table("parts_bom")
                        .upsert(batch, on_conflict="parent_part_id,child_part_id")
                        .execute()
                    )
                    written_count += len(response.data) if response.data else 0
            except Exception as e:
                error_str = str(e)
                if "23505" in error_str or "duplicate key" in error_str.lower():
                    raise HTTPException(
                        status_code=400,
                        detail="Import failed: A BOM line for this parent+child already exists.",
                    )
                if "check_violation" in error_str.lower() or "would create a cycle" in error_str.lower():
                    raise HTTPException(
                        status_code=400,
                        detail="Import failed: A row would create a BOM cycle. Run validate again to see which rows.",
                    )
                sentry_sdk.capture_exception(e)
                raise HTTPException(status_code=500, detail="Internal server error")

        # written_count is inserts + updates; split the updates back out for an honest summary.
        created_count = max(0, written_count - updated_count)
        return BomExecuteResponse(
            success=True,
            imported_count=created_count,
            updated_count=updated_count,
            skipped_count=skipped,
            errors=errors,
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"BOM import execution error: {str(e)}", exc_info=True)
        sentry_sdk.capture_exception(e)
        raise HTTPException(
            status_code=500,
            detail="Internal server error",
        )
