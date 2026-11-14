"""The provider seam: shape, dispatch, and the two deliberate asymmetries.

These are cheap structural tests, and they exist because the expensive failures in
this area are silent. A method added to one provider and forgotten on the other
does not raise until a shop pushes an invoice.
"""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

import services.quickbooks as qb  # noqa: E402
from services.accounting import AccountingProvider, get_provider  # noqa: E402
from services.accounting.qbo import QboProvider  # noqa: E402

pytestmark = pytest.mark.unit


class _FakeConnTable:
    def __init__(self, row):
        self._row = row

    def select(self, *a, **k):
        return self

    def eq(self, *a, **k):
        return self

    def limit(self, *a, **k):
        return self

    def execute(self):
        class _R:
            data = [self._row] if self._row else []

        return _R()


class _FakeDB:
    def __init__(self, row=None):
        self._row = row

    def table(self, name):
        return _FakeConnTable(self._row)


def _qbo(conn=None):
    return QboProvider(_FakeDB(), "co-1", conn or {"realm_id": "realm-1"})


def test_qbo_satisfies_the_protocol():
    assert isinstance(_qbo(), AccountingProvider)


def test_scope_id_is_the_realm():
    assert _qbo({"realm_id": "realm-42"}).scope_id == "realm-42"


def test_qbo_dedupes_replayed_creates():
    """Intuit's ?requestid= is what makes a QBO retry safe. QuickBooks Desktop
    has no equivalent, so this flag is what stops the shared push path from
    retrying an ambiguous outcome there."""
    assert QboProvider.dedupes_replayed_creates is True


def test_qbo_reports_no_customer_tax_code():
    """Deliberate, not a stub.

    QBO pins TaxCodeRef='NON' on every line because an OMITTED code is TAXABLE
    under Automated Sales Tax and would inflate the total. QuickBooks Desktop has
    the opposite default -- verified on Enterprise 24, an omitted code yields
    'Non' and no tax even for a customer whose record says 'Tax' -- so only the
    QBD provider reads the customer's own code. The asymmetry IS the fix.
    """
    assert _qbo().customer_tax_code_id("cust-1") is None


def test_qbo_never_needs_the_recovery_probe():
    assert _qbo().find_created_invoice({"qb_request_id": "r"}) is None


def test_qbo_has_a_deep_link():
    """QBD returns None here; QBO must not, or the job page silently loses its
    'View in QuickBooks' link."""
    url = _qbo({"environment": "sandbox", "realm_id": "9130"}).invoice_deep_link("172")
    assert url is not None
    assert "deeplinkcompanyid=9130" in url


def test_get_provider_returns_none_when_nothing_is_connected():
    assert get_provider(_FakeDB(None), "co-1") is None


def test_get_provider_returns_qbo_when_connected(monkeypatch):
    monkeypatch.setenv("QUICKBOOKS_ENVIRONMENT", "sandbox")
    db = _FakeDB({"realm_id": "realm-1", "environment": "sandbox"})
    provider = get_provider(db, "co-1")
    assert provider is not None
    assert provider.name == "qbo"


def test_get_provider_ignores_a_connection_from_another_environment(monkeypatch):
    """A sandbox row must not be usable against production. Without this, a
    testing connection survives a promotion and quietly points at the wrong
    company's books."""
    monkeypatch.setenv("QUICKBOOKS_ENVIRONMENT", "production")
    db = _FakeDB({"realm_id": "realm-1", "environment": "sandbox"})
    assert get_provider(db, "co-1") is None


def test_provider_protocol_covers_every_public_method_qbo_implements():
    """A method added to a provider but not to the Protocol is invisible to the
    other provider until runtime. Keep them in step."""
    protocol_names = {
        n for n in AccountingProvider.__dict__ if not n.startswith("_")
    } | {"name", "scope_id", "dedupes_replayed_creates"}
    impl_names = {
        n
        for n in dir(QboProvider)
        if not n.startswith("_") and callable(getattr(QboProvider, n, None))
    }
    impl_names |= {"name", "scope_id", "dedupes_replayed_creates"}
    missing = impl_names - protocol_names
    assert not missing, f"QboProvider exposes methods absent from the Protocol: {missing}"


def test_quickbooks_module_is_untouched_by_the_seam():
    """The QBO service keeps its own entry points. The provider is a shell over
    it, not a replacement, so its sandbox-verified behaviour stays reachable and
    its existing tests stay meaningful."""
    for name in (
        "quote_to_invoice_payload",
        "create_invoice",
        "invoice_deep_link",
        "resolve_term_id",
        "find_customer_candidates",
        "load_billable_parts",
        "load_firm_invoice_lines",
    ):
        assert hasattr(qb, name), f"services.quickbooks lost {name}"


