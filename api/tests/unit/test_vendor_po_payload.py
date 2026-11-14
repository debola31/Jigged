"""The vendor-PO payload builders, for QuickBooks Online and QuickBooks Desktop.

Both are PURE: the push resolves the vendor, items, terms and ship method first and
hands the builder plain values, so these tests run with every network path patched
to raise. The mapping they pin is plan §3.11's table, exactly:

  * Online gets Memo (prints on the PO) and PrivateNote (internal); Desktop gets
    vendorMessage (prints, 99 characters) and memo (internal). The two systems use
    the names the opposite way round, which is why both directions are asserted.
  * Desktop gets `rate`, NEVER `amount` -- Conductor ignores rate when amount is
    present, which would print a lump sum. Online gets Amount = round(qty x price, 2),
    the same rule SQL and TypeScript use (the shared fixture below).
  * No CustomerRef, BillableStatus, payeeId, customerId or unitOfMeasure, ever: any
    of them turns a purchase into a billable expense against a customer.

Criteria: QB3 (the create mapping), QB8 (update, close and reopen bodies), QB12 (the
builders are pure), P7 (the amount rule matches its fixture).
"""
import json
import sys
from decimal import Decimal
from pathlib import Path

import httpx
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

import services.accounting.purchase_order as pom  # noqa: E402
import services.quickbooks as qb  # noqa: E402
import services.quickbooks_desktop as qbd  # noqa: E402
import services.quickbooks_desktop_purchasing as qbdp  # noqa: E402
import services.quickbooks_purchasing as qbp  # noqa: E402
from services.accounting.base import QbPurchaseOrderLine, QbPurchaseOrderState  # noqa: E402

pytestmark = pytest.mark.unit

REPO_ROOT = Path(__file__).resolve().parents[3]
AMOUNT_FIXTURE = REPO_ROOT / "__tests__" / "fixtures" / "vendorPoAmountCases.json"
URL = "https://jigged.app/dashboard/co-1/purchasing/orders/po-1"
NOTES = "Certs with the shipment, please."
FORBIDDEN_KEYS = {"CustomerRef", "BillableStatus", "payeeId", "customerId", "unitOfMeasure"}


def _header(**over):
    base = {
        "id": "po-1", "company_id": "co-1", "po_number": "PO-1042", "revision": 2,
        "sent_revision": 2, "vendor_id": "ven-1", "vendor_name": "Acme Anodizing",
        "ordered_on": "2026-11-09", "need_by_on": "2026-11-20", "payment_terms": "Net 30",
        "ship_via": "UPS Ground", "notes_to_vendor": NOTES,
        "internal_notes": "Never send this anywhere.",
        "ship_to_name": "L&L Machine",
        "ship_to_address": {"address_line1": "200 Shop Rd", "address_line2": "Dock 3",
                            "city": "Akron", "state": "OH", "postal_code": "44301",
                            "country": "US", "attention_to": "Receiving"},
        "content_version": 7, "deleted_at": None,
    }
    base.update(over)
    return base


def _part_line(**over):
    base = {
        "id": "line-1", "line_number": 1, "line_kind": "part", "part_name": "BRKT-100",
        "description": "6061-T6 1.0in bar", "vendor_part_number": "88-120",
        "quantity": 3, "unit": "bar", "stock_unit": "inches", "stock_factor": 144,
        "unit_price": 41.5, "job_number": "J-0141", "closed_at": None,
    }
    base.update(over)
    return base


def _outside_line(**over):
    base = {
        "id": "line-2", "line_number": 2, "line_kind": "outside_service",
        "part_name": "BRKT-100", "service_name": "Anodize Type II",
        "description": "Anodize Type II — BRKT-100 — Job J-0141, Op 30",
        "quantity": 100, "unit": "each", "unit_price": 1.25, "job_number": "J-0141",
        "operation_label": "30", "closed_at": None,
    }
    base.update(over)
    return base


