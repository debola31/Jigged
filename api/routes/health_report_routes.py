"""Read-only Data Health / Import-Readiness report endpoints (#523).

Strictly advisory. These routes perform NO writes to any table and call no
``auth.admin`` — their only database access is SELECTs (verify caller access, read the
company feature flag, resolve the AI provider from ``ai_config``). They deliberately do
NOT import any ``*_import_routes`` / execute path, so there is no reachable write.

Two-phase flow (one explicit user action — the frontend "Analyze" button):
  1. ``POST /structure`` — tiny payload (headers + a few sample rows). Verifies access +
     the opt-in flag, then runs the AI "structure" call: per-file entity classification,
     raw->canonical ``column_roles``, and ERP detection.
  2. ``POST /findings`` — the client uploads ONLY the columns the analyzer needs (the
     identified role columns + a status column). Runs the pure-Python deterministic
     analyzer over those, then the grounded narrative call.

The split keeps every request well under Vercel's ~4.5 MB body limit regardless of how
many extra columns the export carries. No on-disk cache is used (it would write the
uploaded rows to disk / EROFS on Vercel).
"""

from __future__ import annotations

import hashlib
import logging
import os

from fastapi import APIRouter, HTTPException, Request
from supabase import Client, create_client

from models.health_report_models import (
    ENTITY_SCHEMAS,
    ERP_CATALOG,
    ErpDetection,
    FileClassification,
    Finding,
    FindingCategory,
    FindingsRequest,
    FindingsResponse,
    Severity,
    StructureRequest,
    StructureResponse,
    entity_type_from_str,
)
from services.ai.factory import get_provider
from services.health_report_analyzer import AnalyzedFile, analyze_bundle, needed_raw_columns
from utils.rate_limiter import RateLimiter

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/health-report", tags=["health-report"])

FEATURE_FLAG = "data_health_report"

# Size caps — reject oversized inputs (413) rather than silently truncate (which would
# make the deterministic counts wrong).
MAX_FILES = 12
MAX_HEADERS_PER_FILE = 300
MAX_TOTAL_ROWS = 200_000

# Best-effort per-company limiter (weak on serverless cold starts; the meaningful bound
# is the feature flag + caller authorization).
_limiter = RateLimiter(max_requests=20, window_seconds=600)


