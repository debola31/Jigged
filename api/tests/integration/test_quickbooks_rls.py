"""Integration tests for QuickBooks table access control (RLS + REVOKE).

The security-critical assertion: the per-company OAuth tokens in
quickbooks_connections must NEVER be readable by the browser (anon/authenticated)
role — only the service-role backend. The map/link tables hold no secrets and are
member-readable but backend-written.

Requires a local Supabase (TEST_SUPABASE_URL / TEST_SUPABASE_PUBLISHABLE_KEY /
TEST_SUPABASE_SECRET_KEY) with this branch's migration applied. Skipped in
environments without it.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from uuid import uuid4

import pytest

pytestmark = pytest.mark.integration


def _seed_connection(supabase_admin, company_id: str) -> None:
    supabase_admin.table("quickbooks_connections").insert(
        {
            "company_id": company_id,
            "realm_id": "realm-rls",
            "environment": "sandbox",
            "access_token": "SECRET-ACCESS",
            "access_expires_at": (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat(),
            "refresh_token": "SECRET-REFRESH",
            "refresh_expires_at": (datetime.now(timezone.utc) + timedelta(days=100)).isoformat(),
        }
    ).execute()


def test_connections_tokens_hidden_from_browser_role(supabase_admin, seeded_user_a):
    """The token table is REVOKE'd from authenticated -> a user's anon-JWT client
    cannot read it at all, while service_role can."""
    company_id = seeded_user_a["company_id"]
    _seed_connection(supabase_admin, company_id)
    try:
        admin_read = (
            supabase_admin.table("quickbooks_connections")
            .select("*")
            .eq("company_id", company_id)
            .execute()
        )
        assert admin_read.data and admin_read.data[0]["access_token"] == "SECRET-ACCESS"

        # The browser (authenticated) role must be denied entirely. REVOKE makes
        # PostgREST raise rather than return rows.
        user_client = seeded_user_a["client"]
        with pytest.raises(Exception):
            user_client.table("quickbooks_connections").select("*").eq(
                "company_id", company_id
            ).execute()
    finally:
        supabase_admin.table("quickbooks_connections").delete().eq("company_id", company_id).execute()


def test_customer_map_member_can_read_but_not_write(supabase_admin, seeded_user_a):
    company_id = seeded_user_a["company_id"]
    customer = (
        supabase_admin.table("customers")
        .insert({"company_id": company_id, "name": "QB RLS Customer"})
        .execute()
        .data[0]
    )
    supabase_admin.table("quickbooks_customer_map").insert(
        {
            "company_id": company_id,
            "customer_id": customer["id"],
            "realm_id": "realm-rls",
            "qb_customer_id": "QB-99",
        }
    ).execute()
    try:
        user_client = seeded_user_a["client"]
        read = (
            user_client.table("quickbooks_customer_map")
            .select("qb_customer_id")
            .eq("company_id", company_id)
            .execute()
        )
        assert read.data and read.data[0]["qb_customer_id"] == "QB-99"

        # INSERT/UPDATE/DELETE are REVOKE'd from authenticated -> must fail.
        with pytest.raises(Exception):
            user_client.table("quickbooks_customer_map").insert(
                {
                    "company_id": company_id,
                    "customer_id": customer["id"],
                    "realm_id": "realm-other",
                    "qb_customer_id": "QB-100",
                }
            ).execute()
    finally:
        supabase_admin.table("quickbooks_customer_map").delete().eq("company_id", company_id).execute()
        supabase_admin.table("customers").delete().eq("id", customer["id"]).execute()


def test_invoice_links_cross_company_blocked(supabase_admin, seeded_user_a, seeded_company_b_graph):
    """User A (member of company A only) cannot read company B's invoice links."""
    company_b = seeded_company_b_graph["company_id"]
    quote_b = seeded_company_b_graph["quote_id"]
    supabase_admin.table("quickbooks_invoice_links").insert(
        {
            "company_id": company_b,
            "quote_id": quote_b,
            "realm_id": "realm-b",
            "qb_request_id": str(uuid4()),
            "status": "created",
            "qb_invoice_id": "INV-B-1",
        }
    ).execute()
    try:
        user_a_client = seeded_user_a["client"]
        read = (
            user_a_client.table("quickbooks_invoice_links")
            .select("*")
            .eq("company_id", company_b)
            .execute()
        )
        # RLS filters to the user's own company -> B's row is invisible.
        assert read.data == []
    finally:
        supabase_admin.table("quickbooks_invoice_links").delete().eq("company_id", company_b).execute()
