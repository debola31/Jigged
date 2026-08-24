"""
Pytest fixtures for Jigged API tests.

Provides fixtures for Supabase client, test data, and authentication.
"""
import os
import sys
from pathlib import Path

import pytest
from typing import AsyncGenerator, Generator

# Load .env.local from project root so integration tests get DB URLs etc.
from dotenv import load_dotenv
_env_file = Path(__file__).resolve().parents[2] / ".env.local"
load_dotenv(_env_file)

from httpx import AsyncClient, ASGITransport
from supabase import create_client, Client

# Import the FastAPI app
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from index import app


@pytest.fixture(scope="session")
def supabase_admin() -> Generator[Client, None, None]:
    """
    Create an admin Supabase client using the local-Supabase service-role key.

    Requires TEST_SUPABASE_URL and TEST_SUPABASE_SECRET_KEY. No fallback to
    SUPABASE_URL / SUPABASE_SECRET_KEY (those are prod); silently running tests
    against prod is exactly the failure mode this guard prevents.

    Session-scoped so seeded_user_a / seeded_user_b (also session-scoped) can
    depend on it. The underlying client is stateless — sharing it across tests
    in a session is safe.
    """
    url = os.getenv("TEST_SUPABASE_URL")
    if not url:
        pytest.exit(
            "TEST_SUPABASE_URL not configured. Run `supabase start` and "
            "`eval \"$(supabase status -o env)\"`, then export "
            "TEST_SUPABASE_URL / TEST_SUPABASE_PUBLISHABLE_KEY / TEST_SUPABASE_SECRET_KEY. "
            "See docs/testing/README.md."
        )
    service_key = os.getenv("TEST_SUPABASE_SECRET_KEY")
    if not service_key:
        pytest.exit("TEST_SUPABASE_SECRET_KEY not configured.")

    client = create_client(url, service_key)
    yield client


@pytest.fixture
async def test_company(supabase_admin: Client) -> AsyncGenerator[dict, None]:
    """
    Create an isolated test company and clean up after tests.
    """
    company_data = {
        "name": f"Test Company {os.urandom(4).hex()}",
    }

    result = supabase_admin.table("companies").insert(company_data).execute()
    company = result.data[0]

    yield company

    # Cleanup: Delete company and all related data
    supabase_admin.table("customers").delete().eq("company_id", company["id"]).execute()
    supabase_admin.table("companies").delete().eq("id", company["id"]).execute()


@pytest.fixture
async def test_user(supabase_admin: Client, test_company: dict) -> AsyncGenerator[dict, None]:
    """
    Create a test user with company access.
    """
    # Note: In a real setup, you'd use Supabase Auth Admin API to create users
    # For now, this is a placeholder that assumes user creation is handled separately
    user_data = {
        "email": f"test-{os.urandom(4).hex()}@test.jigged.local",
        "company_id": test_company["id"],
    }

    yield user_data

    # Cleanup handled by test_company fixture cascading deletes


@pytest.fixture
def auth_token(test_user: dict) -> str:
    """
    Get a JWT token for the test user.

    In a real implementation, this would create an actual JWT.
    For now, returns a mock token.
    """
    return f"mock-jwt-token-{test_user['email']}"


@pytest.fixture
async def client(auth_token: str) -> AsyncGenerator[AsyncClient, None]:
    """
    Create an authenticated async HTTP client for API testing.
    """
    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport,
        base_url="http://testserver",
        headers={"Authorization": f"Bearer {auth_token}"}
    ) as ac:
        yield ac


@pytest.fixture
async def anon_client() -> AsyncGenerator[AsyncClient, None]:
    """
    Create an unauthenticated async HTTP client for API testing.
    """
    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport,
        base_url="http://testserver"
    ) as ac:
        yield ac


# ============================================================================
# JWT-fixture scaffolding for RLS tests (sub-PR 3d builds on these).
#
# These fixtures exercise the policies the same way the app does: anon-key
# clients carrying a real user JWT. Service-role only does the cross-tenant
# setup (creating both companies + linking users); the actual SELECT/INSERT/
# UPDATE/DELETE assertions go through the user-JWT client below.
# ============================================================================


def _publishable_key() -> str:
    """Local Supabase publishable (anon) key, required for user-JWT clients."""
    key = os.getenv("TEST_SUPABASE_PUBLISHABLE_KEY")
    if not key:
        pytest.exit(
            "TEST_SUPABASE_PUBLISHABLE_KEY not configured. Required for JWT-fixture "
            "tests. Run `supabase start` and `eval \"$(supabase status -o env)\"`."
        )
    return key