def _service_client() -> Client:
    url = os.getenv("NEXT_PUBLIC_SUPABASE_URL") or os.getenv("SUPABASE_URL")
    key = os.getenv("SUPABASE_SECRET_KEY") or os.getenv("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        raise HTTPException(status_code=503, detail="Database not configured")
    return create_client(url, key)


async def _verify_company_access(request: Request, company_id: str, client: Client) -> str:
    """Verify the bearer-token caller has a user_company_access row for company_id.

    Read-only (auth.get_user + one SELECT). Mirrors quickbooks_routes._verify_company_access.
    """
    token = request.headers.get("Authorization", "").replace("Bearer ", "")
    if not token:
        raise HTTPException(status_code=401, detail="Not authenticated")
    try:
        user_response = client.auth.get_user(token)
        if not user_response or not user_response.user:
            raise HTTPException(status_code=401, detail="Invalid token")
        user_id = user_response.user.id
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        logger.warning("Token verification failed: %s", exc)
        raise HTTPException(status_code=401, detail="Invalid or expired token")

    access = (
        client.table("user_company_access")
        .select("id")
        .eq("user_id", user_id)
        .eq("company_id", company_id)
        .limit(1)
        .execute()
    )
    if not access.data:
        raise HTTPException(status_code=403, detail="No access to this company")
    return user_id


def _feature_enabled(company_id: str, client: Client) -> bool:
    """Opt-IN gate: true only when companies.settings.features.data_health_report is set.

    Fails CLOSED on read error — an advisory extra shouldn't dark-launch on a DB blip.
    """
    try:
        resp = (
            client.table("companies")
            .select("settings")
            .eq("id", company_id)
            .single()
            .execute()
        )
        settings = (resp.data or {}).get("settings") or {}
    except Exception as e:  # noqa: BLE001
        logger.warning("Failed to read company feature flags: %s", e)
        return False
    features = settings.get("features") or {}
    raw = features.get(FEATURE_FLAG)
    return raw is True or raw == "true"


async def _authorize(request: Request, company_id: str) -> Client:
    """Shared gate for both phases: caller auth + opt-in flag + rate limit."""
    client = _service_client()
    await _verify_company_access(request, company_id, client)
    if not _feature_enabled(company_id, client):
        raise HTTPException(status_code=403, detail="Data Health report is not enabled for this company.")
    if not _limiter.check(company_id):
        raise HTTPException(
            status_code=429,
            detail="Too many data-health analyses. Please wait a few minutes and try again.",
            headers={"Retry-After": "600"},
        )
    return client


def _column_samples(headers: list[str], sample_rows: list[list[str]]) -> dict[str, str]:
    """One non-empty sample value per column, from the positional sample rows."""
    out: dict[str, str] = {}
    for j, h in enumerate(headers):
        for row in sample_rows:
            if j < len(row):
                v = (row[j] or "").strip()
                if v:
                    out[h] = v
                    break
    return out


def _bundle_signature(all_headers: list[list[str]]) -> str:
    per_file = ["|".join(sorted(h)) for h in all_headers]
    return hashlib.md5("||".join(sorted(per_file)).encode()).hexdigest()


@router.post("/structure", response_model=StructureResponse)
async def structure(request: StructureRequest, req: Request) -> StructureResponse:
    """Phase 1: classify each file + detect the ERP from headers + a small sample."""
    company_id = request.company_id
    client = await _authorize(req, company_id)

    if len(request.files) > MAX_FILES:
        raise HTTPException(status_code=413, detail=f"Too many files (max {MAX_FILES}).")
    for f in request.files:
        if len(f.headers) > MAX_HEADERS_PER_FILE:
            raise HTTPException(
                status_code=413,
                detail=f"'{f.filename}' has too many columns (max {MAX_HEADERS_PER_FILE}).",
            )

    try:
        entity_schemas = {et.value: schema for et, schema in ENTITY_SCHEMAS.items()}
        struct_input = [
            {
                "filename": f.filename,
                "headers": f.headers,
                "column_samples": _column_samples(f.headers, f.sample_rows),
            }
            for f in request.files
        ]
        provider = await get_provider(client, company_id, "csv_mapping")
        result = await provider.analyze_structure(struct_input, entity_schemas, ERP_CATALOG)
        model = getattr(provider, "model", "")

        by_name = {f.filename: f for f in request.files}
        classifications = [
            FileClassification(
                filename=fs.filename,
                entity_type=entity_type_from_str(fs.entity_type),
                entity_confidence=fs.entity_confidence,
                headers=by_name[fs.filename].headers if fs.filename in by_name else [],
                row_count=by_name[fs.filename].row_count if fs.filename in by_name else 0,
                column_roles=fs.column_roles,
            )
            for fs in result.files
        ]
        erp = result.erp
        erp_detection = ErpDetection(
            source=erp.source,
            display_name=erp.display_name,
            confidence=erp.confidence,
            matched_headers=erp.matched_headers,
            evidence=erp.evidence,
            alternatives=erp.alternatives,
            header_signature=_bundle_signature([f.headers for f in request.files]),
            ai_provider=provider.provider_name,
            ai_model=model,
        )
        needed_columns = {
            fc.filename: needed_raw_columns(fc.entity_type, fc.column_roles, fc.headers)
            for fc in classifications
        }
        return StructureResponse(
            erp_detection=erp_detection, files=classifications, needed_columns=needed_columns
        )
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001 — log the type only, never row content
        logger.warning("Health report structure step failed: %s", type(e).__name__)
        raise HTTPException(status_code=500, detail="Failed to analyze the uploaded files.")


@router.post("/findings", response_model=FindingsResponse)
async def findings(request: FindingsRequest, req: Request) -> FindingsResponse:
    """Phase 2: deterministic findings over the needed columns + grounded narrative."""
    company_id = request.company_id
    client = await _authorize(req, company_id)

    total_rows = sum(len(f.rows) for f in request.files)
    if total_rows > MAX_TOTAL_ROWS:
        raise HTTPException(
            status_code=413,
            detail=f"Too many rows in one upload (max {MAX_TOTAL_ROWS:,}).",
        )

    try:
        analyzed = [
            AnalyzedFile(
                filename=f.filename,
                entity_type=f.entity_type,
                column_roles=f.column_roles,
                # Rebuild dict rows from the compact positional encoding.
                rows=[dict(zip(f.headers, row)) for row in f.rows],
                headers=f.headers,
            )
            for f in request.files
        ]
        deterministic = analyze_bundle(analyzed)

        file_summaries = [
            {"filename": af.filename, "entity_type": af.entity_type.value, "row_count": len(af.rows)}
            for af in analyzed
        ]
        findings_payload = [
            {
                "id": f.id,
                "category": f.category.value,
                "severity": f.severity.value,
                "title": f.title,
                "detail": f.detail,
                "count": f.count,
                "examples": f.examples[:3],
            }
            for f in deterministic
        ]
        provider = await get_provider(client, company_id, "csv_mapping")
        narrative = await provider.generate_health_narrative(
            erp=request.erp_detection.model_dump(),
            findings=findings_payload,
            file_summaries=file_summaries,
        )

        out = list(deterministic)
        for i, g in enumerate(narrative.gotchas):
            out.append(
                Finding(
                    id=f"gotcha.{i}",
                    category=FindingCategory.ERP_GOTCHA,
                    severity=Severity.INFO,
                    title=g.get("title", "Worth verifying"),
                    detail=g.get("detail", ""),
                    recommended_action=g.get("recommended_action", ""),
                    verified=False,
                )
            )

        return FindingsResponse(
            findings=out,
            summary=narrative.summary if narrative.available else "",
            recommendations=narrative.recommendations,
            narrative_available=narrative.available,
            ai_provider=provider.provider_name,
            ai_model=getattr(provider, "model", ""),
        )
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001 — log the type only, never row content
        logger.warning("Health report findings step failed: %s", type(e).__name__)
        raise HTTPException(status_code=500, detail="Failed to analyze the uploaded files.")