# ───────────────────────── QuickBooks Desktop ─────────────────────────
class _TableAwareDB:
    """Routes by table name, so a QBO row and a QBD row can be present or absent
    independently -- which the single-provider dispatch actually depends on."""

    def __init__(self, qbo_row=None, qbd_row=None):
        self._rows = {
            "quickbooks_connections": qbo_row,
            "quickbooks_desktop_connections": qbd_row,
        }

    def table(self, name):
        return _FakeConnTable(self._rows.get(name))


def _qbd(conn=None):
    from services.accounting.qbd import QbdProvider

    return QbdProvider(
        _TableAwareDB(),
        "co-1",
        conn or {"conductor_end_user_id": "end_usr_1", "environment": "sandbox"},
    )


def test_qbd_satisfies_the_protocol(monkeypatch):
    monkeypatch.setenv("QUICKBOOKS_ENVIRONMENT", "sandbox")
    assert isinstance(_qbd(), AccountingProvider)


def test_qbd_scope_id_is_the_conductor_end_user(monkeypatch):
    """The end-user id IS the connected company file, the QBD analogue of a realm
    id. It is what lands in quickbooks_invoice_links.realm_id."""
    monkeypatch.setenv("QUICKBOOKS_ENVIRONMENT", "sandbox")
    assert _qbd().scope_id == "end_usr_1"


def test_qbd_does_not_dedupe_replayed_creates(monkeypatch):
    """Conductor has no idempotency key and does not dedupe externalId. Verified
    that a create aborted client-side at 1s still produced an invoice, so the
    shared push path must never auto-retry an ambiguous outcome here."""
    monkeypatch.setenv("QUICKBOOKS_ENVIRONMENT", "sandbox")
    assert _qbd().dedupes_replayed_creates is False


def test_qbd_has_no_deep_link(monkeypatch):
    """QuickBooks Desktop has no web app. InvoicesMenu already renders a
    non-link row when the url is absent."""
    monkeypatch.setenv("QUICKBOOKS_ENVIRONMENT", "sandbox")
    assert _qbd().invoice_deep_link("2FBE0-1797378826") is None


def test_qbd_rejects_a_connection_from_another_environment(monkeypatch):
    monkeypatch.setenv("QUICKBOOKS_ENVIRONMENT", "production")
    import services.quickbooks_desktop as qbd_service

    with pytest.raises(qbd_service.QbdNotConnected):
        _qbd({"conductor_end_user_id": "end_usr_1", "environment": "sandbox"})


def test_get_provider_returns_qbd_when_only_desktop_is_connected(monkeypatch):
    monkeypatch.setenv("QUICKBOOKS_ENVIRONMENT", "sandbox")
    db = _TableAwareDB(
        qbd_row={"conductor_end_user_id": "end_usr_9", "environment": "sandbox"}
    )
    provider = get_provider(db, "co-1")
    assert provider is not None
    assert provider.name == "qbd"
    assert provider.scope_id == "end_usr_9"


def test_get_provider_prefers_qbo_but_the_db_forbids_both(monkeypatch):
    """assert_single_accounting_provider() makes 'both connected' unreachable, so
    the check order cannot change the answer. This pins the dispatch anyway, so a
    future edit that drops the trigger is caught by a failing expectation rather
    than by a shop invoicing into the wrong system."""
    monkeypatch.setenv("QUICKBOOKS_ENVIRONMENT", "sandbox")
    db = _TableAwareDB(
        qbo_row={"realm_id": "realm-1", "environment": "sandbox"},
        qbd_row={"conductor_end_user_id": "end_usr_9", "environment": "sandbox"},
    )
    assert get_provider(db, "co-1").name == "qbo"


# ───────────────────────── vendor purchase orders: both providers (QB12) ─────────────────────────
# The PO push added fourteen provider primitives. The parity test above only ever
# looked at QboProvider, which is how QbdProvider.list_customers ended up outside the
# Protocol unnoticed. These run over BOTH providers, with that one method allowed by
# name so a second stray method still fails.
QBD_ALLOWLIST = {"list_customers"}


def _protocol_member_names() -> set[str]:
    return {n for n in AccountingProvider.__dict__ if not n.startswith("_")} | {
        "name", "scope_id", "dedupes_replayed_creates"}


def _protocol_method_names() -> set[str]:
    return {n for n, v in AccountingProvider.__dict__.items()
            if not n.startswith("_") and callable(v)}