def _other_line(**over):
    base = {
        "id": "line-3", "line_number": 3, "line_kind": "other",
        "description": "Spindle rebuild", "quantity": 1, "unit": "each",
        "unit_price": 2400, "work_center_name": "Haas VF-2", "job_number": None,
        "closed_at": None,
    }
    base.update(over)
    return base


def _po(header=None, lines=None, status="sent"):
    return pom.projection_from_rows(
        header or _header(),
        lines if lines is not None else [_part_line(), _outside_line(), _other_line()],
        status=status,
    )


ITEMS = {"line-1": "ITEM-PART", "line-2": "ITEM-OUT", "line-3": "ITEM-OTHER", "line-4": "ITEM-PART"}


def _qbo(po=None, **over):
    kwargs = dict(vendor_ref="QB-VEN-9", item_refs=ITEMS, ap_account_id="AP-33", term_id="TERM-3",
                  ship_method_id="UPS Ground", request_id="7d9b8f1e-0000-4000-8000-000000000001",
                  jigged_url=URL)
    kwargs.update(over)
    return qbp.purchase_order_payload(po or _po(), **kwargs)


def _qbd(po=None, **over):
    kwargs = dict(vendor_ref="80000001-1", item_refs=ITEMS, ap_account_id=None, term_id="20000-1",
                  ship_method_id="SHIP-1", request_id="7d9b8f1e-0000-4000-8000-000000000001",
                  jigged_url=URL)
    kwargs.update(over)
    return qbdp.purchase_order_payload(po or _po(), **kwargs)


def _keys(obj):
    """Every dict key anywhere inside a payload."""
    if isinstance(obj, dict):
        for k, v in obj.items():
            yield k
            yield from _keys(v)
    elif isinstance(obj, list):
        for v in obj:
            yield from _keys(v)


# ───────────────────────── QuickBooks Online create (QB3) ─────────────────────────
def test_qbo_create_maps_the_header():
    body = _qbo()
    assert body["VendorRef"] == {"value": "QB-VEN-9"}
    assert body["APAccountRef"] == {"value": "AP-33"}
    # The PO's own date. A PO does not post, so there is no closed-period bound.
    assert body["TxnDate"] == "2026-11-09"
    # Jigged owns PO numbers (the opposite of invoices, which QuickBooks numbers).
    assert body["DocNumber"] == "PO-1042"
    assert body["SalesTermRef"] == {"value": "TERM-3"}
    # Online has no ship-method entity: the string goes in value AND name.
    assert body["ShipMethodRef"] == {"value": "UPS Ground", "name": "UPS Ground"}
    # DueDate is PAYMENT due on QuickBooks Online, so the need-by date never goes there.
    assert "DueDate" not in body
    assert "POStatus" not in body


def test_qbo_create_maps_item_lines_with_amount_rounded_to_cents():
    lines = _qbo()["Line"]
    assert [ln["DetailType"] for ln in lines] == ["ItemBasedExpenseLineDetail"] * 3
    first = lines[0]
    detail = first["ItemBasedExpenseLineDetail"]
    assert detail["ItemRef"] == {"value": "ITEM-PART"}
    assert detail["Qty"] == 3
    assert detail["UnitPrice"] == 41.5
    assert first["Amount"] == 124.5
    assert "Id" not in first
    # Each line posts under the item set up for ITS kind.
    assert [ln["ItemBasedExpenseLineDetail"]["ItemRef"]["value"] for ln in lines] == [
        "ITEM-PART", "ITEM-OUT", "ITEM-OTHER"]


def test_qbo_memo_prints_the_vendor_notes_and_private_note_carries_the_reference():
    """Online's `Memo` is "Your message to vendor" and prints; `PrivateNote` is the
    internal memo. Swapping them prints Jigged's link on the vendor's copy."""
    body = _qbo()
    assert body["Memo"] == NOTES
    assert body["PrivateNote"] == f"Jigged PO-1042 Rev 2 · {URL}"
    assert NOTES not in body["PrivateNote"]
    assert "Jigged PO-1042" not in body["Memo"]


