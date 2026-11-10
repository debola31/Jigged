"""Finding out whether a QuickBooks Desktop write landed, and searching vendors safely.

Conductor has no idempotency key, and a create aborted client-side at 1s was MEASURED
to still produce a document (docs/modules/quickbooks-desktop.md). So an unknown outcome
is never retried: it is probed ONCE, then adopted or parked for a human (QB5).

The probe and the vendor search must also never use a filter that turns "not found"
into a failed request. Conductor documents that `ids` and `refNumbers` fail the WHOLE
request when any value is missing, and `names`/`fullNames` behave the same way (QB6).

Criteria: QB5, QB6.
"""
import sys
from decimal import Decimal
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

import services.quickbooks as qb  # noqa: E402
import services.quickbooks_desktop as qbd  # noqa: E402
import services.quickbooks_desktop_purchasing as qbdp  # noqa: E402
import services.quickbooks_purchasing as qbp  # noqa: E402
from services.accounting.base import (  # noqa: E402
    PushedPurchaseOrder,
    QbPurchaseOrderLine,
    QbPurchaseOrderState,
)

pytestmark = pytest.mark.unit

LOOKUP_FILTERS = {"ids", "refNumbers", "names", "fullNames", "refNumber"}


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    monkeypatch.setenv("QUICKBOOKS_ENVIRONMENT", "sandbox")
    monkeypatch.setenv("CONDUCTOR_API_KEY", "sk_conductor_test")
    monkeypatch.delenv("QUICKBOOKS_FAKE", raising=False)


# ───────────────────────── the create probe (QB5) ─────────────────────────
def test_the_probe_lists_by_vendor_and_a_one_day_window_and_matches_external_id(monkeypatch):
    calls = []

    def _fake_list(path, end_user_id, params):
        calls.append((path, end_user_id, dict(params)))
        return [
            {"id": "A", "externalId": "someone-else", "refNumber": "PO-1041"},
            {"id": "B", "externalId": "want", "refNumber": "PO-1042", "revisionNumber": "17",
             "isManuallyClosed": False, "lines": [{"id": "L1"}, {"id": "L2"}]},
        ]

    monkeypatch.setattr(qbd, "_list", _fake_list)
    found = qbdp.find_created_purchase_order(
        "eu_1", qb_vendor_id="80000001-1", transaction_date="2026-11-09", external_id="want"
    )
    assert found == PushedPurchaseOrder(id="B", doc_number="PO-1042", sync_token="17",
                                        line_ids=("L1", "L2"), closed=False)
    assert len(calls) == 1, "the probe runs exactly once"
    path, end_user, params = calls[0]
    assert path == "/purchase-orders"
    assert end_user == "eu_1"
    assert params["vendorIds"] == "80000001-1"
    assert params["transactionDateFrom"] == params["transactionDateTo"] == "2026-11-09"
    assert LOOKUP_FILTERS.isdisjoint(params)
    assert set(params) <= {"vendorIds", "transactionDateFrom", "transactionDateTo", "limit"}


def test_the_probe_returns_none_when_nothing_carries_the_attempt_id(monkeypatch):
    monkeypatch.setattr(qbd, "_list", lambda *a, **k: [{"id": "A", "externalId": "other"}])
    assert qbdp.find_created_purchase_order(
        "eu_1", qb_vendor_id="V", transaction_date="2026-11-09", external_id="want"
    ) is None


def test_the_provider_cannot_probe_without_the_vendor_and_date(monkeypatch):
    """The window is what keeps the list small enough to match client-side; without
    it the probe would page the whole company file."""
    from services.accounting.qbd import QbdProvider

    monkeypatch.setattr(qbd, "_list", lambda *a, **k: pytest.fail("probed without a window"))
    provider = QbdProvider(None, "co-1", {"conductor_end_user_id": "eu_1", "environment": "sandbox"})
    assert provider.find_created_purchase_order({"qb_request_id": "r", "qb_vendor_id": None,
                                                 "transaction_date": "2026-11-09"}) is None
    assert provider.find_created_purchase_order({"qb_request_id": "r", "qb_vendor_id": "V",
                                                 "transaction_date": None}) is None


def test_quickbooks_online_never_needs_the_probe():
    """?requestid= makes a replayed create return the original PO."""
    from services.accounting.qbo import QboProvider

    assert QboProvider(None, "co-1", {"realm_id": "r"}).find_created_purchase_order(
        {"qb_request_id": "r"}) is None


# ───────────────────────── the update probe (QB5) ─────────────────────────
def _state(token, lines):
    return QbPurchaseOrderState(
        id="QB-1", sync_token=token, doc_number="PO-1042",
        lines=tuple(QbPurchaseOrderLine(id=f"L{i}", item_id="I", quantity=Decimal(q), rate=Decimal(r))
                    for i, (q, r) in enumerate(lines, start=1)),
    )


