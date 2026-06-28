# Backend Testing Setup

## Local Supabase for tests (sub-PR 3c onwards)

Backend integration tests + RLS tests (sub-PR 3d) run against an ephemeral local Supabase stack started via the CLI. They never touch staging or prod; the conftest exits with an actionable error if `TEST_SUPABASE_URL` is unset.

```bash
# Prereqs (once per machine):
brew install supabase/tap/supabase     # or follow the CLI install docs
docker --version                       # Docker must be running

# Per session:
supabase start                         # boots Postgres + Auth + Storage + Realtime locally
eval "$(supabase status -o env)"       # exposes API_URL / ANON_KEY / SERVICE_ROLE_KEY

# Run backend tests against local (prod-aligned key names with TEST_ prefix):
cd api && \
  TEST_SUPABASE_URL=$API_URL \
  TEST_SUPABASE_PUBLISHABLE_KEY=$ANON_KEY \
  TEST_SUPABASE_SECRET_KEY=$SERVICE_ROLE_KEY \
  pytest -v

# Tear down:
supabase stop
```

CI does the same dance automatically — see `.github/workflows/test.yml`.

The local-Supabase service-role key is publicly known (it's a fixed development default; not the staging or prod one), so using it for test setup is safe. The actual RLS assertions added in 3d use the publishable key + a user JWT — they exercise the policies the same way the app does.

### JWT fixtures

`api/tests/conftest.py` exposes three session-scoped fixtures that the 3d RLS tests build on:

- `seeded_user_a` — creates a user + company (member of A only), signs in, yields `{user, user_id, access_token, company_id, client}` where `client` is an anon-key Supabase client carrying the user JWT.
- `seeded_user_b` — symmetric on company B.
- `seeded_company_b_graph` — builds the parent-child object graph in company B (vendor, internal work center, customer, made part, routing + one operation) so cross-tenant RLS tests have something to attempt to read.

Smoke tests for the fixtures live at `api/tests/database/test_jwt_fixtures_smoke.py`. If those pass, the fixtures wire up correctly.

---

## Step 1: Install Dependencies

Create `api/requirements-test.txt`:

```javascript
pytest>=7.4.0
pytest-asyncio>=0.21.0
pytest-cov>=4.1.0
pytest-mock>=3.11.0
httpx>=0.24.0
factory-boy>=3.3.0
responses>=0.23.0
```

Install:

```bash
pip install -r api/requirements-test.txt
```

---

## Step 2: Pytest Configuration

Create `api/pytest.ini`:

```plain text
[pytest]
asyncio_mode = auto
testpaths = tests
python_files = test_*.py
python_classes = Test*
python_functions = test_*
addopts = -v --tb=short
markers =
    unit: Unit tests (no external dependencies)
    integration: Integration tests (requires DB)
    slow: Slow tests
```

---

## Step 3: Shared Fixtures

Create `api/tests/`[`[conftest.py](http://conftest.py/)`](http://conftest.py/):

```python
import pytest
import os
from httpx import AsyncClient, ASGITransport
from supabase import create_client, Client
from uuid import uuid4

# Import your FastAPI app
from api.index import app

# Test Supabase credentials
TEST_SUPABASE_URL = os.environ.get("TEST_SUPABASE_URL")
TEST_SUPABASE_KEY = os.environ.get("TEST_SUPABASE_SECRET_KEY")


@pytest.fixture(scope="session")
def supabase_admin() -> Client:
    """Admin client that bypasses RLS."""
    return create_client(TEST_SUPABASE_URL, TEST_SUPABASE_KEY)


@pytest.fixture
async def test_company(supabase_admin):
    """Create isolated test company."""
    company = supabase_admin.table("companies").insert({
        "name": f"Test Company {uuid4().hex[:8]}",
        "slug": f"test-{uuid4().hex[:8]}"
    }).execute()
    
    yield [company.data](http://company.data/)[0]
    
    # Cleanup
    supabase_admin.table("companies").delete().eq(
        "id", [company.data](http://company.data/)[0]["id"]
    ).execute()


@pytest.fixture
async def test_user(supabase_admin, test_company):
    """Create test user with company access."""
    email = f"test-{uuid4().hex[:8]}@[test.com](http://test.com/)"
    
    user = supabase_admin.auth.admin.create_user({
        "email": email,
        "password": "testpassword123",
        "email_confirm": True
    })
    
    supabase_admin.table("user_company_access").insert({
        "user_id": [user.user.id](http://user.user.id/),
        "company_id": test_company["id"],
        "role": "owner"
    }).execute()
    
    yield user.user
    
    supabase_admin.auth.admin.delete_user([user.user.id](http://user.user.id/))


@pytest.fixture
async def auth_token(supabase_admin, test_user):
    """Get JWT for test user."""
    # Sign in to get token
    session = supabase_admin.auth.sign_in_with_password({
        "email": test_[user.email](http://user.email/),
        "password": "testpassword123"
    })
    return session.session.access_token


@pytest.fixture
async def client(auth_token):
    """Authenticated HTTP client."""
    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport,
        base_url="[http://test](http://test/)",
        headers={"Authorization": f"Bearer {auth_token}"}
    ) as ac:
        yield ac


@pytest.fixture
async def anon_client():
    """Unauthenticated HTTP client."""
    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport,
        base_url="[http://test](http://test/)"
    ) as ac:
        yield ac
```

---

## Step 4: Test Data Factories

Create `api/tests/factories/customer_`[`[factory.py](http://factory.py/)`](http://factory.py/):

```python
from dataclasses import dataclass, field
from uuid import uuid4
from typing import Optional


@dataclass
class CustomerFactory:
    """Generate test customer data."""
    
    company_id: str
    customer_code: str = field(
        default_factory=lambda: f"TST-{uuid4().hex[:6].upper()}"
    )
    name: str = field(
        default_factory=lambda: f"Test Customer {uuid4().hex[:8]}"
    )
    phone: Optional[str] = "555-0100"
    email: Optional[str] = None
    is_active: bool = True
    
    def __post_init__(self):
        if [self.email](http://self.email/) is None:
            [self.email](http://self.email/) = f"{self.customer_code.lower()}@[test.com](http://test.com/)"
    
    def to_dict(self) -> dict:
        return {
            "company_id": [self.company](http://self.company/)_id,
            "customer_code": self.customer_code,
            "name": [self.name](http://self.name/),
            "phone": [self.phone](http://self.phone/),
            "email": [self.email](http://self.email/),
            "is_active": [self.is](http://self.is/)_active
        }
    
    @classmethod
    def batch(cls, company_id: str, count: int) -> list:
        return [cls(company_id=company_id) for _ in range(count)]
```

---

## Step 5: Running Tests

```bash
# Run all tests
cd api && pytest

# Run with coverage
pytest --cov=. --cov-report=html

# Run specific markers
pytest -m unit
pytest -m integration

# Run specific file
pytest tests/integration/test_customers_[api.py](http://api.py/)
```
