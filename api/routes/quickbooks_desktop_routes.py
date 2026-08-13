"""QuickBooks Desktop connection lifecycle, via Conductor.

WHY THIS IS A SEPARATE ROUTER FROM quickbooks_routes, when the invoice endpoints
deliberately are not:

  * The invoice path (preflight, invoice, verify) stays at /api/quickbooks and
    dispatches on the provider internally. That sequence is where a divergence
    between providers silently double-bills a customer, so it has exactly one
    implementation and the job page never learns which accounting system a shop
    uses.

  * Connecting is genuinely different. There is no OAuth redirect: the backend
    mints an auth-flow URL that the shop opens IN A BROWSER ON THE WINDOWS MACHINE
    RUNNING QUICKBOOKS, and Jigged learns the outcome by asking rather than by
    being called back. Forcing that through an endpoint named /authorize, which
    returns a consent URL to redirect to, would be a lie about what it does.

Auth: every endpoint is company-scoped. Connect/disconnect/config require the
'admin' role. Customer LINKING does not -- the invoice push already lets any
member create the same mapping implicitly at push time, so requiring admin here
would make the bulk screen stricter than the one-off it replaces.
"""
from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

import routes.company_auth as company_auth
import services.quickbooks as qb
import services.quickbooks_desktop as qbd
from routes.quickbooks_routes import _map_qb_error

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/quickbooks-desktop", tags=["quickbooks-desktop"])

# A bulk link is a form submission, not an import. Anything approaching this many
# rows means the screen is being used wrongly, and an unbounded body is a way to
# hold a serverless function open.
MAX_BULK_LINKS = 500


def _require_feature(db, company_id: str) -> None:
    """QuickBooks Desktop is opt-in per tenant.

    Gated on the BACKEND, not merely in the UI, because Conductor bills $49/month
    per active company file connection -- this is the first flag in the repo with
    a direct per-use cost behind it, so a flag-off tenant reaching the endpoint by
    URL would spend real money. Every other flag gates an affordance; this one
    gates a bill.

    Mirrors lib/featureFlags.ts: the flag lives at companies.settings.features and
    is opt-in, so absent means off.
    """
    rows = (
        db.table("companies").select("settings").eq("id", company_id).limit(1).execute().data
    )
    settings = (rows[0].get("settings") if rows else None) or {}
    features = settings.get("features") or {}
    if features.get("quickbooks_desktop") is not True:
        raise HTTPException(
            status_code=403,
            detail="QuickBooks Desktop is not enabled for this company.",
        )


def _conn_or_409(db, company_id: str) -> dict:
    conn = qbd.get_connection(db, company_id)
    if not conn or conn.get("environment") != qbd._environment():
        raise HTTPException(
            status_code=409, detail="QuickBooks Desktop is not connected for this company."
        )
    return conn


# ───────────────────────── connect ─────────────────────────
class ConnectResponse(BaseModel):
    auth_flow_url: str
    end_user_id: str
    expires_at: str | None = None


@router.post("/{company_id}/connect", response_model=ConnectResponse)
async def connect(company_id: str, request: Request):
    """Create-or-reuse the Conductor end user and mint an auth-flow link.

    The returned URL is for the shop to OPEN ON THE COMPUTER RUNNING QUICKBOOKS,
    not for us to redirect to. Nothing here marks the connection live; only a
    successful Web Connector call does, which /status reports.
    """
    user_id, access = await company_auth.verify_company_access(
        request, company_id, require_admin=True
    )
    db = company_auth.service_client()
    _require_feature(db, company_id)

    # A company connects EITHER provider. The database enforces this, but a 409
    # with a readable message beats a check_violation surfacing as a 500.
    if qb.get_connection(db, company_id):
        raise HTTPException(
            status_code=409,
            detail="This company is already connected to QuickBooks Online. "
                   "Disconnect it first.",
        )

    company = (
        db.table("companies").select("name").eq("id", company_id).limit(1).execute().data
    )
    company_name = (company[0]["name"] if company else None) or "Jigged company"

    try:
        end_user = qbd.ensure_end_user(
            company_id, company_name=company_name, email=None
        )
        session = qbd.create_auth_session(end_user["id"])
    except Exception as exc:  # noqa: BLE001
        raise _map_qb_error(exc)

    existing = qbd.get_connection(db, company_id)
    payload = {
        "company_id": company_id,
        "conductor_end_user_id": end_user["id"],
        "environment": qbd._environment(),
        "connected_by": access["id"],
    }
    if existing:
        db.table("quickbooks_desktop_connections").update(payload).eq(
            "company_id", company_id
        ).execute()
    else:
        db.table("quickbooks_desktop_connections").insert(payload).execute()

    return ConnectResponse(
        auth_flow_url=session["auth_flow_url"],
        end_user_id=end_user["id"],
        expires_at=session.get("expires_at"),
    )


# ───────────────────────── status / health ─────────────────────────
class DesktopStatusResponse(BaseModel):
    connected: bool
    linked: bool = False
    qb_company_name: str | None = None
    last_successful_request_at: str | None = None
    needs_income_account: bool = False