@pytest.mark.parametrize("impl_name, allow", [("qbo", set()), ("qbd", QBD_ALLOWLIST)])
def test_every_public_method_of_both_providers_is_on_the_protocol(impl_name, allow):
    from services.accounting.qbd import QbdProvider

    impl = QboProvider if impl_name == "qbo" else QbdProvider
    impl_names = {n for n in dir(impl) if not n.startswith("_") and callable(getattr(impl, n, None))}
    extra = impl_names - _protocol_member_names() - allow
    assert not extra, f"{impl.__name__} exposes methods absent from the Protocol: {extra}"


@pytest.mark.parametrize("impl_name", ["qbo", "qbd"])
def test_both_providers_implement_every_protocol_method(impl_name):
    from services.accounting.qbd import QbdProvider

    impl = QboProvider if impl_name == "qbo" else QbdProvider
    missing = {n for n in _protocol_method_names() if not callable(getattr(impl, n, None))}
    assert not missing, f"{impl.__name__} lacks Protocol methods: {missing}"


def test_the_purchase_order_primitives_are_on_the_protocol():
    """Plan §3.11's list, by name: a rename on one side fails here, not at a push."""
    assert {
        "vendor_name_problem", "find_vendor_candidates", "create_vendor",
        "list_purchase_accounts", "list_ap_accounts", "list_purchase_items",
        "create_purchase_item", "resolve_ship_method_id", "build_purchase_order_payload",
        "create_purchase_order", "read_purchase_order", "update_purchase_order",
        "find_created_purchase_order", "purchase_order_deep_link",
        "check_purchasing_preferences",
    } <= _protocol_method_names()


def test_qbo_purchase_order_deep_link_uses_the_pagereq_shape():
    """The same sign-in-surviving shape as invoices (see invoice_deep_link), aimed at
    the purchase-order page. UNVERIFIED for POs until manual check M-1."""
    url = _qbo({"environment": "sandbox", "realm_id": "9130"}).purchase_order_deep_link("77")
    assert url == ("https://sandbox.qbo.intuit.com/login?deeplinkcompanyid=9130"
                   "&pagereq=purchaseorder%3FtxnId%3D77")


def test_qbd_has_no_purchase_order_deep_link(monkeypatch):
    monkeypatch.setenv("QUICKBOOKS_ENVIRONMENT", "sandbox")
    assert _qbd().purchase_order_deep_link("2FBE0-1797378826") is None


def test_vendor_name_rules_differ_by_provider(monkeypatch):
    """QuickBooks Desktop caps a vendor name at 41 characters; Online allows 500.
    Both refuse a colon, a tab or a line break."""
    monkeypatch.setenv("QUICKBOOKS_ENVIRONMENT", "sandbox")
    name_42 = "A" * 42
    assert _qbd().vendor_name_problem(name_42) is not None
    assert _qbo().vendor_name_problem(name_42) is None
    for provider in (_qbo(), _qbd()):
        assert provider.vendor_name_problem("Acme: Plating") is not None


def test_both_providers_name_their_invoice_item_and_connection(monkeypatch):
    """The purchase-item picker refuses the invoice item by id; each provider keeps it
    in a different column."""
    monkeypatch.setenv("QUICKBOOKS_ENVIRONMENT", "sandbox")
    qbo = _qbo({"id": "conn-1", "realm_id": "r", "default_item_id": "1"})
    assert qbo.connection_id == "conn-1"
    assert qbo.invoice_item_ids == ("1",)
    qbd_provider = _qbd({"id": "conn-2", "conductor_end_user_id": "end_usr_1",
                         "environment": "sandbox", "default_service_item_id": "80000010-1"})
    assert qbd_provider.connection_id == "conn-2"
    assert qbd_provider.invoice_item_ids == ("80000010-1",)
    assert _qbo().invoice_item_ids == ()


def test_qbo_ship_method_and_terms_cost_nothing_in_fake_mode(monkeypatch):
    """QUICKBOOKS_FAKE covers terms too: an E2E push must not reach Intuit to look
    one up. None is the same best-effort answer an unresolvable term gets."""
    monkeypatch.setenv("QUICKBOOKS_ENVIRONMENT", "sandbox")
    monkeypatch.setenv("QUICKBOOKS_FAKE", "1")
    monkeypatch.setattr(qb, "resolve_term_id", lambda *a, **k: pytest.fail("looked up a term"))
    assert _qbo().resolve_term_id("Net 30") is None
    import services.quickbooks_desktop as qbd_service

    monkeypatch.setattr(qbd_service, "resolve_term_id", lambda *a, **k: pytest.fail("looked up a term"))
    assert _qbd().resolve_term_id("Net 30") is None
