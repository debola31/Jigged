"""QuickBooks Desktop (via Conductor): the provider primitives for a VENDOR purchase order.

Reuses services/quickbooks_desktop.py's HTTP layer -- `_request`, no retry layer, the
20s/30s timeouts under Vercel's 60s cap, and its error vocabulary -- and adds only what a
purchase order needs. That module's own docstring explains the measured behaviours this
inherits; the two that matter most here:

  * NO IDEMPOTENCY KEY. A write that times out may still land (a create aborted at 1s
    produced an invoice). So QbdUnknownOutcome is never retried: the route probes once
    with find_created_purchase_order and then adopts or parks.
  * LOOKUP FILTERS FAIL ON A MISS. `ids` and `refNumbers` (and `names`/`fullNames`) fail
    the WHOLE request when any value is absent, so searches here use nameContains and the
    probe lists by vendor plus a one-day date window, matching client-side.

Conductor facts used (docs.conductor.is, purchase-orders create/update/list):
  * refNumber holds 11 characters; vendorMessage 99 (prints); memo 4095 (does not);
    address lines 41, city 31, state 21, postalCode 13, country 31.
  * externalId must be a GUID and is immutable after create.
  * `rate` is ignored when `amount` is sent, so `amount` is never sent.
  * Update needs the current revisionNumber; sending `lines` REPLACES them all (existing
    ids kept, "-1" for a new line); isManuallyClosed exists on update only, header and
    line, and cannot go back to false once received in full.

UNVERIFIED until manual check M-2 on a sample company file: the stale-revision error
code (3200 in the qbXML SDK), the "not found" shape of a deleted PO, which line edits a
received line refuses, and whether vendorMessage prints while memo does not.
"""
from __future__ import annotations

import logging
import re
from decimal import Decimal
from typing import Any

import services.quickbooks_desktop as qbd
from services.accounting import purchase_order as pom
from services.accounting import purchasing_fake as fake
from services.accounting.base import (
    PushedPurchaseOrder,
    QbPurchaseOrderLine,
    QbPurchaseOrderState,
)

logger = logging.getLogger(__name__)

PURCHASE_ORDERS_PATH = "/purchase-orders"
PURCHASE_ACCOUNT_TYPES = ("expense", "cost_of_goods_sold", "other_expense")
ITEM_LISTS = (("/non-inventory-items", "non_inventory"), ("/service-items", "service"))
ITEM_DESCRIPTION = "Purchases sent from Jigged"
# Cursor pages Conductor will hand back for one list. Item lists are the only ones
# paged here; four pages of 150 is far beyond a machine shop's purchase items.
MAX_PAGES = 4

_ADDRESS_CAPS = {"city": 31, "state": 21, "postalCode": 13, "country": 31}
_LINE_CAP = 41
_DUPLICATE = re.compile(r"already|duplicate|in use", re.IGNORECASE)
_STALE = re.compile(r"out-of-date|edit sequence|revision number", re.IGNORECASE)
_NOT_FOUND = re.compile(r"could not be found|cannot be found|not found|does not exist", re.IGNORECASE)
_INVALID_REFERENCE = re.compile(r"invalid reference", re.IGNORECASE)


def is_fake() -> bool:
    return qbd._is_fake()


# ───────────────────────── errors ─────────────────────────
def classify_qbd_error(exc: Any) -> str | None:
    """The shop-fixable 409 code for a Desktop rejection, or None (-> 502).
    UNVERIFIED codes from the qbXML SDK: 3200 stale edit sequence, 3140 invalid
    reference. M-2 records Conductor's real envelopes."""
    if not isinstance(exc, qbd.QbdApiError):
        return None
    code = str(exc.integration_code or "")
    text = str(exc)
    if code == "3200" or _STALE.search(text):
        return "qb_changed_in_quickbooks"
    if code == "3140" or _INVALID_REFERENCE.search(text):
        return "qb_reference_inactive"
    return None


def is_not_found(exc: Any) -> bool:
    """A read of a PO that is no longer in the company file."""
    if not isinstance(exc, qbd.QbdApiError):
        return False
    return str(exc.integration_code or "") in ("500", "3120") or bool(_NOT_FOUND.search(str(exc)))


# ───────────────────────── addresses ─────────────────────────
def _cap(value: str, limit: int) -> str:
    return value[:limit]


