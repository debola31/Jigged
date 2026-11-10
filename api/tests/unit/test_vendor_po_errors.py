"""How a vendor-PO push reads QuickBooks' failures, and what it tells the shop.

Two questions decide every failure:

  * Is it something the shop can fix (a 409 with a sentence saying where, kept out of
    Sentry), or something only Jigged can fix (a 502 that files an issue)?
  * Did the write maybe happen? A QuickBooks Online transport error or 5xx is
    AMBIGUOUS -- the next attempt reuses the same request id, which Intuit
    deduplicates. A 4xx is REJECTED -- the next attempt gets a new id.

Fault codes marked UNVERIFIED are from Intuit's published list or third-party reports,
not yet captured from the sandbox; manual check M-1 records the real fixtures and these
cases are replaced, not added to. Until then an unknown fault falls to 502.

Criteria: QB4 (request-id rules), QB10 (every error-map row: status, code, sentence).
"""
import sys
from pathlib import Path

import httpx
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

import services.accounting.purchase_order as pom  # noqa: E402
import services.quickbooks as qb  # noqa: E402
import services.quickbooks_desktop as qbd  # noqa: E402
import services.quickbooks_desktop_purchasing as qbdp  # noqa: E402
import services.quickbooks_purchasing as qbp  # noqa: E402

pytestmark = pytest.mark.unit

# The plan's error map (§3.11), in its order. A code added in code but not here, or
# here but not in code, fails test_the_error_codes_are_exactly_the_plans.
PLAN_CODES = [
    "qb_not_connected", "qbd_offline", "qbo_purchase_orders_unavailable", "qbo_busy",
    "vendor_po_draft", "vendor_po_unsent_revision", "vendor_po_archived",
    "vendor_po_line_unpriced", "qbd_po_number_too_long",
    "qb_setup_required", "qb_item_name_taken", "qb_reference_inactive",
    "qb_vendor_choice_required", "qb_vendor_name_invalid", "qb_vendor_name_taken",
    "qb_vendor_inactive",
    "qb_po_missing", "qb_foreign_lines", "qb_line_in_use", "qb_cannot_reopen",
    "qb_changed_in_quickbooks",
    "qbd_verify", "qbd_blocked_unverified",
]

SAMPLE_CONTEXT = {
    "po_number": "PO-1042", "vendor": "Acme Anodizing", "revision": 2, "line_number": 3,
    "length": 12, "name": "Acme Anodizing", "problem": "it contains a colon",
    "account": "Job Materials", "quantity": "40", "missing": "the item for outside services",
}

# UNVERIFIED: code 9334 and this message come from integration vendors' help pages
# (Flex Rental Solutions, ProcureDesk), not from Intuit or the sandbox. M-1 captures
# the real fault; this fixture is then replaced with it.
NOT_ENABLED_FAULT = {
    "Fault": {
        "Error": [{"Message": "PurchaseOrder is not enabled", "Detail": "PurchaseOrder is not enabled",
                   "code": "9334", "element": ""}],
        "type": "ValidationFault",
    },
    "time": "2026-11-09T10:00:00.000-08:00",
}


def _fault(code, message="", detail="", status=400):
    return qb.QuickBooksApiError(
        f"QuickBooks API error ({status})", status=status,
        fault={"Fault": {"Error": [{"Message": message, "Detail": detail, "code": code}],
                         "type": "ValidationFault"}},
    )


# ───────────────────────── QuickBooks Online faults (QB10) ─────────────────────────
def test_6240_duplicate_name_is_a_name_taken():
    """DisplayName is unique across vendors, customers AND employees, so a 6240 on a
    vendor create usually means a customer holds the name (create_vendor re-queries
    first, to tell an existing or inactive vendor apart)."""
    assert qbp.classify_qbo_fault(_fault("6240", "Duplicate Name Exists Error")) == "qb_vendor_name_taken"


def test_6140_duplicate_doc_number_reaches_sentry():
    """Every create is sent with include=allowduplicatedocnum, matching Desktop's
    silent duplicates. A 6140 therefore means that assumption broke, which is ours
    to fix -- so it is NOT a shop-fixable 409."""
    assert qbp.classify_qbo_fault(_fault("6140", "Duplicate Document Number Error")) is None


def test_5010_stale_object_is_changed_in_quickbooks():
    assert qbp.classify_qbo_fault(_fault("5010", "Stale Object Error")) == "qb_changed_in_quickbooks"


