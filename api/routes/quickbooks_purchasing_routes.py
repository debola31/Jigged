"""QuickBooks: send a VENDOR purchase order, and the purchasing setup it needs.

"PO" alone means the customer's PO in this codebase, so every route here says vendor PO.
Jigged never creates bills or item receipts and never sets a customer or billable flag:
the bookkeeper bills against the pushed PO in QuickBooks (founder decision, plan §2).

THE STATE MACHINE LIVES HERE, ONCE, for both providers (services/accounting/base.py
explains why the Protocol does not offer a seam to fork it):

  * One link row per (PO, company file), UNIQUE(vendor_purchase_order_id, realm_id), with
    four states -- pending / created / error / needs_verification -- and a compare-and-set
    claim on (status, qb_request_id), so a double-click or two tabs make ONE QuickBooks PO.
  * The SERVER mints every request id; neither the browser nor the MCP tool sends one.
    QuickBooks Online: a stale or ambiguous attempt resumes with the SAME id (Intuit
    replays it); a rejected one gets a new id. QuickBooks Desktop has no request key: an
    unknown outcome is probed ONCE, then adopted or parked as needs_verification with one
    Sentry message, and never retried automatically. /verify is the only way out.
  * A push with no changes makes ZERO provider calls: the stored hash of Jigged's
    projection is compared before anything resolves a term, a ship method or a vendor.
  * Update, close and reopen read the QuickBooks PO ONCE, inside the click, for its token,
    line ids and Desktop received/billed flags. Nothing read is stored but the new token.

EVERY ROUTE checks the office role and the billing gate (company_auth.
verify_office_write_access) BEFORE any QuickBooks call; the setup writes and the
on-click QuickBooks lists need an admin. Only GET /purchasing/setup is a database read,
safe on mount, and it is not billing-gated because nothing it does costs or writes.

Shop-fixable conditions are 409s with a code and a sentence saying where to fix them
(services/accounting/purchase_order.PO_ERROR_SENTENCES) and stay out of Sentry. Any
other QuickBooks rejection is a 502 carrying QuickBooks' own words, which the Starlette
integration reports.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Literal
from uuid import uuid4

import sentry_sdk
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel
from supabase import Client

import routes.company_auth as company_auth
import services.accounting as accounting
import services.quickbooks as qb
import services.quickbooks_desktop as qbd
import services.quickbooks_desktop_purchasing as qbdp
import services.quickbooks_purchasing as qbp
from routes.quickbooks_routes import _app_base_url
from services.accounting import purchase_order as pom
from services.accounting.base import PushedPurchaseOrder, QbPurchaseOrderState

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/quickbooks", tags=["quickbooks-purchasing"])

POS = "vendor_purchase_orders"
PO_LINES = "vendor_purchase_order_lines"
PO_STATUS = "vendor_purchase_order_status"
LINKS = "quickbooks_purchase_order_links"
LINE_LINKS = "quickbooks_purchase_order_line_links"
VENDOR_MAP = "quickbooks_vendor_map"
SETUP = "quickbooks_purchasing_setup"

#: A pending link younger than this has a sibling request in flight (Vercel caps a
#: function at 60s); older, and the worker died. The invoice path's rule.
PENDING_STALE_SECONDS = qb.PENDING_STALE_SECONDS

QBO_NO_ANSWER = (
    "QuickBooks Online didn't answer, so it isn't known yet whether it saved this PO. Send it "
    "again: Jigged picks up the same attempt, so the PO can't be created twice."
)
RECORDING_FAILED = (
    "The purchase order reached QuickBooks, but recording it in Jigged failed. Refresh the "
    "page; if it persists, contact support."
)
CUSTOM_NUMBERS_OFF = (
    "Custom transaction numbers are off in QuickBooks Online, so QuickBooks gives each PO its "
    "own number instead of Jigged's. To keep the numbers the same, turn custom transaction "
    "numbers on in QuickBooks under Settings → Account and settings."
)
PREFERENCE_UNKNOWN = (
    "QuickBooks didn't say whether purchase orders are turned on. The first PO you send will "
    "tell you if they're off."
)
QBD_PURCHASE_ORDERS_OFF = (
    "Purchase orders are turned off in this QuickBooks Desktop company file. Turn on "
    "“Inventory and purchase orders are active” in QuickBooks under Edit → Preferences → "
    "Items & Inventory."
)


# ───────────────────────── small helpers ─────────────────────────
def _now() -> datetime:
    return datetime.now(timezone.utc)


def _refusal(refusal: pom.PurchasingRefusal) -> HTTPException:
    return HTTPException(status_code=409, detail=refusal.detail())


def _refuse(code: str, *, extra: dict | None = None, **ctx: Any) -> HTTPException:
    return _refusal(pom.PurchasingRefusal(code, extra=extra, **ctx))


def _pending_is_fresh(row: dict) -> bool:
    stamp = row.get("updated_at") or row.get("created_at")
    if not stamp:
        return True
    return (_now() - qb._parse_dt(stamp)).total_seconds() < PENDING_STALE_SECONDS


def _provider_or_none(db: Client, company_id: str):
    """The connected provider, or None -- never a QuickBooks call."""
    try:
        provider = accounting.get_provider(db, company_id)
    except qbd.QbdNotConnected:
        return None
    if provider is None or provider.requires_reconnect:
        return None
    return provider


def _require_provider(db: Client, company_id: str):
    provider = _provider_or_none(db, company_id)
    if provider is None:
        raise _refuse("qb_not_connected")
    return provider


async def _admin_writer(request: Request, company_id: str) -> tuple[str, dict]:
    """An ADMIN of the company, not an AI assistant, whose company may write. The
    purchasing setup is a one-time admin choice of accounts with no MCP tool, and every
    push refusal names where to make it."""
    user_id, access = await company_auth.verify_company_access(request, company_id, require_admin=True)
    company_auth.refuse_assistant(request)
    company_auth.assert_company_can_write(company_id)
    return user_id, access


def _provider_error(exc: Exception, po: pom.PurchaseOrderProjection | None = None) -> HTTPException:
    """Map a provider failure. 409 for what the shop can fix; 502 (reported) for a
    QuickBooks rejection Jigged did not foresee; 503 for Jigged's own configuration."""
    po_number = po.po_number if po else None
    if isinstance(exc, HTTPException):
        return exc
    if isinstance(exc, pom.PurchasingRefusal):
        return _refusal(exc)
    if isinstance(exc, (qb.QuickBooksServiceUnavailable, qbd.QbdServiceUnavailable)):
        return HTTPException(status_code=503, detail=str(exc))
    if isinstance(exc, qbd.QbdOffline):
        return _refuse("qbd_offline")
    if isinstance(exc, (qbd.QbdNotConnected, qb.QuickBooksNotConnected)):
        return _refuse("qb_not_connected")
    if isinstance(exc, qbd.QbdUnknownOutcome):
        return _refuse("qbd_verify", po_number=po_number)
    if isinstance(exc, qb.QuickBooksApiError):
        code = qbp.classify_qbo_fault(exc)
        if code:
            return _refuse(code, po_number=po_number, name=po.vendor_name if po else None)
        said = qbp.fault_text(exc)
        return HTTPException(status_code=502, detail={
            "code": "qbo_rejected",
            "message": f"QuickBooks Online rejected it: {said}" if said else "QuickBooks Online rejected the request.",
        })
    if isinstance(exc, qbd.QbdApiError):
        code = qbdp.classify_qbd_error(exc)
        if code:
            return _refuse(code, po_number=po_number)
        return HTTPException(status_code=502, detail={"code": "qbd_rejected", "message": str(exc)})
    if isinstance(exc, ValueError):
        return HTTPException(status_code=400, detail=str(exc))
    return HTTPException(status_code=500, detail="Unexpected error")


