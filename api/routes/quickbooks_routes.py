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
  - The webhook has no bearer token either (Intuit posts to it server-to-server), so
    its only trust signal is the HMAC in `intuit-signature`. It writes stale markers
    and nothing else.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import os
import sentry_sdk
from datetime import datetime, timedelta, timezone
from uuid import uuid4

import jwt
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import RedirectResponse
from pydantic import BaseModel
from supabase import Client, create_client

import routes.company_auth as company_auth
import services.accounting as accounting
import services.quickbooks as qb
import services.quickbooks_desktop as qbd

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/quickbooks", tags=["quickbooks"])

STATE_TTL_SECONDS = 600

# Intuit's own notification bodies are a few kilobytes. The cap is not about them:
# the webhook is public, so an unauthenticated caller must not be able to make us
# HMAC and json.loads an arbitrary amount of data. Checked before either happens.
WEBHOOK_MAX_BYTES = 1024 * 1024

# Entities whose change can move a balance we mirror. Everything else is discarded
# SILENTLY — the Intuit portal lets a human tick extra entities onto the same
# endpoint, and a shop doing that must not start seeing 400s or filing Sentry issues.
WEBHOOK_ENTITIES = frozenset({"invoice", "payment", "creditmemo"})


# ───────────────────────── helpers ─────────────────────────
# Re-exported under their historical private names so existing call sites and the
# integration tests' monkeypatching keep resolving after the extraction.
_service_client = company_auth.service_client
_verify_company_access = company_auth.verify_company_access


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


def _webhook_verifier_token() -> str:
    """The verifier token from the Intuit app's Webhooks page.

    A THIRD secret, distinct from the OAuth client secret and from
    QUICKBOOKS_STATE_SECRET: Intuit signs notifications with this one alone, and
    rotating it in the portal is what invalidates in-flight deliveries. 503 rather
    than a default, so an unconfigured environment rejects everything loudly instead
    of accepting unsigned bodies.
    """
    token = os.getenv("QUICKBOOKS_WEBHOOK_VERIFIER_TOKEN")
    if not token:
        raise HTTPException(
            status_code=503, detail="QUICKBOOKS_WEBHOOK_VERIFIER_TOKEN not configured"
        )
    return token


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


def _map_qb_error(exc: Exception) -> HTTPException:
    if isinstance(exc, (qb.QuickBooksServiceUnavailable, qbd.QbdServiceUnavailable)):
        return HTTPException(status_code=503, detail=str(exc))
    if isinstance(exc, qb.QuickBooksValidationError):
        # Our own guard (e.g. billing more than is ordered) — a bad request, not a
        # QuickBooks failure.
        return HTTPException(status_code=400, detail=str(exc))

    # ── QuickBooks Desktop connection classes ──
    # All 4xx, all structured, and NONE of them captured by Sentry. The Starlette
    # integration captures 5xx only, so returning 409 here is what keeps a shop
    # PC being switched off out of the issue queue — Conductor's own guidance is
    # not to alert on these, since only the end user can fix them.
    if isinstance(exc, qbd.QbdOffline):
        return HTTPException(
            status_code=409, detail={"code": "qbd_offline", "message": str(exc)}
        )
    if isinstance(exc, qbd.QbdUnknownOutcome):
        return HTTPException(
            status_code=409, detail={"code": "qbd_verify", "message": str(exc)}
        )
    if isinstance(exc, qbd.QbdNotConnected):
        # Structured, unlike the QBO twin below: the browser branches on this code
        # to render a warning with a retry rather than a red error. Returned as a
        # bare string it was indistinguishable from a generic failure, so the same
        # condition showed amber in Settings and red in the push dialog.
        return HTTPException(
            status_code=409, detail={"code": "qbd_not_connected", "message": str(exc)}
        )
    if isinstance(exc, qb.QuickBooksNotConnected):
        return HTTPException(status_code=409, detail=str(exc))

    if isinstance(exc, qbd.QbdApiError):
        # QuickBooks rejected the request on business-logic grounds. Surface its
        # own wording: it names the offending field better than we can.
        return HTTPException(
            status_code=502, detail={"code": "qbd_rejected", "message": str(exc)}
        )
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


# ───────────────────────── Change notifications (webhook) ─────────────────────────
def _normalise_webhook_events(payload) -> list[dict]:
    """Flatten either Intuit notification format into one shape:
    {realm_id, entity, operation, entity_id, event_time}.

    BOTH formats are accepted because the Intuit developer portal carries a per-app
    toggle between them: flipping it is two clicks by a human, not a deploy, and the
    old shape keeps arriving from apps configured before the switch.
      * current  — a bare JSON array of CloudEvents, each with `intuitaccountid`
                   (the realm), `intuitentityid`, and a dotted `type` such as
                   "qbo.invoice.updated.v1";
      * legacy   — {"eventNotifications": [{"realmId", "dataChangeEvent":
                   {"entities": [{"name", "id", "operation", "lastUpdated"}]}}]}.

    Raises on anything else. The caller reports that, deliberately: the signature has
    already passed by then, so an unparseable body is one Intuit itself signed.
    """
    events: list[dict] = []

    if isinstance(payload, list):
        for ev in payload:
            parts = str(ev["type"]).split(".")
            if len(parts) < 3:
                raise ValueError(f"Unrecognised CloudEvents type: {ev.get('type')!r}")
            events.append(
                {
                    "realm_id": str(ev["intuitaccountid"]),
                    "entity": parts[1].lower(),
                    "operation": parts[2].lower(),
                    "entity_id": str(ev["intuitentityid"]),
                    "event_time": ev.get("time"),
                }
            )
        return events

    if isinstance(payload, dict) and "eventNotifications" in payload:
        for note in payload.get("eventNotifications") or []:
            realm_id = str(note["realmId"])
            for ent in ((note.get("dataChangeEvent") or {}).get("entities")) or []:
                events.append(
                    {
                        "realm_id": realm_id,
                        "entity": str(ent["name"]).lower(),
                        "operation": str(ent.get("operation") or "").lower(),
                        "entity_id": str(ent["id"]),
                        "event_time": ent.get("lastUpdated"),
                    }
                )
        return events

    raise ValueError("Unrecognised QuickBooks webhook payload shape")


