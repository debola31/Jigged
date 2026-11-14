"""QuickBooks Online: the provider primitives for pushing a VENDOR purchase order.

A separate module from services/quickbooks.py on purpose: that module's invoice entry
points were established against the live Intuit sandbox and its tests pin them
(test_accounting_provider.test_quickbooks_module_is_untouched_by_the_seam). This one
reuses its HTTP client -- token refresh, the 401 retry, minorversion -- and adds only
what a purchase order needs.

Every function here runs inside an explicit click: Send/Update/Close, "Check
QuickBooks", or a Settings choice. None runs on a page load (plan §3.11, QB1).

FACTS THIS MODULE RELIES ON, and where they come from:
  * Memo PRINTS on the PO ("Your message to vendor"); PrivateNote is internal. The
    names are the opposite of QuickBooks Desktop's (Intuit's PurchaseOrder reference).
  * ?requestid= makes Intuit replay the original response to a repeated request, so a
    lost answer is resumed with the SAME id, never a new one.
  * A DocNumber already in use is refused (6140) unless the request carries
    include=allowduplicatedocnum. Desktop accepts duplicates silently; Online is made
    to match, so a PO whose number collides can still be sent.
  * Vendor DisplayName is unique across vendors, customers AND employees (6240).
  * UNVERIFIED until manual check M-1: the "purchase orders are off" fault (code 9334
    per integration vendors), sparse-update line semantics, whether a NonInventory item
    with only an ExpenseAccountRef is accepted, the purchase-order deep link, and
    whether a bill entered against the PO advances its SyncToken.
"""
from __future__ import annotations

import logging
import os
import re
import urllib.parse
import uuid
from typing import Any

from supabase import Client

import services.quickbooks as qb
from services.accounting import purchase_order as pom
from services.accounting import purchasing_fake as fake
from services.accounting.base import (
    PushedPurchaseOrder,
    QbPurchaseOrderLine,
    QbPurchaseOrderState,
)

logger = logging.getLogger(__name__)

PURCHASE_ACCOUNT_TYPES = ("Expense", "Cost of Goods Sold", "Other Expense")
AP_ACCOUNT_TYPE = "Accounts Payable"
PURCHASE_ITEM_TYPES = ("NonInventory", "Service")
ITEM_LINE = "ItemBasedExpenseLineDetail"
# Sent on every purchase-order write. See the module docstring.
DUPLICATE_NUMBERS_ALLOWED = "allowduplicatedocnum"

# UNVERIFIED (M-1): no documented Preferences flag says whether purchase orders are on.
# These are the names worth looking for; absent, the answer is "unknown", never "off".
_PO_ENABLED_PREFERENCE_NAMES = (
    "VendorAndPurchasesPrefs.UsingPurchaseOrders",
    "VendorAndPurchasesPrefs.PurchaseOrderEnabled",
    "PurchaseOrderEnabled",
)
_CUSTOM_NUMBERS_PREFERENCE_NAME = "VendorAndPurchasesPrefs.UseCustomTxnNumbers"


def is_fake() -> bool:
    """The same guard services/quickbooks.py uses for invoices: off in production."""
    return bool(os.getenv("QUICKBOOKS_FAKE")) and qb._environment() != "production"


# ───────────────────────── faults ─────────────────────────
def _fault_errors(exc: Any) -> list[dict]:
    fault = getattr(exc, "fault", None)
    if not isinstance(fault, dict):
        return []
    envelope = fault.get("Fault") or fault.get("fault") or {}
    if not isinstance(envelope, dict):
        return []
    errors = envelope.get("Error") or envelope.get("error") or []
    return [e for e in errors if isinstance(e, dict)] if isinstance(errors, list) else []


def fault_codes(exc: Any) -> set[str]:
    return {str(e.get("code")) for e in _fault_errors(exc) if e.get("code") not in (None, "")}


def fault_text(exc: Any) -> str:
    """QuickBooks' own words for a rejection -- it names the offending field better
    than Jigged can, so a 502 carries it."""
    parts: list[str] = []
    for e in _fault_errors(exc):
        for key in ("Detail", "detail", "Message", "message"):
            value = e.get(key)
            if value and value not in parts:
                parts.append(str(value))
    return " — ".join(parts)


