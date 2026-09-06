"""Unit tests for the Intuit change-notification webhook (no DB, no network).

The handler exists to do ONE thing and to be provably incapable of doing another:
it verifies the signature and stamps stale markers in Postgres. Every balance is
read later, when someone opens a job's Invoices menu. So the properties protected
here are as much about what the route must NOT do — reach Intuit, file a stranger's
signature failure to Sentry, HMAC an unbounded body — as about what it marks.
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import sys
from pathlib import Path

import pytest
from fastapi import HTTPException

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

import routes.quickbooks_routes as qr  # noqa: E402
import services.quickbooks as qb  # noqa: E402

pytestmark = pytest.mark.unit

VERIFIER = "verifier-token-for-tests"
REALM = "realm-123"
OTHER_REALM = "realm-999"


@pytest.fixture(autouse=True)
def _base_env(monkeypatch):
    monkeypatch.setenv("QUICKBOOKS_WEBHOOK_VERIFIER_TOKEN", VERIFIER)
    monkeypatch.setenv("QUICKBOOKS_ENVIRONMENT", "sandbox")


# ───────────────────────── fakes ─────────────────────────
class _Result:
    def __init__(self, data):
        self.data = data


class _Chain:
    """The supabase-py chain, narrow enough for the three statements this handler
    makes: read the connections for a set of realms, update a connection, update the
    invoice links naming an id. Any other table is an assertion failure rather than a
    silent no-op, so a future edit that reaches somewhere new is visible here."""

    def __init__(self, recorder, table: str):
        self.rec = recorder
        self.table = table
        self._op: str | None = None
        self._payload: dict | None = None
        self._eq: dict = {}
        self._in: dict = {}

    def select(self, *a, **k):
        self._op = "select"
        return self

    def update(self, payload):
        self._op = "update"
        self._payload = payload
        return self

    def eq(self, col, val):
        self._eq[col] = val
        return self

    def in_(self, col, vals):
        self._in[col] = list(vals)
        return self

    def execute(self):
        if self.table == "quickbooks_connections":
            if self._op == "select":
                return _Result(
                    [
                        {"company_id": c["company_id"], "realm_id": c["realm_id"]}
                        for c in self.rec.connections
                        if c["realm_id"] in self._in.get("realm_id", [])
                        and c["environment"] == self._eq.get("environment")
                    ]
                )
            self.rec.connection_updates.append((self._eq["company_id"], dict(self._payload)))
            return _Result([{"company_id": self._eq["company_id"]}])

        if self.table == "quickbooks_invoice_links":
            asked = set(self._in.get("qb_invoice_id", []))
            matched = [
                link
                for link in self.rec.links
                if link["company_id"] == self._eq.get("company_id")
                and link["realm_id"] == self._eq.get("realm_id")
                and link["provider"] == self._eq.get("provider")
                and link["qb_invoice_id"] in asked
            ]
            self.rec.link_updates.append(
                {
                    "asked": sorted(asked),
                    "qb_stale_at": self._payload["qb_stale_at"],
                    "matched": sorted(link["qb_invoice_id"] for link in matched),
                }
            )
            return _Result(matched)

        raise AssertionError(f"the webhook handler touched an unexpected table: {self.table}")


class _Recorder:
    """Every write the handler makes, kept so the tests assert on markers rather than
    on a database."""

    def __init__(self, connections=(), links=()):
        self.connections = list(connections)
        self.links = list(links)
        self.connection_updates: list[tuple[str, dict]] = []
        self.link_updates: list[dict] = []

    def table(self, name):
        return _Chain(self, name)


def _connection(company_id="co1", realm_id=REALM, environment="sandbox") -> dict:
    return {"company_id": company_id, "realm_id": realm_id, "environment": environment}


def _link(qb_invoice_id="1001", company_id="co1", realm_id=REALM) -> dict:
    return {
        "company_id": company_id,
        "realm_id": realm_id,
        "provider": "qbo",
        "qb_invoice_id": qb_invoice_id,
    }


class _FakeRequest:
    def __init__(self, body=b"", headers=None):
        self._body = body
        self.headers = headers or {}

    async def body(self):
        return self._body


def _signed(payload, token: str = VERIFIER) -> _FakeRequest:
    """A request carrying the header Intuit would send: base64(HMAC-SHA256(body)).

    Signed over the EXACT bytes, which is why the body is serialised once here and
    handed to both the HMAC and the request — re-serialising would change the
    whitespace and produce a body the signature does not cover."""
    raw = json.dumps(payload).encode("utf-8")
    signature = base64.b64encode(
        hmac.new(token.encode("utf-8"), raw, hashlib.sha256).digest()
    ).decode("ascii")
    return _FakeRequest(body=raw, headers={"intuit-signature": signature})


def _event(entity="invoice", entity_id="1001", realm=REALM, time="2026-09-03T17:59:00.000Z"):
    """One CloudEvents entry as Intuit sends it, entity encoded in the dotted type."""
    return {
        "type": f"qbo.{entity}.updated.v1",
        "intuitaccountid": realm,
        "intuitentityid": entity_id,
        "time": time,
    }


def _no_sentry(monkeypatch) -> list:
    """Spy on the module's capture_exception. The list is the assertion surface for
    both directions: the signature branch must leave it empty, and the signed-but-
    unreadable branch must fill it — without that second case, "not captured" would
    pass for a spy that never worked."""
    captured: list = []
    monkeypatch.setattr(qr.sentry_sdk, "capture_exception", lambda exc: captured.append(exc))
    return captured


def _run(request):
    return asyncio.run(qr.webhook(request))


# ───────────────────────── payload shapes ─────────────────────────
def test_a_cloudevents_array_is_accepted(monkeypatch):
    """The current Intuit format: a bare JSON array, realm in `intuitaccountid`, the
    entity buried in a dotted `type` such as "qbo.invoice.updated.v1"."""
    rec = _Recorder(connections=[_connection()], links=[_link("1001")])
    monkeypatch.setattr(qr, "_service_client", lambda: rec)

    result = _run(_signed([_event(entity_id="1001")]))

    assert result == {"received": True, "realms": 1, "marked": 1}
    assert rec.link_updates[0]["matched"] == ["1001"]
    # Intuit's own instant for the change, not our receipt time — see
    # _webhook_event_time for why the fallback direction is the safe one.
    assert rec.link_updates[0]["qb_stale_at"] == qb._parse_dt("2026-09-03T17:59:00.000Z").isoformat()


def test_the_legacy_event_notifications_shape_is_still_accepted(monkeypatch):
    """The Intuit developer portal carries a per-app toggle between the two formats.
    Flipping it is two clicks by a human, not a deploy, so a shop configured before
    the switch keeps sending the old shape and must keep being understood."""
    rec = _Recorder(connections=[_connection()], links=[_link("2002")])
    monkeypatch.setattr(qr, "_service_client", lambda: rec)

    payload = {
        "eventNotifications": [
            {
                "realmId": REALM,
                "dataChangeEvent": {
                    "entities": [
                        {
                            "name": "Invoice",
                            "id": "2002",
                            "operation": "Update",
                            "lastUpdated": "2026-09-03T17:59:00.000Z",
                        }
                    ]
                },
            }
        ]
    }
    result = _run(_signed(payload))

    assert result == {"received": True, "realms": 1, "marked": 1}
    assert rec.link_updates[0]["matched"] == ["2002"]


def test_an_array_spanning_two_realms_marks_both(monkeypatch):
    """Intuit batches notifications, and one delivery can carry changes for every
    realm our app is connected to. Handling only the first would silently leave the
    other shop's invoices looking current."""
    rec = _Recorder(
        connections=[_connection("co1", REALM), _connection("co2", OTHER_REALM)],
        links=[_link("1001", "co1", REALM), _link("3003", "co2", OTHER_REALM)],
    )
    monkeypatch.setattr(qr, "_service_client", lambda: rec)

    result = _run(
        _signed([_event(entity_id="1001", realm=REALM), _event(entity_id="3003", realm=OTHER_REALM)])
    )

    assert result == {"received": True, "realms": 2, "marked": 2}
    assert sorted(u["matched"][0] for u in rec.link_updates) == ["1001", "3003"]