# ───────────────────────── loading ─────────────────────────
def _load_po(db: Client, company_id: str, po_id: str) -> pom.PurchaseOrderProjection:
    """By id, archived included (a by-id read must find an archived PO -- it is refused
    with a sentence, not a 404)."""
    header = (
        db.table(POS).select("*").eq("company_id", company_id).eq("id", po_id).limit(1).execute().data
    )
    if not header:
        raise HTTPException(status_code=404, detail="That purchase order isn't in this company.")
    lines = (
        db.table(PO_LINES).select("*").eq("company_id", company_id)
        .eq("vendor_purchase_order_id", po_id).order("line_number").execute().data
        or []
    )
    status = db.table(PO_STATUS).select("id, status").eq("id", po_id).limit(1).execute().data
    if not status:
        raise RuntimeError(f"vendor_purchase_order_status has no row for {po_id}")
    return pom.projection_from_rows(header[0], lines, status=status[0]["status"])


def _load_link(db: Client, company_id: str, po_id: str, realm: str) -> dict | None:
    rows = (
        db.table(LINKS).select("*").eq("company_id", company_id)
        .eq("vendor_purchase_order_id", po_id).eq("realm_id", realm).limit(1).execute().data
    )
    return rows[0] if rows else None


def _line_links(db: Client, link_id: str) -> list[dict]:
    return (
        db.table(LINE_LINKS).select("id, vendor_purchase_order_line_id, qb_line_id, qb_item_id")
        .eq("link_id", link_id).execute().data
        or []
    )


def _setup_identity(provider) -> dict:
    """Setup rows hang off the connection row ON DELETE CASCADE, so Disconnect clears them."""
    identity = {"provider": provider.name, "realm_id": provider.scope_id}
    if provider.name == "qbo":
        identity["quickbooks_connection_id"] = provider.connection_id
    else:
        identity["quickbooks_desktop_connection_id"] = provider.connection_id
    return identity


def _setup_rows(db: Client, company_id: str, provider) -> dict[str, dict]:
    rows = (
        db.table(SETUP).select("*").eq("company_id", company_id).eq("realm_id", provider.scope_id)
        .execute().data
        or []
    )
    return {r["setup_key"]: r for r in rows}


def _save_setup_row(db: Client, company_id: str, provider, key: str, *, chosen_by: str | None,
                    qb_id: str | None = None, qb_name: str | None = None,
                    posting_account_id: str | None = None, posting_account_name: str | None = None,
                    details: dict | None = None, created_in_quickbooks: bool = False) -> dict:
    row = {
        "company_id": company_id, **_setup_identity(provider), "setup_key": key,
        "qb_id": qb_id, "qb_name": qb_name,
        "posting_account_id": posting_account_id, "posting_account_name": posting_account_name,
        "details": details or {}, "created_in_quickbooks": created_in_quickbooks,
        "chosen_by": chosen_by,
    }
    saved = db.table(SETUP).upsert(row, on_conflict="company_id,realm_id,setup_key").execute().data
    return saved[0] if saved else row


def _vendor_map(db: Client, company_id: str, vendor_id: str, realm: str) -> dict | None:
    rows = (
        db.table(VENDOR_MAP).select("qb_vendor_id, qb_display_name").eq("company_id", company_id)
        .eq("vendor_id", vendor_id).eq("realm_id", realm).limit(1).execute().data
    )
    return rows[0] if rows else None


def _map_vendor(db: Client, company_id: str, vendor_id: str, provider, qb_vendor_id: str,
                display_name: str | None, linked_by: str | None) -> None:
    db.table(VENDOR_MAP).upsert(
        {
            "company_id": company_id, "vendor_id": vendor_id, "realm_id": provider.scope_id,
            "provider": provider.name, "qb_vendor_id": str(qb_vendor_id),
            "qb_display_name": display_name, "linked_by": linked_by,
        },
        on_conflict="company_id,vendor_id,realm_id",
    ).execute()


def _live_vendor_name(db: Client, po: pom.PurchaseOrderProjection) -> str:
    """The vendor's CURRENT name: the QuickBooks vendor is matched once and mapped for
    every later PO, so it should be found by today's name, not the PO's frozen copy."""
    rows = (
        db.table("vendors").select("id, name").eq("company_id", po.company_id)
        .eq("id", po.vendor_id).limit(1).execute().data
    )
    return (rows[0].get("name") if rows else None) or po.vendor_name


def _po_url(po: pom.PurchaseOrderProjection) -> str | None:
    try:
        base = _app_base_url()
    except Exception:  # noqa: BLE001 - a link in an internal memo is never worth a failed push
        return None
    return f"{base}/dashboard/{po.company_id}/purchasing/orders/{po.vendor_po_id}"


def _missing_items(po: pom.PurchaseOrderProjection, setup: dict[str, dict],
                   known_items: dict[str, str]) -> tuple[dict[str, str], list[str]]:
    """Each line's QuickBooks item: the one it was first pushed with, else the setup item
    for its kind. Only the kinds actually on this PO are required (plan §3.11)."""
    item_refs: dict[str, str] = {}
    missing: list[str] = []
    for line in po.lines:
        if known_items.get(line.line_id):
            item_refs[line.line_id] = known_items[line.line_id]
            continue
        key = pom.ITEM_SETUP_KEYS.get(line.line_kind)
        row = setup.get(key) if key else None
        if row and row.get("qb_id"):
            item_refs[line.line_id] = str(row["qb_id"])
        elif key and key not in missing:
            missing.append(key)
    return item_refs, missing


def _link_summary(link: dict | None, po: pom.PurchaseOrderProjection) -> dict | None:
    if not link:
        return None
    pushed_cv = link.get("pushed_content_version")
    return {
        "id": link["id"], "status": link["status"], "operation": link.get("operation"),
        "last_failure": link.get("last_failure"), "qb_po_id": link.get("qb_po_id"),
        "qb_doc_number": link.get("qb_doc_number"), "qb_url": link.get("qb_url"),
        "qb_closed": bool(link.get("qb_closed")), "pushed_revision": link.get("pushed_revision"),
        "out_of_date": bool(link.get("qb_po_id")) and po.content_version > (pushed_cv if pushed_cv is not None else -1),
    }