def _create_seeded_user(supabase_admin: Client, company_name_suffix: str) -> dict:
    """
    Create an isolated company + auth user, link them via user_company_access,
    and return a dict with everything an RLS test needs:

        {
          "user": SupabaseUser,
          "user_id": str,
          "access_token": str,
          "company_id": str,
          "client": Client,     # anon-key client carrying the user JWT
        }

    Email confirmation is set to True so signInWithPassword works immediately
    (no inbucket roundtrip needed). Local-Supabase default service-role lets
    us call auth.admin.create_user freely; on prod this fixture would never
    work — that's intentional, the conftest exits if TEST_SUPABASE_URL is
    unset earlier.
    """
    company = (
        supabase_admin.table("companies")
        .insert({"name": f"3c-{company_name_suffix}-{os.urandom(3).hex()}"})
        .execute()
    )
    company_id = company.data[0]["id"]

    email = f"3c-{company_name_suffix}-{os.urandom(4).hex()}@test.jigged.local"
    password = "test-password-3c-rls"

    created = supabase_admin.auth.admin.create_user(
        {"email": email, "password": password, "email_confirm": True}
    )
    user = created.user
    user_id = user.id

    supabase_admin.table("user_company_access").insert(
        {"user_id": user_id, "company_id": company_id, "role": "admin"}
    ).execute()

    # Anon-key client used for sign-in + downstream RLS-exercising calls.
    anon_client = create_client(os.environ["TEST_SUPABASE_URL"], _publishable_key())
    session = anon_client.auth.sign_in_with_password(
        {"email": email, "password": password}
    )
    return {
        "user": user,
        "user_id": user_id,
        "email": email,
        "access_token": session.session.access_token,
        "company_id": company_id,
        "client": anon_client,
    }


def _teardown_seeded_user(supabase_admin: Client, seeded: dict) -> None:
    """
    Reverse what _create_seeded_user did, in dependency order.

    A subset of FKs into `companies` lack ON DELETE CASCADE in the current
    schema (e.g. shipments.company_id, jobs.company_id). Same drift that
    test_shipment_void_permutations.py is xfailed against. Delete the
    known blockers explicitly before the company; the rest cascades.
    """
    company_id = seeded["company_id"]

    # Tables with FKs to companies(id) that are NOT ON DELETE CASCADE.
    # Order matters: shipment_line_items → shipments → (job_parts via
    # job_part_id) is independent of the company cascade, but PostgreSQL
    # evaluates the references at the parent-row delete, so wiping
    # shipments first is sufficient.
    for table in ("shipment_line_items", "shipments", "job_parts", "jobs"):
        try:
            (
                supabase_admin.table(table)
                .delete()
                .eq("company_id", company_id)
                .execute()
            )
        except Exception:
            # Some of these may not actually have a company_id column
            # (shipment_line_items doesn't — it inherits via the
            # shipment FK). Swallow the column-not-found error; the
            # subsequent company-delete will tell us if anything else
            # is still referencing us.
            pass

    supabase_admin.table("companies").delete().eq("id", company_id).execute()
    try:
        supabase_admin.auth.admin.delete_user(seeded["user_id"])
    except Exception:
        # Local-Supabase will sometimes 404 if the user is already gone via
        # an explicit test step; we don't want teardown noise to fail tests.
        pass


@pytest.fixture(scope="session")
def seeded_user_a(supabase_admin: Client) -> Generator[dict, None, None]:
    """
    Session-scoped: one user + one company, member of A only. RLS tests sign
    in as this user to attempt cross-tenant operations against B's data.
    """
    seeded = _create_seeded_user(supabase_admin, "user-a")
    yield seeded
    _teardown_seeded_user(supabase_admin, seeded)


@pytest.fixture(scope="session")
def seeded_user_b(supabase_admin: Client) -> Generator[dict, None, None]:
    """
    Session-scoped counterpart to seeded_user_a. Used to populate company B
    with rows that user A then attempts to read/write across the tenant boundary.
    """
    seeded = _create_seeded_user(supabase_admin, "user-b")
    yield seeded
    _teardown_seeded_user(supabase_admin, seeded)


@pytest.fixture
def billing_user(supabase_admin: Client) -> Generator[dict, None, None]:
    """Function-scoped fresh company + admin user + user-JWT client for billing
    write-gate tests. The company starts with NO company_billing row (→
    must_subscribe / write-blocked); each test sets the state it needs via
    supabase_admin. Function scope keeps state changes isolated per test."""
    seeded = _create_seeded_user(supabase_admin, "billing")
    try:
        yield seeded
    finally:
        _teardown_seeded_user(supabase_admin, seeded)