# ───────────────────────── which events do what ─────────────────────────
def test_an_invoice_event_marks_the_link_while_payment_and_credit_memo_mark_the_connection(
    monkeypatch,
):
    """A Payment or CreditMemo notification names only the payment or memo — never the
    invoices it settles. Resolving that would take an Intuit query, which this handler
    must not make, so the whole realm is marked stale and the next menu-open sorts it
    out. Only an Invoice event can name a row."""
    rec = _Recorder(connections=[_connection()], links=[_link("1001")])
    monkeypatch.setattr(qr, "_service_client", lambda: rec)

    result = _run(
        _signed(
            [
                _event("invoice", "1001", time="2026-09-03T17:50:00.000Z"),
                _event("payment", "P-7", time="2026-09-03T17:55:00.000Z"),
                _event("creditmemo", "CM-2", time="2026-09-03T17:59:00.000Z"),
            ]
        )
    )

    assert result == {"received": True, "realms": 1, "marked": 2}  # one connection, one link
    assert rec.link_updates[0]["matched"] == ["1001"]

    _, conn_update = rec.connection_updates[0]
    # The LATEST of the two realm-wide events: an older marker would leave a change
    # that arrived after our last check looking already accounted for.
    assert conn_update["qb_invoices_stale_since"] == qb._parse_dt("2026-09-03T17:59:00.000Z").isoformat()
    # Always stamped, even when nothing was marked — this is the field the settings
    # card reads to show that notifications are arriving at all.
    assert conn_update["webhook_last_received_at"]


def test_an_account_event_marks_nothing(monkeypatch):
    """The Intuit portal lets a human tick extra entities onto the same endpoint. An
    entity whose change cannot move a balance we mirror is discarded SILENTLY — a shop
    doing that must not start seeing 400s or filing Sentry issues — and the handler
    returns before it opens a database connection at all."""
    def _no_db():
        raise AssertionError("an unrelated entity reached the database")

    monkeypatch.setattr(qr, "_service_client", _no_db)

    assert _run(_signed([_event("account", "A-1")])) == {"received": True, "realms": 0, "marked": 0}