def _content_warnings(po: pom.PurchaseOrderProjection, provider) -> list[str]:
    """What QuickBooks will hold differently from the vendor's PDF. Knowable from Jigged
    alone, so the dialog can say it before anything is sent."""
    warnings: list[str] = []
    if provider.name == "qbd":
        if po.notes_to_vendor and len(po.notes_to_vendor) > pom.QBD_VENDOR_MESSAGE_MAX:
            warnings.append("Notes to the vendor are cut to 99 characters in QuickBooks Desktop; "
                            "the PDF has them in full.")
        if qbdp.ship_to_was_cut(po):
            warnings.append("The ship-to address is shortened to fit QuickBooks Desktop; the PDF "
                            "has it in full.")
    elif not po.closed:
        closed = [str(line.line_number) for line in po.lines if line.closed]
        if closed:
            which = "line " + closed[0] if len(closed) == 1 else "lines " + ", ".join(closed)
            warnings.append(f"QuickBooks Online can't close single lines, so {which} stays open "
                            "there until the whole PO is closed.")
    return warnings


# ───────────────────────── the claim and its release ─────────────────────────
def _claim(db: Client, provider, po: pom.PurchaseOrderProjection, link: dict | None,
           operation: str, request_id: str, *, resume: bool) -> dict | None:
    """Make the link ours ('pending'), or None when a sibling got there first."""
    if link is None:
        try:
            rows = db.table(LINKS).insert({
                "company_id": po.company_id, "vendor_purchase_order_id": po.vendor_po_id,
                "provider": provider.name, "realm_id": provider.scope_id,
                "operation": operation, "status": "pending", "qb_request_id": request_id,
                "transaction_date": po.ordered_on, "attempt_content_version": po.content_version,
            }).execute().data
        except Exception:  # noqa: BLE001 - UNIQUE(PO, realm): a sibling claimed it first
            return None
        return rows[0] if rows else None
    update: dict = {"status": "pending", "last_failure": None}
    if not resume:
        update.update({"operation": operation, "qb_request_id": request_id,
                       "attempt_content_version": po.content_version})
        if operation == "create":
            update["transaction_date"] = po.ordered_on
    rows = (
        db.table(LINKS).update(update).eq("id", link["id"]).eq("status", link["status"])
        .eq("qb_request_id", link["qb_request_id"]).execute().data
    )
    return rows[0] if rows else None


def _release(db: Client, link: dict, failure: str) -> None:
    """'error' with why: an ambiguous attempt keeps its request id for the resume."""
    try:
        db.table(LINKS).update({"status": "error", "last_failure": failure}).eq("id", link["id"]).execute()
    except Exception:  # noqa: BLE001 - a stale 'pending' is recoverable in 90s anyway
        logger.warning("Could not release purchase-order link %s", link.get("id"), exc_info=True)


def _park(db: Client, po: pom.PurchaseOrderProjection, link: dict) -> HTTPException:
    """needs_verification, and ONE Sentry message: a 409 is never auto-captured, and an
    unconfirmed purchase order in someone's books must reach the queue."""
    db.table(LINKS).update({"status": "needs_verification"}).eq("id", link["id"]).execute()
    sentry_sdk.set_context("quickbooks_desktop_purchase_order", {
        "link_id": link["id"], "vendor_purchase_order_id": po.vendor_po_id,
        "request_id": str(link.get("qb_request_id")), "operation": link.get("operation"),
    })
    sentry_sdk.capture_message("QuickBooks Desktop purchase order outcome unknown", level="warning")
    return _refuse("qbd_verify", extra={"link_id": link["id"]}, po_number=po.po_number)


# ───────────────────────── recording ─────────────────────────
def _write_line_links(db: Client, po: pom.PurchaseOrderProjection, link_id: str,
                      line_ids: tuple[str, ...], item_refs: dict[str, str]) -> None:
    """Map QuickBooks' line ids back BY POSITION (the payload's line order is the
    projection's), then drop the links of lines no longer on the PO."""
    if len(line_ids) != len(po.lines):
        logger.warning("QuickBooks returned %s lines for %s lines sent (link %s)",
                       len(line_ids), len(po.lines), link_id)
    rows = [
        {"company_id": po.company_id, "link_id": link_id, "vendor_purchase_order_line_id": line.line_id,
         "qb_line_id": str(qb_line_id), "qb_item_id": item_refs.get(line.line_id)}
        for line, qb_line_id in zip(po.lines, line_ids)
    ]
    if rows:
        db.table(LINE_LINKS).upsert(rows, on_conflict="link_id,vendor_purchase_order_line_id").execute()
    keep = [r["vendor_purchase_order_line_id"] for r in rows]
    stale = db.table(LINE_LINKS).delete().eq("link_id", link_id)
    if keep:
        stale = stale.not_.in_("vendor_purchase_order_line_id", keep)
    stale.execute()
    # Links whose Jigged line was removed (vendor_purchase_order_line_id cleared).
    db.table(LINE_LINKS).delete().eq("link_id", link_id).is_("vendor_purchase_order_line_id", "null").execute()


def _record(db: Client, provider, po: pom.PurchaseOrderProjection, link: dict, operation: str,
            pushed: PushedPurchaseOrder, *, item_refs: dict[str, str] | None, lines_sent: bool,
            access: dict | None, warnings: list[str], adopted: bool,
            attempt_content_version: int | None, qb_vendor_id: str | None) -> dict:
    """Flip the link to 'created' with everything QuickBooks answered.

    If this fails, the PO exists in QuickBooks while Jigged has no record of it: the link
    is left 'error'/'ambiguous' holding the ids, so the next push resumes (Online replays
    the same request id) or updates (Desktop), never creates a second one -- and a 500
    files the issue with the ids in its context."""
    url = provider.purchase_order_deep_link(pushed.id)
    if pushed.closed is not None:
        qb_closed = pushed.closed
    elif operation == "close":
        qb_closed = True
    elif operation == "reopen":
        qb_closed = False
    elif operation == "create":
        qb_closed = bool(po.closed and provider.name == "qbo")
    else:
        qb_closed = bool(link.get("qb_closed"))

    created_open = provider.name == "qbd" and operation == "create"
    as_pushed = pom.with_lines_open(po) if created_open else po
    attempt = attempt_content_version if attempt_content_version is not None else po.content_version
    exact = attempt == po.content_version
    stored_hash = pom.payload_hash(as_pushed, closed=qb_closed) if exact else None
    pushed_cv = attempt
    if created_open and exact and as_pushed != po:
        # Desktop creates every PO open. QuickBooks therefore holds an EARLIER state than
        # Jigged, which the out-of-date indicator must show until a second send closes it.
        pushed_cv = max(attempt - 1, 0)
        warnings = [*warnings, "QuickBooks Desktop creates every PO open. Send it to QuickBooks "
                               "again to close it there too."]

    # A header-only answer can leave the number out; what QuickBooks said before still holds.
    doc_number = pushed.doc_number or link.get("qb_doc_number")
    pushed = PushedPurchaseOrder(id=pushed.id, doc_number=doc_number, sync_token=pushed.sync_token,
                                 line_ids=pushed.line_ids, closed=pushed.closed)
    update = {
        "status": "created", "operation": operation, "last_failure": None,
        "qb_po_id": pushed.id, "qb_doc_number": pushed.doc_number,
        "qb_sync_token": pushed.sync_token, "qb_url": url, "qb_closed": qb_closed,
        "pushed_content_version": pushed_cv, "pushed_revision": po.revision,
        "pushed_payload_hash": stored_hash, "pushed_at": _now().isoformat(),
    }
    if qb_vendor_id:
        update["qb_vendor_id"] = qb_vendor_id
    if access:
        update["pushed_by"] = access.get("id")
    try:
        if lines_sent and item_refs is not None:
            _write_line_links(db, po, link["id"], pushed.line_ids, item_refs)
        db.table(LINKS).update(update).eq("id", link["id"]).execute()
    except Exception:  # noqa: BLE001 - captured below with the ids that make it actionable
        try:
            db.table(LINKS).update({
                "status": "error", "last_failure": "ambiguous", "qb_po_id": pushed.id,
                "qb_doc_number": pushed.doc_number, "qb_sync_token": pushed.sync_token, "qb_url": url,
            }).eq("id", link["id"]).execute()
        except Exception:  # noqa: BLE001
            pass
        sentry_sdk.set_context("quickbooks_purchase_order", {
            "qb_po_id": pushed.id, "link_id": link["id"], "vendor_purchase_order_id": po.vendor_po_id,
            "operation": operation,
        })
        # WARNING, not exception: the 500 below is what files the issue (see the invoice path).
        logger.warning("Purchase order %s reached QuickBooks but recording it failed (link %s)",
                       pushed.id, link["id"], exc_info=True)
        raise HTTPException(status_code=500, detail=RECORDING_FAILED)

    if pushed.doc_number and pushed.doc_number != po.po_number:
        warnings = [*warnings, f"QuickBooks numbered it {pushed.doc_number}; Jigged's number is "
                               f"{po.po_number}."]
    return {
        "operation": operation, "qb_po_id": pushed.id, "doc_number": pushed.doc_number, "url": url,
        "already_existed": adopted, "already_up_to_date": False, "warnings": warnings,
        "link_id": link["id"],
    }