_NOT_ENABLED = re.compile(r"PurchaseOrder\s+(is\s+not|has\s+to\s+be)\s+enabled", re.IGNORECASE)


def classify_qbo_fault(exc: Any) -> str | None:
    """The shop-fixable 409 code for a QuickBooks Online fault, or None (-> 502).

    6140 (duplicate DocNumber) is deliberately None: every write carries
    include=allowduplicatedocnum, so a 6140 means that assumption broke -- ours to fix,
    so it belongs in Sentry, not in front of the shop."""
    if not isinstance(exc, qb.QuickBooksApiError):
        return None
    if exc.status == 429:
        return "qbo_busy"
    codes = fault_codes(exc)
    if "9334" in codes or _NOT_ENABLED.search(fault_text(exc)):
        return "qbo_purchase_orders_unavailable"
    if "5010" in codes:
        return "qb_changed_in_quickbooks"
    if "610" in codes:
        return "qb_reference_inactive"
    if "6240" in codes:
        return "qb_vendor_name_taken"
    return None


def failure_kind(exc: Any) -> str:
    """"ambiguous" when the write may have reached Intuit (transport error, 5xx, or an
    unexpected failure after sending), else "rejected". An ambiguous attempt resumes
    with the SAME request id; a rejected one gets a new id."""
    if isinstance(exc, qb.QuickBooksApiError):
        if exc.status is None or exc.status >= 500:
            return "ambiguous"
        return "rejected"
    if isinstance(exc, (qb.QuickBooksNotConnected, qb.QuickBooksServiceUnavailable,
                        pom.PurchasingRefusal, ValueError)):
        return "rejected"
    return "ambiguous"


# ───────────────────────── vendors ─────────────────────────
def vendor_name_problem(name: str | None) -> str | None:
    return pom.vendor_name_problem(name, max_length=pom.QBO_VENDOR_NAME_MAX)


def vendor_request_id(attempt_id: str) -> str:
    """The vendor create's ?requestid=. Derived from the attempt so a resumed attempt
    replays the same vendor create, and distinct from the PO's own id, because Intuit
    wants request ids unique per company."""
    return str(uuid.uuid5(uuid.UUID(str(attempt_id)), "vendor"))


def _vendor_summary(v: dict) -> dict:
    return {"qb_id": str(v["Id"]), "display_name": v.get("DisplayName")}


def find_vendor_candidates(db: Client, company_id: str, name: str) -> dict:
    """Exact DisplayName, then a LIKE search capped at 10 -- the customer contract."""
    if is_fake():
        return fake.fake_vendor_candidates()
    escaped = qb._escape_qb_literal((name or "").strip())
    exact = qb.qb_query(
        db, company_id, f"select * from Vendor where DisplayName = '{escaped}'"
    ).get("Vendor", []) or []
    if exact:
        return {"status": "exact_match", "qb_vendor_id": str(exact[0]["Id"]),
                "candidates": [_vendor_summary(exact[0])]}
    similar = qb.qb_query(
        db, company_id, f"select * from Vendor where DisplayName LIKE '%{escaped}%' MAXRESULTS 10"
    ).get("Vendor", []) or []
    if similar:
        return {"status": "candidates", "qb_vendor_id": None,
                "candidates": [_vendor_summary(v) for v in similar]}
    return {"status": "unmatched", "qb_vendor_id": None, "candidates": []}


