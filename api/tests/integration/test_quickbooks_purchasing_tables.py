"""The four QuickBooks purchasing tables, at the database (plan §3.2 QuickBooks, §3.4; QB9, QB11).

WHAT THIS GUARDS. `quickbooks_vendor_map`, `quickbooks_purchasing_setup`,
`quickbooks_purchase_order_links` and `quickbooks_purchase_order_line_links` hold third-party
ids and the push latch. Only the service role writes them (the FastAPI routes, after their own
office and billing checks); members read them so the PO page can say "In QuickBooks as 1043"
without a QuickBooks call:

  * **Members read, nobody else writes**, and another company sees nothing (QB11).
  * **The uniqueness that makes a push idempotent**: one QuickBooks PO per Jigged PO per company
    file, one request id per company file, one line link per line (QB4, QB11).
  * **Disconnect clears the setup and keeps the history** — the setup rows cascade from the
    connection row; the vendor map and the links are realm-scoped history, like the customer
    map (QB11).
  * **"Out of date" needs no QuickBooks call**: the status view derives `quickbooks_state` from
    the link alone, and only `content_version` moves it — never an ordinary receipt or an
    internal note, but the delivery (or its void) that moves the PO into or out of its derived
    closed status does, because the push closes and reopens from that status (QB9).

Run:
    cd api && pytest -m integration tests/integration/test_quickbooks_purchasing_tables.py
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass

import pytest
from psycopg2 import errors

from tests.integration import purchasing_support as ps
from tests.integration.purchasing_support import db, other_shop, shop  # noqa: F401

pytestmark = pytest.mark.integration

REALM = "realm-po-1"


@dataclass
class Qb:
    po: ps.Po
    connection: str
    vendor_map: str
    setup: str
    link: str
    line_link: str
    request_id: str


@pytest.fixture
def qb(db, shop) -> Qb:
    """A pushed PO: connection, vendor map, setup item, link and line link — as the backend
    writes them after a successful create."""
    po = ps.make_po(db, shop, [ps.part_line(shop.bar, 10, "feet")], sent=True)
    connection = ps.insert_qbo_connection(db, shop, REALM)
    request_id = str(uuid.uuid4())
    link = ps.insert_po_link(db, shop, po.id, realm=REALM, request_id=request_id,
                             pushed_content_version=ps.po_row(db, po.id)["content_version"])
    return Qb(
        po=po, connection=connection,
        vendor_map=ps.insert_vendor_map(db, shop, shop.v1, REALM),
        setup=ps.insert_setup(db, shop, qbo_connection=connection),
        link=link, line_link=ps.insert_line_link(db, shop, link, po.lines[0]), request_id=request_id,
    )


# ── QB11: who reads, who writes ────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("table", ps.QUICKBOOKS_TABLES)
def test_members_read_the_quickbooks_purchasing_rows_and_cannot_write_them(db, shop, qb, table):
    """[QB11] Even an operator can read them (the money-is-a-UI-rule precedent); an admin
    cannot INSERT one — 42501, there is no grant."""
    with ps.session(shop.operator) as (_conn, cur):
        cur.execute(f"SELECT count(*) FROM public.{table} WHERE company_id = %s", (shop.company,))
        assert cur.fetchone()[0] >= 1
    err = ps.refuse_sql(shop.admin, f"INSERT INTO public.{table} (company_id) VALUES (%s)", (shop.company,))
    assert err.pgcode == "42501"


@pytest.mark.parametrize("table", ps.QUICKBOOKS_TABLES)
def test_another_company_sees_none_of_them(db, shop, other_shop, qb, table):
    """[QB11] RLS: `company_id IN (SELECT get_user_company_ids())`."""
    with ps.session(other_shop.admin) as (_conn, cur):
        cur.execute(f"SELECT count(*) FROM public.{table} WHERE company_id = %s", (shop.company,))
        assert cur.fetchone()[0] == 0


# ── QB4 / QB11: the uniqueness a push relies on ───────────────────────────────────────────────


def test_one_quickbooks_po_per_jigged_po_per_company_file(db, shop, qb):
    """[QB4, QB11] UNIQUE(PO, realm): a double click cannot make a second QuickBooks PO. Another
    company file is a separate link."""
    with pytest.raises(errors.UniqueViolation):
        ps.insert_po_link(db, shop, qb.po.id, realm=REALM)
    ps.insert_po_link(db, shop, qb.po.id, realm="realm-po-2")


def test_a_request_id_is_never_reused_within_a_company_file(db, shop, qb):
    """[QB4, QB11] UNIQUE(realm, qb_request_id): QuickBooks deduplicates on it."""
    other = ps.make_po(db, shop, [ps.other_line()], sent=True)
    with pytest.raises(errors.UniqueViolation):
        ps.insert_po_link(db, shop, other.id, realm=REALM, request_id=qb.request_id)


def test_one_line_link_per_line_per_link(db, shop, qb):
    """[QB11] Each Jigged line keeps the QuickBooks line it was first pushed as."""
    with pytest.raises(errors.UniqueViolation):
        ps.insert_line_link(db, shop, qb.link, qb.po.lines[0])


def test_a_removed_line_keeps_its_quickbooks_line_link_naming_no_line(db, shop, qb):
    """[QB8, QB11] Removing an unreceived line deletes it, but QuickBooks still holds the line
    the push put there. Its link row stays with the line cleared (ON DELETE SET NULL on that
    column alone, so the row keeps its company), so the next push knows that QuickBooks line is
    its own to drop, not one the bookkeeper added (qb_foreign_lines). Two removed lines keep two
    rows: NULLs are distinct under UNIQUE (link, line)."""
    ps.save_po(shop.admin, qb.po.id, lines=[ps.other_line("Freight"), ps.other_line("Expedite fee")],
               expected=ps.updated_at_text(db, qb.po.id))
    added = [line["id"] for line in ps.lines_of(db, qb.po.id)[1:]]
    for line in added:
        ps.insert_line_link(db, shop, qb.link, line)

    ps.save_po(shop.admin, qb.po.id, removed=added, expected=ps.updated_at_text(db, qb.po.id))
    held = ps.rows(db, """
        SELECT company_id, vendor_purchase_order_line_id FROM quickbooks_purchase_order_line_links
         WHERE link_id = %s ORDER BY vendor_purchase_order_line_id NULLS LAST""", (qb.link,))
    assert [r["vendor_purchase_order_line_id"] for r in held] == [qb.po.lines[0], None, None]
    assert {r["company_id"] for r in held} == {shop.company}


def test_one_vendor_map_row_per_vendor_per_company_file(db, shop, qb):
    """[QB11] A clone of quickbooks_customer_map: UNIQUE(company, vendor, realm)."""
    with pytest.raises(errors.UniqueViolation):
        ps.insert_vendor_map(db, shop, shop.v1, REALM)


@pytest.mark.parametrize(
    "table, column, value",
    [
        ("quickbooks_purchase_order_links", "operation", "delete"),
        ("quickbooks_purchase_order_links", "status", "done"),
        ("quickbooks_purchase_order_links", "last_failure", "timeout"),
        ("quickbooks_purchasing_setup", "setup_key", "item:freight"),
        ("quickbooks_vendor_map", "provider", "xero"),
    ],
)
def test_the_quickbooks_enums_hold(db, qb, table, column, value):
    """[QB11] operation create|update|close|reopen; status pending|created|error|
    needs_verification; last_failure ambiguous|rejected; setup_key item:part|
    item:outside_service|item:other|ap_account|qbo_preferences; provider qbo|qbd."""
    target = {"quickbooks_purchase_order_links": qb.link, "quickbooks_purchasing_setup": qb.setup,
              "quickbooks_vendor_map": qb.vendor_map}[table]
    with pytest.raises(errors.CheckViolation):
        ps.execute(db, f"UPDATE public.{table} SET {column} = %s WHERE id = %s", (value, target))


def test_a_setup_row_names_exactly_one_connection(db, qb):
    """[QB11] Exactly one of the QBO and QBD connection references is set."""
    qbo_column, _ = ps.setup_connection_columns(db)
    with pytest.raises(errors.CheckViolation):
        ps.execute(db, f"UPDATE quickbooks_purchasing_setup SET {qbo_column} = NULL WHERE id = %s", (qb.setup,))


# ── QB11: disconnect ───────────────────────────────────────────────────────────────────────────


def test_disconnecting_online_clears_the_setup_and_keeps_the_vendor_map_and_links(db, qb):
    """[QB11] Both disconnect routes delete the connection row, so the setup cascades with it."""
    ps.execute(db, "DELETE FROM quickbooks_connections WHERE id = %s", (qb.connection,))
    assert ps.row(db, "SELECT id FROM quickbooks_purchasing_setup WHERE id = %s", (qb.setup,)) is None
    assert ps.row(db, "SELECT id FROM quickbooks_vendor_map WHERE id = %s", (qb.vendor_map,)) is not None
    assert ps.row(db, "SELECT id FROM quickbooks_purchase_order_links WHERE id = %s", (qb.link,)) is not None


def test_disconnecting_desktop_clears_its_setup_too(db, shop):
    """[QB11] The same cascade from the QuickBooks Desktop connection."""
    connection = ps.insert_qbd_connection(db, shop, f"end-user-{shop.tag}")
    setup = ps.insert_setup(db, shop, qbd_connection=connection, setup_key="item:other")
    ps.execute(db, "DELETE FROM quickbooks_desktop_connections WHERE id = %s", (connection,))
    assert ps.row(db, "SELECT id FROM quickbooks_purchasing_setup WHERE id = %s", (setup,)) is None


# ── QB9: the state the PO page shows, without a QuickBooks call ───────────────────────────────


def _state(db, po: ps.Po) -> str:
    return ps.po_status(db, po.id)["quickbooks_state"]


def _sent_po(db, shop) -> ps.Po:
    return ps.make_po(db, shop, [ps.part_line(shop.bar, 10, "feet")], sent=True)


def test_quickbooks_state_is_read_from_the_link_alone(db, shop):
    """[QB9] not_sent → in_quickbooks → out_of_date as `content_version` passes what was
    pushed; and the three unsettled states each read as themselves."""
    po = _sent_po(db, shop)
    assert _state(db, po) == "not_sent"

    ps.insert_po_link(db, shop, po.id, pushed_content_version=ps.po_row(db, po.id)["content_version"])
    assert _state(db, po) == "in_quickbooks"

    ps.save_po(shop.user, po.id, changes={"notes_to_vendor": "Deliver to dock B"},
               expected=ps.updated_at_text(db, po.id))
    assert _state(db, po) == "out_of_date"

    for status, state, extra in (("pending", "pending", {}), ("needs_verification", "needs_checking", {}),
                                 ("error", "failed", {"last_failure": "rejected"})):
        other = _sent_po(db, shop)
        ps.insert_po_link(db, shop, other.id, status=status, qb_po_id=None, **extra)
        assert _state(db, other) == state, f"a {status} link read as {_state(db, other)}"


def test_receipts_internal_notes_and_promises_never_make_a_pushed_po_out_of_date(db, shop):
    """[QB9] None of them is in what QuickBooks holds."""
    po = _sent_po(db, shop)
    ps.insert_po_link(db, shop, po.id, pushed_content_version=ps.po_row(db, po.id)["content_version"])

    ps.receive(shop.admin, po.id, [ps.entry(po.lines[0], 4, location=shop.shelf)])
    ps.save_po(shop.user, po.id, changes={"internal_notes": "Vendor called"})
    ps.save_po(shop.user, po.id, lines=[{"id": po.lines[0], "promised_on": "2026-11-30"}])
    assert _state(db, po) == "in_quickbooks"


def _push_recorded(db, link: str, po: ps.Po, *, closed: bool) -> None:
    """What the route writes after a push: the version it sent, and whether QuickBooks holds the
    PO closed."""
    ps.execute(db, """
        UPDATE quickbooks_purchase_order_links SET pushed_content_version = %s, qb_closed = %s
         WHERE id = %s""", (ps.po_row(db, po.id)["content_version"], closed, link))


def test_the_delivery_that_closes_a_po_beside_a_short_closed_line_makes_it_out_of_date(db, shop):
    """[QB9] The push closes the QuickBooks PO when the DERIVED status reads closed, and nothing
    outstanding while a line was closed short is closed. So the delivery that brings in the rest
    changes what QuickBooks must hold -- on Online, which cannot close a line, it is the only way
    the remainder of the short line stops reading open there -- and voiding that delivery changes
    it back. A partial delivery beside the closed line changes nothing."""
    po = ps.make_po(db, shop, [ps.part_line(shop.bar, 10, "feet"), ps.part_line(shop.screw, 2, "hundred")],
                    sent=True)
    bar, screw = po.lines
    ps.set_lines(shop.admin, po.id, [screw], "close", reason="Vendor is out")
    link = ps.insert_po_link(db, shop, po.id, pushed_content_version=ps.po_row(db, po.id)["content_version"])
    assert _state(db, po) == "in_quickbooks"

    ps.receive(shop.admin, po.id, [ps.entry(bar, 4, location=shop.shelf)])
    assert ps.po_status(db, po.id)["status"] == ps.PARTLY_RECEIVED
    assert _state(db, po) == "in_quickbooks", "an ordinary delivery read as a change QuickBooks must take"

    before = ps.po_row(db, po.id)["content_version"]
    ps.receive(shop.admin, po.id, [ps.entry(bar, 6, location=shop.shelf)])
    assert ps.po_status(db, po.id)["status"] == ps.CLOSED
    assert ps.po_row(db, po.id)["closed_at"] is None, "closed by the delivery, not by hand"
    assert ps.po_row(db, po.id)["content_version"] == before + 1
    assert _state(db, po) == "out_of_date"

    _push_recorded(db, link, po, closed=True)
    assert _state(db, po) == "in_quickbooks"
    completing = ps.receipts_of(db, po.id)[-1]["id"]
    ps.void_receipt(shop.admin, completing, reason="Counted twice")
    assert ps.po_status(db, po.id)["status"] == ps.PARTLY_RECEIVED
    assert ps.po_row(db, po.id)["content_version"] == before + 2
    assert _state(db, po) == "out_of_date", "QuickBooks still holds it closed; the push must reopen it"