def _already_up_to_date(db: Client, po: pom.PurchaseOrderProjection, link: dict) -> dict:
    """QuickBooks already holds exactly this: zero provider calls. The indicator is
    brought level, guarded by the claim columns so a sibling's attempt is not clobbered."""
    if link["status"] != "created" or link.get("pushed_content_version") != po.content_version:
        (
            db.table(LINKS)
            .update({"status": "created", "last_failure": None, "pushed_content_version": po.content_version})
            .eq("id", link["id"]).eq("status", link["status"]).eq("qb_request_id", link["qb_request_id"])
            .execute()
        )
    return {
        "operation": "none", "qb_po_id": link.get("qb_po_id"), "doc_number": link.get("qb_doc_number"),
        "url": link.get("qb_url"), "already_existed": True, "already_up_to_date": True,
        "warnings": [], "link_id": link["id"],
    }


# ───────────────────────── the probe (QuickBooks Desktop) ─────────────────────────
def _pushed_from_state(state: QbPurchaseOrderState) -> PushedPurchaseOrder:
    return PushedPurchaseOrder(id=state.id, doc_number=state.doc_number, sync_token=state.sync_token,
                               line_ids=state.line_ids, closed=state.closed)


def _probe(provider, po: pom.PurchaseOrderProjection, link: dict,
           payload: dict | None) -> tuple[str, PushedPurchaseOrder | None]:
    """ONE look at whether an unconfirmed Desktop write landed: adopt | release | park.

    A create is found by vendor, the one-day window and its externalId; not found means
    PARK, because a create can still land after its answer was lost. An update is judged
    by the token: unchanged means it did not land (release -- an update cannot duplicate
    anything); moved to exactly what was sent means adopt; anything else, park."""
    operation = link.get("operation") or "create"
    try:
        if operation == "create" or not link.get("qb_po_id"):
            found = provider.find_created_purchase_order(link)
            return ("adopt", found) if found else ("park", None)
        state = provider.read_purchase_order(str(link["qb_po_id"]))
        if payload is not None:
            sent_token = payload.get("revisionNumber")
            if "lines" not in payload:  # a header-only close or reopen
                if state is None:
                    return "park", None
                if str(state.sync_token) == str(sent_token):
                    return "release", None
                wanted_closed = operation == "close"
                return ("adopt", _pushed_from_state(state)) if state.closed == wanted_closed else ("park", None)
            expected = qbdp.expected_lines(payload)
        else:
            sent_token = link.get("qb_sync_token")
            exact = link.get("attempt_content_version") == po.content_version
            expected = qbdp.expected_lines_for(po) if exact else None
        decision = qbdp.decide_update_probe(state, sent_token=sent_token, expected_lines=expected)
        return decision, (_pushed_from_state(state) if decision == "adopt" and state else None)
    except Exception:  # noqa: BLE001 - a failed probe is not a failed purchase order
        logger.warning("QuickBooks Desktop probe failed for link %s", link.get("id"), exc_info=True)
        return "park", None


def _db_item_refs(db: Client, provider, po: pom.PurchaseOrderProjection, link: dict) -> dict[str, str]:
    """Best-effort item ids for an adopted attempt's line links (database only)."""
    known = {r["vendor_purchase_order_line_id"]: r["qb_item_id"] for r in _line_links(db, link["id"])
             if r.get("vendor_purchase_order_line_id") and r.get("qb_item_id")}
    item_refs, _ = _missing_items(po, _setup_rows(db, po.company_id, provider), known)
    return item_refs


def _adopt(db: Client, provider, po: pom.PurchaseOrderProjection, link: dict,
           pushed: PushedPurchaseOrder, *, item_refs: dict[str, str] | None, access: dict | None) -> dict:
    operation = link.get("operation") or "create"
    refs = item_refs if item_refs is not None else _db_item_refs(db, provider, po, link)
    lines_sent = bool(pushed.line_ids)
    return _record(db, provider, po, link, operation, pushed, item_refs=refs, lines_sent=lines_sent,
                   access=access, warnings=[], adopted=True,
                   attempt_content_version=link.get("attempt_content_version"),
                   qb_vendor_id=link.get("qb_vendor_id"))


# ───────────────────────── preparing a push (no writes to QuickBooks) ─────────────────────────
@dataclass
class _Prep:
    include_content: bool = True
    state: QbPurchaseOrderState | None = None
    item_refs: dict[str, str] = field(default_factory=dict)
    qb_line_ids: dict[str, str] = field(default_factory=dict)
    ap_account_id: str | None = None
    qb_vendor_id: str | None = None
    vendor_to_create: str | None = None