def create_vendor(db: Client, company_id: str, display_name: str, address: dict | None,
                  *, request_id: str) -> str:
    """Create the vendor; on 6240, re-query rather than guess.

    6240 says the name is taken somewhere among vendors, customers and employees. A
    re-query that includes inactive vendors separates the three answers: an active
    vendor (a race we lost -- use it), an inactive one (a human must reactivate it),
    or none (a customer or employee holds the name)."""
    name = (display_name or "").strip()
    problem = vendor_name_problem(name)
    if problem:
        raise pom.PurchasingRefusal("qb_vendor_name_invalid", name=name, problem=problem)
    if is_fake():
        return fake.fake_id("VENDOR", name.casefold())
    body: dict = {"DisplayName": name, "CompanyName": name[: pom.QBO_COMPANY_NAME_MAX]}
    bill_addr = qb._to_qb_addr(dict(address or {}))
    if bill_addr:
        body["BillAddr"] = bill_addr
    try:
        created = qb.qb_request(db, company_id, "POST", "vendor", json_body=body,
                                params={"requestid": str(request_id)})
        return str(created["Vendor"]["Id"])
    except qb.QuickBooksApiError as exc:
        if "6240" not in fault_codes(exc) and "Duplicate Name" not in fault_text(exc):
            raise
    escaped = qb._escape_qb_literal(name)
    rows = qb.qb_query(
        db, company_id,
        f"select * from Vendor where Active IN (true, false) and DisplayName = '{escaped}'",
    ).get("Vendor", []) or []
    for vendor in rows:
        if (vendor.get("DisplayName") or "").strip().casefold() == name.casefold():
            if vendor.get("Active") is False:
                raise pom.PurchasingRefusal("qb_vendor_inactive", name=name)
            return str(vendor["Id"])
    raise pom.PurchasingRefusal("qb_vendor_name_taken", name=name)


# ───────────────────────── accounts and items ─────────────────────────
def _account_summary(a: dict) -> dict:
    return {"id": str(a["Id"]), "full_name": a.get("FullyQualifiedName") or a.get("Name"),
            "type": a.get("AccountType")}


def _active_accounts(db: Client, company_id: str) -> list[dict]:
    return qb.qb_query(
        db, company_id, "select * from Account where Active = true MAXRESULTS 1000"
    ).get("Account", []) or []


def list_purchase_accounts(db: Client, company_id: str) -> list[dict]:
    if is_fake():
        return [dict(a) for a in fake.FAKE_PURCHASE_ACCOUNTS]
    return [_account_summary(a) for a in _active_accounts(db, company_id)
            if a.get("AccountType") in PURCHASE_ACCOUNT_TYPES]


def list_ap_accounts(db: Client, company_id: str) -> list[dict]:
    if is_fake():
        return [dict(a) for a in fake.FAKE_AP_ACCOUNTS]
    return [_account_summary(a) for a in _active_accounts(db, company_id)
            if a.get("AccountType") == AP_ACCOUNT_TYPE]


def _item_summary(item: dict) -> dict:
    ref = item.get("ExpenseAccountRef") or {}
    return {
        "id": str(item["Id"]),
        "name": item.get("FullyQualifiedName") or item.get("Name"),
        "type": item.get("Type"),
        "posting_account_id": str(ref["value"]) if ref.get("value") is not None else None,
        "posting_account_name": ref.get("name"),
    }


def list_purchase_items(db: Client, company_id: str) -> list[dict]:
    """NonInventory and Service items that carry an expense account. Inventory items
    are never offered: Jigged owns stock, and QuickBooks would start counting it too."""
    if is_fake():
        return [dict(i) for i in fake.FAKE_PURCHASE_ITEMS]
    rows = qb.qb_query(
        db, company_id, "select * from Item where Active = true MAXRESULTS 1000"
    ).get("Item", []) or []
    return [_item_summary(i) for i in rows
            if i.get("Type") in PURCHASE_ITEM_TYPES and (i.get("ExpenseAccountRef") or {}).get("value")]


def _items_named(db: Client, company_id: str, name: str) -> list[dict]:
    escaped = qb._escape_qb_literal(name)
    rows = qb.qb_query(
        db, company_id, f"select * from Item where Active IN (true, false) and Name = '{escaped}'"
    ).get("Item", []) or []
    return [i for i in rows if (i.get("Name") or "").strip().casefold() == name.casefold()]


def _reuse_or_refuse(existing: dict, name: str, account_id: str) -> dict:
    summary = _item_summary(existing)
    if (existing.get("Type") in PURCHASE_ITEM_TYPES and existing.get("Active") is not False
            and summary["posting_account_id"] == str(account_id)):
        return {**summary, "created": False}
    raise pom.PurchasingRefusal(
        "qb_item_name_taken", name=name,
        account=summary["posting_account_name"] or "another account",
    )