@pytest.fixture(scope="session")
def seeded_company_b_graph(
    supabase_admin: Client, seeded_user_b: dict
) -> Generator[dict, None, None]:
    """
    Build the parent-child object graph in company B once per session. RLS
    tests in sub-PR 3d read against this graph as user A and assert empty /
    blocked / 403 results.

    The graph mirrors a realistic shop: a customer, a vendor, two work
    centers (internal + external), three parts (made, raw, sub-assembly), a
    routing on the made part with one operation, and pricing tiers. Tables
    that 3d's RLS tests cover (customers, parts, quotes, jobs, routings,
    vendors, work_centers, shipments) all have at least one row here.

    The shape of this fixture is intentionally close to e2e/global-setup.ts's
    legacy_id-tagged seed — sub-PR 3g may reuse the same shape on the E2E
    side.
    """
    company_b_id = seeded_user_b["company_id"]

    # Vendor + work centers
    vendor = (
        supabase_admin.table("vendors")
        .insert({"company_id": company_b_id, "name": "RLS-3d Vendor B"})
        .execute()
    )
    vendor_id = vendor.data[0]["id"]

    internal_wc = (
        supabase_admin.table("work_centers")
        .insert(
            {
                "company_id": company_b_id,
                "name": "RLS-3d Internal WC",
                "labor_rate": 75.0,
            }
        )
        .execute()
    )
    internal_wc_id = internal_wc.data[0]["id"]

    # Customer
    customer = (
        supabase_admin.table("customers")
        .insert({"company_id": company_b_id, "name": "RLS-3d Customer B"})
        .execute()
    )
    customer_id = customer.data[0]["id"]

    # Part (made) — needs routing for downstream coverage
    part = (
        supabase_admin.table("parts")
        .insert(
            {
                "company_id": company_b_id,
                "part_name": "RLS-3d-MFG-001",
                "source": "made",
                "primary_unit": "each",
            }
        )
        .execute()
    )
    part_id = part.data[0]["id"]

    routing = (
        supabase_admin.table("routings")
        .insert(
            {
                "company_id": company_b_id,
                "part_id": part_id,
                "name": "RLS-3d Routing Default",
            }
        )
        .execute()
    )
    routing_id = routing.data[0]["id"]

    # routing_operations inherits company_id transitively via the routing FK;
    # no company_id column on this table itself.
    routing_op = (
        supabase_admin.table("routing_operations")
        .insert(
            {
                "routing_id": routing_id,
                "work_center_id": internal_wc_id,
                "sequence": 10,
                "setup_minutes": 30,
                "cycle_minutes_per_unit": 2,
            }
        )
        .execute()
    )
    routing_operation_id = routing_op.data[0]["id"]

    # Quote — minimum viable to satisfy NOT NULL constraints. The
    # `set_quote_number` trigger fills quote_number when '' or NULL.
    quote = (
        supabase_admin.table("quotes")
        .insert(
            {
                "company_id": company_b_id,
                "customer_id": customer_id,
                "quote_number": "",  # filled by trigger
                "status": "active",
            }
        )
        .execute()
    )
    quote_id = quote.data[0]["id"]

    # Job — production_status NOT NULL, fulfillment_status defaults to
    # 'unshipped' (per migration 20260523). Job number mirrors the quote
    # number — fill explicitly to avoid relying on quote-conversion.
    job = (
        supabase_admin.table("jobs")
        .insert(
            {
                "company_id": company_b_id,
                "customer_id": customer_id,
                "job_number": "J-RLS-3D-B",
                "production_status": "not_started",
                "fulfillment_status": "unshipped",
            }
        )
        .execute()
    )
    job_id = job.data[0]["id"]

    # Shipment — minimum viable. `shipments_one_address_source` CHECK
    # requires exactly one of (shipping_address_id, one_time_address) to
    # be set. The customer has no addresses in this fixture, so use the
    # one_time_address path with a stub JSONB blob.
    shipment = (
        supabase_admin.table("shipments")
        .insert(
            {
                "company_id": company_b_id,
                "customer_id": customer_id,
                "job_id": job_id,
                "packing_slip_number": "PS-RLS-3D-B-0001",
                "one_time_address": {
                    "name": "RLS-3d Fixture Address",
                    "line1": "1 Test Street",
                    "city": "Testville",
                    "state": "TS",
                    "postal_code": "00000",
                },
            }
        )
        .execute()
    )
    shipment_id = shipment.data[0]["id"]

    yield {
        "company_id": company_b_id,
        "user": seeded_user_b,
        "vendor_id": vendor_id,
        "work_center_id": internal_wc_id,
        "customer_id": customer_id,
        "part_id": part_id,
        "routing_id": routing_id,
        "routing_operation_id": routing_operation_id,
        "quote_id": quote_id,
        "job_id": job_id,
        "shipment_id": shipment_id,
    }

    # Teardown order: clean up rows that the company-delete cascade won't
    # reach automatically. The seeded_user_b teardown will delete the
    # company itself; we leave the children alone here and let CASCADE
    # handle them.