def _webhook_event_time(raw, received_at: datetime) -> datetime:
    """Intuit's own timestamp for the change, or the moment we received it.

    Falling back to `received_at` is the SAFE direction and that is why it is a
    fallback at all: the value is only ever compared against qb_status_checked_at to
    decide whether to re-ask QuickBooks, so a marker that is too NEW costs one extra
    read, while one that is too old would leave a changed invoice looking current.
    """
    if not raw:
        return received_at
    try:
        return qb._parse_dt(str(raw))
    except (ValueError, TypeError):
        logger.info("QuickBooks webhook: unparseable event time %r", raw)
        return received_at


def _apply_webhook_markers(
    db: Client, by_realm: dict[str, list[dict]], received_at: datetime
) -> int:
    """Stamp the stale markers for one verified notification. DATABASE WRITES ONLY.

    Returns the number of rows stamped, so a delivery that resolved to nothing is
    distinguishable from one that never arrived at all.
    """
    conns = (
        db.table("quickbooks_connections")
        .select("company_id, realm_id")
        .in_("realm_id", list(by_realm))
        # A sandbox notification must never touch a production row. The realm id
        # alone does not say which environment it came from, and both environments'
        # connections live in the same table.
        .eq("environment", qb._environment())
        .execute()
        .data
        or []
    )

    # Several companies can legitimately share one realm — the UNIQUE on
    # quickbooks_connections is company_id, not realm_id — so this is a list, and
    # every match gets stamped rather than just the first.
    companies_by_realm: dict[str, list[str]] = {}
    for c in conns:
        companies_by_realm.setdefault(c["realm_id"], []).append(c["company_id"])

    received_iso = received_at.isoformat()
    marked = 0

    for realm_id, events in by_realm.items():
        company_ids = companies_by_realm.get(realm_id)
        if not company_ids:
            # Ordinary, not an error: the shop disconnected, or the realm belongs to
            # the other environment's app on the same Intuit account.
            logger.info("QuickBooks webhook for unknown realm %s (ignored)", realm_id)
            continue

        # Invoice ids bucketed by the event's own instant, so one UPDATE covers every
        # invoice that changed at the same time instead of one per id.
        invoice_ids_by_time: dict[str, set[str]] = {}
        connection_stale_at: datetime | None = None
        for ev in events:
            at = _webhook_event_time(ev["event_time"], received_at)
            if ev["entity"] == "invoice":
                invoice_ids_by_time.setdefault(at.isoformat(), set()).add(ev["entity_id"])
            elif connection_stale_at is None or at > connection_stale_at:
                # Payment and CreditMemo name only their OWN id. Resolving one to the
                # invoices it settles is an Intuit query, which this handler must not
                # make, so the whole realm is marked instead.
                connection_stale_at = at

        for company_id in company_ids:
            conn_update = {"webhook_last_received_at": received_iso}
            if connection_stale_at is not None:
                # Last write wins, with no monotonic guard: two payment events
                # arriving out of order could move this marker backwards, and that
                # self-heals — links_need_check re-asks anything older than
                # INVOICE_STATUS_MAX_AGE_MINUTES regardless of any marker.
                conn_update["qb_invoices_stale_since"] = connection_stale_at.isoformat()
                marked += 1
            db.table("quickbooks_connections").update(conn_update).eq(
                "company_id", company_id
            ).execute()

            for at_iso, ids in invoice_ids_by_time.items():
                updated = (
                    db.table("quickbooks_invoice_links")
                    .update({"qb_stale_at": at_iso})
                    .eq("company_id", company_id)
                    .eq("realm_id", realm_id)
                    .eq("provider", "qbo")
                    # ANY status on purpose. A link still 'pending' or
                    # 'needs_verification' can already hold the id of an invoice that
                    # exists in QuickBooks, and marking it now means the first refresh
                    # after it flips to 'created' sees a real answer.
                    .in_("qb_invoice_id", sorted(ids))
                    .execute()
                    .data
                    or []
                )
                marked += len(updated)

    return marked


