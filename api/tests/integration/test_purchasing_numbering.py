"""Purchasing numbering: one series per company and document kind (plan §3.2, N1–N3).

WHAT THIS GUARDS. A purchase-order number is printed on paper the vendor keeps, and a shop
moving from QuickBooks Desktop wants to carry on its own sequence. So the series is a row per
(company, kind) — never the shared Q-/J- counter — with a settable prefix, next number and
minimum digits, validated together because they only mean something together:

  * **QuickBooks Desktop holds 11 characters** in a PO's `refNumber`. A prefix of six and six
    digits is twelve, and the push would truncate it into someone else's number.
  * **A number is never reissued** — not after an archive, not after a settings change that
    walks the counter back, not when a create rolls back. A rollback consumes nothing, because
    the vendor never saw it.
  * **Concurrency is the RPC's job, not the unique index's.** Two buyers saving at once must
    queue on the series row; a 23505 surfacing as "something went wrong" is the failure.
  * **Any office user may set it** (decision: the Purchasing hub, not admin Settings); an
    operator may not.

Run:
    cd api && pytest -m integration tests/integration/test_purchasing_numbering.py
"""
from __future__ import annotations

import threading

import psycopg2
import pytest

from tests.integration import purchasing_support as ps
from tests.integration.purchasing_support import db, other_shop, shop  # noqa: F401

pytestmark = pytest.mark.integration

PO_KIND = "vendor_purchase_order"


def _new_po(shop: ps.Shop, user: str | None = None) -> tuple[str, str]:
    """The smallest document a series can number: one freight line."""
    return ps.create_po(user or shop.admin, shop.v1, [ps.other_line("Freight")])


def _refuse_settings(shop: ps.Shop, changes: dict, user: str | None = None) -> psycopg2.Error:
    return ps.refuse(user or shop.user, "save_purchasing_document_settings",
                     p_company_id=shop.company, p_kind=PO_KIND, p_changes=changes)


# ── N1: a series per company and per kind ──────────────────────────────────────────────────────


def test_each_company_numbers_its_own_pos_and_rfqs_from_0001(db, shop, other_shop):
    """[N1] PO-0001 and RFQ-0001 by default, per company, and the two kinds never share."""
    assert _new_po(shop)[1] == "PO-0001"
    assert _new_po(shop)[1] == "PO-0002"
    assert _new_po(other_shop)[1] == "PO-0001", "another company's POs consumed this one's numbers"

    _, rfq_number = ps.create_rfq(shop.admin, shop.company, [ps.rfq_adhoc_line("Anodize 40 brackets")], [shop.v1])
    assert rfq_number == "RFQ-0001"
    assert _new_po(shop)[1] == "PO-0003", "an RFQ consumed a purchase-order number"


# ── N2: settable by any office user, validated as one ──────────────────────────────────────────


def test_an_empty_prefix_carries_on_a_quickbooks_sequence(db, shop):
    """[N2] Prefix '', next 1043, one digit gives "1043": the shop's own QuickBooks numbers."""
    ps.save_settings(shop.user, shop.company, prefix="", next_number=1043, min_digits=1)
    assert _new_po(shop)[1] == "1043"
    assert _new_po(shop)[1] == "1044"


@pytest.mark.parametrize(
    "changes",
    [
        pytest.param({"prefix": "ABCDEF", "min_digits": 6}, id="six-and-six-is-twelve"),
        pytest.param({"prefix": "ABCDEFG"}, id="a-seven-character-prefix"),
        pytest.param({"prefix": "ABCDEF", "next_number": 100000}, id="ABCDEF100000-is-twelve"),
    ],
)
def test_a_series_that_cannot_fit_eleven_characters_is_refused(db, shop, changes):
    """[N2] The 6-character prefix limit and QuickBooks Desktop's 11-character total."""
    ps.assert_sentence_refusal(_refuse_settings(shop, changes))
    assert _new_po(shop)[1] == "PO-0001", "a refused save still changed the series"


@pytest.mark.parametrize("prefix", ["PO_", "PO/", "PO ", "P.O", "PÖ-"])
def test_a_prefix_is_letters_digits_and_hyphens_only(db, shop, prefix):
    """[N2] `^[A-Za-z0-9-]{0,6}$`: a slash or a space prints, and breaks the next search."""
    ps.assert_sentence_refusal(_refuse_settings(shop, {"prefix": prefix}))