def test_qbo_private_note_leaves_out_rev_0():
    po = _po(_header(revision=0, sent_revision=0))
    assert _qbo(po)["PrivateNote"] == f"Jigged PO-1042 · {URL}"


def test_qbo_ship_address_is_the_frozen_ship_to():
    addr = _qbo()["ShipAddr"]
    assert addr["Line1"] == "L&L Machine"
    assert addr["Line2"] == "Attn: Receiving"
    assert addr["Line3"] == "200 Shop Rd"
    assert addr["Line4"] == "Dock 3"
    assert addr["City"] == "Akron"
    assert addr["CountrySubDivisionCode"] == "OH"
    assert addr["PostalCode"] == "44301"


def test_qbo_create_of_a_closed_po_sends_it_closed():
    assert _qbo(_po(status="closed"))["POStatus"] == "Closed"


def test_qbo_optional_references_are_left_out_when_unresolved():
    body = _qbo(term_id=None, ship_method_id=None, ap_account_id=None)
    assert "SalesTermRef" not in body
    assert "ShipMethodRef" not in body
    assert "APAccountRef" not in body


# ───────────────────────── QuickBooks Desktop create (QB3) ─────────────────────────
def test_qbd_create_maps_the_header():
    body = _qbd()
    assert body["vendorId"] == "80000001-1"
    assert body["transactionDate"] == "2026-11-09"
    assert body["refNumber"] == "PO-1042"
    # The attempt id. NOT an idempotency key -- Conductor does not dedupe it -- but the
    # only field Jigged controls that identifies its own PO when an outcome is unknown.
    assert body["externalId"] == "7d9b8f1e-0000-4000-8000-000000000001"
    # Desktop's expectedDate is the header need-by date.
    assert body["expectedDate"] == "2026-11-20"
    assert body["termsId"] == "20000-1"
    assert body["shippingMethodId"] == "SHIP-1"
    # Desktop POs take no accounts-payable account.
    assert "apAccountId" not in body and "APAccountRef" not in body
    # Not accepted on create (it is an update-only field in Conductor).
    assert "isManuallyClosed" not in body


def test_qbd_lines_send_rate_and_never_amount():
    """Conductor ignores `rate` when `amount` is present, so sending both loses the
    unit price and the PO prints a lump sum."""
    for line in _qbd()["lines"]:
        assert "amount" not in line
        assert isinstance(line["rate"], str)
    first = _qbd()["lines"][0]
    assert first["itemId"] == "ITEM-PART"
    assert first["quantity"] == 3
    assert first["rate"] == "41.50000"


def test_qbd_vendor_message_prints_the_notes_and_memo_carries_the_reference():
    body = _qbd()
    assert body["vendorMessage"] == NOTES
    assert body["memo"] == f"Jigged PO-1042 Rev 2 · {URL}"
    assert NOTES not in body["memo"]


def test_qbd_vendor_message_is_cut_to_99_characters_with_an_ellipsis():
    long_notes = "Please " + "x" * 150
    body = _qbd(_po(_header(notes_to_vendor=long_notes)))
    assert len(body["vendorMessage"]) == 99
    assert body["vendorMessage"].endswith("…")
    assert body["vendorMessage"][:98] == long_notes[:98]


def test_qbd_ship_address_is_truncated_to_quickbooks_caps():
    """An address is a label, so it is cut to fit rather than refused -- unlike a
    vendor NAME, which is an identity (QB6)."""
    po = _po(_header(
        ship_to_name="N" * 60,
        ship_to_address={"address_line1": "S" * 60, "city": "C" * 40, "state": "T" * 30,
                         "postal_code": "P" * 20, "country": "K" * 40},
    ))
    addr = _qbd(po)["shippingAddress"]
    assert addr["line1"] == "N" * 41
    assert addr["line2"] == "S" * 41
    assert addr["city"] == "C" * 31
    assert addr["state"] == "T" * 21
    assert addr["postalCode"] == "P" * 13
    assert addr["country"] == "K" * 31
    assert all(len(v) <= 41 for v in addr.values())


