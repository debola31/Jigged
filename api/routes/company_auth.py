"""Company-scoped auth for FastAPI routes.

Extracted from quickbooks_routes so the QuickBooks Online and QuickBooks Desktop
routers share one copy rather than drifting. Both are company-scoped and both
need the same two things: a service-role Supabase client, and proof that the
caller belongs to the company (optionally as an admin).

The import `execute` routes and the AI Insights routes use it too, through the
office-only variants below. Those routes once took a company id with no token at
all, from the URL or the request body, and acted on it with the service-role key.

`stripe_routes.py` keeps its own private variants; unifying those is out of scope
here and would touch a working billing path for no functional gain.
"""
from __future__ import annotations

import hmac
import logging
import os

import jwt
import sentry_sdk
from fastapi import HTTPException, Request
from supabase import Client, create_client

logger = logging.getLogger(__name__)

OFFICE_ONLY_DETAIL = "This is for office users. Ask an admin for an office login."
BILLING_BLOCKED_DETAIL = (
    "Your shop's subscription isn't active, so nothing was saved. An admin can start one in Settings."
)

# AI assistants (Claude, ChatGPT) get ordinary Supabase JWTs with a `client_id` claim from the
# OAuth server, and get_user accepts them like any session. The MCP server at /mcp proves a request
# is its own with this header (MCP_GATEWAY_KEY); without it an assistant's token is refused here,
# the same rule public.mcp_token_binding() enforces on the Data API (migration 20261109163801).
MCP_GATEWAY_HEADER = "x-jigged-mcp"
UNBOUND_ASSISTANT_DETAIL = "AI assistants reach Jigged only through jigged.app/mcp."
ASSISTANT_NOT_ALLOWED_DETAIL = "AI assistants can't do this. Use Jigged in your browser."


def _bearer(request: Request) -> str:
    return request.headers.get("Authorization", "").replace("Bearer ", "")


def assistant_client_id(token: str) -> str | None:
    """The `client_id` claim of a token, or None for a browser session.

    Read WITHOUT verifying the signature. Safe only because the callers below use it to REFUSE:
    a token claiming to be an assistant's gets less access, never more, and every route still
    verifies the token itself through get_user.
    """
    try:
        claims = jwt.decode(token, options={"verify_signature": False})
    except jwt.PyJWTError:
        return None
    client_id = claims.get("client_id")
    return client_id if isinstance(client_id, str) and client_id else None


def refuse_unbound_assistant(request: Request) -> None:
    """403 for an AI assistant's token that did not come through /mcp. Browser sessions pass."""
    if assistant_client_id(_bearer(request)) is None:
        return
    key = os.getenv("MCP_GATEWAY_KEY") or ""
    presented = request.headers.get(MCP_GATEWAY_HEADER) or ""
    if not key or not presented or not hmac.compare_digest(presented.encode(), key.encode()):
        raise HTTPException(status_code=403, detail=UNBOUND_ASSISTANT_DETAIL)


def refuse_assistant(request: Request) -> None:
    """403 for any AI assistant's token: routes no assistant tool calls (billing, system admin,
    and Jigged's own AI features, which the MCP server never invokes)."""
    if assistant_client_id(_bearer(request)) is not None:
        raise HTTPException(status_code=403, detail=ASSISTANT_NOT_ALLOWED_DETAIL)


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
    refuse_unbound_assistant(request)

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


async def verify_office_access(request: Request, company_id: str) -> tuple[str, dict]:
    """`verify_company_access`, refusing role='operator'.

    RLS does not tell an operator from an office user: `get_user_company_ids()` is
    membership-only, and the office/shop-floor split is AuthGuard's redirect. So a route
    that does office work (imports, AI Insights) has to draw the line itself, or an
    operator's token reaches it the moment someone calls it outside the browser.
    """
    user_id, row = await verify_company_access(request, company_id)
    if row.get("role") == "operator":
        raise HTTPException(status_code=403, detail=OFFICE_ONLY_DETAIL)
    return user_id, row


def assert_company_can_write(company_id: str) -> None:
    """The billing write-gate, for a route that writes with the service-role key.

    The gate is RLS (`billing_gate_*` policies calling `company_can_write`), and the
    service role bypasses RLS, so a service-role write skips it unless the route asks the
    same function first. Fails CLOSED: a write we cannot prove is entitled does not run,
    exactly as the RLS policy would refuse it.
    """
    try:
        res = service_client().rpc("company_can_write", {"check_company_id": company_id}).execute()
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        logger.error("company_can_write check failed for %s: %s", company_id, exc)
        sentry_sdk.capture_exception(exc)
        raise HTTPException(
            status_code=503, detail="Couldn't check your shop's subscription. Try again in a moment."
        ) from exc
    if res.data is not True:
        raise HTTPException(status_code=403, detail=BILLING_BLOCKED_DETAIL)


async def verify_office_write_access(request: Request, company_id: str) -> tuple[str, dict]:
    """An office member of `company_id`, whose company may write. For service-role writes."""
    user_id, row = await verify_office_access(request, company_id)
    assert_company_can_write(company_id)
    return user_id, row
