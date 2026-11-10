"""Deterministic stand-ins for every vendor-PO QuickBooks call, under QUICKBOOKS_FAKE.

E2E runs the API with QUICKBOOKS_FAKE set (e2e/run-stack.mjs), so the Send-to-QuickBooks
dialog and the Settings purchasing panel can be driven end to end with no Intuit or
Conductor account and no network. Everything else -- the claim, the link and line-link
rows, the request-id rules, the hash -- runs for real against the database.

Each provider module checks its OWN guard before calling into here, and both guards are
off in production (services/quickbooks.py create_invoice, services/quickbooks_desktop.py
_is_fake), so a stray environment variable can never fake a real purchase order.

Ids are derived from their inputs, so a replay produces the same id -- which is what
lets E2E exercise idempotency rather than merely survive it.
"""
from __future__ import annotations

import uuid

from .base import PushedPurchaseOrder, QbPurchaseOrderLine, QbPurchaseOrderState

LINKS_TABLE = "quickbooks_purchase_order_links"
LINE_LINKS_TABLE = "quickbooks_purchase_order_line_links"

FAKE_PURCHASE_ACCOUNTS = [
    {"id": "E2E-ACCT-COGS", "full_name": "Cost of Goods Sold", "type": "Cost of Goods Sold"},
    {"id": "E2E-ACCT-EXP", "full_name": "Repairs and Maintenance", "type": "Expense"},
]
FAKE_AP_ACCOUNTS = [
    {"id": "E2E-ACCT-AP", "full_name": "Accounts Payable (A/P)", "type": "Accounts Payable"},
]
FAKE_PURCHASE_ITEMS = [
    {"id": "E2E-ITEM-PURCHASES", "name": "Jigged purchases", "type": "NonInventory",
     "posting_account_id": "E2E-ACCT-COGS", "posting_account_name": "Cost of Goods Sold"},
]


def fake_id(prefix: str, *parts: object) -> str:
    seed = "|".join(str(p) for p in parts)
    return f"E2E-{prefix}-{uuid.uuid5(uuid.NAMESPACE_URL, seed).hex[:8]}"


def fake_vendor_candidates() -> dict:
    """"Nobody matched", so the dialog offers to create the vendor -- the first-push
    path a real shop takes."""
    return {"status": "unmatched", "qb_vendor_id": None, "candidates": []}


def fake_item(name: str, account_id: str) -> dict:
    account = next((a for a in FAKE_PURCHASE_ACCOUNTS if a["id"] == account_id), None)
    return {
        "id": fake_id("ITEM", name, account_id),
        "name": name,
        "type": "NonInventory",
        "posting_account_id": account_id,
        "posting_account_name": account["full_name"] if account else account_id,
        "created": True,
    }


def _next_token(token: object) -> str:
    try:
        return str(int(str(token)) + 1)
    except (TypeError, ValueError):
        return "1"


def fake_created(*, request_id: str, line_count: int, doc_number: str | None,
                 closed: bool) -> PushedPurchaseOrder:
    rid = str(request_id)
    return PushedPurchaseOrder(
        id=f"E2E-PO-{rid[:8]}",
        doc_number=doc_number,
        sync_token="0",
        line_ids=tuple(f"E2E-L-{rid[:8]}-{i}" for i in range(1, line_count + 1)),
        closed=closed,
    )


def fake_updated(*, qb_po_id: str, request_id: str, prior_token: object,
                 existing_line_ids: list[str | None] | None, doc_number: str | None,
                 closed: bool | None) -> PushedPurchaseOrder:
    """`existing_line_ids` is the sent line array's ids in order, None for a new line;
    a header-only update (no lines sent) passes None for the whole list."""
    rid = str(request_id)
    line_ids: tuple[str, ...] = ()
    if existing_line_ids is not None:
        line_ids = tuple(
            line_id or f"E2E-L-{rid[:8]}-{i}"
            for i, line_id in enumerate(existing_line_ids, start=1)
        )
    return PushedPurchaseOrder(id=qb_po_id, doc_number=doc_number,
                               sync_token=_next_token(prior_token), line_ids=line_ids,
                               closed=closed)


def fake_state(db, company_id: str, qb_po_id: str) -> QbPurchaseOrderState | None:
    """The faked QuickBooks PO is exactly what Jigged last recorded pushing, so the
    foreign-line and in-use guards pass and the update path can be driven end to end."""
    rows = (
        db.table(LINKS_TABLE)
        .select("id, qb_po_id, qb_sync_token, qb_closed, qb_doc_number")
        .eq("company_id", company_id)
        .eq("qb_po_id", qb_po_id)
        .limit(1)
        .execute()
        .data
        or []
    )
    if not rows:
        return None
    link = rows[0]
    line_rows = (
        db.table(LINE_LINKS_TABLE)
        .select("qb_line_id, qb_item_id")
        .eq("link_id", link["id"])
        .execute()
        .data
        or []
    )
    return QbPurchaseOrderState(
        id=qb_po_id,
        sync_token=str(link.get("qb_sync_token") or "0"),
        doc_number=link.get("qb_doc_number"),
        lines=tuple(QbPurchaseOrderLine(id=str(r["qb_line_id"]), item_id=r.get("qb_item_id"))
                    for r in line_rows),
        closed=bool(link.get("qb_closed")),
    )
