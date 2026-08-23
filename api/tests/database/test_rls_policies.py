"""
Row-Level Security policy tests for the multi-tenant model.

Architecture
------------
Each test exercises one CRUD verb against a row that user A *should not*
be able to see or touch. Setup of the cross-tenant row is done by the
session-scoped `seeded_company_b_graph` fixture using the local-Supabase
service-role key (publicly known, throwaway local DB). The actual SELECT
/ INSERT / UPDATE / DELETE attempts go through `seeded_user_a["client"]`
— an anon-key Supabase client carrying the user A JWT. Exercising the
policies the same way the production app does is the whole point; if a
policy regresses, this test file fails loudly.

Expected behaviors when user A targets company B's data
-------------------------------------------------------
- SELECT: returns `[]`. RLS silently filters; PostgREST does not raise.
- INSERT: raises postgrest.exceptions.APIError (the policy's WITH CHECK
  rejects). The exact code is typically `42501` (insufficient privilege)
  or PostgREST `PGRST301`.
- UPDATE: returns `data == []`, not an error. RLS narrows the affected
  set to empty.
- DELETE: same shape — `data == []`.

Coverage
--------
Tables covered (in matrix form: rows = tables, columns = verbs):

  customers      SELECT INSERT UPDATE DELETE
  parts          SELECT INSERT UPDATE DELETE
  quotes         SELECT INSERT UPDATE DELETE
  jobs           SELECT INSERT UPDATE DELETE
  routings       SELECT INSERT UPDATE DELETE
  vendors        SELECT INSERT UPDATE DELETE
  work_centers   SELECT INSERT UPDATE DELETE
  shipments      SELECT INSERT UPDATE DELETE
  companies      SELECT INSERT UPDATE DELETE   # last-line-of-defense

Child tables (routing_operations, shipment_line_items, user_company_access)
inherit isolation transitively via their parents; the parent tests cover
them implicitly. Direct tests for child tables can be added in a
follow-up if specific bypass routes are suspected.
"""
from __future__ import annotations

import pytest
from postgrest.exceptions import APIError

pytestmark = pytest.mark.integration


# Common helpers ---------------------------------------------------------------


def _expect_blocked_insert(call):
    """
    Run `call()` and require it to raise APIError (RLS WITH CHECK violated).
    Accepts either a true raise or PostgREST's 401/403-style error payload.
    """
    with pytest.raises(APIError) as exc_info:
        call()
    # We don't pin on a specific code because PostgREST varies between
    # versions and providers (42501 for direct PG, PGRST301 for missing
    # JWT, "new row violates row-level security policy" string match).
    # The fact that it raises at all is the assertion.
    assert exc_info.value is not None


def _user_a_table(seeded_user_a, table_name):
    """Shortcut: PostgREST `from(table)` chain via user A's anon-key client."""
    return seeded_user_a["client"].table(table_name)


# customers --------------------------------------------------------------------


class TestCustomersRLS:
    def test_select_cross_tenant_returns_empty(
        self, seeded_user_a, seeded_company_b_graph
    ):
        result = (
            _user_a_table(seeded_user_a, "customers")
            .select("id")
            .eq("id", seeded_company_b_graph["customer_id"])
            .execute()
        )
        assert result.data == []

    def test_insert_into_other_company_is_blocked(
        self, seeded_user_a, seeded_company_b_graph
    ):
        _expect_blocked_insert(
            lambda: _user_a_table(seeded_user_a, "customers")
            .insert(
                {
                    "company_id": seeded_company_b_graph["company_id"],
                    "name": "RLS Attack — should not land",
                }
            )
            .execute()
        )

    def test_update_cross_tenant_returns_empty(
        self, seeded_user_a, seeded_company_b_graph
    ):
        result = (
            _user_a_table(seeded_user_a, "customers")
            .update({"name": "RLS Attack — should not stick"})
            .eq("id", seeded_company_b_graph["customer_id"])
            .execute()
        )
        assert result.data == []

    def test_delete_cross_tenant_returns_empty(
        self, seeded_user_a, seeded_company_b_graph
    ):
        result = (
            _user_a_table(seeded_user_a, "customers")
            .delete()
            .eq("id", seeded_company_b_graph["customer_id"])
            .execute()
        )
        assert result.data == []


# parts ------------------------------------------------------------------------