SENT = [(Decimal("3"), Decimal("41.50000")), (Decimal("100"), Decimal("1.25"))]


def test_an_update_whose_token_did_not_move_did_not_land():
    assert qbdp.decide_update_probe(_state("4", [("3", "41.5")]), sent_token="4",
                                    expected_lines=SENT) == "release"


def test_an_update_whose_token_moved_with_the_lines_we_sent_is_adopted():
    assert qbdp.decide_update_probe(_state("5", [("3", "41.5"), ("100", "1.25")]), sent_token="4",
                                    expected_lines=SENT) == "adopt"


@pytest.mark.parametrize("lines", [
    [("3", "41.5")],                          # a line short
    [("3", "41.5"), ("90", "1.25")],          # a quantity that is not ours
    [("3", "41.5"), ("100", "1.30")],         # a rate that is not ours
])
def test_a_token_that_moved_to_something_else_is_parked(lines):
    """Someone else changed it, or it half-landed: a human must look."""
    assert qbdp.decide_update_probe(_state("5", lines), sent_token="4", expected_lines=SENT) == "park"


def test_a_po_that_vanished_or_unknown_lines_are_parked():
    assert qbdp.decide_update_probe(None, sent_token="4", expected_lines=SENT) == "park"
    assert qbdp.decide_update_probe(_state("5", [("3", "41.5")]), sent_token="4",
                                    expected_lines=None) == "park"


def test_expected_lines_come_from_the_payload_that_was_sent():
    payload = {"lines": [{"id": "L1", "quantity": 3, "rate": "41.50000"},
                         {"id": "-1", "quantity": 100, "rate": "1.25000"}]}
    assert qbdp.expected_lines(payload) == SENT


# ───────────────────────── vendor search (QB6) ─────────────────────────
def test_desktop_vendor_search_uses_name_contains_only(monkeypatch):
    seen = []

    def _fake_list(path, end_user_id, params):
        seen.append((path, dict(params)))
        return []

    monkeypatch.setattr(qbd, "_list", _fake_list)
    assert qbdp.find_vendor_candidates("eu", "Acme Anodizing") == {
        "status": "unmatched", "qb_vendor_id": None, "candidates": []}
    assert len(seen) == 1
    path, params = seen[0]
    assert path == "/vendors"
    assert params["nameContains"] == "Acme Anodizing"
    assert LOOKUP_FILTERS.isdisjoint(params)


def test_desktop_exact_name_is_found_among_contains_results(monkeypatch):
    monkeypatch.setattr(qbd, "_list", lambda *a, **k: [
        {"id": "A", "name": "Acme Anodizing and Plating"},
        {"id": "B", "name": "acme anodizing"},
    ])
    res = qbdp.find_vendor_candidates("eu", "Acme Anodizing")
    assert res["status"] == "exact_match"
    assert res["qb_vendor_id"] == "B"


def test_desktop_similar_names_are_candidates_never_a_guess(monkeypatch):
    monkeypatch.setattr(qbd, "_list", lambda *a, **k: [
        {"id": "A", "name": "Acme Anodizing and Plating"},
    ])
    res = qbdp.find_vendor_candidates("eu", "Acme Anodizing")
    assert res == {"status": "candidates", "qb_vendor_id": None,
                   "candidates": [{"qb_id": "A", "display_name": "Acme Anodizing and Plating"}]}


def test_online_vendor_search_queries_display_name_exact_then_like(monkeypatch):
    queries = []

    def _fake_query(db, company_id, query):
        queries.append(query)
        return {}

    monkeypatch.setattr(qb, "qb_query", _fake_query)
    res = qbp.find_vendor_candidates(None, "co-1", "O'Brien Plating")
    assert res["status"] == "unmatched"
    assert queries == [
        "select * from Vendor where DisplayName = 'O\\'Brien Plating'",
        "select * from Vendor where DisplayName LIKE '%O\\'Brien Plating%' MAXRESULTS 10",
    ]


def test_online_exact_vendor_is_matched_without_the_fuzzy_query(monkeypatch):
    queries = []

    def _fake_query(db, company_id, query):
        queries.append(query)
        return {"Vendor": [{"Id": "56", "DisplayName": "Acme Anodizing"}]}

    monkeypatch.setattr(qb, "qb_query", _fake_query)
    res = qbp.find_vendor_candidates(None, "co-1", "Acme Anodizing")
    assert res == {"status": "exact_match", "qb_vendor_id": "56",
                   "candidates": [{"qb_id": "56", "display_name": "Acme Anodizing"}]}
    assert len(queries) == 1