@router.post("/webhook")
async def webhook(request: Request):
    """Intuit change notification. Signature-verified, then PURE DATABASE WRITES.

    ZERO INTUIT READS HAPPEN HERE, and that is the design rather than an omission. A
    notification says only THAT something changed; the balance itself is fetched
    later, when someone opens a job's Invoices menu, by
    POST /{company_id}/jobs/{job_id}/invoice-status. Reading Intuit from this handler
    would put a third-party round trip — plus a possible token refresh — inside a
    request Intuit retries on timeout, to produce a number nobody may ever look at.

    So all this does is stamp staleness: qb_stale_at on the invoice rows an Invoice
    event names, and qb_invoices_stale_since on the connection for Payment and
    CreditMemo events, whose payloads name only the payment or memo id.

    THE PRODUCTION ENDPOINT MUST BE REGISTERED ON
    https://www.jigged.app/api/quickbooks/webhook — never the apex. Vercel answers
    https://jigged.app/… with a 307 from its edge router, BEFORE this function is
    invoked, so a misregistration fails with nothing for Sentry to see. That is
    as-built history, not caution: the Stripe endpoint was registered on the apex and
    every live event failed for five days (docs/modules/billing.md § "The production
    webhook URL must be www.jigged.app"). A GET here answers 405 automatically —
    route reachable, method not allowed — which is what an uptime probe asserts, and
    it never reaches the signature path so the probe files no events.
    """
    raw = await request.body()
    if len(raw) > WEBHOOK_MAX_BYTES:
        logger.warning("QuickBooks webhook rejected: %d byte body", len(raw))
        raise HTTPException(status_code=413, detail="Payload too large")

    expected = base64.b64encode(
        hmac.new(_webhook_verifier_token().encode("utf-8"), raw, hashlib.sha256).digest()
    ).decode("ascii")
    if not hmac.compare_digest(expected, request.headers.get("intuit-signature", "")):
        # Deliberately NOT captured to Sentry, for the same reason as the Stripe
        # webhook (stripe_routes.py): this route is public and unauthenticated, so
        # anyone who finds the URL can drive this branch at will, and reporting it
        # hands a stranger our issue quota. A genuine mismatch — a verifier token
        # rotated in the portal — shows in Intuit's own delivery log, which is the
        # authority on it anyway.
        logger.warning("QuickBooks webhook rejected: invalid signature")
        raise HTTPException(status_code=400, detail="Invalid signature")

    try:
        events = _normalise_webhook_events(json.loads(raw))
    except Exception as exc:  # noqa: BLE001
        # REPORTABLE, unlike the branch above: the signature has already passed, so
        # Intuit signed this body. It is a shape change on their side or a bug on
        # ours, and both are ours to know about.
        sentry_sdk.capture_exception(exc)
        logger.warning("QuickBooks webhook: unparseable signed payload", exc_info=True)
        raise HTTPException(status_code=400, detail="Invalid payload") from exc

    received_at = datetime.now(timezone.utc)
    by_realm: dict[str, list[dict]] = {}
    for ev in events:
        if ev["entity"] in WEBHOOK_ENTITIES:
            by_realm.setdefault(ev["realm_id"], []).append(ev)

    if not by_realm:
        return {"received": True, "realms": 0, "marked": 0}

    try:
        marked = _apply_webhook_markers(_service_client(), by_realm, received_at)
    except Exception as exc:  # noqa: BLE001
        # 500 so Intuit retries the delivery. Sentry gets ONE event, not two: the
        # Starlette integration captures any 5xx by itself, so a capture_exception
        # here as well would file the same failure twice under different
        # fingerprints (the trap in telemetry.md). The context is what makes the
        # integration's event actionable, and carries counts only — never a realm's
        # documents.
        sentry_sdk.set_context(
            "quickbooks_webhook",
            {"realms": len(by_realm), "events": sum(len(v) for v in by_realm.values())},
        )
        logger.warning("QuickBooks webhook handler error", exc_info=True)
        raise HTTPException(status_code=500, detail="Webhook handler error") from exc

    return {"received": True, "realms": len(by_realm), "marked": marked}


class StatusResponse(BaseModel):
    connected: bool
    reconnect_required: bool = False
    realm_id: str | None = None
    environment: str | None = None
    qb_company_name: str | None = None
    connected_at: str | None = None
    # Evidence that Intuit's change notifications are actually arriving. A webhook
    # registered on the apex instead of www is rejected at Vercel's edge with nothing
    # for Sentry to see (see the webhook route), so a value that stays null is the
    # only signal the settings card can offer that live updates are not reaching us.
    webhook_last_received_at: str | None = None


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
        webhook_last_received_at=conn.get("webhook_last_received_at"),
    )


class TermsResponse(BaseModel):
    """The connected company's QuickBooks payment terms, for the quote picker."""

    connected: bool
    terms: list[dict] = []


@router.get("/{company_id}/terms", response_model=TermsResponse)
async def terms(company_id: str, request: Request):
    """List the Terms this company already has in QuickBooks.

    THE TWO PROVIDERS ARE SERVED DIFFERENTLY HERE, AND THAT IS NOT AN OVERSIGHT.

    QBO stays LIVE. A cached copy would be a second list of terms drifting from
    QuickBooks' own — the exact problem this endpoint removes — and the query is
    four rows against Intuit's REST API, so live is affordable.

    QuickBooks Desktop is served FROM CACHE, because affordability is the whole
    difference. `PaymentTermsPicker` calls this from a MOUNT effect on every quote
    form and every customer detail page. Against Desktop, live would mean a
    multi-second Web Connector round trip on page load, aimed at a PC that may be
    switched off — precisely the failure mode the "no third-party call from a
    mount" rule exists to prevent. The cache is refreshed on connect and by an
    explicit admin action, never by a render.

    Never raises for the ordinary "no QuickBooks" cases. A shop that hasn't
    connected, an Intuit outage, or a cold cache must not stop anyone from writing
    a quote: the caller falls back to Jigged's own presets, and `resolve_term_id`
    still creates whatever term is chosen at push time. Missing options degrade
    the picker; they never block the quote.
    """
    await _verify_company_access(request, company_id)
    db = _service_client()

    conn = qb.get_connection(db, company_id)
    if _is_connected(conn) and not conn.get("reconnect_required"):
        try:
            return TermsResponse(connected=True, terms=qb.list_qb_terms(db, company_id))
        except Exception:  # noqa: BLE001
            logger.warning("Could not list QuickBooks terms for %s", company_id, exc_info=True)
            return TermsResponse(connected=False)

    dconn = qbd.get_connection(db, company_id)
    if dconn and dconn.get("environment") == qbd._environment():
        rows = (
            db.table("quickbooks_terms_cache")
            .select("qb_term_id, name, due_days")
            .eq("company_id", company_id)
            .eq("realm_id", dconn["conductor_end_user_id"])
            .execute()
            .data
            or []
        )
        return TermsResponse(
            connected=True,
            terms=[
                {"id": r["qb_term_id"], "name": r["name"], "due_days": r["due_days"]}
                for r in rows
            ],
        )

    return TermsResponse(connected=False)