@pytest.mark.parametrize(
    "changes",
    [
        pytest.param({"min_digits": 0}, id="zero-digits"),
        pytest.param({"min_digits": 9}, id="nine-digits"),
        pytest.param({"next_number": 0}, id="next-number-zero"),
        pytest.param({"terms_and_conditions": "x" * 10001}, id="terms-over-10000-characters"),
    ],
)
def test_digits_next_number_and_terms_are_bounded(db, shop, changes):
    """[N2] min_digits 1–8, next_number ≥ 1, terms and conditions ≤ 10,000 characters."""
    ps.assert_sentence_refusal(_refuse_settings(shop, changes))


def test_the_next_number_must_stay_above_the_highest_issued_under_that_prefix(db, shop):
    """[N2] Walking the counter back would reissue a number a vendor already holds.

    The rule is per prefix: nothing has been issued under `P-`, so 1 is fine there — and
    switching back to `PO-` still remembers PO-0003.
    """
    for _ in range(3):
        _new_po(shop)
    for walked_back in (3, 1):
        ps.assert_sentence_refusal(_refuse_settings(shop, {"next_number": walked_back}))
    ps.save_settings(shop.user, shop.company, next_number=4)

    ps.save_settings(shop.user, shop.company, prefix="P-", next_number=1)
    assert _new_po(shop)[1] == "P-0001"

    ps.assert_sentence_refusal(_refuse_settings(shop, {"prefix": "PO-", "next_number": 2}))


def test_an_office_user_sets_numbering_and_an_operator_is_refused(db, shop):
    """[N2, S1] Any office user, from the Purchasing hub; an operator gets the office refusal."""
    ps.save_settings(shop.user, shop.company, prefix="VP-", next_number=500)
    assert _new_po(shop)[1] == "VP-0500"

    ps.assert_office_only(_refuse_settings(shop, {"next_number": 900}, user=shop.operator))
    assert _new_po(shop)[1] == "VP-0501", "an operator's refused save moved the series"


def test_a_new_po_copies_the_series_terms_and_keeps_its_own_copy(db, shop):
    """[N2, P1] Terms and conditions live on the series and are frozen onto each PO at create:
    the paper the vendor signed does not change when the shop edits its standard terms."""
    ps.save_settings(shop.user, shop.company, terms_and_conditions="Certs with every heat. Net 30.")
    first, _ = _new_po(shop)
    assert ps.po_row(db, first)["terms_and_conditions"] == "Certs with every heat. Net 30."

    ps.save_settings(shop.user, shop.company, terms_and_conditions="Revised terms")
    assert ps.po_row(db, first)["terms_and_conditions"] == "Certs with every heat. Net 30."
    second, _ = _new_po(shop)
    assert ps.po_row(db, second)["terms_and_conditions"] == "Revised terms"

    # The PO's copy is not a save key: it prints on the vendor's document, so changing it would
    # bump the revision without being on the shared vendor-visible field list (P3).
    err = ps.refuse(shop.user, "save_vendor_purchase_order",
                    **ps.save_args(first, changes={"terms_and_conditions": "Edited on the PO"}))
    assert err.pgcode == "XX000", f"expected XX000, got {err.pgcode}: {ps.message(err)}"
    assert ps.po_row(db, first)["terms_and_conditions"] == "Certs with every heat. Net 30."


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
    """[N3] A counter walked back behind the RPC's back (a repair script, an import) mints
    numbers that already exist; they are stepped over, never hit with a 23505 the user would
    read as a failure."""
    _new_po(shop)
    _new_po(shop)  # PO-0001, PO-0002
    ps.execute(db, """
        UPDATE purchasing_document_series SET next_number = 1
         WHERE company_id = %s AND document_kind = 'vendor_purchase_order'""", (shop.company,))
    assert _new_po(shop)[1] == "PO-0003"


def test_po_99999999_is_the_last_number_that_fits(db, shop):
    """[N3] PO-99999999 is eleven characters and is minted; PO-100000000 is twelve and is
    refused as a sentence, not truncated."""
    ps.save_settings(shop.user, shop.company, next_number=99999999)
    assert _new_po(shop)[1] == "PO-99999999"

    err = ps.refuse(shop.admin, "create_vendor_purchase_order", **ps.create_args(shop.v1, [ps.other_line()]))
    ps.assert_sentence_refusal(err)
    assert ps.count(db, "vendor_purchase_orders", shop.company) == 1
