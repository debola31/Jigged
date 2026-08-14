"""QuickBooks Desktop service: the pure transform, the field caps, and the error
classifier.

Several of these assert behaviour that was MEASURED against QuickBooks Desktop
Enterprise 24 on 2026-08-10 rather than read from documentation -- in two cases
the documentation was wrong. Where that is so, the test says which observation it
pins, because the next person to "simplify" one of these will otherwise be
reverting a bug fix they cannot see.
"""
import sys
from pathlib import Path

import httpx
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

import services.quickbooks_desktop as qbd  # noqa: E402

pytestmark = pytest.mark.unit


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    monkeypatch.setenv("QUICKBOOKS_ENVIRONMENT", "sandbox")
    monkeypatch.setenv("CONDUCTOR_API_KEY", "sk_conductor_test")
    monkeypatch.setenv("CONDUCTOR_PUBLISHABLE_KEY", "pk_conductor_test")
    monkeypatch.delenv("QUICKBOOKS_FAKE", raising=False)


def _payload(**over):
    base = dict(
        customer_id="800000D0-1182061376",
        item_id="10000-933272655",
        transaction_date="2026-08-10",
        external_id="3f8a1c22-0000-4000-8000-abcdef123456",
        lines=[{"quantity": 3, "unit_price": 12.5, "part_name": "Bracket",
                "description": "Rev C"}],
    )
    base.update(over)
    return qbd.job_to_qbd_invoice_payload(**base)


# ───────────────────────── the pure payload ─────────────────────────
def test_payload_sends_no_ref_number():
    """MEASURED: posting with no refNumber made QuickBooks assign the next one
    itself (file max 1098 -> we got 1100). Conductor's docs claim a blank
    refNumber stays blank; on Enterprise 24 it does not. Sending one would make
    Jigged fight the shop's own numbering for no gain."""
    assert "refNumber" not in _payload()


def test_payload_line_sends_rate_and_never_amount():
    """Conductor ignores `rate` when `amount` is present, which would erase the
    unit price and print a lump sum. AP reconciles qty x unit price against a PO."""
    line = _payload()["lines"][0]
    assert line["rate"] == "12.50000"
    assert line["quantity"] == 3
    assert "amount" not in line


def test_payload_omits_tax_code_when_the_customer_has_none():
    assert "salesTaxCodeId" not in _payload()["lines"][0]


def test_payload_carries_the_customers_tax_code_onto_every_line():
    """MEASURED: a line with NO salesTaxCodeId defaulted to `Non` and was NOT
    taxed, even for a customer whose record read `Tax` with the header showing
    7.75%. Sending the code produced the tax. Omitting it under-bills a taxable
    sale -- the direction that costs the shop money."""
    p = _payload(sales_tax_code_id="10000-999022286")
    assert all(l["salesTaxCodeId"] == "10000-999022286" for l in p["lines"])


def test_payload_requires_a_transaction_date():
    """QBO derives TxnDate server-side; QuickBooks Desktop requires it."""
    assert _payload()["transactionDate"] == "2026-08-10"


def test_payload_external_id_is_the_recovery_key():
    p = _payload()
    assert p["externalId"] == "3f8a1c22-0000-4000-8000-abcdef123456"


def test_payload_uses_the_native_po_field_and_no_custom_field():
    p = _payload(customer_po_number="PO-789")
    assert p["purchaseOrderNumber"] == "PO-789"
    assert "customFields" not in p and "CustomField" not in p


def test_payload_truncates_a_long_po_to_the_quickbooks_cap():
    p = _payload(customer_po_number="P" * 40)
    assert len(p["purchaseOrderNumber"]) == qbd.PO_NUMBER_MAX


def test_payload_line_description_carries_part_and_po():
    p = _payload(customer_po_number="PO-789")
    assert p["lines"][0]["description"] == "Bracket — Rev C (PO Number: PO-789)"


def test_payload_memo_is_internal_only():
    """Conductor documents that memo does not print, so it is the QBD analogue of
    QBO's PrivateNote: traceability and QuickBooks-side search, not customer copy."""
    p = _payload(job_number="J-1042", customer_po_number="PO-789")
    assert p["memo"] == "Jigged job J-1042 · PO Number: PO-789"


def test_payload_omits_terms_when_unresolved():
    """Absent, not null. MEASURED: an invoice sent with no term came back with the
    customer's own default (Net 15) and a matching due date, which is the correct
    fallback -- so a mistyped term must not block the push."""
    assert "termsId" not in _payload()