def test_a_notification_for_an_unknown_realm_is_skipped_without_error(monkeypatch):
    """Ordinary rather than exceptional: the shop disconnected, or the realm belongs to
    another Intuit app on the same account. Intuit retries a non-2xx, so answering with
    an error here would buy a redelivery loop for a realm we will never recognise."""
    rec = _Recorder(connections=[_connection()], links=[_link("1001")])
    monkeypatch.setattr(qr, "_service_client", lambda: rec)

    result = _run(_signed([_event(entity_id="4004", realm=OTHER_REALM)]))

    assert result == {"received": True, "realms": 1, "marked": 0}
    assert rec.connection_updates == []
    assert rec.link_updates == []


def test_a_notification_for_another_environments_realm_is_skipped(monkeypatch):
    """Both environments' connections live in one table and a realm id does not say
    which app it came from, so the environment predicate is the only thing standing
    between a sandbox notification and a production shop's rows."""
    rec = _Recorder(
        connections=[_connection(environment="production")], links=[_link("1001")]
    )
    monkeypatch.setattr(qr, "_service_client", lambda: rec)

    result = _run(_signed([_event(entity_id="1001")]))

    assert result == {"received": True, "realms": 1, "marked": 0}
    assert rec.connection_updates == []
    assert rec.link_updates == []


# ───────────────────────── the guarantees about what it does NOT do ─────────────────────────
def test_the_handler_makes_zero_intuit_calls(monkeypatch):
    """THE load-bearing property of this route. A notification says only THAT something
    changed; reading the balance here would put a third-party round trip — plus a
    possible token refresh — inside a request Intuit retries on timeout, to produce a
    number nobody may ever look at. Asserted by making every read path fatal."""
    def _boom(*a, **k):
        raise AssertionError("the webhook handler called Intuit")

    for name in (
        "qb_request",
        "qb_query",
        "qb_query_strict",
        "fetch_invoice_facts",
        "refresh_invoice_statuses",
        "ensure_fresh_access_token",
    ):
        monkeypatch.setattr(qb, name, _boom)

    rec = _Recorder(connections=[_connection()], links=[_link("1001")])
    monkeypatch.setattr(qr, "_service_client", lambda: rec)

    assert _run(_signed([_event(entity_id="1001")])) == {"received": True, "realms": 1, "marked": 1}


def test_a_bad_signature_is_rejected_and_files_nothing_to_sentry(monkeypatch):
    """This route is public and unauthenticated, so anyone who finds the URL can drive
    this branch at will — capturing it would hand a stranger our Sentry quota and bury
    real issues under it. A genuine mismatch (a verifier token rotated in the portal)
    shows in Intuit's own delivery log, which is the authority on it anyway."""
    captured = _no_sentry(monkeypatch)
    monkeypatch.setattr(
        qr, "_service_client", lambda: (_ for _ in ()).throw(AssertionError("wrote on a bad sig"))
    )

    request = _signed([_event()], token="not-the-verifier-token")
    with pytest.raises(HTTPException) as exc:
        _run(request)

    assert exc.value.status_code == 400
    assert captured == []


def test_a_signed_body_we_cannot_read_is_rejected_AND_reported(monkeypatch):
    """The other half of the pair above, and what keeps it from being vacuous: the
    signature has already passed here, so Intuit itself signed this body. That is a
    shape change on their side or a bug on ours, and both are ours to know about."""
    captured = _no_sentry(monkeypatch)

    with pytest.raises(HTTPException) as exc:
        _run(_signed({"somethingElse": [1, 2, 3]}))

    assert exc.value.status_code == 400
    assert len(captured) == 1


def test_a_missing_verifier_token_rejects_the_delivery(monkeypatch):
    """503 rather than a default, so an unconfigured environment rejects everything
    loudly instead of quietly accepting unsigned bodies. Intuit retries a 503, so a
    delivery that arrives during a misconfiguration is not lost."""
    monkeypatch.delenv("QUICKBOOKS_WEBHOOK_VERIFIER_TOKEN", raising=False)

    with pytest.raises(HTTPException) as exc:
        _run(_signed([_event()]))

    assert exc.value.status_code == 503


def test_an_oversized_body_is_rejected_before_it_is_hmacd(monkeypatch):
    """The cap is not about Intuit's own bodies, which are a few kilobytes. It is that
    an unauthenticated caller must not be able to make us HMAC and json.loads an
    arbitrary amount of data — so the length check has to come FIRST, which is what
    the exploding verifier reader below actually asserts."""
    def _must_not_hmac():
        raise AssertionError("hashed an oversized body before checking its length")

    monkeypatch.setattr(qr, "_webhook_verifier_token", _must_not_hmac)

    request = _FakeRequest(body=b"x" * (qr.WEBHOOK_MAX_BYTES + 1), headers={"intuit-signature": "x"})
    with pytest.raises(HTTPException) as exc:
        _run(request)

    assert exc.value.status_code == 413