def test_qbd_optional_references_are_left_out_when_unresolved():
    """A ship method that is not in QuickBooks Desktop is omitted (with a warning),
    never created; an unresolved term is omitted as on invoices."""
    body = _qbd(term_id=None, ship_method_id=None)
    assert "termsId" not in body
    assert "shippingMethodId" not in body


# ───────────────────────── never billable (QB3) ─────────────────────────
@pytest.mark.parametrize("builder", [_qbo, _qbd])
@pytest.mark.parametrize("operation", ["create", "update", "close", "reopen"])
def test_no_payload_carries_a_customer_billable_flag_or_unit_of_measure(builder, operation):
    """A recursive scan rather than a top-level check: CustomerRef and payeeId live
    on LINES, which is exactly where a later edit would add them."""
    po = _po(lines=[_part_line(), _outside_line(), _other_line()],
             status="closed" if operation == "close" else "sent")
    existing = QbPurchaseOrderState(
        id="QB-77", sync_token="4", doc_number="PO-1042",
        lines=(QbPurchaseOrderLine(id="L1", item_id="ITEM-PART"),),
    )
    kwargs = {} if operation == "create" else dict(
        operation=operation, existing=existing, qb_line_id_by_line={"line-1": "L1"})
    body = builder(po, **kwargs)
    assert FORBIDDEN_KEYS.isdisjoint(set(_keys(body)))


# ───────────────────────── descriptions ─────────────────────────
def test_part_line_description_carries_part_vendor_pn_unit_and_job():
    po = _po(lines=[_part_line()])
    assert pom.describe_line(po.lines[0], max_length=4000) == (
        "BRKT-100 — 6061-T6 1.0in bar · Vendor P/N 88-120 · Unit: bar (= 144 inches) · Job J-0141"
    )


def test_outside_line_description_does_not_repeat_what_it_already_says():
    po = _po(lines=[_outside_line()])
    assert pom.describe_line(po.lines[0], max_length=4000) == (
        "Anodize Type II — BRKT-100 — Job J-0141, Op 30 · Unit: each"
    )


def test_outside_line_description_adds_the_part_job_and_op_when_missing():
    """A shop that shortens the line to "Anodize Type II" still gets the part and the
    job/op in QuickBooks, because that is what the bookkeeper bills against."""
    po = _po(lines=[_outside_line(description="Anodize Type II")])
    assert pom.describe_line(po.lines[0], max_length=4000) == (
        "Anodize Type II · Part BRKT-100 · Unit: each · Job J-0141 op 30"
    )


def test_other_line_description_names_the_machine():
    po = _po(lines=[_other_line()])
    assert pom.describe_line(po.lines[0], max_length=4000) == (
        "Spindle rebuild · Machine: Haas VF-2 · Unit: each"
    )


def test_per_100_pricing_reads_as_a_hundred_of_each():
    po = _po(lines=[_part_line(unit="hundred", stock_unit="each", stock_factor=100,
                               description="", vendor_part_number=None, job_number=None,
                               part_name="SCREW-10")])
    assert pom.describe_line(po.lines[0], max_length=4000) == "SCREW-10 · Unit: hundred (= 100 each)"


def test_descriptions_are_capped_per_provider():
    po = _po(lines=[_part_line(description="d" * 5000)])
    assert len(_qbo(po)["Line"][0]["Description"]) == 4000
    assert len(_qbd(po)["lines"][0]["description"]) == 4095


# ───────────────────────── update, close, reopen (QB8) ─────────────────────────
def _state(lines, *, token="4", closed=False, fully_received=False):
    return QbPurchaseOrderState(id="QB-77", sync_token=token, doc_number="PO-1042",
                                lines=tuple(lines), closed=closed, fully_received=fully_received)