def test_payload_raises_when_a_line_has_no_price():
    with pytest.raises(qbd.QbdApiError):
        _payload(lines=[{"quantity": 1, "unit_price": None, "part_name": "X"}])


# ───────────────────────── customers ─────────────────────────
def test_create_customer_refuses_a_name_over_the_cap(monkeypatch):
    """Truncating is NOT acceptable here. Two different customers can share their
    first 41 characters, and a truncation collision silently invoices the wrong
    company. A term may be truncated -- a term is a label; a customer is an
    identity."""
    monkeypatch.setattr(qbd, "_request", lambda *a, **k: pytest.fail("must not call out"))
    with pytest.raises(qbd.QbdApiError, match="41-character"):
        qbd.create_customer("end_usr_x", "A" * 42)


# ───────────────────────── error classification ─────────────────────────
def _resp(status, code=None, message="boom", friendly=None):
    body = {"error": {"message": message, "userFacingMessage": friendly or message,
                      "type": "INTEGRATION_CONNECTION_ERROR", "code": code,
                      "httpStatusCode": status, "requestId": "req_123"}}
    return httpx.Response(status, json=body, request=httpx.Request("GET", "https://x"))


def test_connection_not_active_is_offline_not_an_api_error():
    """Offline is a 409 the UI renders as a warning with a retry, and it is never
    reported to Sentry: only the end user can fix a closed laptop, and alerting
    would page us for it."""
    with pytest.raises(qbd.QbdOffline):
        qbd._raise_for_error(_resp(409, "INTEGRATION_CONNECTION_NOT_ACTIVE"), is_write=False)


def test_qbd_connection_error_is_also_offline():
    with pytest.raises(qbd.QbdOffline):
        qbd._raise_for_error(_resp(409, "QBD_CONNECTION_ERROR"), is_write=False)


def test_not_set_up_is_not_connected():
    with pytest.raises(qbd.QbdNotConnected):
        qbd._raise_for_error(_resp(409, "INTEGRATION_CONNECTION_NOT_SET_UP"), is_write=False)


def test_timeout_on_a_write_is_an_unknown_outcome():
    """The same wire error means different things by direction. MEASURED: a create
    aborted client-side at 1s still produced an invoice, so a write timeout is
    'unknown', never 'failed' -- and must never be auto-retried."""
    with pytest.raises(qbd.QbdUnknownOutcome):
        qbd._raise_for_error(_resp(504, "QBD_REQUEST_TIMEOUT"), is_write=True)


def test_timeout_on_a_read_is_merely_retryable():
    with pytest.raises(qbd.QbdApiError):
        qbd._raise_for_error(_resp(504, "QBD_REQUEST_TIMEOUT"), is_write=False)


def test_auth_failure_is_service_unavailable_not_a_user_error():
    """A rejected key is OUR misconfiguration; it must not read to a shop as
    'QuickBooks refused you'."""
    with pytest.raises(qbd.QbdServiceUnavailable):
        qbd._raise_for_error(_resp(401, "UNAUTHORIZED"), is_write=False)


def test_business_rule_rejection_keeps_the_support_handle():
    with pytest.raises(qbd.QbdApiError) as exc:
        qbd._raise_for_error(_resp(400, "QBD_REQUEST_ERROR", friendly="Item name too long"),
                             is_write=True)
    assert exc.value.request_id == "req_123"
    assert "Item name too long" in str(exc.value)


def test_success_does_not_raise():
    qbd._raise_for_error(httpx.Response(200, json={}, request=httpx.Request("GET", "https://x")),
                         is_write=True)


# ───────────────────────── config ─────────────────────────
def test_production_requires_its_own_keys_with_no_fallback(monkeypatch):
    """The testing and production Conductor projects mint DIFFERENT end-user ids,
    so falling back would address an end user that does not exist there -- or the
    wrong company's books."""
    monkeypatch.setenv("QUICKBOOKS_ENVIRONMENT", "production")
    monkeypatch.delenv("CONDUCTOR_PROD_API_KEY", raising=False)
    with pytest.raises(qbd.QbdServiceUnavailable, match="CONDUCTOR_PROD_API_KEY"):
        qbd._secret_key()