def test_610_object_not_found_is_an_inactive_reference():
    """Intuit: "Something you're trying to use has been made inactive"."""
    assert qbp.classify_qbo_fault(_fault("610", "Object Not Found")) == "qb_reference_inactive"


def test_429_is_busy_whatever_the_body_says():
    exc = qb.QuickBooksApiError("QuickBooks API error (429)", status=429, fault="<html>Too Many</html>")
    assert qbp.classify_qbo_fault(exc) == "qbo_busy"


def test_the_not_enabled_fault_means_purchase_orders_are_off():
    exc = qb.QuickBooksApiError("QuickBooks API error (400)", status=400, fault=NOT_ENABLED_FAULT)
    assert qbp.classify_qbo_fault(exc) == "qbo_purchase_orders_unavailable"


def test_an_unknown_fault_is_not_classified_and_falls_to_502():
    assert qbp.classify_qbo_fault(_fault("6000", "A business validation error has occurred")) is None
    assert qbp.classify_qbo_fault(RuntimeError("boom")) is None


def test_lowercase_fault_envelopes_are_read_too():
    """Intuit's auth layer answers with {"fault": {"error": [...]}} in lower case."""
    exc = qb.QuickBooksApiError("x", status=400,
                                fault={"fault": {"error": [{"code": "5010", "message": "Stale"}]}})
    assert qbp.classify_qbo_fault(exc) == "qb_changed_in_quickbooks"


# ───────────────────────── ambiguous vs rejected (QB4) ─────────────────────────
def test_a_transport_error_is_ambiguous():
    """`QuickBooksApiError` with no status is what _do_qb_request raises when the
    connection broke -- the request may have reached Intuit."""
    assert qbp.failure_kind(qb.QuickBooksApiError("QuickBooks request failed: reset")) == "ambiguous"


@pytest.mark.parametrize("status", [500, 502, 503, 504])
def test_a_5xx_is_ambiguous(status):
    assert qbp.failure_kind(_fault("", status=status)) == "ambiguous"


@pytest.mark.parametrize("status", [400, 401, 403, 404])
def test_a_4xx_is_rejected(status):
    assert qbp.failure_kind(_fault("6000", status=status)) == "rejected"


def test_a_429_is_rejected_because_nothing_was_processed():
    assert qbp.failure_kind(_fault("", status=429)) == "rejected"


def test_not_connected_is_rejected():
    assert qbp.failure_kind(qb.QuickBooksNotConnected("reconnect")) == "rejected"


def test_a_shop_fixable_refusal_is_rejected():
    assert qbp.failure_kind(pom.PurchasingRefusal("qb_vendor_name_taken", name="Acme")) == "rejected"


# ───────────────────────── QuickBooks Desktop (QB5, QB10) ─────────────────────────
def _conductor(status, code, message="boom", integration_code=None):
    body = {"error": {"message": message, "userFacingMessage": message,
                      "type": "INTEGRATION_ERROR", "code": code, "httpStatusCode": status,
                      "integrationCode": integration_code, "requestId": "req_9"}}
    return httpx.Response(status, json=body, request=httpx.Request("POST", "https://x"))


def test_a_desktop_write_timeout_names_a_purchase_order(monkeypatch):
    monkeypatch.setenv("CONDUCTOR_API_KEY", "sk_test")
    with pytest.raises(qbd.QbdUnknownOutcome, match="purchase order"):
        qbd._raise_for_error(_conductor(504, "QBD_REQUEST_TIMEOUT"), is_write=True,
                             noun="purchase order")


def test_the_invoice_wording_is_unchanged_by_default():
    """The invoice path reads these messages; parameterising the noun must not move
    a single word of what it already says."""
    with pytest.raises(qbd.QbdUnknownOutcome) as exc:
        qbd._raise_for_error(_conductor(504, "QBD_REQUEST_TIMEOUT"), is_write=True)
    assert str(exc.value) == "We couldn't confirm whether QuickBooks recorded that invoice."


def test_a_lost_connection_on_a_desktop_write_names_a_purchase_order(monkeypatch):
    monkeypatch.setenv("CONDUCTOR_API_KEY", "sk_test")

    class _Dead:
        def __init__(self, *a, **k):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def request(self, *a, **k):
            raise httpx.ConnectError("reset")

    monkeypatch.setattr(qbd.httpx, "Client", _Dead)
    with pytest.raises(qbd.QbdUnknownOutcome, match="purchase order"):
        qbd._request("POST", "/purchase-orders", end_user_id="eu", json_body={},
                     is_write=True, noun="purchase order")