class TestPartsRLS:
    def test_select_cross_tenant_returns_empty(
        self, seeded_user_a, seeded_company_b_graph
    ):
        result = (
            _user_a_table(seeded_user_a, "parts")
            .select("id")
            .eq("id", seeded_company_b_graph["part_id"])
            .execute()
        )
        assert result.data == []

    def test_insert_into_other_company_is_blocked(
        self, seeded_user_a, seeded_company_b_graph
    ):
        _expect_blocked_insert(
            lambda: _user_a_table(seeded_user_a, "parts")
            .insert(
                {
                    "company_id": seeded_company_b_graph["company_id"],
                    "part_name": "RLS-ATTACK-PART",
                    "source": "made",
                    "primary_unit": "each",
                }
            )
            .execute()
        )

    def test_update_cross_tenant_returns_empty(
        self, seeded_user_a, seeded_company_b_graph
    ):
        result = (
            _user_a_table(seeded_user_a, "parts")
            .update({"part_name": "RLS Attack — should not stick"})
            .eq("id", seeded_company_b_graph["part_id"])
            .execute()
        )
        assert result.data == []

    def test_delete_cross_tenant_returns_empty(
        self, seeded_user_a, seeded_company_b_graph
    ):
        result = (
            _user_a_table(seeded_user_a, "parts")
            .delete()
            .eq("id", seeded_company_b_graph["part_id"])
            .execute()
        )
        assert result.data == []


# quotes -----------------------------------------------------------------------


class TestQuotesRLS:
    def test_select_cross_tenant_returns_empty(
        self, seeded_user_a, seeded_company_b_graph
    ):
        result = (
            _user_a_table(seeded_user_a, "quotes")
            .select("id")
            .eq("id", seeded_company_b_graph["quote_id"])
            .execute()
        )
        assert result.data == []

    def test_insert_into_other_company_is_blocked(
        self, seeded_user_a, seeded_company_b_graph
    ):
        _expect_blocked_insert(
            lambda: _user_a_table(seeded_user_a, "quotes")
            .insert(
                {
                    "company_id": seeded_company_b_graph["company_id"],
                    "customer_id": seeded_company_b_graph["customer_id"],
                    "quote_number": "",
                    "status": "active",
                }
            )
            .execute()
        )

    def test_update_cross_tenant_returns_empty(
        self, seeded_user_a, seeded_company_b_graph
    ):
        result = (
            _user_a_table(seeded_user_a, "quotes")
            .update({"status": "expired"})
            .eq("id", seeded_company_b_graph["quote_id"])
            .execute()
        )
        assert result.data == []

    def test_delete_cross_tenant_returns_empty(
        self, seeded_user_a, seeded_company_b_graph
    ):
        result = (
            _user_a_table(seeded_user_a, "quotes")
            .delete()
            .eq("id", seeded_company_b_graph["quote_id"])
            .execute()
        )
        assert result.data == []


# jobs -------------------------------------------------------------------------


class TestJobsRLS:
    def test_select_cross_tenant_returns_empty(
        self, seeded_user_a, seeded_company_b_graph
    ):
        result = (
            _user_a_table(seeded_user_a, "jobs")
            .select("id")
            .eq("id", seeded_company_b_graph["job_id"])
            .execute()
        )
        assert result.data == []

    def test_insert_into_other_company_is_blocked(
        self, seeded_user_a, seeded_company_b_graph
    ):
        _expect_blocked_insert(
            lambda: _user_a_table(seeded_user_a, "jobs")
            .insert(
                {
                    "company_id": seeded_company_b_graph["company_id"],
                    "customer_id": seeded_company_b_graph["customer_id"],
                    "job_number": "J-RLS-ATTACK",
                    "production_status": "not_started",
                    "fulfillment_status": "unshipped",
                }
            )
            .execute()
        )

    def test_update_cross_tenant_returns_empty(
        self, seeded_user_a, seeded_company_b_graph
    ):
        result = (
            _user_a_table(seeded_user_a, "jobs")
            .update({"production_status": "in_progress"})
            .eq("id", seeded_company_b_graph["job_id"])
            .execute()
        )
        assert result.data == []

    def test_delete_cross_tenant_returns_empty(
        self, seeded_user_a, seeded_company_b_graph
    ):
        result = (
            _user_a_table(seeded_user_a, "jobs")
            .delete()
            .eq("id", seeded_company_b_graph["job_id"])
            .execute()
        )
        assert result.data == []


# routings ---------------------------------------------------------------------


