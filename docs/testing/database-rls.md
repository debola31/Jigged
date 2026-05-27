# Database RLS Policy Tests

## Why Test RLS?

Row Level Security is critical for multi-tenant applications. These tests verify that users can only access data from their authorized companies.

---

## RLS Policy Tests

Create `api/tests/database/test_rls_`[`[policies.py](http://policies.py/)`](http://policies.py/):

```python
import pytest
from supabase import create_client
import os

pytestmark = pytest.mark.asyncio

TEST_SUPABASE_URL = os.environ.get("TEST_SUPABASE_URL")
TEST_SUPABASE_PUBLISHABLE_KEY = os.environ.get("TEST_SUPABASE_PUBLISHABLE_KEY")


class TestCustomerRLS:
    """RLS policies for customers table."""
    
    async def test_user_cannot_read_other_company(
        self, supabase_admin, test_user, test_company
    ):
        """Users cannot see other companies' customers."""
        # Create another company with customer
        other = supabase_admin.table("companies").insert({
            "name": "Other Corp",
            "slug": "other-corp"
        }).execute()
        
        secret = supabase_admin.table("customers").insert({
            "company_id": [other.data](http://other.data/)[0]["id"],
            "customer_code": "SECRET",
            "name": "Secret Customer"
        }).execute()
        
        # Get user session
        session = supabase_admin.auth.sign_in_with_password({
            "email": test_[user.email](http://user.email/),
            "password": "testpassword123"
        })
        
        # Create client as user
        user_client = create_client(
            TEST_SUPABASE_URL, 
            TEST_SUPABASE_PUBLISHABLE_KEY
        )
        user_client.auth.set_session(
            session.session.access_token,
            session.session.refresh_token
        )
        
        # Try to read secret customer
        result = user_client.table("customers").select("*").eq(
            "id", [secret.data](http://secret.data/)[0]["id"]
        ).execute()
        
        # RLS should block - returns empty
        assert len([result.data](http://result.data/)) == 0
    
    async def test_user_cannot_insert_other_company(
        self, supabase_admin, test_user
    ):
        """Users cannot insert into unauthorized companies."""
        # Create company user has NO access to
        other = supabase_admin.table("companies").insert({
            "name": "Other",
            "slug": "other"
        }).execute()
        
        session = supabase_admin.auth.sign_in_with_password({
            "email": test_[user.email](http://user.email/),
            "password": "testpassword123"
        })
        
        user_client = create_client(
            TEST_SUPABASE_URL,
            TEST_SUPABASE_PUBLISHABLE_KEY
        )
        user_client.auth.set_session(
            session.session.access_token,
            session.session.refresh_token
        )
        
        # Attempt unauthorized insert
        with pytest.raises(Exception) as exc_info:
            user_client.table("customers").insert({
                "company_id": [other.data](http://other.data/)[0]["id"],
                "customer_code": "HACK01",
                "name": "Unauthorized"
            }).execute()
        
        assert "policy" in str(exc_info.value).lower()
    
    async def test_user_can_read_own_company(
        self, supabase_admin, test_user, test_company
    ):
        """Users CAN see their company's customers."""
        my_customer = supabase_admin.table("customers").insert({
            "company_id": test_company["id"],
            "customer_code": "MINE01",
            "name": "My Customer"
        }).execute()
        
        session = supabase_admin.auth.sign_in_with_password({
            "email": test_[user.email](http://user.email/),
            "password": "testpassword123"
        })
        
        user_client = create_client(
            TEST_SUPABASE_URL,
            TEST_SUPABASE_PUBLISHABLE_KEY
        )
        user_client.auth.set_session(
            session.session.access_token,
            session.session.refresh_token
        )
        
        result = user_client.table("customers").select("*").eq(
            "id", my_[customer.data](http://customer.data/)[0]["id"]
        ).execute()
        
        assert len([result.data](http://result.data/)) == 1
        assert [result.data](http://result.data/)[0]["name"] == "My Customer"


class TestPartsRLS:
    """RLS policies for parts table."""
    
    async def test_parts_inherit_customer_company(
        self, supabase_admin, test_user, test_company
    ):
        """Parts are visible based on company access."""
        # Create customer and part
        customer = supabase_admin.table("customers").insert({
            "company_id": test_company["id"],
            "customer_code": "CUST01",
            "name": "Customer"
        }).execute()
        
        part = supabase_admin.table("parts").insert({
            "company_id": test_company["id"],
            "customer_id": [customer.data](http://customer.data/)[0]["id"],
            "part_name": "PART-001",
            "description": "Test Part"
        }).execute()
        
        session = supabase_admin.auth.sign_in_with_password({
            "email": test_[user.email](http://user.email/),
            "password": "testpassword123"
        })
        
        user_client = create_client(
            TEST_SUPABASE_URL,
            TEST_SUPABASE_PUBLISHABLE_KEY
        )
        user_client.auth.set_session(
            session.session.access_token,
            session.session.refresh_token
        )
        
        result = user_client.table("parts").select("*").eq(
            "id", [part.data](http://part.data/)[0]["id"]
        ).execute()
        
        assert len([result.data](http://result.data/)) == 1
```

---

## Test Checklist

- [ ] Users cannot SELECT from other companies

- [ ] Users cannot INSERT into other companies

- [ ] Users cannot UPDATE other companies' data

- [ ] Users cannot DELETE other companies' data

- [ ] Service role key bypasses RLS (for admin operations)

- [ ] Anon key with no auth sees nothing
