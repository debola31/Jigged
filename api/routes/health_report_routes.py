"""Read-only Data Health / Import-Readiness report endpoint (#523).

Strictly advisory. This route performs NO writes to any table and calls no
``auth.admin`` — its only database access is SELECTs (verify caller access, read the
company feature flag, resolve the AI provider from ``ai_config``). It deliberately does
NOT import any ``*_import_routes`` / execute path, so there is no reachable write.

Flow (one explicit user action — the frontend "Analyze" button):
  1. Verify the caller has access to ``company_id`` (never trust the body alone).
  2. Server-side feature-flag gate (opt-in; the client flag only hides the UI).
  3. Enforce size caps (files / headers / total rows).
  4. Best-effort in-memory rate limit (real bound is flag + caller-auth; a serverless
     in-memory limiter is weak by itself — see plan).
  5. AI "structure" call: per-file entity + raw->canonical column_roles + ERP detection.
  6. Deterministic findings over the uploaded bundle (pure Python, no AI, no DB).
  7. AI "narrative" call, grounded strictly in those findings (informative, never
     fabricating numbers; degrades to raw findings if it fails).

No on-disk cache is used here: the reused import-route cache would write the uploaded
rows to disk (a data-at-rest leak, and it EROFS-fails on Vercel anyway).
"""

from __future__ import annotations

import hashlib
import logging
import os
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException, Request
from supabase import Client, create_client

from models.health_report_models import (
    ENTITY_SCHEMAS,
    ERP_CATALOG,
    ErpDetection,
    FileClassification,
    Finding,
    FindingCategory,
    HealthReport,
    HealthReportRequest,
    HealthReportResponse,
    Severity,
    entity_type_from_str,
)
from services.ai.factory import get_provider
from services.health_report_analyzer import AnalyzedFile, analyze_bundle
from utils.rate_limiter import RateLimiter

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/health-report", tags=["health-report"])

FEATURE_FLAG = "data_health_report"

# Size caps — reject oversized bundles (413) rather than silently truncate, which would
# make the deterministic counts wrong.
MAX_FILES = 12
MAX_HEADERS_PER_FILE = 300
MAX_TOTAL_ROWS = 200_000
_SAMPLE_SCAN_ROWS = 50  # rows scanned to find one non-empty sample value per column

# Best-effort per-company limiter (10 reports / 10 min). Weak on serverless cold starts;
# the meaningful bound is the feature flag + caller authorization.
_limiter = RateLimiter(max_requests=10, window_seconds=600)


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
    """Opt-IN gate: only true when companies.settings.features.data_health_report is set.

    Unlike ai_insights (opt-out), this new tool is off unless explicitly enabled per
    company. Fails CLOSED on read error — an advisory extra shouldn't dark-launch on a
    DB blip.
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


def _enforce_caps(files) -> None:
    if len(files) > MAX_FILES:
        raise HTTPException(status_code=413, detail=f"Too many files (max {MAX_FILES}).")
    total_rows = sum(len(f.rows) for f in files)
    if total_rows > MAX_TOTAL_ROWS:
        raise HTTPException(
            status_code=413,
            detail=f"Too many rows in one upload (max {MAX_TOTAL_ROWS:,}).",
        )
    for f in files:
        if len(f.headers) > MAX_HEADERS_PER_FILE:
            raise HTTPException(
                status_code=413,
                detail=f"'{f.filename}' has too many columns (max {MAX_HEADERS_PER_FILE}).",
            )


def _column_samples(headers: list[str], rows: list[dict]) -> dict[str, str]:
    """One non-empty sample value per column, scanning only the first few rows."""
    out: dict[str, str] = {}
    scan = rows[:_SAMPLE_SCAN_ROWS]
    for h in headers:
        for row in scan:
            v = (row.get(h) or "").strip()
            if v:
                out[h] = v
                break
    return out


def _bundle_signature(files) -> str:
    per_file = ["|".join(sorted(f.headers)) for f in files]
    return hashlib.md5("||".join(sorted(per_file)).encode()).hexdigest()


@router.post("/analyze", response_model=HealthReportResponse)
async def analyze(request: HealthReportRequest, req: Request) -> HealthReportResponse:
    company_id = request.company_id
    client = _service_client()

    # 1-2. authorization + opt-in feature gate (both before any paid AI work)
    await _verify_company_access(req, company_id, client)
    if not _feature_enabled(company_id, client):
        raise HTTPException(status_code=403, detail="Data Health report is not enabled for this company.")

    # 3. size caps
    _enforce_caps(request.files)

    # 4. best-effort rate limit
    if not _limiter.check(company_id):
        raise HTTPException(
            status_code=429,
            detail="Too many data-health analyses. Please wait a few minutes and try again.",
            headers={"Retry-After": "600"},
        )

    try:
        # 5. AI structure + source detection
        entity_schemas = {et.value: schema for et, schema in ENTITY_SCHEMAS.items()}
        struct_input = [
            {
                "filename": f.filename,
                "headers": f.headers,
                "column_samples": _column_samples(f.headers, f.rows),
            }
            for f in request.files
        ]
        provider = await get_provider(client, company_id, "csv_mapping")
        structure = await provider.analyze_structure(struct_input, entity_schemas, ERP_CATALOG)
        model = getattr(provider, "model", "")

        # 6. deterministic findings over the AI-identified column roles
        rows_by_name = {f.filename: f.rows for f in request.files}
        headers_by_name = {f.filename: f.headers for f in request.files}
        analyzed = [
            AnalyzedFile(
                filename=fs.filename,
                entity_type=entity_type_from_str(fs.entity_type),
                column_roles=fs.column_roles,
                rows=rows_by_name.get(fs.filename, []),
                headers=headers_by_name.get(fs.filename, []),
            )
            for fs in structure.files
        ]
        findings = analyze_bundle(analyzed)

        # 7. grounded narrative
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
            for f in findings
        ]
        narrative = await provider.generate_health_narrative(
            erp=structure.erp.model_dump(),
            findings=findings_payload,
            file_summaries=file_summaries,
        )

        # AI "gotchas" are informative but unverified — appended as verified=False findings.
        for i, g in enumerate(narrative.gotchas):
            findings.append(
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

        classifications = [
            FileClassification(
                filename=fs.filename,
                entity_type=entity_type_from_str(fs.entity_type),
                entity_confidence=fs.entity_confidence,
                headers=headers_by_name.get(fs.filename, []),
                row_count=len(rows_by_name.get(fs.filename, [])),
                column_roles=fs.column_roles,
            )
            for fs in structure.files
        ]

        erp = structure.erp
        erp_detection = ErpDetection(
            source=erp.source,
            display_name=erp.display_name,
            confidence=erp.confidence,
            matched_headers=erp.matched_headers,
            evidence=erp.evidence,
            alternatives=erp.alternatives,
            header_signature=_bundle_signature(request.files),
            ai_provider=provider.provider_name,
            ai_model=model,
        )

        report = HealthReport(
            erp_detection=erp_detection,
            files=classifications,
            findings=findings,
            summary=narrative.summary if narrative.available else "",
            recommendations=narrative.recommendations,
            narrative_available=narrative.available,
            ai_provider=provider.provider_name,
            ai_model=model,
            generated_at=datetime.now(timezone.utc).isoformat(),
        )
        return HealthReportResponse(report=report)
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001
        # Log the error TYPE only — never the uploaded row content (avoids leaking a
        # shop's data into logs/Sentry, since send_default_pii is on).
        logger.warning("Health report analysis failed: %s", type(e).__name__)
        raise HTTPException(status_code=500, detail="Failed to analyze the uploaded files.")