def address(addr: dict | None) -> dict | None:
    """A vendor's AddressSnapshot as a Desktop address, cut to QuickBooks' caps. Cut
    rather than refused: an address is a label, unlike a vendor name (an identity)."""
    parts = pom.address_parts(addr)
    out: dict = {}
    for i, key in enumerate(("address_line1", "address_line2"), start=1):
        if parts.get(key):
            out[f"line{i}"] = _cap(parts[key], _LINE_CAP)
    for src, dest in (("city", "city"), ("state", "state"), ("postal_code", "postalCode"),
                      ("country", "country")):
        if parts.get(src):
            out[dest] = _cap(parts[src], _ADDRESS_CAPS[dest])
    return out or None


def _ship_to_lines(name: str | None, addr: dict | None) -> list[str]:
    parts = pom.address_parts(addr)
    lines = [
        (name or "").strip(),
        f"Attn: {parts['attention_to']}" if parts.get("attention_to") else "",
        parts.get("address_line1", ""),
        parts.get("address_line2", ""),
    ]
    return [ln for ln in lines if ln][:5]


def shipping_address(name: str | None, addr: dict | None) -> dict | None:
    """The frozen ship-to: name, attention, then the street, five lines of 41 at most."""
    parts = pom.address_parts(addr)
    out: dict = {f"line{i}": _cap(ln, _LINE_CAP)
                 for i, ln in enumerate(_ship_to_lines(name, addr), start=1)}
    for src, dest in (("city", "city"), ("state", "state"), ("postal_code", "postalCode"),
                      ("country", "country")):
        if parts.get(src):
            out[dest] = _cap(parts[src], _ADDRESS_CAPS[dest])
    return out or None


def ship_to_was_cut(po: pom.PurchaseOrderProjection) -> bool:
    """True when the ship-to had to be shortened for Desktop -- worth a warning, since
    the PDF the vendor holds has it in full."""
    parts = pom.address_parts(po.ship_to_address)
    if any(len(ln) > _LINE_CAP for ln in _ship_to_lines(po.ship_to_name, po.ship_to_address)):
        return True
    for src, dest in (("city", "city"), ("state", "state"), ("postal_code", "postalCode"),
                      ("country", "country")):
        if len(parts.get(src, "")) > _ADDRESS_CAPS[dest]:
            return True
    return False


# ───────────────────────── vendors ─────────────────────────
def vendor_name_problem(name: str | None) -> str | None:
    return pom.vendor_name_problem(name, max_length=pom.QBD_VENDOR_NAME_MAX)


def _vendors_named(end_user_id: str, name: str, *, status: str) -> list[dict]:
    """nameContains, never `names`: a name filter fails the whole request on a miss."""
    wanted = (name or "").strip()
    if not wanted:
        return []
    return qbd._list("/vendors", end_user_id, {"nameContains": wanted, "status": status, "limit": 10})


def _exact(rows: list[dict], name: str) -> dict | None:
    wanted = (name or "").strip().casefold()
    for row in rows:
        for candidate in (row.get("name"), row.get("fullName")):
            if (candidate or "").strip().casefold() == wanted:
                return row
    return None


def _vendor_summary(v: dict) -> dict:
    return {"qb_id": str(v["id"]), "display_name": v.get("name") or v.get("fullName")}


def find_vendor_candidates(end_user_id: str, name: str) -> dict:
    if is_fake():
        return fake.fake_vendor_candidates()
    rows = _vendors_named(end_user_id, name, status="active")
    exact = _exact(rows, name)
    if exact:
        return {"status": "exact_match", "qb_vendor_id": str(exact["id"]),
                "candidates": [_vendor_summary(exact)]}
    if rows:
        return {"status": "candidates", "qb_vendor_id": None,
                "candidates": [_vendor_summary(v) for v in rows]}
    return {"status": "unmatched", "qb_vendor_id": None, "candidates": []}


def _resolve_existing_vendor(end_user_id: str, name: str) -> str:
    """After "already in use": the vendor of that name, if it is one; a refusal
    naming why, if not. Inactive vendors are included so the two cases separate."""
    found = _exact(_vendors_named(end_user_id, name, status="all"), name)
    if found is None:
        raise pom.PurchasingRefusal("qb_vendor_name_taken", name=name)
    if found.get("isActive") is False:
        raise pom.PurchasingRefusal("qb_vendor_inactive", name=name)
    return str(found["id"])