@router.get("/{company_id}/status", response_model=DesktopStatusResponse)
async def status(company_id: str, request: Request):
    """Cheap and safe to poll while a setup link is outstanding.

    Reads our own row, and asks Conductor ONLY while we are still waiting to learn
    that the auth flow finished. Once linked it is a pure database read.
    """
    await company_auth.verify_company_access(request, company_id)
    db = company_auth.service_client()
    conn = qbd.get_connection(db, company_id)
    if not conn or conn.get("environment") != qbd._environment():
        return DesktopStatusResponse(connected=False)

    linked = bool(conn.get("last_successful_request_at"))
    if not linked:
        try:
            state = qbd.connection_state(conn["conductor_end_user_id"])
            linked = state["linked"]
            if linked:
                db.table("quickbooks_desktop_connections").update(
                    {
                        "integration_connection_id": state["integration_connection_id"],
                        "last_successful_request_at": state["last_successful_request_at"],
                    }
                ).eq("company_id", company_id).execute()
                conn["last_successful_request_at"] = state["last_successful_request_at"]
        except Exception as exc:  # noqa: BLE001
            # "Couldn't check" is not "not connected": report what we know and let
            # the card offer a retry rather than asserting a negative.
            logger.warning("QuickBooks Desktop status probe failed: %s", exc)

    return DesktopStatusResponse(
        connected=True,
        linked=linked,
        qb_company_name=conn.get("qb_company_name"),
        last_successful_request_at=conn.get("last_successful_request_at"),
        needs_income_account=not conn.get("default_income_account_id"),
    )


class HealthResponse(BaseModel):
    ok: bool
    code: str | None = None
    message: str | None = None


@router.post("/{company_id}/health", response_model=HealthResponse)
async def health(company_id: str, request: Request):
    """An explicit 'Test connection'. Round-trips to the shop PC, so it is a user
    action, never a mount or a poll.

    Never 5xx for a user-side condition -- an offline connector is ok=False, which
    the UI renders as a warning with a retry.
    """
    await company_auth.verify_company_access(request, company_id)
    db = company_auth.service_client()
    conn = _conn_or_409(db, company_id)
    result = qbd.health_check(conn["conductor_end_user_id"])

    if result["ok"]:
        update: dict = {"last_health_check_at": "now()"}
        try:
            info = qbd.company_info(conn["conductor_end_user_id"])
            name = info.get("companyName") or info.get("legalCompanyName")
            if name:
                update["qb_company_name"] = name
        except Exception as exc:  # noqa: BLE001
            logger.info("Could not read QuickBooks company name: %s", exc)
        db.table("quickbooks_desktop_connections").update(update).eq(
            "company_id", company_id
        ).execute()
        # Piggyback the terms refresh on an action the user already took, so the
        # picker's cache warms without anyone having to know it exists.
        _refresh_terms_cache(db, company_id, conn["conductor_end_user_id"])

    return HealthResponse(**result)


def _refresh_terms_cache(db, company_id: str, end_user_id: str) -> int:
    """Mirror the shop's QuickBooks terms into quickbooks_terms_cache.

    Called only from explicit user actions (connect, Test connection, Refresh
    terms) -- never from a render. See the /terms endpoint for why Desktop reads a
    cache while QBO reads live.

    Best-effort by contract: a failure here must not fail the action that
    triggered it. A stale or empty cache degrades the terms picker to Jigged's own
    presets, and resolve_term_id still creates whatever term is chosen at push
    time.
    """
    try:
        terms = qbd.list_terms(end_user_id)
    except Exception as exc:  # noqa: BLE001
        logger.warning("Could not refresh QuickBooks Desktop terms: %s", exc)
        return 0

    if terms:
        db.table("quickbooks_terms_cache").upsert(
            [
                {
                    "company_id": company_id,
                    "provider": "qbd",
                    "realm_id": end_user_id,
                    "qb_term_id": t["id"],
                    "name": t["name"],
                    "due_days": t.get("due_days"),
                }
                for t in terms
            ],
            on_conflict="company_id,realm_id,qb_term_id",
        ).execute()

    # Drop terms the shop has since deleted, so the picker cannot offer an id that
    # no longer resolves.
    keep = [t["id"] for t in terms]
    q = (
        db.table("quickbooks_terms_cache")
        .delete()
        .eq("company_id", company_id)
        .eq("realm_id", end_user_id)
    )
    if keep:
        q = q.not_.in_("qb_term_id", keep)
    q.execute()
    return len(terms)


@router.post("/{company_id}/terms/refresh")
async def refresh_terms(company_id: str, request: Request):
    """Explicit admin action. The picker never triggers this."""
    await company_auth.verify_company_access(request, company_id, require_admin=True)
    db = company_auth.service_client()
    conn = _conn_or_409(db, company_id)
    count = _refresh_terms_cache(db, company_id, conn["conductor_end_user_id"])
    return {"terms": count}