class TestRoutingsRLS:
    def test_select_cross_tenant_returns_empty(
        self, seeded_user_a, seeded_company_b_graph
    ):
        result = (
            _user_a_table(seeded_user_a, "routings")
            .select("id")
            .eq("id", seeded_company_b_graph["routing_id"])
            .execute()
        )
        assert result.data == []

    def test_insert_into_other_company_is_blocked(
        self, seeded_user_a, seeded_company_b_graph
    ):
        _expect_blocked_insert(
            lambda: _user_a_table(seeded_user_a, "routings")
            .insert(
                {
                    "company_id": seeded_company_b_graph["company_id"],
                    "part_id": seeded_company_b_graph["part_id"],
                    "name": "RLS Attack Routing",
                }
            )
            .execute()
        )

    def test_update_cross_tenant_returns_empty(
        self, seeded_user_a, seeded_company_b_graph
    ):
        result = (
            _user_a_table(seeded_user_a, "routings")
            .update({"name": "RLS Attack — should not stick"})
            .eq("id", seeded_company_b_graph["routing_id"])
            .execute()
        )
        assert result.data == []

    def test_delete_cross_tenant_returns_empty(
        self, seeded_user_a, seeded_company_b_graph
    ):
        result = (
            _user_a_table(seeded_user_a, "routings")
            .delete()
            .eq("id", seeded_company_b_graph["routing_id"])
            .execute()
        )
        assert result.data == []


# vendors ----------------------------------------------------------------------


class TestVendorsRLS:
    def test_select_cross_tenant_returns_empty(
        self, seeded_user_a, seeded_company_b_graph
    ):
        result = (
            _user_a_table(seeded_user_a, "vendors")
            .select("id")
            .eq("id", seeded_company_b_graph["vendor_id"])
            .execute()
        )
        assert result.data == []

    def test_insert_into_other_company_is_blocked(
        self, seeded_user_a, seeded_company_b_graph
    ):
        _expect_blocked_insert(
            lambda: _user_a_table(seeded_user_a, "vendors")
            .insert(
                {
                    "company_id": seeded_company_b_graph["company_id"],
                    "name": "RLS Attack Vendor",
                }
            )
            .execute()
        )

    def test_update_cross_tenant_returns_empty(
        self, seeded_user_a, seeded_company_b_graph
    ):
        result = (
            _user_a_table(seeded_user_a, "vendors")
            .update({"name": "RLS Attack — should not stick"})
            .eq("id", seeded_company_b_graph["vendor_id"])
            .execute()
        )
        assert result.data == []

    def test_delete_cross_tenant_returns_empty(
        self, seeded_user_a, seeded_company_b_graph
    ):
        result = (
            _user_a_table(seeded_user_a, "vendors")
            .delete()
            .eq("id", seeded_company_b_graph["vendor_id"])
            .execute()
        )
        assert result.data == []


# work_centers -----------------------------------------------------------------


class TestWorkCentersRLS:
    def test_select_cross_tenant_returns_empty(
        self, seeded_user_a, seeded_company_b_graph
    ):
        result = (
            _user_a_table(seeded_user_a, "work_centers")
            .select("id")
            .eq("id", seeded_company_b_graph["work_center_id"])
            .execute()
        )
        assert result.data == []

    def test_insert_into_other_company_is_blocked(
        self, seeded_user_a, seeded_company_b_graph
    ):
        _expect_blocked_insert(
            lambda: _user_a_table(seeded_user_a, "work_centers")
            .insert(
                {
                    "company_id": seeded_company_b_graph["company_id"],
                    "name": "RLS Attack WC",
                    "labor_rate": 0,
                }
            )
            .execute()
        )

    def test_update_cross_tenant_returns_empty(
        self, seeded_user_a, seeded_company_b_graph
    ):
        result = (
            _user_a_table(seeded_user_a, "work_centers")
            .update({"name": "RLS Attack — should not stick"})
            .eq("id", seeded_company_b_graph["work_center_id"])
            .execute()
        )
        assert result.data == []

    def test_delete_cross_tenant_returns_empty(
        self, seeded_user_a, seeded_company_b_graph
    ):
        result = (
            _user_a_table(seeded_user_a, "work_centers")
            .delete()
            .eq("id", seeded_company_b_graph["work_center_id"])
            .execute()
        )
        assert result.data == []


# shipments --------------------------------------------------------------------