def _guard_quickbooks_state(po: pom.PurchaseOrderProjection, state: QbPurchaseOrderState,
                            links: list[dict], operation: str, provider) -> None:
    """Refuse -- with nothing written anywhere -- an update QuickBooks holds lines Jigged
    never sent to, or one that would remove or shrink a line received or billed there."""
    ours = {str(r["qb_line_id"]) for r in links}
    foreign = [lid for lid in state.line_ids if lid not in ours] + list(state.other_line_ids)
    if foreign:
        raise _refuse("qb_foreign_lines", po_number=po.po_number)
    if operation == "reopen" and provider.name == "qbd" and state.fully_received:
        raise _refuse("qb_cannot_reopen", po_number=po.po_number)
    current = {line.line_id: line for line in po.lines}
    by_qb_id = {line.id: (position, line) for position, line in enumerate(state.lines, start=1)}
    for link_row in links:
        found = by_qb_id.get(str(link_row["qb_line_id"]))
        if not found or not found[1].in_use:
            continue
        position, qb_line = found
        line = current.get(link_row.get("vendor_purchase_order_line_id") or "")
        received = pom.decimal_text(qb_line.received_quantity) or "0"
        if line is None:
            raise _refuse("qb_line_in_use", po_number=po.po_number, line_number=position, quantity=received)
        if qb_line.received_quantity > 0 and line.quantity < qb_line.received_quantity:
            raise _refuse("qb_line_in_use", po_number=po.po_number, line_number=line.line_number,
                          quantity=received)


def _vendor_before_claim(db: Client, provider, po: pom.PurchaseOrderProjection,
                         body: "PushBody", access: dict, prep: _Prep) -> None:
    """Mapped, an explicit choice, an exact match, or create -- and everything that can
    refuse, refuses here, before the link is claimed (so a choice the shop has to make
    never shows as a failed send)."""
    mapped = _vendor_map(db, po.company_id, po.vendor_id, provider.scope_id)
    if mapped:
        prep.qb_vendor_id = str(mapped["qb_vendor_id"])
        return
    name = _live_vendor_name(db, po)
    choice = body.vendor
    if choice and choice.action == "use_existing":
        if not choice.qb_vendor_id:
            raise HTTPException(status_code=400, detail="Choose the QuickBooks vendor to link.")
        _map_vendor(db, po.company_id, po.vendor_id, provider, choice.qb_vendor_id, None, access.get("id"))
        prep.qb_vendor_id = str(choice.qb_vendor_id)
        return
    problem = provider.vendor_name_problem(name)
    if choice is None or choice.action != "create":
        found = provider.find_vendor_candidates(name)
        if found.get("status") == "exact_match" and found.get("qb_vendor_id"):
            display = (found.get("candidates") or [{}])[0].get("display_name")
            _map_vendor(db, po.company_id, po.vendor_id, provider, found["qb_vendor_id"], display, access.get("id"))
            prep.qb_vendor_id = str(found["qb_vendor_id"])
            return
        if found.get("status") == "candidates":
            raise _refuse("qb_vendor_choice_required", extra={"candidates": found.get("candidates") or []},
                          name=name)
    if problem:
        raise _refuse("qb_vendor_name_invalid", name=name, problem=problem)
    prep.vendor_to_create = name


def _prepare(db: Client, provider, po: pom.PurchaseOrderProjection, link: dict | None,
             operation: str, body: "PushBody", access: dict) -> _Prep:
    prep = _Prep()
    links = _line_links(db, link["id"]) if link else []
    known_items = {r["vendor_purchase_order_line_id"]: str(r["qb_item_id"]) for r in links
                   if r.get("vendor_purchase_order_line_id") and r.get("qb_item_id")}
    prep.qb_line_ids = {r["vendor_purchase_order_line_id"]: str(r["qb_line_id"]) for r in links
                        if r.get("vendor_purchase_order_line_id")}

    if operation != "create":
        prep.include_content = operation == "update" or pom.content_changed(po, link)
        prep.qb_vendor_id = link.get("qb_vendor_id")
        state = provider.read_purchase_order(str(link["qb_po_id"]))  # THE one read
        if state is None:
            raise _refuse("qb_po_missing", po_number=po.po_number)
        _guard_quickbooks_state(po, state, links, operation, provider)
        prep.state = state
        # A line someone deleted inside QuickBooks is sent again as a new line: Jigged is the
        # record ("never edit a pushed PO in QuickBooks"), and an id QuickBooks no longer
        # has would only be rejected.
        held = set(state.line_ids)
        prep.qb_line_ids = {line: qb_id for line, qb_id in prep.qb_line_ids.items() if qb_id in held}

    if operation == "create" or prep.include_content:
        setup = _setup_rows(db, po.company_id, provider)
        prep.item_refs, missing = _missing_items(po, setup, known_items)
        if provider.name == "qbo":
            ap = setup.get(pom.AP_ACCOUNT_KEY)
            if ap and ap.get("qb_id"):
                prep.ap_account_id = str(ap["qb_id"])
            else:
                # A question with one answer is not asked (docs/modules/quickbooks-desktop.md).
                accounts = provider.list_ap_accounts()
                if len(accounts) == 1:
                    _save_setup_row(db, po.company_id, provider, pom.AP_ACCOUNT_KEY,
                                    qb_id=accounts[0]["id"], qb_name=accounts[0].get("full_name"),
                                    chosen_by=access.get("id"))
                    prep.ap_account_id = str(accounts[0]["id"])
                else:
                    missing.append(pom.AP_ACCOUNT_KEY)
        if missing:
            raise _refuse("qb_setup_required", extra={"missing": missing},
                          missing=pom.describe_missing(missing))

    if operation == "create":
        _vendor_before_claim(db, provider, po, body, access, prep)
    return prep


# ───────────────────────── the push ─────────────────────────
class VendorChoice(BaseModel):
    action: Literal["use_existing", "create"]
    qb_vendor_id: str | None = None


class PushBody(BaseModel):
    vendor: VendorChoice | None = None