def test_fake_mode_is_disabled_in_production(monkeypatch):
    monkeypatch.setenv("QUICKBOOKS_FAKE", "1")
    monkeypatch.setenv("QUICKBOOKS_ENVIRONMENT", "production")
    assert qbd._is_fake() is False


def test_fake_create_is_deterministic_per_draft(monkeypatch):
    """Derived from request_id so idempotency and multi-invoice behaviour are
    exercised end to end by the hermetic stack."""
    monkeypatch.setenv("QUICKBOOKS_FAKE", "1")
    a = qbd.create_invoice("e", {}, request_id="abcdef12-0000-4000-8000-000000000000")
    b = qbd.create_invoice("e", {}, request_id="abcdef12-0000-4000-8000-000000000000")
    c = qbd.create_invoice("e", {}, request_id="99999999-0000-4000-8000-000000000000")
    assert a == b and a["id"] != c["id"]


# ───────────────────────── connection state ─────────────────────────
def test_linked_keys_on_last_successful_request_not_on_the_row_existing(monkeypatch):
    """MEASURED: Conductor creates the integration_connection the moment the auth
    flow STARTS. A half-finished setup (Web Connector never run) presents as a
    connection whose lastSuccessfulRequestAt is null while health-check returns
    409 NOT_SET_UP. Keying on the array being non-empty would report a dead
    connection as live."""
    monkeypatch.setattr(qbd, "_request", lambda *a, **k: {
        "integrationConnections": [
            {"id": "int_conn_1", "integrationSlug": "quickbooks_desktop",
             "lastSuccessfulRequestAt": None}
        ]
    })
    assert qbd.connection_state("end_usr_x")["linked"] is False


def test_linked_is_true_once_a_request_has_succeeded(monkeypatch):
    monkeypatch.setattr(qbd, "_request", lambda *a, **k: {
        "integrationConnections": [
            {"id": "int_conn_1", "integrationSlug": "quickbooks_desktop",
             "lastSuccessfulRequestAt": "2026-08-10T23:50:00Z"}
        ]
    })
    assert qbd.connection_state("end_usr_x")["linked"] is True


def test_health_check_reports_offline_rather_than_raising(monkeypatch):
    """'Couldn't check' must never render as 'not connected'."""
    def _boom(*a, **k):
        raise qbd.QbdOffline("QuickBooks isn't running on the shop PC.")

    monkeypatch.setattr(qbd, "_request", _boom)
    result = qbd.health_check("end_usr_x")
    assert result["ok"] is False and result["code"] == "qbd_offline"


# ───────────────────────── recovery ─────────────────────────
def test_find_created_invoice_matches_on_external_id(monkeypatch):
    monkeypatch.setattr(qbd, "_list", lambda *a, **k: [
        {"id": "A", "externalId": None, "refNumber": "1100"},
        {"id": "B", "externalId": "want", "refNumber": "1101", "revisionNumber": "1"},
    ])
    found = qbd.find_created_invoice("e", qb_customer_id="c",
                                     transaction_date="2026-08-10", external_id="want")
    assert found == {"id": "B", "doc_number": "1101", "sync_token": "1"}


def test_find_created_invoice_returns_none_when_absent(monkeypatch):
    monkeypatch.setattr(qbd, "_list", lambda *a, **k: [
        {"id": "A", "externalId": "other", "refNumber": "1100"},
    ])
    assert qbd.find_created_invoice("e", qb_customer_id="c",
                                    transaction_date="2026-08-10",
                                    external_id="want") is None


# ───────────────────────── customer tax code ─────────────────────────
def test_tax_code_comes_from_the_customer_when_it_has_one(monkeypatch):
    monkeypatch.setattr(qbd, "_list", lambda *a, **k: [
        {"id": "C1", "salesTaxCode": {"id": "TAX"}, "parent": None},
    ])
    assert qbd.customer_tax_code_id("e", "C1") == "TAX"


def test_tax_code_walks_up_to_the_parent_for_a_job(monkeypatch):
    """MEASURED: a QuickBooks job (Customer:Job) carries salesTaxCode null and
    inherits its parent's, while still inheriting the tax ITEM. Invoicing such a
    job without a code produced $0.00 tax under a parent whose code is `Tax`, so
    reading only the mapped record silently UNDER-BILLS every shop that invoices
    to jobs -- which is most of them."""
    rows = {
        "JOB": {"id": "JOB", "salesTaxCode": None, "parent": {"id": "PARENT"}},
        "PARENT": {"id": "PARENT", "salesTaxCode": {"id": "TAX"}, "parent": None},
    }
    monkeypatch.setattr(qbd, "_list", lambda p, e, params: [rows[params["ids"]]])
    assert qbd.customer_tax_code_id("e", "JOB") == "TAX"