class TestShipmentsRLS:
    def test_select_cross_tenant_returns_empty(
        self, seeded_user_a, seeded_company_b_graph
    ):
        result = (
            _user_a_table(seeded_user_a, "shipments")
            .select("id")
            .eq("id", seeded_company_b_graph["shipment_id"])
            .execute()
        )
        assert result.data == []

    def test_insert_into_other_company_is_blocked(
        self, seeded_user_a, seeded_company_b_graph
    ):
        _expect_blocked_insert(
            lambda: _user_a_table(seeded_user_a, "shipments")
            .insert(
                {
                    "company_id": seeded_company_b_graph["company_id"],
                    "customer_id": seeded_company_b_graph["customer_id"],
                    "job_id": seeded_company_b_graph["job_id"],
                    "packing_slip_number": "PS-RLS-ATTACK",
                }
            )
            .execute()
        )

    def test_update_cross_tenant_returns_empty(
        self, seeded_user_a, seeded_company_b_graph
    ):
        result = (
            _user_a_table(seeded_user_a, "shipments")
            .update({"carrier": "RLS Attack — should not stick"})
            .eq("id", seeded_company_b_graph["shipment_id"])
            .execute()
        )
        assert result.data == []

    def test_delete_cross_tenant_returns_empty(
        self, seeded_user_a, seeded_company_b_graph
    ):
        result = (
            _user_a_table(seeded_user_a, "shipments")
            .delete()
            .eq("id", seeded_company_b_graph["shipment_id"])
            .execute()
        )
        assert result.data == []


# companies --------------------------------------------------------------------
# Last line of defense: even if user A could somehow target the companies table
# directly, RLS must not let them read/write company B's row.


class TestCompaniesRLS:
    def test_select_cross_tenant_returns_empty(
        self, seeded_user_a, seeded_company_b_graph
    ):
        result = (
            _user_a_table(seeded_user_a, "companies")
            .select("id")
            .eq("id", seeded_company_b_graph["company_id"])
            .execute()
        )
        assert result.data == []

    def test_insert_into_other_company_is_blocked(self, seeded_user_a):
        # Companies have no `company_id` — they ARE the tenant. But the
        # insert policy still restricts to the authenticated user creating
        # their own company; user A trying to manufacture a fake company
        # they're not linked to should fail (the trigger on companies links
        # creator → access).
        # In the current schema, INSERT on companies is gated by an after-
        # insert trigger that requires the auth user; service-role bypasses
        # this. Anon-key + JWT users hit the policy. We assert it raises.
        _expect_blocked_insert(
            lambda: _user_a_table(seeded_user_a, "companies")
            .insert({"name": "RLS Attack Company"})
            .execute()
        )

    def test_update_cross_tenant_returns_empty(
        self, seeded_user_a, seeded_company_b_graph
    ):
        result = (
            _user_a_table(seeded_user_a, "companies")
            .update({"name": "RLS Attack — should not stick"})
            .eq("id", seeded_company_b_graph["company_id"])
            .execute()
        )
        assert result.data == []

    def test_delete_cross_tenant_returns_empty(
        self, seeded_user_a, seeded_company_b_graph
    ):
        result = (
            _user_a_table(seeded_user_a, "companies")
            .delete()
            .eq("id", seeded_company_b_graph["company_id"])
            .execute()
        )
        assert result.data == []


# work_center_attachments --------------------------------------------------------
#
# Machine manuals. Company-scoped like everything else, with one extra rule the
# other tables here don't have: the uploader is resolved server-side, so a member
# cannot file an upload under someone else's name.


class TestWorkCenterAttachmentsRLS:
    def test_select_cross_tenant_returns_empty(
        self, seeded_user_a, seeded_company_b_graph
    ):
        result = (
            _user_a_table(seeded_user_a, "work_center_attachments")
            .select("id")
            .eq("work_center_id", seeded_company_b_graph["work_center_id"])
            .execute()
        )
        assert result.data == []

    def test_insert_into_other_company_is_blocked(
        self, seeded_user_a, seeded_company_b_graph
    ):
        _expect_blocked_insert(
            lambda: _user_a_table(seeded_user_a, "work_center_attachments")
            .insert(
                {
                    "company_id": seeded_company_b_graph["company_id"],
                    "work_center_id": seeded_company_b_graph["work_center_id"],
                    "storage_path": "b/work-centers/x/attack.pdf",
                    "file_name": "attack.pdf",
                    "kind": "pdf",
                }
            )
            .execute()
        )

    # The "uploaded_by must be the acting member" rule is NOT tested here.
    # These fixtures' companies are not billing-entitled, so every write is
    # refused by the billing gate before any other policy is consulted — an
    # attribution test would pass without ever exercising the clause it names.
    # It lives in test_note_views_rls.py instead, on a writable fixture, next to
    # the identical rule for notes.author_id.

    def test_delete_cross_tenant_returns_empty(
        self, seeded_user_a, seeded_company_b_graph
    ):
        result = (
            _user_a_table(seeded_user_a, "work_center_attachments")
            .delete()
            .eq("work_center_id", seeded_company_b_graph["work_center_id"])
            .execute()
        )
        assert result.data == []
