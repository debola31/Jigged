"""Data-import endpoints (#523): the AI-only steps behind the Review & Fix stage.

Strictly advisory and AI-only. The deterministic analysis runs in the BROWSER
(lib/dataImportAnalyzer.ts) on rows that are already parsed there, so raw rows never
reach the server (no 4.5 MB body limit, and nothing is stored). The server keeps only the
two steps that need the secret API key, each with a tiny payload:

  1. ``POST /structure`` — headers + a few sample rows -> per-file entity classification,
     raw->canonical ``column_roles``, and ERP detection.
  2. ``POST /narrative`` — the client-computed findings -> grounded plain-English prose.

Both perform NO writes to any table and call no ``auth.admin``; their only database access
is SELECTs (verify caller access, read the company feature flag, resolve the AI provider).
They deliberately import no ``*_import_routes`` / execute path.
"""

from __future__ import annotations

import hashlib
import logging
import os

from fastapi import APIRouter, HTTPException, Request
from supabase import Client, create_client

from models.data_import_models import (
    ENTITY_SCHEMAS,
    ERP_CATALOG,
    ErpDetection,
    FileClassification,
    NarrativeRequest,
    NarrativeResponse,
    StructureRequest,
    StructureResponse,
    entity_type_from_str,
)
from services.ai.factory import get_provider
from utils.rate_limiter import RateLimiter

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/data-import", tags=["data-import"])

FEATURE_FLAG = "data_import"

MAX_FILES = 12
MAX_HEADERS_PER_FILE = 300
MAX_FINDINGS = 500  # findings are aggregated (small); bound the AI prompt anyway

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
    """Opt-IN gate: true only when companies.settings.features.data_import is set.

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
    """Shared gate for both endpoints: caller auth + opt-in flag + rate limit."""
    client = _service_client()
    await _verify_company_access(request, company_id, client)
    if not _feature_enabled(company_id, client):
        raise HTTPException(status_code=403, detail="Data import is not enabled for this company.")
    if not _limiter.check(company_id):
        raise HTTPException(
            status_code=429,
            detail="Too many import analyses. Please wait a few minutes and try again.",
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
        return StructureResponse(erp_detection=erp_detection, files=classifications)
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001 — log the type only, never row content
        logger.warning("Import structure step failed: %s", type(e).__name__)
        raise HTTPException(status_code=500, detail="Failed to analyze the uploaded files.")


@router.post("/narrative", response_model=NarrativeResponse)
async def narrative(request: NarrativeRequest, req: Request) -> NarrativeResponse:
    """Phase 2: turn the client-computed findings into grounded plain-English prose."""
    company_id = request.company_id
    client = await _authorize(req, company_id)

    try:
        provider = await get_provider(client, company_id, "csv_mapping")
        result = await provider.generate_import_narrative(
            erp=request.erp_detection.model_dump(),
            findings=request.findings[:MAX_FINDINGS],
            file_summaries=request.file_summaries[:MAX_FILES],
        )
        return NarrativeResponse(
            summary=result.summary if result.available else "",
            recommendations=result.recommendations,
            gotchas=result.gotchas,
            narrative_available=result.available,
            ai_provider=provider.provider_name,
            ai_model=getattr(provider, "model", ""),
        )
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001 — log the type only, never row content
        logger.warning("Import narrative step failed: %s", type(e).__name__)
        raise HTTPException(status_code=500, detail="Failed to generate the summary.")
