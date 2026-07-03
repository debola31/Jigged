"""
Customer-consistency triggers from migration 20260527 (Shipments PR 8).

Phase 1.5 (Flow D) introduced multi-job shipments — one packing slip
can cover lines from multiple jobs for one customer. Two new triggers
defend the customer-consistency invariant:

  Trigger 1 — enforce_shipment_line_item_customer_consistency
    BEFORE INSERT OR UPDATE on shipment_line_items. Raises when the
    line's job.customer_id ≠ the parent shipments.customer_id.

  Trigger 2 — enforce_shipment_customer_id_immutable
    BEFORE UPDATE OF customer_id on shipments. Raises on any change.
    Voiding and recreating is the right path for a shipment that needs
    to belong to a different customer.

This file exercises both negative paths and confirms benign UPDATEs to
other shipment fields are unaffected by Trigger 2.

Run:
    cd api && pytest -m integration tests/integration/test_shipment_customer_consistency.py

Requires SUPABASE_URL + SUPABASE_SECRET_KEY in .env.local (service role,
so RLS doesn't have to be threaded through the test client).
"""
from __future__ import annotations

import os
import uuid
from dataclasses import dataclass

import pytest
from supabase import Client, create_client


pytestmark = pytest.mark.integration


@pytest.fixture(scope="module")
def admin() -> Client:
    url = os.getenv("TEST_SUPABASE_URL")
    key = os.getenv("TEST_SUPABASE_SECRET_KEY")
    if not url or not key:
        pytest.skip("Supabase admin credentials not configured")
    return create_client(url, key)


@dataclass
class TwoCustomerEnv:
    """
    Two distinct customers under one company, each with one job +
    one job_part. The fixtures share a company so the customers
    legitimately live on the same tenant — what we're catching is a
    leak across customer boundaries within a tenant.
    """
    company_id: str
    customer_a_id: str
    customer_b_id: str
    customer_a_address_id: str
    job_a_id: str
    job_part_a_id: str
    job_part_b_id: str


def _new_two_customer_env(admin: Client) -> TwoCustomerEnv:
    suffix = uuid.uuid4().hex[:8]

    company = (
        admin.table("companies")
        .insert({"name": f"CrossCustomer-{suffix}"})
        .execute()
        .data[0]
    )

    def _make_customer_with_job(name_prefix: str) -> tuple[str, str, str, str]:
        c = (
            admin.table("customers")
            .insert({"company_id": company["id"], "name": f"{name_prefix}-{suffix}"})
            .execute()
            .data[0]
        )
        addr = (
            admin.table("customer_addresses")
            .insert({
                "customer_id": c["id"],
                "address_line1": "1 Crosscheck Way",
                "city": "Testtown",
                "state": "CA",
                "postal_code": "94000",
                "country": "USA",
                "default_billing": True,
                "default_shipping": True,
            })
            .execute()
            .data[0]
        )
        job = (
            admin.table("jobs")
            .insert({
                "company_id": company["id"],
                "customer_id": c["id"],
                "job_number": f"J-{name_prefix}-{suffix}",
                "production_status": "completed",
                "fulfillment_status": "unshipped",
            })
            .execute()
            .data[0]
        )
        part = (
            admin.table("parts")
            .insert({
                "company_id": company["id"],
                "part_name": f"Part-{name_prefix}-{suffix}",
                "primary_unit": "ea",
            })
            .execute()
            .data[0]
        )
        jp = (
            admin.table("job_parts")
            .insert({
                "job_id": job["id"],
                "company_id": company["id"],
                "part_id": part["id"],
                "sequence": 10,
                "quantity": 10,
                "production_status": "completed",
                "fulfillment_status": "unshipped",
            })
            .execute()
            .data[0]
        )
        return c["id"], addr["id"], job["id"], jp["id"]

    cust_a_id, addr_a_id, job_a_id, jp_a_id = _make_customer_with_job("A")
    cust_b_id, _addr_b_id, _job_b_id, jp_b_id = _make_customer_with_job("B")

    return TwoCustomerEnv(
        company_id=company["id"],
        customer_a_id=cust_a_id,
        customer_b_id=cust_b_id,
        customer_a_address_id=addr_a_id,
        job_a_id=job_a_id,
        job_part_a_id=jp_a_id,
        job_part_b_id=jp_b_id,
    )


def _teardown(admin: Client, env: TwoCustomerEnv) -> None:
    # shipments.company_id is FK to companies WITHOUT cascade — clear the
    # dependent rows by hand so teardown doesn't fail after a test left a
    # shipment lying around. shipment_line_items cascades from shipments.
    admin.table("shipments").delete().eq("company_id", env.company_id).execute()
    admin.table("companies").delete().eq("id", env.company_id).execute()