def _execute(db: Client, provider, po: pom.PurchaseOrderProjection, link: dict, operation: str,
             request_id: str, prep: _Prep, access: dict, *, resume: bool) -> dict:
    sends_content = operation == "create" or prep.include_content
    warnings = _content_warnings(po, provider) if sends_content else []
    stage = "prepare"
    payload: dict | None = None
    qb_vendor_id = prep.qb_vendor_id
    try:
        if prep.vendor_to_create:
            stage = "vendor"
            qb_vendor_id = provider.create_vendor(prep.vendor_to_create, dict(po.vendor_address or {}),
                                                  request_id=qbp.vendor_request_id(request_id))
            _map_vendor(db, po.company_id, po.vendor_id, provider, qb_vendor_id, prep.vendor_to_create,
                        access.get("id"))
            stage = "prepare"
        if operation == "create" and qb_vendor_id:
            # Recorded before the write: the Desktop probe narrows on it.
            db.table(LINKS).update({"qb_vendor_id": qb_vendor_id}).eq("id", link["id"]).execute()
            link = {**link, "qb_vendor_id": qb_vendor_id}
        term_id = None
        ship_method_id = None
        if sends_content:
            term_id = provider.resolve_term_id(po.payment_terms) if po.payment_terms else None
            ship_method_id = provider.resolve_ship_method_id(po.ship_via) if po.ship_via else None
            if po.ship_via and not ship_method_id:
                warnings.append(f"Ship via “{po.ship_via}” isn't a shipping method in QuickBooks "
                                "Desktop, so it was left off. Add it in QuickBooks to have it print.")
        payload = provider.build_purchase_order_payload(
            po, vendor_ref=qb_vendor_id or "", item_refs=prep.item_refs,
            ap_account_id=prep.ap_account_id, term_id=term_id, ship_method_id=ship_method_id,
            request_id=request_id, operation=operation, existing=prep.state,
            qb_line_id_by_line=prep.qb_line_ids, include_content=prep.include_content,
            jigged_url=_po_url(po),
        )
        stage = "write"
        if operation == "create":
            pushed = provider.create_purchase_order(payload, request_id=request_id)
        else:
            pushed = provider.update_purchase_order(str(link["qb_po_id"]), payload, request_id=request_id)
    except Exception as exc:  # noqa: BLE001 - every branch below re-raises or answers
        unknown = isinstance(exc, qbd.QbdUnknownOutcome) or (
            stage == "write" and not provider.dedupes_replayed_creates
            and not isinstance(exc, (qbd.QbdApiError, qbd.QbdOffline, qbd.QbdNotConnected,
                                     qbd.QbdServiceUnavailable, HTTPException, pom.PurchasingRefusal))
        )
        if unknown and stage == "write":
            decision, found = _probe(provider, po, link, payload)
            if decision == "adopt" and found is not None:
                return _adopt(db, provider, po, link, found, item_refs=prep.item_refs, access=access)
            if decision == "release":
                _release(db, link, "rejected")
                raise _refuse("qbd_offline")
            raise _park(db, po, link)
        failure = "rejected"
        if provider.dedupes_replayed_creates and stage in ("vendor", "write") \
                and qbp.failure_kind(exc) == "ambiguous":
            failure = "ambiguous"
        _release(db, link, failure)
        if not isinstance(exc, (HTTPException, pom.PurchasingRefusal)):
            # WARNING, not exception: a 5xx below is captured once by the Starlette
            # integration; a 409 is the shop's to fix and belongs nowhere near Sentry.
            logger.warning("Vendor PO push failed (%s, %s)", operation, po.vendor_po_id, exc_info=True)
        if failure == "ambiguous":
            # It may have landed. Not "rejected": the next send resumes this same attempt
            # (same ?requestid=), which Intuit answers with whatever it did.
            raise HTTPException(status_code=502, detail={"code": "qbo_unreachable", "message": QBO_NO_ANSWER})
        raise _provider_error(exc, po)
    return _record(db, provider, po, link, operation, pushed, item_refs=prep.item_refs,
                   lines_sent="Line" in payload or "lines" in payload, access=access,
                   warnings=warnings, adopted=False,
                   attempt_content_version=link.get("attempt_content_version"),
                   qb_vendor_id=qb_vendor_id)


@router.post("/{company_id}/vendor-pos/{po_id}/push")
async def push_vendor_po(company_id: str, po_id: str, request: Request, body: PushBody | None = None):
    """Create, update, close or reopen the QuickBooks copy of one vendor PO.

    Body: {vendor?: {action: "use_existing"|"create", qb_vendor_id?}} -- only needed when
    preflight found similar vendor names. No request id: the server mints it.
    -> {operation, qb_po_id, doc_number, url, already_existed, already_up_to_date,
        warnings, link_id} or {in_progress: true}."""
    _, access = await company_auth.verify_office_write_access(request, company_id)
    db = company_auth.service_client()
    provider = _require_provider(db, company_id)
    po = _load_po(db, company_id, po_id)
    refusal = pom.push_refusal(po, provider=provider.name)
    if refusal:
        raise _refusal(refusal)
    body = body or PushBody()
    link = _load_link(db, company_id, po.vendor_po_id, provider.scope_id)

    if link and link["status"] == "needs_verification":
        raise _refuse("qbd_blocked_unverified", extra={"link_id": link["id"]}, po_number=po.po_number)
    if link and link["status"] == "pending" and _pending_is_fresh(link):
        return {"in_progress": True}

    resume = False
    if link and link["status"] == "pending":
        # The worker that claimed this died mid-flight.
        if not provider.dedupes_replayed_creates:
            decision, found = _probe(provider, po, link, None)
            if decision == "adopt" and found is not None:
                return _adopt(db, provider, po, link, found, item_refs=None, access=access)
            if decision == "park":
                raise _park(db, po, link)
            _release(db, link, "rejected")
            link = _load_link(db, company_id, po.vendor_po_id, provider.scope_id)
        else:
            resume = True
    elif (link and link["status"] == "error" and link.get("last_failure") == "ambiguous"
          and provider.dedupes_replayed_creates):
        resume = True

    if resume:
        # Same request id: Intuit answers with whatever the lost attempt produced.
        operation = link.get("operation") or "create"
        request_id = str(link["qb_request_id"])
    else:
        operation = pom.operation_for(po, link)
        if operation == "none":
            return _already_up_to_date(db, po, link)
        request_id = str(uuid4())

    try:
        prep = _prepare(db, provider, po, link, operation, body, access)
    except Exception as exc:  # noqa: BLE001
        raise _provider_error(exc, po)

    claimed = _claim(db, provider, po, link, operation, request_id, resume=resume)
    if claimed is None:
        return {"in_progress": True}
    return _execute(db, provider, po, claimed, operation, request_id, prep, access, resume=resume)


# ───────────────────────── preflight ─────────────────────────
@router.post("/{company_id}/vendor-pos/{po_id}/preflight")
async def preflight_vendor_po(company_id: str, po_id: str, request: Request):
    """What a push would do, run only when the dialog OPENS from its button.

    No read of the QuickBooks PO here (only the push's Update/Close does that); the one
    QuickBooks call is the vendor search on a first send, and a failure there degrades to
    "unmatched" rather than blocking the dialog."""
    _, access = await company_auth.verify_office_write_access(request, company_id)
    db = company_auth.service_client()
    provider = _provider_or_none(db, company_id)
    if provider is None:
        return {"connected": False}
    po = _load_po(db, company_id, po_id)
    link = _load_link(db, company_id, po.vendor_po_id, provider.scope_id)
    refusal = pom.push_refusal(po, provider=provider.name)
    operation = pom.operation_for(po, link)
    blocked = None
    if link and link["status"] == "needs_verification":
        blocked = {"code": "qbd_blocked_unverified", "link_id": link["id"],
                   "message": pom.po_error_message("qbd_blocked_unverified", po_number=po.po_number)}

    setup = _setup_rows(db, company_id, provider)
    links = _line_links(db, link["id"]) if link else []
    known_items = {r["vendor_purchase_order_line_id"]: str(r["qb_item_id"]) for r in links
                   if r.get("vendor_purchase_order_line_id") and r.get("qb_item_id")}
    _, setup_missing = _missing_items(po, setup, known_items)

    warnings = _content_warnings(po, provider)
    prefs = (setup.get(pom.QBO_PREFERENCES_KEY) or {}).get("details") or {}
    if provider.name == "qbo" and operation == "create" and prefs.get("custom_txn_numbers") is False:
        warnings.append("QuickBooks Online will number this PO itself, because custom transaction "
                        "numbers are off there. Jigged's number stays on the PDF.")

    vendor = None
    name = _live_vendor_name(db, po)
    if operation != "create":
        vendor = {"status": "mapped", "qb_vendor_id": link.get("qb_vendor_id") if link else None,
                  "candidates": []}
    elif refusal is None and blocked is None:
        mapped = _vendor_map(db, company_id, po.vendor_id, provider.scope_id)
        if mapped:
            vendor = {"status": "mapped", "qb_vendor_id": mapped["qb_vendor_id"], "candidates": []}
        else:
            try:
                vendor = provider.find_vendor_candidates(name)
            except Exception:  # noqa: BLE001 - not finding one is the ordinary first-send path
                logger.warning("QuickBooks vendor lookup failed for %r; offering to create", name,
                               exc_info=True)
                vendor = {"status": "unmatched", "qb_vendor_id": None, "candidates": []}
        if provider.name == "qbo" and not (setup.get(pom.AP_ACCOUNT_KEY) or {}).get("qb_id"):
            try:
                if len(provider.list_ap_accounts()) != 1:
                    setup_missing.append(pom.AP_ACCOUNT_KEY)
            except Exception:  # noqa: BLE001 - the push will say; the dialog must still open
                logger.warning("QuickBooks AP account lookup failed", exc_info=True)
    if vendor is not None:
        vendor = {**vendor, "jigged_vendor_id": po.vendor_id, "jigged_name": name,
                  "name_problem": provider.vendor_name_problem(name)}

    return {
        "connected": True,
        "provider": provider.name,
        # Desktop has no web app, so the dialog must not pre-open a tab.
        "has_deep_links": provider.name == "qbo",
        "operation": operation,
        "blocked": blocked,
        "refusal": refusal.detail() if refusal else None,
        "setup_missing": setup_missing,
        "vendor": vendor,
        "link": _link_summary(link, po),
        "warnings": warnings,
    }


