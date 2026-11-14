"""Purchasing numbering: one fixed series per company and document kind (plan §3.2, N1–N3).

WHAT THIS GUARDS. A purchase-order number is printed on paper the vendor keeps and quoted back
on their invoice. POs and RFQs number themselves, PO-0001 and RFQ-0001 on, the way quotes, jobs
and packing slips do: there are no numbering settings (the founder removed them, 2026-11-12).
The series is a row per (company, kind), never the shared Q-/J- counter, because a quote and its
job share a number on purpose and a PO is a separate document.

  * **The format is fixed.** Four digits, growing rather than truncating past 9999.
  * **QuickBooks Desktop holds 11 characters** in a PO's `refNumber`, so PO-99999999 is the last
    number minted; past it the create refuses in a sentence.
  * **A number is never reissued**: not after an archive, not when a create rolls back. A
    rollback consumes nothing, because the vendor never saw it.
  * **Concurrency is the RPC's job, not the unique index's.** Two buyers saving at once must
    queue on the series row; a 23505 surfacing as "something went wrong" is the failure.

Run:
    cd api && pytest -m integration tests/integration/test_purchasing_numbering.py
"""
from __future__ import annotations

import threading

import pytest

from tests.integration import purchasing_support as ps
from tests.integration.purchasing_support import db, other_shop, shop  # noqa: F401

pytestmark = pytest.mark.integration


def _new_po(shop: ps.Shop, user: str | None = None) -> tuple[str, str]:
    """The smallest document a series can number: one freight line."""
    return ps.create_po(user or shop.admin, shop.v1, [ps.other_line("Freight")])


def _set_counter(db, shop: ps.Shop, next_number: int) -> None:
    """Move a counter by hand, as only the service role can: nothing in the app sets it. An
    upsert, because a company's series row only exists once its first PO has been minted."""
    ps.execute(db, """
        INSERT INTO purchasing_document_series (company_id, document_kind, next_number)
        VALUES (%s, 'vendor_purchase_order', %s)
        ON CONFLICT (company_id, document_kind) DO UPDATE SET next_number = EXCLUDED.next_number""",
        (shop.company, next_number))


# ── N1: a series per company and per kind ──────────────────────────────────────────────────────


def test_each_company_numbers_its_own_pos_and_rfqs_from_0001(db, shop, other_shop):
    """[N1] PO-0001 and RFQ-0001, per company, and the two kinds never share."""
    assert _new_po(shop)[1] == "PO-0001"
    assert _new_po(shop)[1] == "PO-0002"
    assert _new_po(other_shop)[1] == "PO-0001", "another company's POs consumed this one's numbers"

    _, rfq_number = ps.create_rfq(shop.admin, shop.company, [ps.rfq_adhoc_line("Anodize 40 brackets")], [shop.v1])
    assert rfq_number == "RFQ-0001"
    assert _new_po(shop)[1] == "PO-0003", "an RFQ consumed a purchase-order number"


# ── N2: the format is fixed ────────────────────────────────────────────────────────────────────


def test_there_are_no_numbering_settings(db):
    """[N2] Like quotes and jobs, nothing sets the prefix or the next number: no writer exists,
    and the series row holds a counter and nothing a shop could configure."""
    assert ps.scalar(db, "SELECT count(*) FROM pg_proc WHERE proname = 'save_purchasing_document_settings'") == 0
    columns = {r["column_name"] for r in ps.rows(db, """
        SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'purchasing_document_series'""")}
    assert columns == {"company_id", "document_kind", "next_number", "created_at", "updated_at"}, columns


def test_a_number_grows_past_four_digits_rather_than_truncating(db, shop):
    """[N2] PO-9999 is followed by PO-10000, not by a truncated PO-0000."""
    _set_counter(db, shop, 9999)
    assert _new_po(shop)[1] == "PO-9999"
    assert _new_po(shop)[1] == "PO-10000"


def test_po_99999999_is_the_last_number_that_fits(db, shop):
    """[N2] PO-99999999 is eleven characters and is minted; PO-100000000 is twelve and is
    refused as a sentence, not truncated."""
    _set_counter(db, shop, 99999999)
    assert _new_po(shop)[1] == "PO-99999999"

    err = ps.refuse(shop.admin, "create_vendor_purchase_order", **ps.create_args(shop.v1, [ps.other_line()]))
    ps.assert_sentence_refusal(err)
    assert ps.count(db, "vendor_purchase_orders", shop.company) == 1


# ── N3: concurrency-safe, never reissued, nothing consumed by a rollback ───────────────────────


def _create_in_open_transaction(conn, shop: ps.Shop) -> str:
    with conn.cursor() as cur:
        ps.act_as(cur, shop.admin)
        return ps.rpc(cur, "create_vendor_purchase_order", **ps.create_args(shop.v1, [ps.other_line()]))[1]


@pytest.mark.parametrize("round_", ["first-po-ever", "series-already-exists"])
def test_two_creates_at_once_queue_on_the_series_without_a_duplicate(db, shop, round_):
    """[N3] The second create WAITS for the first and then takes the next number.

    Run on the company's very first PO as well as a later one, because the first is where an
    implementation that "selects, then inserts the default series row" races itself into a
    23505 on the series key — the failure this test exists to catch.
    """
    if round_ == "series-already-exists":
        assert _new_po(shop)[1] == "PO-0001"
    expected = ("PO-0001", "PO-0002") if round_ == "first-po-ever" else ("PO-0002", "PO-0003")

    first, second = ps.connect(), ps.connect()
    outcome: dict = {}

    def the_second_buyer():
        try:
            outcome["number"] = _create_in_open_transaction(second, shop)
            second.commit()
        except Exception as exc:  # noqa: BLE001 - reported below, with its SQLSTATE
            outcome["error"] = exc

    try:
        held = _create_in_open_transaction(first, shop)
        worker = threading.Thread(target=the_second_buyer)
        worker.start()
        assert ps.wait_until_blocked(db, second.get_backend_pid()), (
            "the second create did not wait for the first one's lock on the series")
        first.commit()
        worker.join(timeout=20)
        assert not worker.is_alive(), "the second create never finished"
        assert "error" not in outcome, f"the second create failed instead of queueing: {outcome.get('error')!r}"
        assert (held, outcome["number"]) == expected
    finally:
        first.close()
        second.close()


def test_an_archived_pos_number_is_never_reissued(db, shop):
    """[N3] Archive is soft: PO-0001 stays spent."""
    first, number = _new_po(shop)
    assert number == "PO-0001"
    ps.set_state(shop.admin, first, "archive")
    assert _new_po(shop)[1] == "PO-0002"


def test_a_rolled_back_create_consumes_no_number(db, shop):
    """[N3] The vendor never saw the rolled-back number, so the next create takes it."""
    assert _new_po(shop)[1] == "PO-0001"
    conn = ps.connect()
    try:
        assert _create_in_open_transaction(conn, shop) == "PO-0002"
        conn.rollback()
    finally:
        conn.close()
    assert _new_po(shop)[1] == "PO-0002", "a rolled-back create left a gap in the sequence"


def test_a_number_that_already_exists_is_skipped_not_collided_with(db, shop):
    """[N3] A counter walked back behind the RPC's back (a repair script, a row inserted by
    hand) mints numbers that already exist; they are stepped over, never hit with a 23505 the
    user would read as a failure."""
    _new_po(shop)
    _new_po(shop)  # PO-0001, PO-0002
    _set_counter(db, shop, 1)
    assert _new_po(shop)[1] == "PO-0003"