def create_vendor(end_user_id: str, display_name: str, addr: dict | None) -> str:
    """A name over 41 characters, or with a colon, tab or line break, is REFUSED before
    any call (never truncated). A create that times out is settled by name: QuickBooks
    names are unique, so a second create cannot make a duplicate vendor -- but when the
    lookup misses, the shop retries rather than Jigged retrying blind."""
    name = (display_name or "").strip()
    problem = vendor_name_problem(name)
    if problem:
        raise pom.PurchasingRefusal("qb_vendor_name_invalid", name=name, problem=problem)
    if is_fake():
        return fake.fake_id("VENDOR", name.casefold())
    body: dict = {"name": name, "companyName": name}
    billing = address(addr)
    if billing:
        body["billingAddress"] = billing
    try:
        created = qbd._request("POST", "/vendors", end_user_id=end_user_id, json_body=body,
                               is_write=True, noun="vendor")
        return str(created["id"])
    except qbd.QbdUnknownOutcome:
        found = _exact(_vendors_named(end_user_id, name, status="all"), name)
        if found is not None and found.get("isActive") is not False:
            return str(found["id"])
        raise pom.PurchasingRefusal("qbd_offline")
    except qbd.QbdApiError as exc:
        if exc.integration_code == "3100" or _DUPLICATE.search(str(exc)):
            return _resolve_existing_vendor(end_user_id, name)
        raise


# ───────────────────────── accounts and items ─────────────────────────
def list_purchase_accounts(end_user_id: str) -> list[dict]:
    """Expense, cost-of-goods-sold and other-expense accounts. Conductor's accounts list
    takes one accountType per call, so this is three calls."""
    if is_fake():
        return [dict(a) for a in fake.FAKE_PURCHASE_ACCOUNTS]
    out: list[dict] = []
    for account_type in PURCHASE_ACCOUNT_TYPES:
        for a in qbd._list("/accounts", end_user_id,
                           {"accountType": account_type, "status": "active", "limit": 150}):
            out.append({"id": str(a["id"]), "full_name": a.get("fullName") or a.get("name"),
                        "type": account_type})
    return out


def list_ap_accounts(end_user_id: str) -> list[dict]:
    """Desktop purchase orders carry no accounts-payable account."""
    return []


def _list_all(path: str, end_user_id: str, params: dict) -> list[dict]:
    """Follow Conductor's cursor (it must be used within 10 seconds, which a loop does)."""
    rows: list[dict] = []
    cursor: str | None = None
    for _ in range(MAX_PAGES):
        page_params = dict(params)
        if cursor:
            page_params["cursor"] = cursor
        body = qbd._request("GET", path, end_user_id=end_user_id, params=page_params) or {}
        rows.extend(body.get("data") or [])
        cursor = body.get("nextCursor")
        if not body.get("hasMore") or not cursor:
            break
    return rows


def _posting_account(item: dict) -> dict:
    one_way = (item.get("salesOrPurchaseDetails") or {}).get("postingAccount")
    two_way = (item.get("salesAndPurchaseDetails") or {}).get("expenseAccount")
    return one_way or two_way or {}


def _item_summary(item: dict, item_type: str) -> dict:
    account = _posting_account(item)
    return {
        "id": str(item["id"]),
        "name": item.get("fullName") or item.get("name"),
        "type": item_type,
        "posting_account_id": str(account["id"]) if account.get("id") is not None else None,
        "posting_account_name": account.get("fullName") or account.get("name"),
    }


def list_purchase_items(end_user_id: str) -> list[dict]:
    """Non-inventory and service items with somewhere to post a purchase: a one-way
    item's posting account, or a two-way item's expense account."""
    if is_fake():
        return [dict(i) for i in fake.FAKE_PURCHASE_ITEMS]
    out: list[dict] = []
    for path, item_type in ITEM_LISTS:
        for item in _list_all(path, end_user_id, {"status": "active", "limit": 150}):
            summary = _item_summary(item, item_type)
            if summary["posting_account_id"]:
                out.append(summary)
    return out


def _items_named(end_user_id: str, name: str) -> list[tuple[dict, str]]:
    """Item names are unique across EVERY item type, so both lists are searched."""
    found: list[tuple[dict, str]] = []
    for path, item_type in ITEM_LISTS:
        rows = qbd._list(path, end_user_id, {"nameContains": name, "status": "all", "limit": 10})
        exact = _exact(rows, name)
        if exact is not None:
            found.append((exact, item_type))
    return found