def test_a_desktop_read_timeout_stays_retryable():
    with pytest.raises(qbd.QbdApiError):
        qbd._raise_for_error(_conductor(504, "QBD_REQUEST_TIMEOUT"), is_write=False,
                             noun="purchase order")


def test_offline_and_not_set_up_are_unchanged():
    with pytest.raises(qbd.QbdOffline):
        qbd._raise_for_error(_conductor(409, "INTEGRATION_CONNECTION_NOT_ACTIVE"), is_write=True,
                             noun="purchase order")
    with pytest.raises(qbd.QbdNotConnected):
        qbd._raise_for_error(_conductor(409, "INTEGRATION_CONNECTION_NOT_SET_UP"), is_write=True,
                             noun="purchase order")


def test_a_stale_desktop_revision_is_changed_in_quickbooks():
    """UNVERIFIED: 3200 is the qbXML SDK's "edit sequence is out-of-date". M-2
    captures Conductor's real envelope for it."""
    exc = qbd.QbdApiError("The provided edit sequence \"1\" is out-of-date.",
                          code="QBD_REQUEST_ERROR", integration_code="3200")
    assert qbdp.classify_qbd_error(exc) == "qb_changed_in_quickbooks"
    by_text = qbd.QbdApiError("The provided edit sequence \"1\" is out-of-date.")
    assert qbdp.classify_qbd_error(by_text) == "qb_changed_in_quickbooks"


def test_an_invalid_desktop_reference_is_an_inactive_reference():
    exc = qbd.QbdApiError("There is an invalid reference to QuickBooks Vendor \"X\".",
                          code="QBD_REQUEST_ERROR", integration_code="3140")
    assert qbdp.classify_qbd_error(exc) == "qb_reference_inactive"


def test_an_unknown_desktop_rejection_falls_to_502():
    assert qbdp.classify_qbd_error(qbd.QbdApiError("Item name too long")) is None


@pytest.mark.parametrize(
    "exc, expected",
    [
        (qbd.QbdApiError("x", integration_code="500"), True),
        (qbd.QbdApiError("x", integration_code="3120"), True),
        (qbd.QbdApiError("Object \"8000\" specified in the request cannot be found."), True),
        (qbd.QbdApiError("There was a required element that could not be found in QuickBooks."), True),
        (qbd.QbdApiError("Item name too long"), False),
    ],
)
def test_a_missing_desktop_po_is_recognised(exc, expected):
    """A PO deleted in QuickBooks reads back as None, which the push turns into
    qb_po_missing with nothing written. UNVERIFIED shape until M-2."""
    assert qbdp.is_not_found(exc) is expected


# ───────────────────────── every code has a sentence (QB10) ─────────────────────────
def test_the_error_codes_are_exactly_the_plans():
    assert list(pom.PO_ERROR_CODES) == PLAN_CODES
    assert set(pom.PO_ERROR_SENTENCES) == set(PLAN_CODES)


@pytest.mark.parametrize("code", PLAN_CODES)
def test_every_code_has_a_sentence_saying_where_to_fix_it(code):
    message = pom.po_error_message(code, **SAMPLE_CONTEXT)
    assert message.strip()
    assert "{" not in message and "}" not in message, message
    assert message.endswith("."), message
    # Each sentence names somewhere to go: QuickBooks, a Jigged page, or a retry.
    assert any(place in message for place in (
        "QuickBooks", "Settings", "Purchasing page", "on the PO", "try again", "Try again",
        "Check again", "Mark as sent",
    )), message


def test_an_unknown_code_is_a_bug_not_a_blank_sentence():
    with pytest.raises(KeyError):
        pom.po_error_message("qb_made_up_code")


def test_a_refusal_carries_its_code_sentence_and_extra_fields():
    refusal = pom.PurchasingRefusal("qb_vendor_choice_required", name="Acme",
                                    extra={"candidates": [{"qb_id": "1", "display_name": "Acme Inc"}]})
    assert refusal.code == "qb_vendor_choice_required"
    assert "Acme" in refusal.message
    assert refusal.extra["candidates"][0]["qb_id"] == "1"
    assert refusal.detail() == {
        "code": "qb_vendor_choice_required", "message": refusal.message,
        "candidates": [{"qb_id": "1", "display_name": "Acme Inc"}],
    }