def test_qbo_update_is_sparse_with_the_full_line_array():
    """Every mapped line keeps its Line.Id, a new line carries none, and a removed
    line is simply absent. Sparse rather than full so the class and custom fields
    the bookkeeper set in QuickBooks survive (UNVERIFIED until manual check M-1)."""
    po = _po(lines=[_part_line(quantity=5), _part_line(id="line-4", line_number=4)])
    state = _state([QbPurchaseOrderLine(id="QL-1", item_id="ITEM-PART"),
                    QbPurchaseOrderLine(id="QL-2", item_id="ITEM-OUT")])
    body = _qbo(po, operation="update", existing=state,
                qb_line_id_by_line={"line-1": "QL-1", "line-2": "QL-2"})
    assert body["Id"] == "QB-77"
    assert body["SyncToken"] == "4"
    assert body["sparse"] is True
    assert [ln.get("Id") for ln in body["Line"]] == ["QL-1", None]
    assert body["Line"][0]["ItemBasedExpenseLineDetail"]["Qty"] == 5
    assert all(ln.get("Id") != "QL-2" for ln in body["Line"])
    assert "POStatus" not in body


def test_qbd_update_sends_the_revision_existing_ids_and_minus_one_for_new_lines():
    po = _po(lines=[_part_line(quantity=5), _part_line(id="line-4", line_number=4)])
    state = _state([QbPurchaseOrderLine(id="DL-1", item_id="ITEM-PART")], token="1721172183")
    body = _qbd(po, operation="update", existing=state, qb_line_id_by_line={"line-1": "DL-1"})
    assert body["revisionNumber"] == "1721172183"
    assert [ln["id"] for ln in body["lines"]] == ["DL-1", "-1"]
    assert "externalId" not in body  # immutable on QuickBooks Desktop
    assert "vendorId" not in body    # the vendor is locked once a PO is sent


def test_qbd_update_closes_short_closed_lines_at_line_level():
    po = _po(lines=[_part_line(closed_at="2026-11-12T00:00:00Z"), _part_line(id="line-4", line_number=4)])
    state = _state([QbPurchaseOrderLine(id="DL-1", item_id="ITEM-PART")])
    body = _qbd(po, operation="update", existing=state, qb_line_id_by_line={"line-1": "DL-1"})
    assert body["lines"][0]["isManuallyClosed"] is True
    assert "isManuallyClosed" not in body["lines"][1]


def test_qbd_update_reopens_a_line_quickbooks_closed_unless_it_is_fully_received():
    """isManuallyClosed cannot go back to false once a line is fully received, so it
    is sent only where QuickBooks will accept it."""
    po = _po(lines=[_part_line(), _part_line(id="line-4", line_number=4)])
    state = _state([
        QbPurchaseOrderLine(id="DL-1", item_id="ITEM-PART", quantity=Decimal(3), closed=True),
        QbPurchaseOrderLine(id="DL-4", item_id="ITEM-PART", quantity=Decimal(3),
                            received_quantity=Decimal(3), closed=True),
    ])
    body = _qbd(po, operation="update", existing=state,
                qb_line_id_by_line={"line-1": "DL-1", "line-4": "DL-4"})
    assert body["lines"][0]["isManuallyClosed"] is False
    assert "isManuallyClosed" not in body["lines"][1]


def test_qbo_header_only_close_and_reopen_bodies():
    state = _state([QbPurchaseOrderLine(id="QL-1", item_id="ITEM-PART")])
    close = _qbo(_po(status="closed"), operation="close", existing=state, include_content=False)
    assert close == {"Id": "QB-77", "SyncToken": "4", "sparse": True, "POStatus": "Closed"}
    reopen = _qbo(_po(), operation="reopen", existing=state, include_content=False)
    assert reopen == {"Id": "QB-77", "SyncToken": "4", "sparse": True, "POStatus": "Open"}