def _reuse_or_refuse(item: dict, item_type: str, name: str, account_id: str) -> dict:
    summary = _item_summary(item, item_type)
    if item.get("isActive") is not False and summary["posting_account_id"] == str(account_id):
        return {**summary, "created": False}
    raise pom.PurchasingRefusal("qb_item_name_taken", name=name,
                                account=summary["posting_account_name"] or "another account")


def create_purchase_item(end_user_id: str, name: str, account_id: str) -> dict:
    """A ONE-WAY non-inventory item (salesOrPurchaseDetails.postingAccountId) -- or a
    same-named item, only when it already posts to `account_id`. The invoice path's
    resolve_default_item checks its income account the same way since 2026-11-12."""
    clean = (name or "").strip()
    if not clean or len(clean) > pom.QBD_ITEM_NAME_MAX or ":" in clean:
        raise ValueError(
            f"QuickBooks Desktop item names must be 1 to {pom.QBD_ITEM_NAME_MAX} characters, "
            "without a colon."
        )
    if is_fake():
        return fake.fake_item(clean, account_id)
    existing = _items_named(end_user_id, clean)
    if existing:
        return _reuse_or_refuse(existing[0][0], existing[0][1], clean, account_id)
    body = {"name": clean,
            "salesOrPurchaseDetails": {"description": ITEM_DESCRIPTION, "postingAccountId": str(account_id)}}
    try:
        created = qbd._request("POST", "/non-inventory-items", end_user_id=end_user_id,
                               json_body=body, is_write=True, noun="item")
    except qbd.QbdApiError as exc:
        if exc.integration_code != "3100" and not _DUPLICATE.search(str(exc)):
            raise
        raced = _items_named(end_user_id, clean)
        if not raced:
            raise
        return _reuse_or_refuse(raced[0][0], raced[0][1], clean, account_id)
    return {**_item_summary(created, "non_inventory"), "created": True}


def check_purchasing_preferences(end_user_id: str) -> dict:
    """Purchase orders exist on Desktop only while "Inventory and purchase orders are
    active" is on (purchasesAndVendors.isUsingInventory). Desktop always takes Jigged's
    refNumber, so custom numbering is not a question here."""
    if is_fake():
        return {"purchase_orders_enabled": True, "custom_txn_numbers": True}
    prefs = qbd._request("GET", "/preferences", end_user_id=end_user_id) or {}
    using = (prefs.get("purchasesAndVendors") or {}).get("isUsingInventory")
    return {"purchase_orders_enabled": using if isinstance(using, bool) else None,
            "custom_txn_numbers": True}


def resolve_ship_method_id(end_user_id: str, name: str | None) -> str | None:
    """Match an existing shipping method by name. NEVER creates one: a mistyped "ship
    via" would otherwise become a permanent list entry in the shop's company file.
    Best-effort -- None, and the push warns that it was left off."""
    wanted = (name or "").strip()
    if not wanted:
        return None
    if is_fake():
        return fake.fake_id("SHIP", wanted.casefold())
    try:
        rows = qbd._list("/shipping-methods", end_user_id, {"nameContains": wanted})
    except Exception:  # noqa: BLE001 - best-effort by contract, like resolve_term_id
        logger.warning("QuickBooks Desktop ship-method lookup failed for %r", wanted, exc_info=True)
        return None
    for row in rows:
        if (row.get("name") or "").strip().casefold() == wanted.casefold():
            return str(row["id"])
    return None


# ───────────────────────── the purchase order ─────────────────────────
def _lines(po: pom.PurchaseOrderProjection, item_refs: dict[str, str],
           existing: QbPurchaseOrderState | None,
           qb_line_id_by_line: dict[str, str] | None) -> list[dict]:
    by_qb_id = {ln.id: ln for ln in (existing.lines if existing else ())}
    out: list[dict] = []
    for line in po.lines:
        if line.unit_price is None:
            raise ValueError(f"Line {line.line_number} of {po.po_number} has no price.")
        item = item_refs.get(line.line_id)
        if not item:
            raise ValueError(f"Line {line.line_number} of {po.po_number} has no QuickBooks item.")
        entry: dict = {}
        if existing is not None:
            entry["id"] = (qb_line_id_by_line or {}).get(line.line_id) or "-1"
        entry.update({
            "itemId": str(item),
            "description": pom.describe_line(line, max_length=pom.QBD_DESCRIPTION_MAX),
            "quantity": pom.json_number(line.quantity),
            # A rate string, NEVER amount: Conductor ignores rate when amount is present.
            "rate": pom.rate_string(line.unit_price),
        })
        if existing is not None:
            qb_line = by_qb_id.get(entry["id"])
            if line.closed:
                entry["isManuallyClosed"] = True
            elif qb_line is not None and qb_line.closed and not qb_line.fully_received:
                # Reopened in Jigged; QuickBooks refuses false once fully received.
                entry["isManuallyClosed"] = False
        out.append(entry)
    return out


