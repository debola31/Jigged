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


@pytest.fixture
def supabase_admin() -> Generator[Client, None, None]:
    """
    Create an admin Supabase client using service key.

    Uses TEST_SUPABASE_URL and TEST_SUPABASE_SERVICE_KEY environment variables.
    Falls back to regular Supabase vars if test vars not set.
    """
    url = os.getenv("TEST_SUPABASE_URL") or os.getenv("SUPABASE_URL")
    service_key = os.getenv("TEST_SUPABASE_SERVICE_KEY") or os.getenv("SUPABASE_SECRET_KEY")

    if not url or not service_key:
        pytest.skip("Supabase credentials not configured")

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