def test_tax_code_is_none_when_nothing_in_the_chain_has_one(monkeypatch):
    """Then QuickBooks applies its own default rather than us inventing one."""
    rows = {
        "JOB": {"id": "JOB", "salesTaxCode": None, "parent": {"id": "PARENT"}},
        "PARENT": {"id": "PARENT", "salesTaxCode": None, "parent": None},
    }
    monkeypatch.setattr(qbd, "_list", lambda p, e, params: [rows[params["ids"]]])
    assert qbd.customer_tax_code_id("e", "JOB") is None


def test_tax_code_walk_cannot_spin_on_a_cycle(monkeypatch):
    rows = {
        "A": {"id": "A", "salesTaxCode": None, "parent": {"id": "B"}},
        "B": {"id": "B", "salesTaxCode": None, "parent": {"id": "A"}},
    }
    monkeypatch.setattr(qbd, "_list", lambda p, e, params: [rows[params["ids"]]])
    assert qbd.customer_tax_code_id("e", "A") is None


# ───────────────────────── customer lookup ─────────────────────────
def test_customer_search_never_uses_the_fullNames_filter(monkeypatch):
    """MEASURED: `fullNames` is a LOOKUP, not a filter. QuickBooks treats a name it
    cannot find as a missing required element and fails the whole request with
    "The query request has not been fully completed. There was a required element
    (...) that could not be found in QuickBooks." So a brand-new customer turned
    the invoice dialog into a 500 instead of the create-it path. nameContains
    returns an empty list for a miss, which is what a search should do."""
    seen = {}

    def _fake_list(path, end_user_id, params):
        seen.update(params)
        return []

    monkeypatch.setattr(qbd, "_list", _fake_list)
    qbd.find_customer_candidates("e", "Granite Equipment Co")
    assert "fullNames" not in seen
    assert seen.get("nameContains") == "Granite Equipment Co"


def test_unknown_customer_is_unmatched_not_an_error(monkeypatch):
    """The ordinary first-invoice path, and it must mirror QuickBooks Online:
    nobody matched, so the push creates the customer."""
    monkeypatch.setattr(qbd, "_list", lambda *a, **k: [])
    assert qbd.find_customer_candidates("e", "Brand New Co") == {
        "status": "unmatched", "qb_customer_id": None, "candidates": [],
    }


def test_exact_match_is_found_among_contains_results(monkeypatch):
    monkeypatch.setattr(qbd, "_list", lambda *a, **k: [
        {"id": "A", "fullName": "Acme Machining and Sons", "name": "Acme Machining and Sons"},
        {"id": "B", "fullName": "Acme Machining", "name": "Acme Machining"},
    ])
    r = qbd.find_customer_candidates("e", "acme machining")
    assert r["status"] == "exact_match" and r["qb_customer_id"] == "B"


def test_partial_matches_are_offered_as_candidates(monkeypatch):
    monkeypatch.setattr(qbd, "_list", lambda *a, **k: [
        {"id": "A", "fullName": "Acme Machining and Sons", "name": "Acme Machining and Sons"},
    ])
    r = qbd.find_customer_candidates("e", "Acme")
    assert r["status"] == "candidates" and r["qb_customer_id"] is None


# ───────────────────────── addresses ─────────────────────────
def test_address_uses_quickbooks_desktop_key_names():
    """The QuickBooks ONLINE shape (Line1 / CountrySubDivisionCode) is rejected
    outright: 'Unrecognized keys: "Line1", "City", ... at "billingAddress"'. It bit
    twice -- once on the invoice, once on customer creation -- so each provider now
    shapes the raw row itself."""
    out = qbd.to_qbd_address({
        "address_line1": "310 Quarry St", "address_line2": None,
        "city": "Manchester", "state": "NH", "postal_code": "03101", "country": "USA",
    })
    assert out == {"line1": "310 Quarry St", "city": "Manchester", "state": "NH",
                   "postalCode": "03101", "country": "USA"}
    assert "Line1" not in out and "CountrySubDivisionCode" not in out


def test_address_is_none_when_there_is_nothing_to_send():
    assert qbd.to_qbd_address(None) is None
    assert qbd.to_qbd_address({}) is None