def _content(po: pom.PurchaseOrderProjection, *, term_id: str | None,
             ship_method_id: str | None, jigged_url: str | None) -> dict:
    body: dict = {"memo": pom.private_note(po, jigged_url)[: pom.QBD_MEMO_MAX]}
    if po.notes_to_vendor:
        body["vendorMessage"] = pom.cut_with_ellipsis(po.notes_to_vendor, pom.QBD_VENDOR_MESSAGE_MAX)[0]
    if po.need_by_on:
        body["expectedDate"] = po.need_by_on
    if term_id:
        body["termsId"] = str(term_id)
    if ship_method_id:
        body["shippingMethodId"] = str(ship_method_id)
    ship_to = shipping_address(po.ship_to_name, po.ship_to_address)
    if ship_to:
        body["shippingAddress"] = ship_to
    return body


def purchase_order_payload(
    po: pom.PurchaseOrderProjection,
    *,
    vendor_ref: str,
    item_refs: dict[str, str],
    ap_account_id: str | None,
    term_id: str | None,
    ship_method_id: str | None,
    request_id: str,
    operation: str = "create",
    existing: QbPurchaseOrderState | None = None,
    qb_line_id_by_line: dict[str, str] | None = None,
    include_content: bool = True,
    jigged_url: str | None = None,
) -> dict:
    """PURE: the Conductor purchase-order body for one push.

    Jigged sends its own number as refNumber -- the opposite of invoices, which
    QuickBooks numbers (docs/modules/quickbooks-desktop.md). `ap_account_id` is accepted
    for parity and ignored: Desktop POs take none. On create `request_id` is the
    externalId; on an update it is not sent, because externalId is immutable."""
    if operation == "create":
        body: dict = {"vendorId": str(vendor_ref), "transactionDate": po.ordered_on,
                      "refNumber": po.po_number, "externalId": str(request_id)}
        body.update(_content(po, term_id=term_id, ship_method_id=ship_method_id,
                             jigged_url=jigged_url))
        body["lines"] = _lines(po, item_refs, None, None)
        return body

    if existing is None:
        raise ValueError("An update needs the QuickBooks purchase order read in this same push.")
    body = {"revisionNumber": existing.sync_token}
    if include_content:
        body["refNumber"] = po.po_number
        body["transactionDate"] = po.ordered_on
        body.update(_content(po, term_id=term_id, ship_method_id=ship_method_id,
                             jigged_url=jigged_url))
        body["lines"] = _lines(po, item_refs, existing, qb_line_id_by_line)
    if operation in ("close", "reopen"):
        body["isManuallyClosed"] = operation == "close"
    return body


def _pushed(po: dict) -> PushedPurchaseOrder:
    closed = po.get("isManuallyClosed")
    return PushedPurchaseOrder(
        id=str(po["id"]),
        doc_number=po.get("refNumber"),
        sync_token=po.get("revisionNumber"),
        line_ids=tuple(str(ln["id"]) for ln in (po.get("lines") or []) if ln.get("id")),
        closed=closed if isinstance(closed, bool) else None,
    )


def create_purchase_order(end_user_id: str, payload: dict, *, request_id: str) -> PushedPurchaseOrder:
    """May raise QbdUnknownOutcome, which the route must NOT treat as a failure."""
    if is_fake():
        return fake.fake_created(request_id=str(request_id), line_count=len(payload.get("lines") or []),
                                 doc_number=payload.get("refNumber"), closed=False)
    created = qbd._request("POST", PURCHASE_ORDERS_PATH, end_user_id=end_user_id,
                           json_body=payload, is_write=True, noun="purchase order")
    return _pushed(created)


