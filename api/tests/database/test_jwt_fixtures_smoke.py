"""
Smoke tests for the JWT fixtures added in sub-PR 3c.

These don't test RLS policies (that's sub-PR 3d). They test that the
fixtures themselves wire up correctly:
- seeded_user_a creates a user + company + access row + signs in
- seeded_user_b does the same for company B
- seeded_company_b_graph builds the parent-child object graph

If these pass, the 3d RLS tests have a working fixture base.
"""
import pytest

pytestmark = pytest.mark.integration


def test_seeded_user_a_yields_authenticated_client(seeded_user_a):
    """User A can read its own company via the JWT-authenticated client."""
    assert seeded_user_a["user_id"]
    assert seeded_user_a["access_token"]
    assert seeded_user_a["company_id"]

    # Anon-key client carrying the JWT should be able to read its own company.
    result = (
        seeded_user_a["client"]
        .table("companies")
        .select("id, name")
        .eq("id", seeded_user_a["company_id"])
        .execute()
    )
    assert len(result.data) == 1
    assert result.data[0]["id"] == seeded_user_a["company_id"]


def test_seeded_user_b_yields_authenticated_client(seeded_user_b):
    """Symmetric check on company B."""
    assert seeded_user_b["user_id"]
    assert seeded_user_b["access_token"]
    assert seeded_user_b["company_id"]
    result = (
        seeded_user_b["client"]
        .table("companies")
        .select("id")
        .eq("id", seeded_user_b["company_id"])
        .execute()
    )
    assert len(result.data) == 1


def test_seeded_company_b_graph_creates_expected_entities(seeded_company_b_graph):
    """Object graph fixture creates vendor, work center, customer, part, routing."""
    assert seeded_company_b_graph["vendor_id"]
    assert seeded_company_b_graph["work_center_id"]
    assert seeded_company_b_graph["customer_id"]
    assert seeded_company_b_graph["part_id"]
    assert seeded_company_b_graph["routing_id"]
    # company_id is the same as seeded_user_b's company_id (fixture chain)
    assert seeded_company_b_graph["company_id"] == seeded_company_b_graph["user"]["company_id"]
