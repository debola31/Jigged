"""
QuickBooks Online integration routes.

Thin HTTP layer over services.quickbooks. All QBO logic (OAuth, token lifecycle,
mapping, invoice creation) lives in the service; these handlers do auth, request
validation, the idempotency claim, and error mapping.

Auth model (mirrors quote_email_routes):
  - Company-scoped endpoints extract the caller's user from their Supabase JWT and
    verify a user_company_access row for the company. Connect/disconnect/config
    additionally require the 'admin' role.
  - The OAuth callback has NO bearer token (Intuit redirects the browser there), so
    its only trust signal is the signed `state` we minted in /authorize.
"""
from __future__ import annotations

import logging
import os
from datetime import datetime, timedelta, timezone
from uuid import uuid4

import jwt
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import RedirectResponse
from pydantic import BaseModel
from supabase import Client, create_client

import services.quickbooks as qb

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/quickbooks", tags=["quickbooks"])

STATE_TTL_SECONDS = 600


# ───────────────────────── helpers ─────────────────────────
def _service_client() -> Client:
    url = os.getenv("NEXT_PUBLIC_SUPABASE_URL") or os.getenv("SUPABASE_URL")
    key = os.getenv("SUPABASE_SECRET_KEY") or os.getenv("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        raise HTTPException(status_code=503, detail="Database not configured")
    return create_client(url, key)


def _app_base_url() -> str:
    """Frontend origin for the post-OAuth redirect. Set APP_BASE_URL per
    environment (e.g. http://localhost:3000 locally, the stable domain on
    Vercel). Falls back to the first ALLOWED_ORIGINS entry."""
    explicit = os.getenv("APP_BASE_URL") or os.getenv("NEXT_PUBLIC_APP_URL")
    if explicit:
        return explicit.rstrip("/")
    origins = os.getenv("ALLOWED_ORIGINS", "http://localhost:3000")
    first = next((o.strip() for o in origins.split(",") if o.strip()), "http://localhost:3000")
    return first.rstrip("/")


def _state_secret() -> str:
    secret = os.getenv("QUICKBOOKS_STATE_SECRET") or os.getenv("SUPABASE_JWT_SECRET")
    if not secret:
        raise HTTPException(status_code=503, detail="QUICKBOOKS_STATE_SECRET not configured")
    return secret


def _mint_state(company_id: str, user_id: str) -> str:
    payload = {
        "company_id": company_id,
        "user_id": user_id,
        "nonce": uuid4().hex,
        "env": qb._environment(),
        "exp": datetime.now(timezone.utc) + timedelta(seconds=STATE_TTL_SECONDS),
    }
    return jwt.encode(payload, _state_secret(), algorithm="HS256")


def _verify_state(state: str) -> dict:
    return jwt.decode(state, _state_secret(), algorithms=["HS256"])


async def _verify_company_access(
    request: Request, company_id: str, require_admin: bool = False
) -> tuple[str, dict]:
    """Returns (user_id, access_row) where access_row has the user_company_access id + role."""
    token = request.headers.get("Authorization", "").replace("Bearer ", "")
    if not token:
        raise HTTPException(status_code=401, detail="Not authenticated")

    client = _service_client()
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


def _map_qb_error(exc: Exception) -> HTTPException:
    if isinstance(exc, qb.QuickBooksServiceUnavailable):
        return HTTPException(status_code=503, detail=str(exc))
    if isinstance(exc, qb.QuickBooksNotConnected):
        return HTTPException(status_code=409, detail=str(exc))
    if isinstance(exc, qb.QuickBooksValidationError):
        # Our own guard (e.g. billing more than has shipped) — a bad request, not a QBO failure.
        return HTTPException(status_code=400, detail=str(exc))
    if isinstance(exc, qb.QuickBooksApiError):
        return HTTPException(status_code=502, detail="QuickBooks rejected the request.")
    return HTTPException(status_code=500, detail="Unexpected error")


def _is_connected(conn: dict | None) -> bool:
    return bool(conn) and conn.get("environment") == qb._environment()


# ───────────────────────── OAuth lifecycle ─────────────────────────
class AuthorizeResponse(BaseModel):
    authorize_url: str


@router.post("/{company_id}/authorize", response_model=AuthorizeResponse)
async def authorize(company_id: str, request: Request):
    user_id, _ = await _verify_company_access(request, company_id, require_admin=True)
    try:
        url = qb.build_authorize_url(_mint_state(company_id, user_id))
    except qb.QuickBooksServiceUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    return AuthorizeResponse(authorize_url=url)


@router.get("/callback")
async def callback(
    state: str = "", code: str = "", realmId: str = "", error: str = ""
):
    try:
        claims = _verify_state(state)
    except Exception as exc:  # noqa: BLE001
        logger.warning("QuickBooks callback: invalid state: %s", exc)
        return RedirectResponse(f"{_app_base_url()}/select-company?qb=error", status_code=302)

    company_id = claims.get("company_id", "")
    user_id = claims.get("user_id", "")
    settings_url = f"{_app_base_url()}/dashboard/{company_id}/settings"

    if error or not code or not realmId:
        return RedirectResponse(f"{settings_url}?qb=error", status_code=302)

    db = _service_client()
    try:
        bundle = qb.exchange_code_for_tokens(code)
        access = (
            db.table("user_company_access")
            .select("id")
            .eq("user_id", user_id)
            .eq("company_id", company_id)
            .limit(1)
            .execute()
        )
        connected_by = access.data[0]["id"] if access.data else None
        qb.persist_connection(db, company_id, realmId, bundle, connected_by=connected_by)
        # Best-effort: store the QBO company name for the UI label.
        try:
            info = qb.qb_request(db, company_id, "GET", f"companyinfo/{realmId}")
            name = (info.get("CompanyInfo") or {}).get("CompanyName")
            if name:
                db.table("quickbooks_connections").update({"qb_company_name": name}).eq(
                    "company_id", company_id
                ).execute()
        except Exception as exc:  # noqa: BLE001
            logger.info("Could not fetch QBO company name: %s", exc)
    except Exception:
        logger.exception("QuickBooks callback failed for company %s", company_id)
        return RedirectResponse(f"{settings_url}?qb=error", status_code=302)

    return RedirectResponse(f"{settings_url}?qb=connected", status_code=302)


class StatusResponse(BaseModel):
    connected: bool
    reconnect_required: bool = False
    realm_id: str | None = None
    environment: str | None = None
    qb_company_name: str | None = None
    connected_at: str | None = None


@router.get("/{company_id}/status", response_model=StatusResponse)
async def status(company_id: str, request: Request):
    await _verify_company_access(request, company_id)
    conn = qb.get_connection(_service_client(), company_id)
    if not _is_connected(conn):
        return StatusResponse(connected=False)
    return StatusResponse(
        connected=True,
        reconnect_required=bool(conn.get("reconnect_required")),
        realm_id=conn.get("realm_id"),
        environment=conn.get("environment"),
        qb_company_name=conn.get("qb_company_name"),
        connected_at=conn.get("created_at"),
    )


@router.post("/{company_id}/disconnect")
async def disconnect(company_id: str, request: Request):
    await _verify_company_access(request, company_id, require_admin=True)
    db = _service_client()
    conn = qb.get_connection(db, company_id)
    if conn:
        qb.revoke_token(conn.get("refresh_token", ""))
        db.table("quickbooks_connections").delete().eq("company_id", company_id).execute()
    return {"disconnected": True}


# ───────────────────────── Push (preflight + commit) ─────────────────────────
async def _load_gated_job(db: Client, company_id: str, job_id: str) -> dict:
    """Load the job for invoicing. A job IS the work order, so it's intrinsically
    billable — there's no 'converted' gate (PO-sourced jobs have no quote). 404 if
    the job is missing. Returns the job dict (incl. customer_id, job_number,
    quote_id provenance, billing_address_id)."""
    job = (
        db.table("jobs")
        .select(
            "id, company_id, customer_id, job_number, customer_po_number, "
            "quote_id, billing_address_id, payment_terms"
        )
        .eq("id", job_id)
        .eq("company_id", company_id)
        .limit(1)
        .execute()
        .data
    )
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return job[0]


@router.post("/{company_id}/jobs/{job_id}/preflight")
async def preflight(company_id: str, job_id: str, request: Request):
    await _verify_company_access(request, company_id)
    db = _service_client()
    conn = qb.get_connection(db, company_id)
    if not _is_connected(conn) or conn.get("reconnect_required"):
        return {"connected": False}

    realm = conn["realm_id"]
    job = await _load_gated_job(db, company_id, job_id)

    customer = (
        db.table("customers").select("id, name").eq("id", job["customer_id"]).limit(1).execute().data
    )
    if not customer:
        raise HTTPException(status_code=400, detail="Job has no customer to invoice.")
    customer = customer[0]

    cmap = (
        db.table("quickbooks_customer_map")
        .select("qb_customer_id, qb_display_name")
        .eq("company_id", company_id)
        .eq("customer_id", customer["id"])
        .eq("realm_id", realm)
        .limit(1)
        .execute()
        .data
    )
    try:
        if cmap:
            customer_res = {
                "status": "mapped",
                "qb_customer_id": cmap[0]["qb_customer_id"],
                "candidates": [],
            }
        else:
            customer_res = qb.find_customer_candidates(db, company_id, customer["name"])
        # Per-part billing context (ordered / shipped / invoiced / invoiceable + price)
        # for the quantity picker. Replaces the old whole-job "lines_preview": a job now
        # has many invoices, each billing a chosen quantity of shipped-but-unbilled parts.
        parts = qb.load_billable_parts(db, company_id, job, realm)
    except Exception as exc:  # noqa: BLE001
        raise _map_qb_error(exc)

    customer_res.update({"jigged_customer_id": customer["id"], "jigged_name": customer["name"]})
    return {
        "connected": True,
        "customer": customer_res,
        "parts": parts,
    }


class CommitCustomer(BaseModel):
    action: str  # 'use_existing' | 'create'
    qb_customer_id: str | None = None


class InvoiceLineSelection(BaseModel):
    job_part_id: str
    quantity: float  # billed on THIS invoice; validated server-side against the ship-cap


class CommitBody(BaseModel):
    customer: CommitCustomer
    # request_id: client-minted idempotency key for THIS draft invoice (one per dialog
    # open). Re-homes idempotency off (job_id, realm_id) now that a job has many invoices;
    # a double-submit reuses it and collides on the unique index instead of double-POSTing.
    request_id: str
    # lines: the per-part quantities to bill. Empty/omitted is rejected server-side.
    lines: list[InvoiceLineSelection] = []


def _upsert_customer_map(
    db: Client, company_id: str, customer_id: str, realm: str, qb_customer_id: str, name: str, linked_by: str | None
) -> None:
    db.table("quickbooks_customer_map").upsert(
        {
            "company_id": company_id,
            "customer_id": customer_id,
            "realm_id": realm,
            "qb_customer_id": qb_customer_id,
            "qb_display_name": name,
            "linked_by": linked_by,
            "updated_at": datetime.now(timezone.utc).isoformat(),
        },
        on_conflict="company_id,customer_id,realm_id",
    ).execute()


def _pending_is_fresh(row: dict) -> bool:
    ts = row.get("updated_at") or row.get("created_at")
    if not ts:
        return True
    age = datetime.now(timezone.utc) - qb._parse_dt(ts)
    return age.total_seconds() < qb.PENDING_STALE_SECONDS


@router.post("/{company_id}/jobs/{job_id}/invoice")
async def push_invoice(company_id: str, job_id: str, request: Request, body: CommitBody):
    _, access = await _verify_company_access(request, company_id)
    db = _service_client()
    conn = qb.get_connection(db, company_id)
    if not _is_connected(conn) or conn.get("reconnect_required"):
        raise HTTPException(status_code=409, detail="QuickBooks is not connected.")
    realm = conn["realm_id"]
    job = await _load_gated_job(db, company_id, job_id)

    if not body.request_id:
        raise HTTPException(status_code=400, detail="Missing invoice request id.")

    # ── Idempotency claim, keyed on the client-minted request_id. A job now has MANY
    #    invoices, so (job_id, realm) no longer identifies "the invoice" — the draft's
    #    request_id does (unique index quickbooks_invoice_links_realm_request_key).
    #    Check for a replay of THIS draft BEFORE validating the selection: a completed
    #    draft's own lines are already counted in qty-invoiced, so re-validating would
    #    wrongly trip the over-cap guard. ──
    existing = (
        db.table("quickbooks_invoice_links")
        .select("*")
        .eq("realm_id", realm)
        .eq("qb_request_id", body.request_id)
        .limit(1)
        .execute()
        .data
    )
    if existing and existing[0]["status"] == "created":
        row = existing[0]
        return {
            "qb_invoice_id": row["qb_invoice_id"],
            "doc_number": row["qb_invoice_doc_number"],
            "url": row.get("qb_invoice_url"),
            "already_existed": True,
        }
    if existing and existing[0]["status"] == "pending" and _pending_is_fresh(existing[0]):
        # A sibling request for this same draft is in flight — do not double-POST.
        return {"in_progress": True}

    # Build + validate the selected lines (ship-cap, price snapshot). Done after the
    # created/pending short-circuit above but before claiming a NEW row, so a bad
    # selection returns 400 without leaving a junk pending link (resume of an
    # error/stale row re-validates cleanly — its lines aren't counted yet).
    selection = [{"job_part_id": ln.job_part_id, "quantity": ln.quantity} for ln in body.lines]
    try:
        lines, bill_addr, snapshot_rows = qb.load_firm_invoice_lines(
            db, company_id, job, selection, realm
        )
    except Exception as exc:  # noqa: BLE001
        raise _map_qb_error(exc)

    if existing:
        # Stale pending or prior error → resume with the SAME request id (QBO replays).
        request_id = existing[0]["qb_request_id"]
        link_id = existing[0]["id"]
    else:
        request_id = body.request_id
        try:
            inserted = (
                db.table("quickbooks_invoice_links")
                .insert(
                    {
                        "company_id": company_id,
                        "job_id": job_id,
                        "quote_id": job.get("quote_id"),  # provenance only; null for PO-sourced jobs
                        "realm_id": realm,
                        "qb_request_id": request_id,
                        "status": "pending",
                        "pushed_by": access["id"],
                    }
                )
                .execute()
            )
            link_id = inserted.data[0]["id"]
        except Exception:  # noqa: BLE001 - unique violation = a sibling claimed it first
            return {"in_progress": True}

    try:
        customer = (
            db.table("customers").select("id, name").eq("id", job["customer_id"]).limit(1).execute().data
        )
        if not customer:
            raise HTTPException(status_code=400, detail="Job has no customer to invoice.")
        customer = customer[0]

        cmap = (
            db.table("quickbooks_customer_map")
            .select("qb_customer_id")
            .eq("company_id", company_id)
            .eq("customer_id", customer["id"])
            .eq("realm_id", realm)
            .limit(1)
            .execute()
            .data
        )
        if cmap:
            customer_ref = cmap[0]["qb_customer_id"]
        elif body.customer.action == "use_existing" and body.customer.qb_customer_id:
            customer_ref = body.customer.qb_customer_id
            _upsert_customer_map(
                db, company_id, customer["id"], realm, customer_ref, customer["name"], access["id"]
            )
        else:
            customer_ref = qb.create_customer(db, company_id, customer["name"], bill_addr)
            _upsert_customer_map(
                db, company_id, customer["id"], realm, customer_ref, customer["name"], access["id"]
            )

        item_ref = qb.resolve_default_item(db, company_id, conn)

        # Terms the job was sold on -> a QBO Term Id. Best-effort by design: a
        # term that cannot be resolved or created returns None and the invoice
        # goes out exactly as it did before this existed, rather than failing.
        sales_term_id = (
            qb.resolve_term_id(db, company_id, job["payment_terms"])
            if job.get("payment_terms")
            else None
        )

        # The shop's PO custom field, if they have made one. Read from the cached
        # discovery on the connection — Preferences is not re-read per push.
        payload = qb.quote_to_invoice_payload(
            customer_ref=customer_ref,
            item_ref=item_ref,
            job_number=job.get("job_number"),
            customer_po_number=job.get("customer_po_number"),
            bill_addr=bill_addr,
            lines=lines,
            sales_term_id=sales_term_id,
            po_custom_field_id=conn.get("po_custom_field_id"),
            po_custom_field_name=conn.get("po_custom_field_name"),
        )
        result = qb.create_invoice(db, company_id, payload, request_id)
        invoice_url = qb.invoice_deep_link(
            conn.get("environment", ""), result["id"], conn.get("realm_id")
        )
    except HTTPException:
        db.table("quickbooks_invoice_links").update({"status": "error"}).eq("id", link_id).execute()
        raise
    except Exception as exc:  # noqa: BLE001
        db.table("quickbooks_invoice_links").update({"status": "error"}).eq("id", link_id).execute()
        logger.exception("QuickBooks push failed for job %s", job_id)
        raise _map_qb_error(exc)

    # Success: flip the link to created. This fires the invoicing_status recompute
    # triggers — but only after the line rows exist, so insert them first.
    line_rows = [
        {
            "company_id": company_id,
            "invoice_link_id": link_id,
            "job_part_id": r["job_part_id"],
            "quantity": r["quantity"],
            "unit_price": r["unit_price"],
            "total_price": r["total_price"],
        }
        for r in snapshot_rows
    ]
    try:
        # Resume-safe: unique(invoice_link_id, job_part_id) + ignore-duplicates makes a
        # replay a no-op rather than double-billing. Insert BEFORE the status flip so the
        # on-link-status trigger sees the lines; the over-invoice BEFORE trigger backstops.
        db.table("quickbooks_invoice_line_items").upsert(
            line_rows, on_conflict="invoice_link_id,job_part_id", ignore_duplicates=True
        ).execute()
        db.table("quickbooks_invoice_links").update(
            {
                "status": "created",
                "qb_invoice_id": result["id"],
                "qb_invoice_doc_number": result["doc_number"],
                "qb_invoice_sync_token": result["sync_token"],
                "qb_invoice_url": invoice_url,
            }
        ).eq("id", link_id).execute()
    except Exception:  # noqa: BLE001
        # The QBO invoice exists but we couldn't record its lines/status. Mark the link
        # so the anomaly is visible, and surface a reconcile error rather than silently
        # under-counting invoiced qty (which could later allow over-invoicing).
        db.table("quickbooks_invoice_links").update(
            {"status": "error", "qb_invoice_id": result["id"], "qb_invoice_url": invoice_url}
        ).eq("id", link_id).execute()
        logger.exception(
            "Invoice %s created in QBO but recording its lines failed (link %s)", result["id"], link_id
        )
        raise HTTPException(
            status_code=500,
            detail="Invoice created in QuickBooks, but recording it in Jigged failed. Refresh; if it persists, contact support.",
        )

    return {
        "qb_invoice_id": result["id"],
        "doc_number": result["doc_number"],
        "url": invoice_url,
        "already_existed": False,
    }