def update_purchase_order(end_user_id: str, qb_po_id: str, payload: dict,
                          *, request_id: str) -> PushedPurchaseOrder:
    """`request_id` identifies the attempt in Jigged's own records only: Desktop has no
    request key and externalId cannot change."""
    if is_fake():
        lines = payload.get("lines")
        return fake.fake_updated(
            qb_po_id=qb_po_id, request_id=str(request_id), prior_token=payload.get("revisionNumber"),
            existing_line_ids=([None if ln.get("id") in (None, "-1") else ln.get("id") for ln in lines]
                               if lines is not None else None),
            doc_number=payload.get("refNumber"),
            closed=payload.get("isManuallyClosed") if "isManuallyClosed" in payload else None,
        )
    updated = qbd._request("POST", f"{PURCHASE_ORDERS_PATH}/{qb_po_id}", end_user_id=end_user_id,
                           json_body=payload, is_write=True, noun="purchase order")
    return _pushed(updated)


def _state(po: dict) -> QbPurchaseOrderState:
    lines = tuple(
        QbPurchaseOrderLine(
            id=str(ln["id"]),
            item_id=(ln.get("item") or {}).get("id"),
            quantity=pom.to_decimal(ln.get("quantity")),
            rate=pom.to_decimal(ln.get("rate")),
            received_quantity=pom.to_decimal(ln.get("receivedQuantity")) or Decimal(0),
            billed=bool(ln.get("isBilled")),
            closed=bool(ln.get("isManuallyClosed")),
        )
        for ln in (po.get("lines") or []) if ln.get("id")
    )
    groups = tuple(str(g["id"]) for g in (po.get("lineGroups") or []) if g.get("id"))
    return QbPurchaseOrderState(
        id=str(po["id"]), sync_token=str(po.get("revisionNumber")), doc_number=po.get("refNumber"),
        lines=lines, other_line_ids=groups, fully_received=bool(po.get("isFullyReceived")),
        closed=bool(po.get("isManuallyClosed")),
    )


def read_purchase_order(end_user_id: str, qb_po_id: str, *, db=None,
                        company_id: str | None = None) -> QbPurchaseOrderState | None:
    """The one read allowed. `db` and `company_id` serve the fake only, which answers
    with what Jigged last recorded pushing."""
    if is_fake():
        return fake.fake_state(db, company_id or "", qb_po_id) if db is not None else None
    try:
        po = qbd._request("GET", f"{PURCHASE_ORDERS_PATH}/{qb_po_id}", end_user_id=end_user_id)
    except qbd.QbdApiError as exc:
        if is_not_found(exc):
            return None
        raise
    return _state(po) if po else None


def find_created_purchase_order(end_user_id: str, *, qb_vendor_id: str, transaction_date: str,
                                external_id: str) -> PushedPurchaseOrder | None:
    """The recovery probe: one list by vendor and a one-day window, matched on externalId
    client-side. Never refNumbers or ids (a miss fails the request), and never retried."""
    if is_fake():
        return None
    rows = qbd._list(
        PURCHASE_ORDERS_PATH, end_user_id,
        {"vendorIds": qb_vendor_id, "transactionDateFrom": transaction_date,
         "transactionDateTo": transaction_date, "limit": 150},
    )
    for row in rows:
        if row.get("externalId") == external_id:
            return _pushed(row)
    return None


def expected_lines(payload: dict) -> list[tuple[Decimal, Decimal]]:
    """(quantity, rate) of every line a Desktop payload sent, in order."""
    return [(Decimal(str(ln["quantity"])), Decimal(str(ln["rate"]))) for ln in payload.get("lines") or []]


def expected_lines_for(po: pom.PurchaseOrderProjection) -> list[tuple[Decimal, Decimal]] | None:
    """(quantity, rate) the projection would send, or None when a line is unpriced."""
    out: list[tuple[Decimal, Decimal]] = []
    for line in po.lines:
        if line.unit_price is None:
            return None
        out.append((line.quantity, Decimal(pom.rate_string(line.unit_price))))
    return out


def decide_update_probe(state: QbPurchaseOrderState | None, *, sent_token: str | None,
                        expected_lines: list[tuple[Decimal, Decimal]] | None) -> str:
    """After an update whose outcome is unknown: "adopt" | "release" | "park".

    Token unchanged -> it did not land; release (an update cannot duplicate anything,
    so a retry is safe). Token moved and every line is what was sent -> adopt.
    Anything else -> a human looks."""
    if state is None or expected_lines is None:
        return "park"
    if sent_token is not None and str(state.sync_token) == str(sent_token):
        return "release"
    if len(state.lines) != len(expected_lines):
        return "park"
    for qb_line, (quantity, rate) in zip(state.lines, expected_lines):
        if qb_line.quantity is None or qb_line.rate is None:
            return "park"
        if qb_line.quantity != quantity or qb_line.rate != rate:
            return "park"
    return "adopt"