def create_purchase_item(db: Client, company_id: str, name: str, account_id: str,
                         *, request_id: str) -> dict:
    """Create a NonInventory item posting ONLY to `account_id`, or reuse a same-named
    item when -- and only when -- it already posts there."""
    clean = (name or "").strip()
    if not clean or len(clean) > pom.QBO_ITEM_NAME_MAX or ":" in clean:
        raise ValueError(
            f"Item names must be 1 to {pom.QBO_ITEM_NAME_MAX} characters, without a colon."
        )
    if is_fake():
        return fake.fake_item(clean, account_id)
    existing = _items_named(db, company_id, clean)
    if existing:
        return _reuse_or_refuse(existing[0], clean, account_id)
    body = {"Name": clean, "Type": "NonInventory", "ExpenseAccountRef": {"value": str(account_id)}}
    try:
        created = qb.qb_request(db, company_id, "POST", "item", json_body=body,
                                params={"requestid": str(request_id)})
    except qb.QuickBooksApiError as exc:
        if "6240" not in fault_codes(exc) and "Duplicate Name" not in fault_text(exc):
            raise
        raced = _items_named(db, company_id, clean)
        if not raced:
            raise
        return _reuse_or_refuse(raced[0], clean, account_id)
    return {**_item_summary(created["Item"]), "created": True}


def _bool_preference(value: Any) -> bool | None:
    if isinstance(value, bool):
        return value
    if isinstance(value, str) and value.strip().lower() in ("true", "false"):
        return value.strip().lower() == "true"
    return None


def check_purchasing_preferences(db: Client, company_id: str) -> dict:
    """Two answers, stored by the admin's "Check QuickBooks" click.

    Custom transaction numbers: Intuit documents the PO number rule under
    Preferences:OtherPrefs:NameValue.Name = VendorAndPurchasesPrefs.UseCustomTxnNumbers.
    Off means QuickBooks numbers each PO itself. Purchase orders on: no documented flag
    (UNVERIFIED, M-1), so None unless one of the candidate names is present."""
    if is_fake():
        return {"purchase_orders_enabled": True, "custom_txn_numbers": True}
    prefs = qb.qb_request(db, company_id, "GET", "preferences").get("Preferences") or {}
    pairs = ((prefs.get("OtherPrefs") or {}).get("NameValue")) or []
    values = {str(p.get("Name")): p.get("Value") for p in pairs if isinstance(p, dict)}
    enabled = None
    for key in _PO_ENABLED_PREFERENCE_NAMES:
        enabled = _bool_preference(values.get(key))
        if enabled is not None:
            break
    return {
        "purchase_orders_enabled": enabled,
        "custom_txn_numbers": _bool_preference(values.get(_CUSTOM_NUMBERS_PREFERENCE_NAME)),
    }


def resolve_ship_method_id(name: str | None) -> str | None:
    """QuickBooks Online has no ship-method entity: Intuit says to store the string in
    both ShipMethodRef.value and ShipMethodRef.name. Nothing to look up."""
    text = (name or "").strip()
    return text or None


# ───────────────────────── the purchase order ─────────────────────────
def ship_address(name: str | None, address: dict | None) -> dict | None:
    """The frozen ship-to as an Intuit address: the name first, then attention, then
    the street lines. Intuit's lines hold 500 characters, so nothing needs cutting."""
    parts = pom.address_parts(address)
    lines = [
        (name or "").strip(),
        f"Attn: {parts['attention_to']}" if parts.get("attention_to") else "",
        parts.get("address_line1", ""),
        parts.get("address_line2", ""),
    ]
    lines = [ln for ln in lines if ln]
    out: dict = {f"Line{i}": ln[:500] for i, ln in enumerate(lines[:5], start=1)}
    if parts.get("city"):
        out["City"] = parts["city"][:255]
    if parts.get("state"):
        out["CountrySubDivisionCode"] = parts["state"][:255]
    if parts.get("postal_code"):
        out["PostalCode"] = parts["postal_code"][:30]
    if parts.get("country"):
        out["Country"] = parts["country"][:255]
    return out or None