# ───────────────────────── verify ─────────────────────────
@router.post("/{company_id}/vendor-po-links/{link_id}/verify")
async def verify_vendor_po_link(company_id: str, link_id: str, request: Request):
    """Settle an attempt whose outcome nobody could confirm: adopt it or release it.

    The ONLY way a needs_verification link moves -- a human action, never a retry, because
    a Desktop create that timed out was measured to land anyway. Idempotent.
    -> {outcome: adopted|released|in_progress, qb_po_id?, doc_number?, url?}"""
    _, access = await company_auth.verify_office_write_access(request, company_id)
    db = company_auth.service_client()
    provider = _require_provider(db, company_id)
    rows = db.table(LINKS).select("*").eq("company_id", company_id).eq("id", link_id).limit(1).execute().data
    if not rows:
        raise HTTPException(status_code=404, detail="That QuickBooks attempt isn't in this company.")
    link = rows[0]
    if link["realm_id"] != provider.scope_id:
        raise _refuse("qb_not_connected")
    if link["status"] == "created":
        return {"outcome": "adopted", "qb_po_id": link.get("qb_po_id"),
                "doc_number": link.get("qb_doc_number"), "url": link.get("qb_url")}
    if link["status"] == "pending" and _pending_is_fresh(link):
        return {"outcome": "in_progress"}
    if link["status"] == "error" or provider.dedupes_replayed_creates:
        # Nothing to settle: a push resumes or re-sends safely from here.
        return {"outcome": "released"}

    po = _load_po(db, company_id, link["vendor_purchase_order_id"])
    decision, found = _probe(provider, po, link, None)
    if decision == "adopt" and found is not None:
        result = _adopt(db, provider, po, link, found, item_refs=None, access=access)
        return {"outcome": "adopted", "qb_po_id": result["qb_po_id"], "doc_number": result["doc_number"],
                "url": result["url"]}
    # A person asked and QuickBooks does not hold what was sent: let the next push try.
    _release(db, link, "rejected")
    return {"outcome": "released"}


# ───────────────────────── purchasing setup (Settings → QuickBooks) ─────────────────────────
def _item_view(kind: str, row: dict) -> dict:
    return {
        "line_kind": kind, "setup_key": row["setup_key"], "qb_id": row.get("qb_id"),
        "qb_name": row.get("qb_name"), "posting_account_id": row.get("posting_account_id"),
        "posting_account_name": row.get("posting_account_name"),
        "created_in_quickbooks": bool(row.get("created_in_quickbooks")),
    }


def _setup_view(provider, rows: dict[str, dict]) -> dict:
    items = [_item_view(kind, rows[key]) for kind, key in pom.ITEM_SETUP_KEYS.items() if rows.get(key)]
    ids = {i["qb_id"] for i in items}
    ap = rows.get(pom.AP_ACCOUNT_KEY)
    prefs = rows.get(pom.QBO_PREFERENCES_KEY)
    missing = [key for key in pom.ITEM_SETUP_KEYS.values() if not rows.get(key)]
    if provider.name == "qbo" and not ap:
        missing.append(pom.AP_ACCOUNT_KEY)
    return {
        "connected": True,
        "provider": provider.name,
        "items": items,
        # The default: one general purchases item filling all three line kinds.
        "one_item_for_all": len(items) == len(pom.ITEM_SETUP_KEYS) and len(ids) == 1,
        "ap_account": {"qb_id": ap.get("qb_id"), "qb_name": ap.get("qb_name")} if ap else None,
        "preferences": dict(prefs.get("details") or {}) if prefs else None,
        "missing": missing,
    }


@router.get("/{company_id}/purchasing/setup")
async def purchasing_setup(company_id: str, request: Request):
    """Database only -- safe on mount; never calls QuickBooks."""
    await company_auth.verify_office_access(request, company_id)
    db = company_auth.service_client()
    provider = _provider_or_none(db, company_id)
    if provider is None:
        return {"connected": False, "provider": None, "items": [], "one_item_for_all": False,
                "ap_account": None, "preferences": None, "missing": []}
    return _setup_view(provider, _setup_rows(db, company_id, provider))


@router.get("/{company_id}/purchasing/accounts")
async def purchasing_accounts(company_id: str, request: Request):
    """Admin, on click: the accounts a purchase item may post to, and (Online) the
    accounts-payable accounts."""
    await _admin_writer(request, company_id)
    db = company_auth.service_client()
    provider = _require_provider(db, company_id)
    try:
        return {"accounts": provider.list_purchase_accounts(), "ap_accounts": provider.list_ap_accounts()}
    except Exception as exc:  # noqa: BLE001
        raise _provider_error(exc)


@router.get("/{company_id}/purchasing/items")
async def purchasing_items(company_id: str, request: Request):
    """Admin, on click: the items a purchase may post under, each marked eligible when it
    posts to an expense, cost-of-goods-sold or other-expense account. The invoice item is
    never offered."""
    await _admin_writer(request, company_id)
    db = company_auth.service_client()
    provider = _require_provider(db, company_id)
    try:
        accounts = provider.list_purchase_accounts()
        account_ids = {a["id"] for a in accounts}
        items = [
            {**item, "eligible": item.get("posting_account_id") in account_ids}
            for item in provider.list_purchase_items()
            if not pom.is_invoice_item(item, invoice_item_ids=provider.invoice_item_ids)
        ]
    except Exception as exc:  # noqa: BLE001
        raise _provider_error(exc)
    return {"items": items, "accounts": accounts}


class PurchaseItemChoice(BaseModel):
    action: Literal["use_existing", "create"]
    qb_item_id: str | None = None
    qb_account_id: str | None = None
    name: str | None = None