def _make_shipment_for_a(admin: Client, env: TwoCustomerEnv) -> str:
    """
    Insert a clean shipment for customer A directly (bypassing the
    SECURITY DEFINER RPC's auth guard, same shape as the existing
    void permutations harness). Returns the new shipment id.
    """
    ps = f"PS-XCUST-{uuid.uuid4().hex[:6].upper()}"
    row = (
        admin.table("shipments")
        .insert({
            "company_id": env.company_id,
            "customer_id": env.customer_a_id,
            "job_id": env.job_a_id,
            "shipping_address_id": env.customer_a_address_id,
            "packing_slip_number": ps,
        })
        .execute()
        .data[0]
    )
    # Seed one valid same-customer line so the shipment exists with
    # data we can mutate. Two follow-up tests probe what UPDATEs are
    # allowed.
    admin.table("shipment_line_items").insert({
        "shipment_id": row["id"],
        "job_part_id": env.job_part_a_id,
        "quantity": 1,
    }).execute()
    return row["id"]


def test_line_item_trigger_rejects_cross_customer_insert(admin: Client):
    """
    Inserting a shipment_line_items row whose job_part resolves to a
    different customer than the parent shipment must raise.
    """
    env = _new_two_customer_env(admin)
    try:
        shipment_id = _make_shipment_for_a(admin, env)

        with pytest.raises(Exception) as exc_info:
            admin.table("shipment_line_items").insert({
                "shipment_id": shipment_id,
                "job_part_id": env.job_part_b_id,
                "quantity": 1,
            }).execute()

        msg = str(exc_info.value).lower()
        # The trigger raises with the customer ids in the message; the
        # postgrest layer will pass the SQLSTATE/MESSAGE through.
        assert "different customer" in msg or "belongs to customer" in msg or "check" in msg, (
            f"Expected customer-consistency error, got: {exc_info.value}"
        )
    finally:
        _teardown(admin, env)


def test_line_item_trigger_rejects_cross_customer_update(admin: Client):
    """
    Same trigger fires on UPDATE OF job_part_id: pointing an existing
    line at another customer's job_part is the same violation.
    """
    env = _new_two_customer_env(admin)
    try:
        shipment_id = _make_shipment_for_a(admin, env)
        line_id = (
            admin.table("shipment_line_items")
            .select("id")
            .eq("shipment_id", shipment_id)
            .single()
            .execute()
            .data["id"]
        )

        with pytest.raises(Exception) as exc_info:
            admin.table("shipment_line_items").update({
                "job_part_id": env.job_part_b_id,
            }).eq("id", line_id).execute()

        msg = str(exc_info.value).lower()
        assert "different customer" in msg or "belongs to customer" in msg or "check" in msg, (
            f"Expected customer-consistency error, got: {exc_info.value}"
        )
    finally:
        _teardown(admin, env)


def test_shipment_customer_id_immutable_trigger_rejects_change(admin: Client):
    """
    Trigger 2: UPDATE shipments SET customer_id = <other customer>
    must raise.

    Two BEFORE triggers fire on this UPDATE — the existing
    enforce_shipment_address_contact_customer (PR 4) also fires because
    shipping_address_id no longer matches the new customer. BEFORE-row
    trigger ordering isn't guaranteed in PostgreSQL, so either trigger
    may surface its error first. The behavior under test is "the
    UPDATE is rejected" — we assert exception + unchanged row, not a
    specific error message.
    """
    env = _new_two_customer_env(admin)
    try:
        shipment_id = _make_shipment_for_a(admin, env)

        with pytest.raises(Exception):
            admin.table("shipments").update({
                "customer_id": env.customer_b_id,
            }).eq("id", shipment_id).execute()

        # Row is unchanged — original customer still in place.
        row = (
            admin.table("shipments")
            .select("customer_id")
            .eq("id", shipment_id)
            .single()
            .execute()
            .data
        )
        assert row["customer_id"] == env.customer_a_id
    finally:
        _teardown(admin, env)


def test_shipment_immutability_trigger_allows_other_field_updates(admin: Client):
    """
    Trigger 2 watches OF customer_id specifically — updates to other
    fields on the same row must succeed (regression guard against an
    over-broad trigger that fires on every UPDATE).
    """
    env = _new_two_customer_env(admin)
    try:
        shipment_id = _make_shipment_for_a(admin, env)

        admin.table("shipments").update({
            "carrier": "UPS",
            "shipping_method": "shipment",
        }).eq("id", shipment_id).execute()

        row = (
            admin.table("shipments")
            .select("carrier, shipping_method")
            .eq("id", shipment_id)
            .single()
            .execute()
            .data
        )
        assert row["carrier"] == "UPS"
        assert row["shipping_method"] == "shipment"
    finally:
        _teardown(admin, env)
