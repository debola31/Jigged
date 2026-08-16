"""Company-scoped auth for FastAPI routes.

Extracted from quickbooks_routes so the QuickBooks Online and QuickBooks Desktop
routers share one copy rather than drifting. Both are company-scoped and both
need the same two things: a service-role Supabase client, and proof that the
caller belongs to the company (optionally as an admin).

`stripe_routes.py` keeps its own private variants; unifying those is out of scope
here and would touch a working billing path for no functional gain.
"""
from __future__ import annotations

import logging
import os

from fastapi import HTTPException, Request
from supabase import Client, create_client

logger = logging.getLogger(__name__)


def service_client() -> Client:
    """Built PER REQUEST, reading env at call time.

    That is what lets the integration tests re-point the backend at a local
    Supabase with monkeypatch.setenv; a module-level client captured at import
    would ignore it.
    """
    url = os.getenv("NEXT_PUBLIC_SUPABASE_URL") or os.getenv("SUPABASE_URL")
    key = os.getenv("SUPABASE_SECRET_KEY") or os.getenv("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        raise HTTPException(status_code=503, detail="Database not configured")
    return create_client(url, key)


async def verify_company_access(
    request: Request, company_id: str, require_admin: bool = False
) -> tuple[str, dict]:
    """Returns (user_id, access_row) where access_row has the user_company_access
    id + role. Raises 401 / 403 otherwise."""
    token = request.headers.get("Authorization", "").replace("Bearer ", "")
    if not token:
        raise HTTPException(status_code=401, detail="Not authenticated")

    client = service_client()
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
        .select("id, role")
        .eq("user_id", user_id)
        .eq("company_id", company_id)
        .limit(1)
        .execute()
    )
    if not access.data:
        raise HTTPException(status_code=403, detail="No access to this company")
    row = access.data[0]
    if require_admin and row.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Admin role required")
    return user_id, row
