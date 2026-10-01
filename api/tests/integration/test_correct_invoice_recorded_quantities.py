"""Correcting what Jigged RECORDED an invoice as billing, and what it refuses.

THE DEFECT THESE ARE WRITTEN AGAINST. Before partial invoicing, billing half a job
meant pushing the whole invoice from Jigged and editing it down in QuickBooks. §7b of
20260702011324 then backfilled every legacy `created` invoice as having billed each
part's FULL current quantity, on the stated assumption that `job_parts.quantity ==
the invoiced qty`. For a hand-edited invoice that is false, so `qty_invoiceable` is 0
forever and the rest of the job can never be billed. Reported live on J-0018: 12
ordered, 3 shipped and invoiced, backfilled as 12, with a recorded line total of
$2,274.48 against a mirrored QuickBooks total of $585.12.

WHY THESE ARE DATABASE TESTS. Every property below lives in Postgres and none of it
is observable from the frontend: the role gate and the billing refusal are RAISEs
inside a SECURITY DEFINER body, the reopen is a three-trigger chain, the
over-ordered cap is a trigger the UI tries never to reach, and the revoked table
grant is the thing that makes the RPC the only write path rather than the intended
one.

These pin what makes the correction NARROW, not that it works:

  * lowering a recorded quantity reopens the remainder, through the existing
    triggers, with nothing writing invoicing_status by hand;
  * total_price is recomputed from the LOCKED unit_price, never taken from the
    caller, or Jigged's revenue figure could be made to disagree with its own
    quantity;
  * it refuses to leave an invoice recording nothing, because Σ line total 0 breaks
    the payment mirror's void test and a voided invoice would start reading as PAID;
  * it is office-only, and the dashboard has no operator redirect, so this is a real
    gate;
  * it refuses a lapsed shop, because SECURITY DEFINER bypasses the RESTRICTIVE
    billing policy and the gate is re-stated by hand;
  * a non-member cannot tell a missing invoice from someone else's;
  * the browser STILL cannot write the line-item table directly — that table carried
    a stray INSERT/UPDATE/DELETE grant for `authenticated` from 2026-07-02 until
    20261001025551 revoked it.

Requires a local Supabase with all migrations applied (TEST_SUPABASE_URL /
TEST_SUPABASE_PUBLISHABLE_KEY / TEST_SUPABASE_SECRET_KEY). Skipped without it.
"""
from __future__ import annotations

import os
import uuid

import pytest
from supabase import create_client

pytestmark = pytest.mark.integration

ORDERED = 12
UNIT_PRICE = 189.54
# What the real QuickBooks document billed, per the J-0018 case this reproduces.
ACTUALLY_BILLED = 3


def _publishable_key() -> str:
    return os.environ.get("TEST_SUPABASE_PUBLISHABLE_KEY") or os.environ["TEST_SUPABASE_ANON_KEY"]


def _add_member(admin, company_id: str, label: str, role: str) -> dict:
    email = f"civ-{label}-{os.urandom(4).hex()}@test.jigged.local"
    password = "test-password-correct-invoice-qty"
    created = admin.auth.admin.create_user(
        {"email": email, "password": password, "email_confirm": True}
    )
    admin.table("user_company_access").insert(
        {
            "user_id": created.user.id,
            "company_id": company_id,
            "role": role,
            "name": label.title(),
        }
    ).execute()
    client = create_client(os.environ["TEST_SUPABASE_URL"], _publishable_key())
    client.auth.sign_in_with_password({"email": email, "password": password})
    return {"user_id": created.user.id, "client": client}