def test_qbd_header_only_close_and_reopen_bodies():
    state = _state([QbPurchaseOrderLine(id="DL-1", item_id="ITEM-PART")], token="9")
    assert _qbd(_po(status="closed"), operation="close", existing=state,
                include_content=False) == {"revisionNumber": "9", "isManuallyClosed": True}
    assert _qbd(_po(), operation="reopen", existing=state,
                include_content=False) == {"revisionNumber": "9", "isManuallyClosed": False}


def test_a_close_with_content_changes_sends_both():
    state = _state([QbPurchaseOrderLine(id="QL-1", item_id="ITEM-PART")])
    body = _qbo(_po(lines=[_part_line(quantity=2)], status="closed"), operation="close",
                existing=state, qb_line_id_by_line={"line-1": "QL-1"})
    assert body["POStatus"] == "Closed"
    assert body["Line"][0]["Id"] == "QL-1"


@pytest.mark.parametrize("builder", [_qbo, _qbd])
def test_an_update_without_the_state_just_read_is_refused(builder):
    """Update, close and reopen build on the token and line ids READ inside the same
    click; building one without them would send a stale token or invent line ids."""
    with pytest.raises(ValueError):
        builder(_po(), operation="update", existing=None)


# ───────────────────────── refusals and purity ─────────────────────────
@pytest.mark.parametrize("builder", [_qbo, _qbd])
def test_an_unpriced_line_raises(builder):
    """The route refuses an unpriced PO with a sentence first; this is the backstop
    that keeps a "to be confirmed" line from ever reaching QuickBooks as $0."""
    with pytest.raises(ValueError):
        builder(_po(lines=[_part_line(unit_price=None)]))


@pytest.mark.parametrize("builder", [_qbo, _qbd])
def test_a_zero_price_is_sent(builder):
    body = builder(_po(lines=[_part_line(unit_price=0)]))
    assert body  # built, not refused


def test_the_builders_do_no_io(monkeypatch):
    """QB12: every network and database path is patched to raise; building both
    providers' payloads must still succeed."""
    def _boom(*a, **k):
        raise AssertionError("a payload builder did I/O")

    monkeypatch.setattr(httpx, "Client", _boom)
    monkeypatch.setattr(qb, "qb_request", _boom)
    monkeypatch.setattr(qb, "qb_query", _boom)
    monkeypatch.setattr(qbd, "_request", _boom)
    monkeypatch.setattr(qbd, "_list", _boom)
    assert _qbo()["Line"]
    assert _qbd()["lines"]
    state = _state([QbPurchaseOrderLine(id="L1", item_id="ITEM-PART")])
    assert _qbo(operation="update", existing=state, qb_line_id_by_line={"line-1": "L1"})
    assert _qbd(operation="update", existing=state, qb_line_id_by_line={"line-1": "L1"})


# ───────────────────────── the shared amount fixture (P7) ─────────────────────────
def _amount_cases() -> list[dict]:
    assert AMOUNT_FIXTURE.exists(), (
        f"{AMOUNT_FIXTURE} is missing. It is the one fixture SQL, TypeScript and this "
        "builder all agree on (plan §3.5); do not replace it with local cases."
    )
    data = json.loads(AMOUNT_FIXTURE.read_text(encoding="utf-8"))
    cases = data["cases"] if isinstance(data, dict) else data
    assert cases, "vendorPoAmountCases.json has no cases"
    return cases


def test_line_amount_matches_the_shared_fixture():
    for case in _amount_cases():
        got = pom.line_amount(case["quantity"], case["unit_price"])
        assert got == Decimal(str(case["amount"])), case


def test_qbo_amount_is_the_shared_rule():
    for case in _amount_cases():
        po = _po(lines=[_part_line(quantity=case["quantity"], unit_price=case["unit_price"])])
        assert Decimal(str(_qbo(po)["Line"][0]["Amount"])) == Decimal(str(case["amount"])), case