class PoFieldResponse(BaseModel):
    """State of this company's PO custom field in QuickBooks.

    `configured` false is the normal starting state, not an error — the shop has
    to create the field themselves in the QuickBooks UI, and Jigged genuinely
    cannot do it for them (see the endpoint docstring).
    """

    configured: bool
    field_id: str | None = None
    field_name: str | None = None
    # Every enabled sales custom field, so the settings card can show the shop
    # which of their three slots are taken and by what.
    candidates: list[dict] = []
    slots_used: int = 0


@router.post("/{company_id}/po-field/refresh", response_model=PoFieldResponse)
async def refresh_po_field(company_id: str, request: Request):
    """Re-read QuickBooks Preferences and remember which custom field holds the PO.

    EXPLICITLY USER-TRIGGERED. This is the "I've set it up, check again" button
    on the settings card — never called on mount or on a push, because it is a
    round trip to Intuit for a value that changes only when a human edits their
    QuickBooks settings.

    Jigged CANNOT create the field. Both paths were tested against a live
    sandbox rather than assumed:
      * the legacy REST Preferences write returns HTTP 200 and silently changes
        nothing — three body shapes tried, all no-ops, confirmed by re-read;
      * the GraphQL Custom Fields API answers 403 without a paid Silver partner
        tier, whose sandbox host does not resolve at all.
    Intuit's own capability matrix agrees: "Create custom field names | UI: Yes |
    API: No". So the shop creates it, and this endpoint finds it.
    """
    await _verify_company_access(request, company_id, require_admin=True)
    db = _service_client()
    conn = qb.get_connection(db, company_id)
    if not _is_connected(conn):
        raise HTTPException(status_code=400, detail="QuickBooks is not connected.")
    if conn.get("reconnect_required"):
        raise HTTPException(
            status_code=400,
            detail="Reconnect QuickBooks first — we can't read your settings until then.",
        )

    # A failed read must NOT be written down. Persisting it would turn "we
    # couldn't ask" into "you have no PO field", wiping an id that was correct
    # a minute ago and silently dropping the PO from every later invoice. So the
    # write happens only on a definitive answer, and a failure surfaces as a
    # retryable error with the stored value untouched.
    try:
        found = qb.discover_po_custom_field(db, company_id)
    except Exception as exc:  # noqa: BLE001
        logger.warning("Could not read QuickBooks settings for %s", company_id, exc_info=True)
        raise HTTPException(
            status_code=502,
            detail="Couldn't reach QuickBooks to check your settings. Try again in a moment.",
        ) from exc

    db.table("quickbooks_connections").update(
        {
            "po_custom_field_id": found["id"],
            "po_custom_field_name": found["name"],
            "qb_settings_checked_at": datetime.now(timezone.utc).isoformat(),
        }
    ).eq("company_id", company_id).execute()

    return PoFieldResponse(
        configured=found["id"] is not None,
        field_id=found["id"],
        field_name=found["name"],
        candidates=found["candidates"],
        slots_used=len(found["candidates"]),
    )


# ───────────────────────── Invoice payment mirror (read-back) ─────────────────────────
class InvoiceStatusRow(BaseModel):
    """What QuickBooks Online last said about ONE invoice, exactly as stored.

    Every field but link_id is nullable because "never checked" is a real state the
    UI renders as such, not a gap to paper over: only a successful Intuit read can
    produce these values, and no backfill could invent them.

    `overdue` is absent on purpose. It depends on today's date, so it is derived at
    render from qb_due_date rather than stored and left to rot.
    """

    link_id: str
    qb_invoice_id: str | None = None
    qb_status: str | None = None
    qb_total_amt: float | None = None
    qb_balance: float | None = None
    qb_due_date: str | None = None
    qb_txn_date: str | None = None
    voided_at: str | None = None


class InvoiceStatusResponse(BaseModel):
    # checked=False means nothing was stale, so Intuit was NOT asked. It is not an
    # error and not an empty answer: `invoices` still carries the stored rows.
    checked: bool
    checked_at: str | None = None
    invoices: list[InvoiceStatusRow] = []
    # Invoices this job holds in a QuickBooks company the shop is no longer connected
    # to. Their ids address nothing in the current realm, so they are never queried;
    # the count exists so the UI can explain why those rows have no status rather
    # than showing them as unchecked forever.
    skipped_other_realm: int = 0


# The response columns come from the service's own list rather than a second copy of
# it: refresh_invoice_statuses re-selects with qb._MIRROR_COLUMNS after the write, so
# hardcoding them here would let the checked=False path drift from the checked=True
# one. The three added columns are what only the ROUTE needs — realm_id to partition
# by connected company, and the two timestamps links_need_check reads.
_MIRROR_SELECT = qb._MIRROR_COLUMNS + ", realm_id, qb_status_checked_at, qb_stale_at"


def _mirror_row(row: dict) -> InvoiceStatusRow:
    return InvoiceStatusRow(
        link_id=row["id"],
        qb_invoice_id=row.get("qb_invoice_id"),
        qb_status=row.get("qb_status"),
        qb_total_amt=row.get("qb_total_amt"),
        qb_balance=row.get("qb_balance"),
        qb_due_date=row.get("qb_due_date"),
        qb_txn_date=row.get("qb_txn_date"),
        voided_at=row.get("voided_at"),
    )