def _lines(po: pom.PurchaseOrderProjection, item_refs: dict[str, str],
           qb_line_id_by_line: dict[str, str] | None) -> list[dict]:
    out: list[dict] = []
    for line in po.lines:
        if line.unit_price is None:
            raise ValueError(f"Line {line.line_number} of {po.po_number} has no price.")
        item = item_refs.get(line.line_id)
        if not item:
            raise ValueError(f"Line {line.line_number} of {po.po_number} has no QuickBooks item.")
        entry: dict = {}
        existing_id = (qb_line_id_by_line or {}).get(line.line_id)
        if existing_id:
            entry["Id"] = existing_id
        entry.update({
            "DetailType": ITEM_LINE,
            # Intuit requires Amount on an item line; the same rule as SQL and TypeScript.
            "Amount": pom.json_number(pom.line_amount(line.quantity, line.unit_price)),
            "Description": pom.describe_line(line, max_length=pom.QBO_TEXT_MAX),
            ITEM_LINE: {
                "ItemRef": {"value": str(item)},
                "Qty": pom.json_number(line.quantity),
                "UnitPrice": pom.json_number(line.unit_price),
            },
        })
        out.append(entry)
    return out


def _content(po: pom.PurchaseOrderProjection, *, term_id: str | None, ship_method_id: str | None,
             jigged_url: str | None) -> dict:
    body: dict = {}
    if po.notes_to_vendor:
        body["Memo"] = po.notes_to_vendor[: pom.QBO_TEXT_MAX]
    body["PrivateNote"] = pom.private_note(po, jigged_url)[: pom.QBO_TEXT_MAX]
    addr = ship_address(po.ship_to_name, po.ship_to_address)
    if addr:
        body["ShipAddr"] = addr
    if ship_method_id:
        body["ShipMethodRef"] = {"value": ship_method_id, "name": ship_method_id}
    if term_id:
        # SalesTermRef only, never DueDate: on Online DueDate means PAYMENT due, and the
        # term derives it (the invoice path verified the two disagree when both are sent).
        body["SalesTermRef"] = {"value": str(term_id)}
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
    """PURE: the QuickBooks Online PurchaseOrder body for one push.

    `request_id` is not part of the body -- it travels as ?requestid= -- and is accepted
    only so both providers' builders take the same arguments.

    An update is SPARSE with the FULL Line array: mapped lines keep their Line.Id, a new
    line has none, and a line left out is deleted. Sparse rather than full so the class
    and custom fields a bookkeeper set in QuickBooks survive (UNVERIFIED, M-1)."""
    if operation == "create":
        body: dict = {"VendorRef": {"value": str(vendor_ref)}, "TxnDate": po.ordered_on,
                      "DocNumber": po.po_number}
        if ap_account_id:
            body["APAccountRef"] = {"value": str(ap_account_id)}
        body.update(_content(po, term_id=term_id, ship_method_id=ship_method_id,
                             jigged_url=jigged_url))
        body["Line"] = _lines(po, item_refs, None)
        if po.closed:
            body["POStatus"] = "Closed"
        return body

    if existing is None:
        raise ValueError("An update needs the QuickBooks purchase order read in this same push.")
    body = {"Id": existing.id, "SyncToken": existing.sync_token, "sparse": True}
    if include_content:
        body["DocNumber"] = po.po_number
        body["TxnDate"] = po.ordered_on
        if ap_account_id:
            body["APAccountRef"] = {"value": str(ap_account_id)}
        body.update(_content(po, term_id=term_id, ship_method_id=ship_method_id,
                             jigged_url=jigged_url))
        body["Line"] = _lines(po, item_refs, qb_line_id_by_line)
    if operation == "close":
        body["POStatus"] = "Closed"
    elif operation == "reopen":
        body["POStatus"] = "Open"
    return body


def _pushed(po: dict) -> PushedPurchaseOrder:
    lines = [ln for ln in (po.get("Line") or []) if ln.get("DetailType") == ITEM_LINE and ln.get("Id")]
    status = po.get("POStatus")
    return PushedPurchaseOrder(
        id=str(po["Id"]),
        doc_number=po.get("DocNumber"),
        sync_token=po.get("SyncToken"),
        line_ids=tuple(str(ln["Id"]) for ln in lines),
        closed=(status == "Closed") if status else None,
    )