@router.post("/{company_id}/disconnect")
async def disconnect(company_id: str, request: Request):
    await company_auth.verify_company_access(request, company_id, require_admin=True)
    db = company_auth.service_client()
    conn = qbd.get_connection(db, company_id)
    if conn and conn.get("conductor_end_user_id"):
        qbd.delete_end_user(conn["conductor_end_user_id"])
    db.table("quickbooks_desktop_connections").delete().eq(
        "company_id", company_id
    ).execute()
    return {"disconnected": True}


# ───────────────────────── configuration ─────────────────────────
@router.get("/{company_id}/accounts")
async def accounts(company_id: str, request: Request):
    """Income accounts, for the posting-account chooser.

    An admin picks it; we never guess. QBO's resolve_income_account takes
    accounts[0], and revenue landing in the wrong account is invisible until month
    end -- so the QBD path blocks the first push until someone has chosen.
    """
    await company_auth.verify_company_access(request, company_id, require_admin=True)
    db = company_auth.service_client()
    conn = _conn_or_409(db, company_id)
    try:
        return {"accounts": qbd.list_income_accounts(conn["conductor_end_user_id"])}
    except Exception as exc:  # noqa: BLE001
        raise _map_qb_error(exc)


class IncomeAccountBody(BaseModel):
    income_account_id: str


@router.post("/{company_id}/income-account")
async def set_income_account(company_id: str, request: Request, body: IncomeAccountBody):
    await company_auth.verify_company_access(request, company_id, require_admin=True)
    db = company_auth.service_client()
    _conn_or_409(db, company_id)
    db.table("quickbooks_desktop_connections").update(
        {
            "default_income_account_id": body.income_account_id,
            # The shared service item posts to this account, so a change must
            # re-resolve it rather than keep pointing at the old one.
            "default_service_item_id": None,
        }
    ).eq("company_id", company_id).execute()
    return {"saved": True}


# ───────────────────────── customer mapping ─────────────────────────
@router.get("/{company_id}/customers")
async def customers(company_id: str, request: Request, cursor: str | None = None,
                    limit: int = 100):
    """One page of QuickBooks customers, for the mapping screen.

    Explicitly requested by a click, never on mount: this is a Web Connector round
    trip against a PC that may be switched off.
    """
    await company_auth.verify_company_access(request, company_id)
    db = company_auth.service_client()
    conn = _conn_or_409(db, company_id)
    try:
        return qbd.list_customers(
            conn["conductor_end_user_id"], cursor=cursor, limit=min(limit, 150)
        )
    except Exception as exc:  # noqa: BLE001
        raise _map_qb_error(exc)


class CustomerLink(BaseModel):
    customer_id: str
    qb_customer_id: str | None = None
    qb_display_name: str | None = None


class BulkLinkBody(BaseModel):
    links: list[CustomerLink] = []


@router.post("/{company_id}/customer-map")
async def bulk_link_customers(company_id: str, request: Request, body: BulkLinkBody):
    """Bulk link/unlink Jigged customers to QuickBooks customers.

    This is a FastAPI endpoint rather than Supabase CRUD for two of the four
    reasons in architecture.md 8.1: quickbooks_customer_map has INSERT/UPDATE/
    DELETE revoked from `authenticated` (writes are service-role only), and the
    QuickBooks customer ids being linked are only readable with the Conductor
    secret key.
    """
    _, access = await company_auth.verify_company_access(request, company_id)
    db = company_auth.service_client()
    conn = _conn_or_409(db, company_id)
    realm = conn["conductor_end_user_id"]

    if len(body.links) > MAX_BULK_LINKS:
        raise HTTPException(
            status_code=400,
            detail=f"Too many customers at once (max {MAX_BULK_LINKS}).",
        )
    if not body.links:
        return {"linked": 0, "unlinked": 0}

    # Every customer_id must belong to THIS company. One query, not one per row:
    # a client-supplied id is untrusted, and an unchecked one would link another
    # tenant's customer into this company's map.
    ids = [l.customer_id for l in body.links]
    owned = {
        r["id"]
        for r in db.table("customers").select("id").eq("company_id", company_id)
        .in_("id", ids).execute().data or []
    }
    unknown = [i for i in ids if i not in owned]
    if unknown:
        raise HTTPException(
            status_code=400,
            detail=f"{len(unknown)} customer(s) do not belong to this company.",
        )

    to_link = [l for l in body.links if l.qb_customer_id]
    to_unlink = [l.customer_id for l in body.links if not l.qb_customer_id]

    if to_link:
        db.table("quickbooks_customer_map").upsert(
            [
                {
                    "company_id": company_id,
                    "customer_id": l.customer_id,
                    "realm_id": realm,
                    "provider": "qbd",
                    "qb_customer_id": l.qb_customer_id,
                    "qb_display_name": l.qb_display_name,
                    "linked_by": access["id"],
                }
                for l in to_link
            ],
            on_conflict="company_id,customer_id,realm_id",
        ).execute()

    if to_unlink:
        db.table("quickbooks_customer_map").delete().eq("company_id", company_id).eq(
            "realm_id", realm
        ).in_("customer_id", to_unlink).execute()

    return {"linked": len(to_link), "unlinked": len(to_unlink)}