@router.post(
    "/{company_id}/jobs/{job_id}/invoice-status", response_model=InvoiceStatusResponse
)
async def invoice_status(company_id: str, job_id: str, request: Request):
    """What QuickBooks Online last said about this job's invoices.

    CALLED WHEN THE INVOICES MENU IS OPENED, and there is deliberately no button
    beside it. This is the bounded-reconcile-on-an-explicit-action shape
    /api/stripe/reconcile uses, not a fetch-on-mount: opening the menu is a click,
    and the BACKEND — never the browser — decides whether Intuit is actually asked.
    qb.links_need_check answers that from three conditions: a webhook marked
    something stale, a row has never been checked, or the newest check is older than
    qb.INVOICE_STATUS_MAX_AGE_MINUTES. A second open inside that window costs one
    Supabase read and no Intuit call at all.

    A balance the shop has to ask for is a balance they will not trust, which is why
    it is automatic; the freshness rule above is what keeps automatic affordable.

    MEMBER access, not admin. Reading what QuickBooks said about an invoice is a read
    on a user surface, and the same members can already create the invoice.
    """
    await _verify_company_access(request, company_id)
    db = _service_client()

    provider = accounting.get_provider(db, company_id)
    if provider is not None and provider.name != "qbo":
        # QuickBooks Desktop keeps the balance on a PC behind the Web Connector, so
        # reading it here would be a multi-second round trip to a machine that may be
        # switched off — on a menu open. That is exactly the failure mode the terms
        # endpoint's Desktop cache exists to avoid, and until this mirror has an
        # equivalent cached path, Desktop gets an honest refusal instead.
        raise HTTPException(
            status_code=400,
            detail=(
                "Payment status needs QuickBooks Online; this company uses "
                "QuickBooks Desktop."
            ),
        )

    conn = qb.get_connection(db, company_id)
    if not _is_connected(conn):
        raise HTTPException(status_code=400, detail="QuickBooks Online is not connected.")
    if conn.get("reconnect_required"):
        raise HTTPException(
            status_code=400,
            detail="Reconnect QuickBooks first — we can't check payments until then.",
        )

    await _load_gated_job(db, company_id, job_id)  # 404 + company scoping

    links = (
        db.table("quickbooks_invoice_links")
        .select(_MIRROR_SELECT)
        .eq("company_id", company_id)
        .eq("job_id", job_id)
        .eq("provider", "qbo")
        .eq("status", "created")
        .not_.is_("qb_invoice_id", "null")
        .execute()
        .data
        or []
    )

    # Rows the mirror itself voided are KEPT in the batch, not filtered out. If the
    # invoice reappears in QuickBooks (a delete undone, a void reversed),
    # apply_qbo_invoice_mirror clears the mirror-owned voided_at and the quantity
    # re-locks — which it can only do for a row we actually sent.
    realm_id = conn["realm_id"]
    in_realm = [r for r in links if r["realm_id"] == realm_id]
    skipped_other_realm = len(links) - len(in_realm)

    if not in_realm:
        return InvoiceStatusResponse(checked=False, skipped_other_realm=skipped_other_realm)

    # ONE clock read, taken BEFORE the fetch, serving both the staleness test and the
    # monotonic guard in apply_qbo_invoice_mirror. Stamping it after Intuit answers
    # would let a slow pass finish last carrying a later timestamp than a pass that
    # started after it — and overwrite a newer balance with an older one.
    checked_at = datetime.now(timezone.utc)

    if not qb.links_need_check(in_realm, conn, checked_at):
        return InvoiceStatusResponse(
            checked=False,
            invoices=[_mirror_row(r) for r in in_realm],
            skipped_other_realm=skipped_other_realm,
        )

    # A failed read must NOT be written down — the same rule as refresh_po_field
    # above, and it bites harder here. Persisting "we couldn't ask" as a status would
    # tell a shop owner an invoice is unpaid when it may have been settled that
    # morning. refresh_invoice_statuses writes only on a definitive answer, so every
    # branch below leaves the stored mirror exactly as it was.
    try:
        stored = qb.refresh_invoice_statuses(
            db, company_id, conn, in_realm, checked_at=checked_at
        )
    except qb.QuickBooksNotConnected as exc:
        # The refresh token died between the check above and the call. Same wording
        # as the pre-flight branch: the shop's action is identical either way.
        raise HTTPException(
            status_code=400,
            detail="Reconnect QuickBooks first — we can't check payments until then.",
        ) from exc
    except Exception as exc:  # noqa: BLE001
        # 409, NOT a 5xx, and the difference is the whole point. The Starlette
        # integration captures 5xx only, and this branch fires on a MENU OPEN — a
        # lapsed connection or an Intuit outage would file an issue every time
        # anyone glanced at a job, for a condition only the shop can fix. That is how
        # an alert gets trained away. Same reasoning as the QuickBooks Desktop 409s
        # in _map_qb_error, which is deliberately not reused here: its 502 semantics
        # belong to the push path, where a failure IS news.
        logger.warning(
            "Could not read QuickBooks invoice status for job %s", job_id, exc_info=True
        )
        raise HTTPException(
            status_code=409,
            detail={
                "code": "qbo_unreachable",
                "message": (
                    "Couldn't reach QuickBooks to check payments. Showing what it "
                    "last said."
                ),
            },
        ) from exc

    return InvoiceStatusResponse(
        checked=True,
        checked_at=checked_at.isoformat(),
        invoices=[_mirror_row(r) for r in stored],
        skipped_other_realm=skipped_other_realm,
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
    provider = accounting.get_provider(db, company_id)
    if provider is None or provider.requires_reconnect:
        return {"connected": False}

    realm = provider.scope_id
    job = await _load_gated_job(db, company_id, job_id)

    # Surfaced so the push dialog can explain a blocked Create button rather than
    # letting the user click it and take a 409.
    unverified = _job_has_unverified_invoice(db, company_id, job_id)

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
            # A customer lookup must never block the dialog. Not finding one is the
            # ORDINARY path -- it ends in creating the customer at push time, which
            # is exactly how QuickBooks Online behaves -- so a failure here degrades
            # to "unmatched" rather than turning a routine first invoice into an
            # error the user cannot act on.
            try:
                customer_res = provider.find_customer_candidates(customer["name"])
            except Exception:  # noqa: BLE001
                logger.warning(
                    "QuickBooks customer lookup failed for %s; offering to create",
                    customer["name"], exc_info=True,
                )
                customer_res = {
                    "status": "unmatched", "qb_customer_id": None, "candidates": [],
                }
        # Per-part billing context (ordered / shipped / invoiced / invoiceable + price)
        # for the quantity picker. Replaces the old whole-job "lines_preview": a job now
        # has many invoices, each billing a chosen quantity of shipped-but-unbilled parts.
        parts = qb.load_billable_parts(db, company_id, job)
    except Exception as exc:  # noqa: BLE001
        raise _map_qb_error(exc)

    customer_res.update({"jigged_customer_id": customer["id"], "jigged_name": customer["name"]})
    return {
        "connected": True,
        "provider": provider.name,
        # None for QuickBooks Desktop: there is no web app to link an invoice into,
        # so the dialog must not pre-open a tab it will only close again.
        "has_deep_links": provider.name == "qbo",
        "blocked": (
            {"code": "qbd_blocked_unverified", "link_id": unverified["id"]}
            if unverified
            else None
        ),
        "customer": customer_res,
        "parts": parts,
    }


class VerifyResponse(BaseModel):
    outcome: str  # 'adopted' | 'released'
    qb_invoice_id: str | None = None
    doc_number: str | None = None
    url: str | None = None


@router.post("/{company_id}/invoices/{link_id}/verify", response_model=VerifyResponse)
async def verify_invoice(company_id: str, link_id: str, request: Request):
    """Resolve an invoice whose create ended with an unknown outcome.

    This is the ONLY way a 'needs_verification' link advances. It is deliberately
    a human-triggered action rather than an automatic retry: Conductor does not
    deduplicate, and a create aborted client-side was verified to still produce an
    invoice, so retrying blind is exactly how a customer gets billed twice.

    Adopting is idempotent — the line-item upsert ignores duplicates — so running
    this twice records the invoice once.
    """
    await _verify_company_access(request, company_id)
    db = _service_client()
    provider = accounting.get_provider(db, company_id)
    if provider is None:
        raise HTTPException(status_code=409, detail="QuickBooks is not connected.")

    rows = (
        db.table("quickbooks_invoice_links")
        .select("*")
        .eq("company_id", company_id)
        .eq("id", link_id)
        .limit(1)
        .execute()
        .data
    )
    if not rows:
        raise HTTPException(status_code=404, detail="Invoice record not found.")
    row = rows[0]

    if row["status"] == "created":
        return VerifyResponse(
            outcome="adopted",
            qb_invoice_id=row.get("qb_invoice_id"),
            doc_number=row.get("qb_invoice_doc_number"),
            url=row.get("qb_invoice_url"),
        )

    try:
        found = provider.find_created_invoice(row)
    except Exception as exc:  # noqa: BLE001
        raise _map_qb_error(exc)

    if found:
        # The line items were written at claim time, so flipping the status is all
        # that is needed — and it is what makes the quantities count.
        adopted = _adopt_invoice(db, link_id, found, provider)
        return VerifyResponse(
            outcome="adopted",
            qb_invoice_id=adopted["qb_invoice_id"],
            doc_number=adopted["doc_number"],
            url=adopted["url"],
        )

    # Not found: it provably never landed. Release the draft so a retry can claim
    # it again with a fresh attempt.
    db.table("quickbooks_invoice_links").update({"status": "error"}).eq("id", link_id).execute()
    return VerifyResponse(outcome="released")


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
    # transaction_date: the invoice date, YYYY-MM-DD, supplied by the browser
    # because it knows the shop's timezone and the server only knows UTC. Bounded
    # server-side to +/-1 day so a client cannot backdate into a closed period.
    # QBO derives its own TxnDate; QuickBooks Desktop requires one.
    transaction_date: str | None = None


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


def _resolve_transaction_date(supplied: str | None) -> str:
    """The invoice date, taken from the browser because it knows the shop's
    timezone and the server only knows UTC.

    Bounded to +/-1 day of the server's date so a client cannot backdate an
    invoice into a closed accounting period. A bare UTC default would misdate
    roughly one push in thirty for a US shop working past 4pm Pacific -- a real
    period-cutoff error, not a cosmetic one.
    """
    today = datetime.now(timezone.utc).date()
    if not supplied:
        return today.isoformat()
    try:
        parsed = datetime.strptime(supplied, "%Y-%m-%d").date()
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid invoice date.")
    if abs((parsed - today).days) > 1:
        raise HTTPException(
            status_code=400,
            detail="Invoice date must be within a day of today.",
        )
    return parsed.isoformat()


def _adopt_invoice(db: Client, link_id: str, found, provider) -> dict:
    """An invoice we could not confirm turned out to exist. Record it and flip
    the link to 'created'.

    Safe to run twice: the line-item upsert is keyed on
    (invoice_link_id, job_part_id) with ignore_duplicates, so a second verify
    writes nothing new.
    """
    url = provider.invoice_deep_link(found.id)
    db.table("quickbooks_invoice_links").update(
        {
            "status": "created",
            "qb_invoice_id": found.id,
            "qb_invoice_doc_number": found.doc_number,
            "qb_invoice_sync_token": found.sync_token,
            "qb_invoice_url": url,
        }
    ).eq("id", link_id).execute()
    return {
        "qb_invoice_id": found.id,
        "doc_number": found.doc_number,
        "url": url,
        "already_existed": True,
    }


def _job_has_unverified_invoice(db: Client, company_id: str, job_id: str) -> dict | None:
    rows = (
        db.table("quickbooks_invoice_links")
        .select("id, qb_request_id")
        .eq("company_id", company_id)
        .eq("job_id", job_id)
        .eq("status", "needs_verification")
        .limit(1)
        .execute()
        .data
    )
    return rows[0] if rows else None


@router.post("/{company_id}/jobs/{job_id}/invoice")
async def push_invoice(company_id: str, job_id: str, request: Request, body: CommitBody):
    _, access = await _verify_company_access(request, company_id)
    db = _service_client()
    provider = accounting.get_provider(db, company_id)
    if provider is None or provider.requires_reconnect:
        raise HTTPException(status_code=409, detail="QuickBooks is not connected.")
    realm = provider.scope_id
    conn = getattr(provider, "_conn", {})
    job = await _load_gated_job(db, company_id, job_id)

    if not body.request_id:
        raise HTTPException(status_code=400, detail="Missing invoice request id.")

    transaction_date = _resolve_transaction_date(body.transaction_date)

    # ── An unverified invoice on this job blocks a new one. ──
    # A 'needs_verification' link contributes ZERO to invoiced quantity (every
    # compute function and assert_invoice_not_over_ordered filter status='created'),
    # which is right — money we cannot confirm must not satisfy a billing cap. But
    # it means the ordered-cap would happily let the same quantity be billed again.
    # This block is what closes that. Per JOB, not per company: the ambiguity is
    # about specific quantities on one job.
    unverified = _job_has_unverified_invoice(db, company_id, job_id)
    if unverified:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "qbd_blocked_unverified",
                "message": (
                    "An earlier invoice for this job could not be confirmed in "
                    "QuickBooks. Check it before creating another."
                ),
                "link_id": unverified["id"],
            },
        )

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

    # Build + validate the selected lines (ordered-cap, price snapshot). Done after the
    # created/pending short-circuit above but before claiming a NEW row, so a bad
    # selection returns 400 without leaving a junk pending link (resume of an
    # error/stale row re-validates cleanly — its lines aren't counted yet).
    selection = [{"job_part_id": ln.job_part_id, "quantity": ln.quantity} for ln in body.lines]
    try:
        lines, bill_addr, snapshot_rows = qb.load_firm_invoice_lines(
            db, company_id, job, selection
        )
    except Exception as exc:  # noqa: BLE001
        raise _map_qb_error(exc)

    # The raw address row, for providers that shape it themselves.
    # load_firm_invoice_lines returns bill_addr already in QuickBooks ONLINE's
    # shape (Line1 / CountrySubDivisionCode); Desktop uses different key names and
    # rejects that one outright.
    raw_bill_addr = None
    if job.get("billing_address_id"):
        rows = (
            db.table("customer_addresses")
            .select("address_line1, address_line2, city, state, postal_code, country")
            .eq("id", job["billing_address_id"])
            .limit(1)
            .execute()
            .data
        )
        raw_bill_addr = rows[0] if rows else None

    if existing:
        row = existing[0]
        request_id = row["qb_request_id"]
        link_id = row["id"]

        # A stale PENDING row means a worker died mid-flight and we do not know
        # whether the invoice landed.
        #
        # QBO resumes by re-POSTing with the same request id, which is safe only
        # because Intuit dedupes on ?requestid=. Conductor has no such mechanism,
        # and a create aborted client-side at 1s was verified to still produce an
        # invoice — so re-POSTing here is how you double-bill a customer. For a
        # provider that does not dedupe, look before leaping: probe for the
        # invoice, adopt it if it exists, and otherwise park the link for a human.
        if row["status"] == "pending" and not provider.dedupes_replayed_creates:
            try:
                found = provider.find_created_invoice(row)
            except Exception:  # noqa: BLE001 — a failed probe is not a failed invoice
                found = None
            if found:
                return _adopt_invoice(db, link_id, found, provider)
            db.table("quickbooks_invoice_links").update(
                {"status": "needs_verification"}
            ).eq("id", link_id).execute()
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "qbd_verify",
                    "message": (
                        "We couldn't confirm whether QuickBooks recorded that "
                        "invoice. Check QuickBooks before trying again."
                    ),
                    "link_id": link_id,
                },
            )

        # An ERROR row is reclaimed in place. The push dialog's retry deliberately
        # reuses the same request_id (that is what makes a double-click safe), and
        # the errored row still holds it — so without this the retry would collide
        # with UNIQUE(realm_id, qb_request_id) and dead-end. It is the same draft;
        # only the attempt is new.
        db.table("quickbooks_invoice_links").update(
            {
                "status": "pending",
                "qb_invoice_id": None,
                "qb_invoice_doc_number": None,
                "qb_invoice_url": None,
                "transaction_date": transaction_date,
            }
        ).eq("id", link_id).execute()
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
                        "provider": provider.name,
                        "qb_request_id": request_id,
                        "transaction_date": transaction_date,
                        "status": "pending",
                        "pushed_by": access["id"],
                    }
                )
                .execute()
            )
            link_id = inserted.data[0]["id"]
        except Exception:  # noqa: BLE001 - unique violation = a sibling claimed it first
            return {"in_progress": True}

    # ── Record the billed quantities NOW, while the link is still 'pending'. ──
    # They count for nothing until the link flips to 'created' (every compute
    # function and assert_invoice_not_over_ordered filter on that status), so
    # writing them early is safe — and it is what makes an unknown outcome
    # recoverable at all. If the create's result is lost, the quantities that were
    # billed are the one thing we could never reconstruct from QuickBooks, because
    # the invoice there is denominated in its own lines, not in job_part ids.
    # Delete-then-insert rather than upsert: a reclaimed draft may have been edited
    # between attempts, and a stale row would bill a part nobody chose.
    db.table("quickbooks_invoice_line_items").delete().eq("invoice_link_id", link_id).execute()
    db.table("quickbooks_invoice_line_items").insert(
        [
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
    ).execute()

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
            customer_ref = provider.create_customer(customer["name"], raw_bill_addr)
            _upsert_customer_map(
                db, company_id, customer["id"], realm, customer_ref, customer["name"], access["id"]
            )

        # Record the customer alongside the claim: the QuickBooks Desktop recovery
        # probe narrows on it, and a re-mapping between push and verify must not
        # move the window.
        db.table("quickbooks_invoice_links").update(
            {"qb_customer_id": customer_ref}
        ).eq("id", link_id).execute()

        item_ref = provider.resolve_default_item()

        # Terms the job was sold on. Best-effort by design on both providers: a
        # term that cannot be resolved or created returns None and the invoice
        # goes out with the customer's own default rather than failing.
        sales_term_id = (
            provider.resolve_term_id(job["payment_terms"])
            if job.get("payment_terms")
            else None
        )

        # The customer's OWN sales-tax code. QBO returns None here and pins 'NON'
        # internally, because an omitted code is TAXABLE under Automated Sales Tax.
        # QuickBooks Desktop is the mirror image: verified that a line with no code
        # defaults to 'Non' and is NOT taxed even for a customer whose record reads
        # 'Tax', so omitting it there silently under-bills a taxable sale.
        sales_tax_code_id = provider.customer_tax_code_id(customer_ref)

        payload = provider.build_invoice_payload(
            customer_ref=customer_ref,
            item_ref=item_ref,
            job_number=job.get("job_number"),
            customer_po_number=job.get("customer_po_number"),
            bill_addr=bill_addr,
            raw_billing_address=raw_bill_addr,
            lines=lines,
            sales_term_id=sales_term_id,
            term_id=sales_term_id,
            sales_tax_code_id=sales_tax_code_id,
            transaction_date=transaction_date,
            request_id=str(request_id),
            po_custom_field_id=conn.get("po_custom_field_id"),
            po_custom_field_name=conn.get("po_custom_field_name"),
        )
        created = provider.create_invoice(payload, request_id=str(request_id))
        result = {
            "id": created.id,
            "doc_number": created.doc_number,
            "sync_token": created.sync_token,
        }
        invoice_url = provider.invoice_deep_link(created.id)
    except qbd.QbdUnknownOutcome:
        # The create may well have landed — verified that one aborted at 1s did.
        # Probe once; adopt it if it is there, otherwise park the link and make a
        # human look. NEVER retry: that is precisely how the duplicate happens.
        probe_row = {
            "qb_request_id": str(request_id),
            "qb_customer_id": locals().get("customer_ref"),
            "transaction_date": transaction_date,
        }
        try:
            found = provider.find_created_invoice(probe_row)
        except Exception:  # noqa: BLE001
            found = None
        if found:
            return _adopt_invoice(db, link_id, found, provider)

        db.table("quickbooks_invoice_links").update(
            {"status": "needs_verification"}
        ).eq("id", link_id).execute()
        # A 409 is NOT auto-captured by the Starlette integration, and unconfirmed
        # money is the one thing that must reach the queue — so this is a single
        # deliberate capture, not a duplicate of an existing one.
        sentry_sdk.set_context(
            "quickbooks_desktop_invoice",
            {"link_id": link_id, "job_id": job_id, "request_id": str(request_id)},
        )
        sentry_sdk.capture_message(
            "QuickBooks Desktop invoice outcome unknown", level="warning"
        )
        raise HTTPException(
            status_code=409,
            detail={
                "code": "qbd_verify",
                "message": (
                    "We couldn't confirm whether QuickBooks recorded that invoice. "
                    "Check QuickBooks before trying again."
                ),
                "link_id": link_id,
            },
        )
    except HTTPException:
        db.table("quickbooks_invoice_links").update({"status": "error"}).eq("id", link_id).execute()
        raise
    except Exception as exc:  # noqa: BLE001
        db.table("quickbooks_invoice_links").update({"status": "error"}).eq("id", link_id).execute()
        # WARNING, not exception: `LoggingIntegration` files an ERROR-level record as its own
        # Sentry event, and `_map_qb_error` raises an HTTPException the Starlette integration
        # already captures for any 5xx (its default `failed_request_status_codes` is 500-599).
        # Two captures for one failure, fingerprinted differently — the trap in telemetry.md.
        # `exc_info` keeps the traceback in the log, where it costs nothing.
        logger.warning("QuickBooks push failed for job %s", job_id, exc_info=True)
        raise _map_qb_error(exc)

    # Success: flip the link to created. The line rows were written at claim time
    # (above), so the on-status trigger sees them and recomputes invoicing_status;
    # the over-invoice BEFORE trigger has already backstopped their insert.
    try:
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
        # Same double-capture reasoning as the push failure above — but this is the path with
        # real data consequences (money exists in QBO that Jigged has not recorded), so the ids
        # go into Sentry's context rather than being lost with the duplicate event. The 500
        # below is what files the issue; this is what makes it actionable.
        sentry_sdk.set_context(
            "quickbooks_invoice",
            {"qb_invoice_id": result["id"], "link_id": link_id, "job_id": job_id},
        )
        logger.warning(
            "Invoice %s created in QBO but recording its lines failed (link %s)",
            result["id"],
            link_id,
            exc_info=True,
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