def _write_params(request_id: str) -> dict:
    return {"requestid": str(request_id), "include": DUPLICATE_NUMBERS_ALLOWED}


def create_purchase_order(db: Client, company_id: str, payload: dict, *, request_id: str) -> PushedPurchaseOrder:
    if is_fake():
        return fake.fake_created(request_id=str(request_id), line_count=len(payload.get("Line") or []),
                                 doc_number=payload.get("DocNumber"),
                                 closed=payload.get("POStatus") == "Closed")
    created = qb.qb_request(db, company_id, "POST", "purchaseorder", json_body=payload,
                            params=_write_params(request_id))
    return _pushed(created["PurchaseOrder"])


def update_purchase_order(db: Client, company_id: str, qb_po_id: str, payload: dict,
                          *, request_id: str) -> PushedPurchaseOrder:
    if is_fake():
        lines = payload.get("Line")
        return fake.fake_updated(
            qb_po_id=qb_po_id, request_id=str(request_id), prior_token=payload.get("SyncToken"),
            existing_line_ids=[ln.get("Id") for ln in lines] if lines is not None else None,
            doc_number=payload.get("DocNumber"),
            closed=(payload["POStatus"] == "Closed") if "POStatus" in payload else None,
        )
    updated = qb.qb_request(db, company_id, "POST", "purchaseorder", json_body=payload,
                            params=_write_params(request_id))
    return _pushed(updated["PurchaseOrder"])


def _state(po: dict) -> QbPurchaseOrderState:
    item_lines = []
    other_ids = []
    for ln in po.get("Line") or []:
        if not ln.get("Id"):
            continue
        if ln.get("DetailType") != ITEM_LINE:
            other_ids.append(str(ln["Id"]))
            continue
        detail = ln.get(ITEM_LINE) or {}
        item_lines.append(QbPurchaseOrderLine(
            id=str(ln["Id"]),
            item_id=(detail.get("ItemRef") or {}).get("value"),
            quantity=pom.to_decimal(detail.get("Qty")),
            rate=pom.to_decimal(detail.get("UnitPrice")),
        ))
    return QbPurchaseOrderState(
        id=str(po["Id"]), sync_token=str(po.get("SyncToken")), doc_number=po.get("DocNumber"),
        lines=tuple(item_lines), other_line_ids=tuple(other_ids),
        closed=po.get("POStatus") == "Closed",
    )


def read_purchase_order(db: Client, company_id: str, qb_po_id: str) -> QbPurchaseOrderState | None:
    """The one read allowed, by id. A query rather than GET /purchaseorder/{id}: an
    empty answer is an unambiguous "gone", where a GET of a deleted PO is a fault."""
    if is_fake():
        return fake.fake_state(db, company_id, qb_po_id)
    escaped = qb._escape_qb_literal(str(qb_po_id))
    rows = qb.qb_query_strict(
        db, company_id, f"select * from PurchaseOrder where Id = '{escaped}'"
    ).get("PurchaseOrder") or []
    for row in rows if isinstance(rows, list) else []:
        if isinstance(row, dict) and str(row.get("Id")) == str(qb_po_id):
            return _state(row)
    return None


def purchase_order_deep_link(environment: str, qb_po_id: str, realm_id: str | None = None) -> str:
    """The invoice link's /login?pagereq= shape (see services/quickbooks.invoice_deep_link
    for why only that shape survives Intuit's sign-in bounce), aimed at the purchase
    order page. UNVERIFIED for purchase orders until M-1."""
    base = "https://qbo.intuit.com" if environment == "production" else "https://sandbox.qbo.intuit.com"
    if not realm_id:
        return f"{base}/app/purchaseorder?txnId={qb_po_id}"
    pagereq = urllib.parse.quote(f"purchaseorder?txnId={qb_po_id}", safe="")
    return f"{base}/login?deeplinkcompanyid={realm_id}&pagereq={pagereq}"
