"""supabase/seed.sql loads a purchasing department worth reviewing (plan §3.2, §6 step 1; S6).

WHAT THIS GUARDS. Every preview branch and every local reset is seeded from seed.sql, and a
reviewer can only judge what the seed puts on screen. A purchasing block that silently stopped
loading — a renamed column, a reordered insert — would leave the Orders tab empty and every
status chip but one unreviewable, with nothing failing. So this asserts the SHAPE the seed
must have in the dev company (Vanguard Precision Works), as lower bounds rather than counts:

  * a purchase order in every status: draft, sent, partly received, received, closed;
  * an outside-service line with a vendor packing slip linked to it;
  * RFQs that have been quoted, with a vendor who declined;
  * price sheets; and something on order, so To buy and the Materials card have a figure.

Statuses are read from the views, never re-derived, so the seed is checked by the same
definition the app shows.

Run (after `supabase db reset`):
    cd api && pytest -m integration tests/integration/test_purchasing_seed.py
"""
from __future__ import annotations

import re
from decimal import Decimal

import pytest

from tests.integration import purchasing_support as ps
from tests.integration.purchasing_support import db  # noqa: F401

pytestmark = pytest.mark.integration

SEED_COMPANY = "22222222-2222-2222-2222-222222222222"


@pytest.fixture
def seeded(db) -> str:
    if ps.scalar(db, "SELECT count(*) FROM companies WHERE id = %s", (SEED_COMPANY,)) == 0:
        pytest.fail("the seed company is missing: run `supabase db reset`, which loads supabase/seed.sql")
    return SEED_COMPANY


def test_the_seed_has_a_purchase_order_in_every_status(db, seeded):
    """[S6] Draft · Sent · Partly received · Received · Closed, all live."""
    statuses = {r["status"] for r in ps.rows(db, """
        SELECT s.status FROM vendor_purchase_order_status s
          JOIN vendor_purchase_orders p ON p.id = s.id
         WHERE p.company_id = %s AND p.deleted_at IS NULL""", (seeded,))}
    assert {ps.DRAFT, ps.SENT, ps.PARTLY_RECEIVED, ps.RECEIVED, ps.CLOSED} <= statuses, statuses


def test_the_seed_links_an_outside_line_to_a_live_slip(db, seeded):
    """[S6] The outside-processing integration is reviewable on the job page and the PO page."""
    linked = ps.scalar(db, """
        SELECT count(*) FROM outside_shipments s
          JOIN vendor_purchase_order_lines l ON l.id = s.vendor_purchase_order_line_id
         WHERE l.company_id = %s AND l.line_kind = 'outside_service' AND s.voided_at IS NULL""", (seeded,))
    assert linked >= 1


def test_the_seed_has_a_quoted_rfq_with_a_declined_vendor(db, seeded):
    """[S6] The compare matrix has prices in it, and the decline state is on screen."""
    statuses = {r["status"] for r in ps.rows(db, """
        SELECT s.status FROM vendor_rfq_status s JOIN vendor_rfqs r ON r.id = s.id
         WHERE r.company_id = %s AND r.deleted_at IS NULL""", (seeded,))}
    assert statuses & {"quoted", "awarded"}, statuses
    assert ps.scalar(db, "SELECT count(*) FROM vendor_rfq_responses WHERE company_id = %s", (seeded,)) >= 1
    assert ps.scalar(db, """
        SELECT count(*) FROM vendor_rfq_invitations WHERE company_id = %s AND declined_at IS NOT NULL""",
        (seeded,)) >= 1


def test_the_seed_has_live_price_sheets(db, seeded):
    """[S6] The Buying tab and the PO price default have a sheet to show."""
    assert ps.scalar(db, """
        SELECT count(*) FROM part_vendor_price_breaks b JOIN part_vendors pv ON pv.id = b.part_vendor_id
         WHERE pv.company_id = %s AND pv.deleted_at IS NULL""", (seeded,)) >= 1


def test_the_seed_has_something_on_order(db, seeded):
    """[S6] On order > 0 for at least one part, so Shortages nets it and the Materials card shows it."""
    most = ps.scalar(db, "SELECT max(on_order_quantity) FROM part_on_order WHERE company_id = %s", (seeded,))
    assert most is not None and Decimal(most) > 0


def test_the_seed_puts_a_part_on_shortages_each_way(db, seeded):
    """[S6, B2] The Shortages tab fills itself, so an empty one in the seed reads as a tab nobody can
    use (founder, 2026-11-12). The seed holds one row of each kind: the motors under their reorder
    point even with what is on order, and a job wanting more stainless than the shelf and the
    orders hold."""
    motors = ps.rows(db, """
        SELECT p.quantity + COALESCE(o.on_order_quantity, 0) AS supply, p.reorder_point
          FROM parts p LEFT JOIN part_on_order o ON o.part_id = p.id
         WHERE p.company_id = %s AND p.part_name = 'BUY-MOTOR-12V'""", (seeded,))[0]
    assert Decimal(motors["supply"]) <= Decimal(motors["reorder_point"]), motors

    stainless = ps.rows(db, """
        SELECT p.quantity + COALESCE(o.on_order_quantity, 0) AS supply,
               (SELECT COALESCE(sum(jp.quantity * b.quantity), 0)
                  FROM job_parts jp
                  JOIN jobs j ON j.id = jp.job_id AND j.deleted_at IS NULL
                  JOIN parts_bom b ON b.parent_part_id = jp.part_id AND b.child_part_id = p.id
                 WHERE jp.company_id = p.company_id
                   AND jp.production_status IN ('not_started', 'in_progress')) AS demand
          FROM parts p LEFT JOIN part_on_order o ON o.part_id = p.id
         WHERE p.company_id = %s AND p.part_name = 'RAW-SS304-BLANK'""", (seeded,))[0]
    assert Decimal(stainless["demand"]) > Decimal(stainless["supply"]), stainless


def test_every_seeded_po_holds_the_hash_its_content_version_counts(db, seeded):
    """[S6, QB9] The seed builds its POs through the RPCs -- create, award, receipts, a slip receipt
    on a linked line -- and every one of them ends by settling, so each PO's content_hash is the md5
    of what a push would send now. A writer that skipped it would leave a PO here whose next
    unrelated save reads "Out of date in QuickBooks"."""
    stale = [r["po_number"] for r in ps.rows(db, """
        SELECT po_number FROM vendor_purchase_orders
         WHERE company_id = %s
           AND content_hash IS DISTINCT FROM md5(public.vendor_purchase_order_pushed_projection(id)::text)""",
        (seeded,))]
    assert stale == []
    assert ps.scalar(db, "SELECT count(*) FROM vendor_purchase_orders WHERE company_id = %s AND vendor_rfq_id IS NOT NULL",
                     (seeded,)) >= 1, "the seed no longer awards an RFQ, so this no longer covers award_vendor_rfq"


def test_the_seeds_po_numbers_fit_quickbooks_desktop(db, seeded):
    """[S6, N1] The seed's POs are numbered the one fixed way, PO-0001 on, so they are unique and
    fit QuickBooks Desktop's 11 characters."""
    numbers = [r["po_number"] for r in ps.rows(db, "SELECT po_number FROM vendor_purchase_orders WHERE company_id = %s",
                                                 (seeded,))]
    assert numbers, "the seed has no purchase orders"
    assert all(re.fullmatch(r"PO-\d{4}", n) for n in numbers), numbers
    assert len(numbers) == len(set(numbers))