@pytest.fixture
def shop(supabase_admin):
    """A job of 12 carrying one legacy invoice the backfill recorded at the full 12."""
    admin = supabase_admin
    company_id = (
        admin.table("companies")
        .insert({"name": f"civ-{os.urandom(3).hex()}"})
        .execute()
        .data[0]["id"]
    )
    # Demo => company_can_write() is true with no billing row. One test flips this off
    # deliberately; every other test needs the write to succeed for reasons that have
    # nothing to do with billing.
    admin.table("companies").update({"is_demo": True}).eq("id", company_id).execute()

    office = _add_member(admin, company_id, "cory", "user")
    machinist = _add_member(admin, company_id, "joe", "operator")

    def _part(prefix: str) -> str:
        return (
            admin.table("parts")
            .insert(
                {
                    "company_id": company_id,
                    "part_name": f"{prefix}-{os.urandom(3).hex()}",
                    "primary_unit": "ea",
                }
            )
            .execute()
            .data[0]["id"]
        )

    # Two distinct parts: job_parts carries a UNIQUE (job_id, part_id), so one job
    # cannot list the same part twice.
    part_id = _part("RAIL")
    other_part_id = _part("JAW")
    job_id = (
        admin.table("jobs")
        .insert(
            {
                "company_id": company_id,
                "job_number": f"J-0018-{os.urandom(2).hex()}",
                "production_status": "not_started",
                "fulfillment_status": "unshipped",
            }
        )
        .execute()
        .data[0]["id"]
    )

    def _job_part(sequence: int, part: str) -> str:
        return (
            admin.table("job_parts")
            .insert(
                {
                    "company_id": company_id,
                    "job_id": job_id,
                    "part_id": part,
                    "sequence": sequence,
                    "quantity": ORDERED,
                    "unit_price": UNIT_PRICE,
                    "production_status": "not_started",
                    "fulfillment_status": "unshipped",
                }
            )
            .execute()
            .data[0]["id"]
        )

    job_part_id = _job_part(10, part_id)

    def _add_job_part(sequence: int) -> str:
        """A SECOND part on the job. Deliberately not in the base fixture: the job
        rollup reads every part, so a spare uninvoiced one makes the job
        `partially_invoiced` before anything has been corrected."""
        return _job_part(sequence, other_part_id)


    def _invoice(job_part: str | None, quantity: float, doc: str) -> str:
        link_id = (
            admin.table("quickbooks_invoice_links")
            .insert(
                {
                    "company_id": company_id,
                    "job_id": job_id,
                    "realm_id": "realm-civ",
                    "qb_request_id": str(uuid.uuid4()),
                    "qb_invoice_id": doc,
                    "qb_invoice_doc_number": doc,
                    "status": "created",
                    "provider": "qbo",
                }
            )
            .execute()
            .data[0]["id"]
        )
        if job_part is not None:
            _add_line(link_id, job_part, quantity)
        return link_id

    def _add_line(link_id: str, job_part: str, quantity: float) -> None:
        admin.table("quickbooks_invoice_line_items").insert(
            {
                "company_id": company_id,
                "invoice_link_id": link_id,
                "job_part_id": job_part,
                "quantity": quantity,
                "unit_price": UNIT_PRICE,
                "total_price": round(quantity * UNIT_PRICE, 4),
            }
        ).execute()

    ctx = {
        "admin": admin,
        "company_id": company_id,
        "office": office,
        "machinist": machinist,
        "job_id": job_id,
        "job_part_id": job_part_id,
        "add_job_part": _add_job_part,
        # The backfill's row: the whole ordered quantity, recorded as billed.
        "link_id": _invoice(job_part_id, ORDERED, "93587"),
        "invoice": _invoice,
        "add_line": _add_line,
    }
    yield ctx

    for table in (
        "quickbooks_invoice_line_items",
        "quickbooks_invoice_links",
        "job_parts",
        "jobs",
        "parts",
    ):
        try:
            admin.table(table).delete().eq("company_id", company_id).execute()
        except Exception:
            pass
    admin.table("companies").delete().eq("id", company_id).execute()
    for m in (office, machinist):
        try:
            admin.auth.admin.delete_user(m["user_id"])
        except Exception:
            pass


def _correct(member: dict, link_id: str, lines: list[dict]):
    return (
        member["client"]
        .rpc(
            "correct_invoice_recorded_quantities",
            {"p_invoice_link_id": link_id, "p_lines": lines},
        )
        .execute()
    )


def _statuses(admin, ctx) -> tuple[str, str]:
    part = (
        admin.table("job_parts")
        .select("invoicing_status")
        .eq("id", ctx["job_part_id"])
        .single()
        .execute()
        .data["invoicing_status"]
    )
    job = (
        admin.table("jobs")
        .select("invoicing_status")
        .eq("id", ctx["job_id"])
        .single()
        .execute()
        .data["invoicing_status"]
    )
    return part, job


def _lines(admin, link_id: str) -> list[dict]:
    return (
        admin.table("quickbooks_invoice_line_items")
        .select("job_part_id, quantity, unit_price, total_price")
        .eq("invoice_link_id", link_id)
        .execute()
        .data
    )


def test_the_backfilled_invoice_starts_the_job_fully_invoiced(shop):
    """The defect, pinned: nothing is left to invoice before the correction."""
    assert _statuses(shop["admin"], shop) == ("fully_invoiced", "fully_invoiced")