class PurchaseItemsBody(BaseModel):
    #: One item for every line kind -- the default the panel offers.
    all_kinds: PurchaseItemChoice | None = None
    #: Or one per kind, for a shop that splits material, outside work and the rest.
    by_kind: dict[Literal["part", "outside_service", "other"], PurchaseItemChoice] | None = None


def _resolve_item_choice(provider, choice: PurchaseItemChoice, *, kind: str | None,
                         accounts: dict[str, dict], listed: list[dict] | None) -> dict:
    if choice.action == "use_existing":
        if not choice.qb_item_id:
            raise HTTPException(status_code=400, detail="Choose the QuickBooks item to use.")
        item = next((i for i in (listed or []) if str(i["id"]) == str(choice.qb_item_id)), None)
        if item is None:
            raise HTTPException(status_code=400, detail=(
                "That item isn't a non-inventory or service item in QuickBooks any more. "
                "Choose another, or create one."))
        if pom.is_invoice_item(item, invoice_item_ids=provider.invoice_item_ids):
            raise HTTPException(status_code=400, detail=(
                "That's the item Jigged's invoices post to, so purchases can't use it. Choose "
                "another item, or create one."))
        if item.get("posting_account_id") not in accounts:
            raise HTTPException(status_code=400, detail=(
                f"“{item.get('name')}” posts to {item.get('posting_account_name') or 'an account'}, "
                "which isn't an expense, cost-of-goods-sold or other-expense account. Choose "
                "another item, or create one."))
        return {**item, "created": False}
    account_id = choice.qb_account_id
    if not account_id or account_id not in accounts:
        raise HTTPException(status_code=400, detail=(
            "Choose an expense, cost-of-goods-sold or other-expense account for the new item."))
    name = (choice.name or (pom.PURCHASE_ITEM_NAME_BY_KIND[kind] if kind else pom.DEFAULT_PURCHASE_ITEM_NAME)).strip()
    if pom.is_invoice_item({"name": name}, invoice_item_ids=()):
        raise HTTPException(status_code=400, detail=(
            f"“{name}” is the item Jigged's invoices post to. Choose another name."))
    return provider.create_purchase_item(name, account_id, request_id=str(uuid4()))


@router.post("/{company_id}/purchasing/items")
async def set_purchase_items(company_id: str, request: Request, body: PurchaseItemsBody):
    """Admin: the QuickBooks item each line kind posts under. Either ONE item for all
    three kinds (the default) or a per-kind mapping. Every item is verified by its posting
    account; the invoice item is refused."""
    _, access = await _admin_writer(request, company_id)
    if (body.all_kinds is None) == (not body.by_kind):
        raise HTTPException(status_code=400, detail="Send either one item for all kinds or one per kind.")
    db = company_auth.service_client()
    provider = _require_provider(db, company_id)
    choices: dict[str, PurchaseItemChoice] = (
        {kind: body.all_kinds for kind in pom.LINE_KINDS} if body.all_kinds is not None else dict(body.by_kind)
    )
    try:
        accounts = {a["id"]: a for a in provider.list_purchase_accounts()}
        listed = (provider.list_purchase_items()
                  if any(c.action == "use_existing" for c in choices.values()) else None)
        resolved: dict[str, dict] = {}
        cache: dict[tuple, dict] = {}
        for kind, choice in choices.items():
            key = (choice.action, choice.qb_item_id, choice.qb_account_id, choice.name,
                   None if body.all_kinds is not None else kind)
            if key not in cache:
                cache[key] = _resolve_item_choice(provider, choice,
                                                  kind=None if body.all_kinds is not None else kind,
                                                  accounts=accounts, listed=listed)
            resolved[kind] = cache[key]
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        raise _provider_error(exc)

    for kind, item in resolved.items():
        _save_setup_row(
            db, company_id, provider, pom.ITEM_SETUP_KEYS[kind], chosen_by=access.get("id"),
            qb_id=str(item["id"]), qb_name=item.get("name"),
            posting_account_id=item.get("posting_account_id"),
            posting_account_name=item.get("posting_account_name"),
            details={"type": item.get("type")}, created_in_quickbooks=bool(item.get("created")),
        )
    view = _setup_view(provider, _setup_rows(db, company_id, provider))
    return {"saved": True, "items": view["items"], "one_item_for_all": view["one_item_for_all"]}


class ApAccountBody(BaseModel):
    qb_account_id: str


@router.post("/{company_id}/purchasing/ap-account")
async def set_ap_account(company_id: str, request: Request, body: ApAccountBody):
    """Admin, QuickBooks Online only: the accounts-payable account POs carry. Chosen here
    only when the company has more than one; with exactly one, the push uses it."""
    _, access = await _admin_writer(request, company_id)
    db = company_auth.service_client()
    provider = _require_provider(db, company_id)
    if provider.name != "qbo":
        raise HTTPException(status_code=400, detail=(
            "QuickBooks Desktop purchase orders don't use an accounts-payable account."))
    try:
        accounts = provider.list_ap_accounts()
    except Exception as exc:  # noqa: BLE001
        raise _provider_error(exc)
    account = next((a for a in accounts if str(a["id"]) == str(body.qb_account_id)), None)
    if account is None:
        raise HTTPException(status_code=400, detail="That isn't an accounts-payable account in QuickBooks.")
    _save_setup_row(db, company_id, provider, pom.AP_ACCOUNT_KEY, chosen_by=access.get("id"),
                    qb_id=str(account["id"]), qb_name=account.get("full_name"))
    return {"saved": True, "ap_account": {"qb_id": str(account["id"]), "qb_name": account.get("full_name")}}


@router.post("/{company_id}/purchasing/check-preferences")
async def check_preferences(company_id: str, request: Request):
    """Admin "Check QuickBooks": are purchase orders on, and does QuickBooks keep Jigged's
    numbers? Stored for QuickBooks Online (setup_key qbo_preferences); Desktop always takes
    Jigged's number, so its answer is returned but has nothing to store."""
    _, access = await _admin_writer(request, company_id)
    db = company_auth.service_client()
    provider = _require_provider(db, company_id)
    try:
        prefs = provider.check_purchasing_preferences()
    except Exception as exc:  # noqa: BLE001
        raise _provider_error(exc)
    details = {"purchase_orders_enabled": prefs.get("purchase_orders_enabled"),
               "custom_txn_numbers": prefs.get("custom_txn_numbers"),
               "checked_at": _now().isoformat()}
    if provider.name == "qbo":
        _save_setup_row(db, company_id, provider, pom.QBO_PREFERENCES_KEY, chosen_by=access.get("id"),
                        details=details)
    warnings: list[str] = []
    if details["purchase_orders_enabled"] is False:
        warnings.append(pom.po_error_message("qbo_purchase_orders_unavailable")
                        if provider.name == "qbo" else QBD_PURCHASE_ORDERS_OFF)
    elif details["purchase_orders_enabled"] is None:
        warnings.append(PREFERENCE_UNKNOWN)
    if details["custom_txn_numbers"] is False:
        warnings.append(CUSTOM_NUMBERS_OFF)
    return {"provider": provider.name, **details, "warnings": warnings}