def test_lowering_the_recorded_quantity_reopens_the_remainder(shop):
    result = _correct(
        shop["office"],
        shop["link_id"],
        [{"job_part_id": shop["job_part_id"], "quantity": ACTUALLY_BILLED}],
    )
    assert result.data["lines_changed"] == 1
    assert result.data["lines_removed"] == 0
    assert result.data["job_id"] == shop["job_id"]

    # The reopen is the whole point, and it is the trigger chain's work: nothing in
    # the RPC writes invoicing_status.
    assert _statuses(shop["admin"], shop) == ("partially_invoiced", "partially_invoiced")

    line = _lines(shop["admin"], shop["link_id"])[0]
    assert float(line["quantity"]) == ACTUALLY_BILLED
    # Recomputed from the LOCKED snapshot, never supplied by the caller.
    assert float(line["unit_price"]) == UNIT_PRICE
    assert float(line["total_price"]) == round(ACTUALLY_BILLED * UNIT_PRICE, 4)


def test_it_stamps_who_corrected_the_record(shop):
    _correct(
        shop["office"],
        shop["link_id"],
        [{"job_part_id": shop["job_part_id"], "quantity": ACTUALLY_BILLED}],
    )
    link = (
        shop["admin"]
        .table("quickbooks_invoice_links")
        .select("corrected_at, corrected_by")
        .eq("id", shop["link_id"])
        .single()
        .execute()
        .data
    )
    assert link["corrected_at"] is not None
    # An auth.users id, like shipments.voided_by -- NOT a user_company_access id.
    assert link["corrected_by"] == shop["office"]["user_id"]


def test_re_sending_the_same_numbers_changes_nothing(shop):
    lines = [{"job_part_id": shop["job_part_id"], "quantity": ACTUALLY_BILLED}]
    _correct(shop["office"], shop["link_id"], lines)
    again = _correct(shop["office"], shop["link_id"], lines)
    assert again.data["lines_changed"] == 0
    assert again.data["lines_removed"] == 0


def test_a_line_corrected_to_zero_is_removed_and_the_part_reopens_fully(shop):
    """An invoice that billed nothing of a part should record no line for it. The
    invoice still records SOMETHING, because a second line on the same invoice
    survives -- otherwise the "record at least some quantity" rule refuses it."""
    second = shop["add_job_part"](20)
    shop["add_line"](shop["link_id"], second, 5)

    result = _correct(
        shop["office"],
        shop["link_id"],
        [{"job_part_id": shop["job_part_id"], "quantity": 0}],
    )
    assert result.data["lines_removed"] == 1

    remaining = _lines(shop["admin"], shop["link_id"])
    assert [r["job_part_id"] for r in remaining] == [second]
    part, _job = _statuses(shop["admin"], shop)
    assert part == "uninvoiced"


def test_it_refuses_to_leave_an_invoice_recording_nothing(shop):
    """Σ line total 0 makes the payment mirror read a voided invoice as PAID
    (derive_invoice_status: total_amt 0 while Jigged's total > 0 => voided)."""
    with pytest.raises(Exception) as err:
        _correct(
            shop["office"],
            shop["link_id"],
            [{"job_part_id": shop["job_part_id"], "quantity": 0}],
        )
    assert "at least some quantity" in str(err.value)
    assert "void it in QuickBooks" in str(err.value)
    assert _statuses(shop["admin"], shop) == ("fully_invoiced", "fully_invoiced")


def test_it_refuses_more_than_the_job_ordered_without_naming_an_internal_id(shop):
    with pytest.raises(Exception) as err:
        _correct(
            shop["office"],
            shop["link_id"],
            [{"job_part_id": shop["job_part_id"], "quantity": ORDERED + 1}],
        )
    message = str(err.value)
    assert "more than the job ordered" in message
    # The at-rest backstop names a job_part UUID, and friendlyErrorMessage passes a
    # check_violation straight to the screen -- so the readable refusal has to win.
    assert shop["job_part_id"] not in message


def test_it_caps_against_what_other_invoices_already_record(shop):
    """Headroom is ordered MINUS what OTHER invoices record, not simply ordered.

    The second invoice can only be seeded after this one makes room, because the
    at-rest trigger blocks the seeding insert otherwise -- which is itself the
    invariant holding."""
    _correct(
        shop["office"],
        shop["link_id"],
        [{"job_part_id": shop["job_part_id"], "quantity": 8}],
    )
    shop["invoice"](shop["job_part_id"], 4, "93589")  # 8 + 4 == 12 ordered

    # 9 here would make 13 against an order of 12.
    with pytest.raises(Exception) as err:
        _correct(
            shop["office"],
            shop["link_id"],
            [{"job_part_id": shop["job_part_id"], "quantity": 9}],
        )
    assert "more than the job ordered" in str(err.value)

    # 8 -> 7 still works: lowering never collides with the cap.
    assert (
        _correct(
            shop["office"],
            shop["link_id"],
            [{"job_part_id": shop["job_part_id"], "quantity": 7}],
        ).data["lines_changed"]
        == 1
    )


def test_it_refuses_a_line_that_belongs_to_another_invoice(shop):
    other = shop["invoice"](shop["add_job_part"](20), 2, "93590")
    with pytest.raises(Exception) as err:
        _correct(
            shop["office"],
            other,
            [{"job_part_id": shop["job_part_id"], "quantity": 1}],
        )
    assert "does not belong to this invoice" in str(err.value)


def test_a_voided_invoice_has_nothing_to_correct(shop):
    shop["admin"].table("quickbooks_invoice_links").update(
        {"voided_at": "2026-09-01T00:00:00Z"}
    ).eq("id", shop["link_id"]).execute()
    with pytest.raises(Exception) as err:
        _correct(
            shop["office"],
            shop["link_id"],
            [{"job_part_id": shop["job_part_id"], "quantity": ACTUALLY_BILLED}],
        )
    assert "counts for nothing" in str(err.value)


def test_an_operator_cannot_correct_an_invoice(shop):
    with pytest.raises(Exception) as err:
        _correct(
            shop["machinist"],
            shop["link_id"],
            [{"job_part_id": shop["job_part_id"], "quantity": ACTUALLY_BILLED}],
        )
    assert "office task" in str(err.value)
    assert _statuses(shop["admin"], shop) == ("fully_invoiced", "fully_invoiced")


def test_a_non_member_cannot_tell_a_missing_invoice_from_someone_elses(shop, supabase_admin):
    outsider_company = (
        supabase_admin.table("companies")
        .insert({"name": f"civ-out-{os.urandom(3).hex()}"})
        .execute()
        .data[0]["id"]
    )
    outsider = _add_member(supabase_admin, outsider_company, "stranger", "admin")
    try:
        with pytest.raises(Exception) as err:
            _correct(
                outsider,
                shop["link_id"],
                [{"job_part_id": shop["job_part_id"], "quantity": 1}],
            )
        message = str(err.value)
        assert "not available" in message
        # Existence and membership answer together, so the refusal cannot be read as
        # confirmation that the invoice is real.
        with pytest.raises(Exception) as missing:
            _correct(
                outsider,
                str(uuid.uuid4()),
                [{"job_part_id": shop["job_part_id"], "quantity": 1}],
            )
        assert str(missing.value).count("not available") == message.count("not available")
    finally:
        supabase_admin.table("companies").delete().eq("id", outsider_company).execute()
        try:
            supabase_admin.auth.admin.delete_user(outsider["user_id"])
        except Exception:
            pass


def test_a_lapsed_shop_cannot_correct_an_invoice(shop):
    """SECURITY DEFINER bypasses the RESTRICTIVE billing policy, so the gate is
    re-stated by hand in the function body."""
    shop["admin"].table("companies").update({"is_demo": False}).eq(
        "id", shop["company_id"]
    ).execute()
    with pytest.raises(Exception) as err:
        _correct(
            shop["office"],
            shop["link_id"],
            [{"job_part_id": shop["job_part_id"], "quantity": ACTUALLY_BILLED}],
        )
    assert "no active subscription" in str(err.value)
    assert _statuses(shop["admin"], shop) == ("fully_invoiced", "fully_invoiced")


def test_the_browser_still_cannot_write_the_invoice_tables_directly(shop):
    """The RPC is the only write path, not merely the intended one.
    quickbooks_invoice_line_items carried a stray authenticated DML grant from
    2026-07-02 (it predates the non-retroactive 20260716025048) until 20261001025551
    revoked it, leaving it one RLS policy away from browser-writable."""
    for table, payload in (
        ("quickbooks_invoice_line_items", {"quantity": 1}),
        ("quickbooks_invoice_links", {"voided_at": "2026-09-01T00:00:00Z"}),
    ):
        with pytest.raises(Exception) as err:
            shop["office"]["client"].table(table).update(payload).eq(
                "company_id", shop["company_id"]
            ).execute()
        assert "permission denied" in str(err.value).lower()


def test_the_correction_rpc_leaves_every_ci_guard_empty(supabase_admin):
    """Both invoice tables left tenant_tables_missing_write_gate()'s exempt list in
    20261001025551, which is what makes definer_writers_missing_write_gate() able to
    see this function at all -- it only inspects writers of a GATED table."""
    for guard in (
        "tenant_tables_missing_write_gate",
        "definer_writers_missing_write_gate",
        "function_execute_leaks",
    ):
        assert supabase_admin.rpc(guard, {}).execute().data == [], guard
